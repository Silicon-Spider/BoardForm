import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetRecord, TrainingRunRecord, TrainingRunStatus } from "@/types";
import { datasetsRepo, enginesRepo, networksRepo, runsRepo } from "@/storage/repos";
import { resetStorage } from "@/storage/test-utils";
import { PACKED_SIZE, POSITIONS_PER_CHUNK } from "@/nnue/pack";
import { quantizeNetwork } from "@/nnue/format";
import { createNetwork } from "@/nnue/init";
import { makeMaterialDataset } from "@/nnue/synthetic";
import { bestDataId, checkpointDataId } from "./constants";
import { getLiveRun, useLiveRunStore } from "./live";
import { createLabService } from "./service";
import { thinPoints } from "./run-controller";
import type { TrainerLike } from "./deps";
import type { TrainProgress } from "@/nnue/protocol";
import { FakeLocks, FakeSelfPlaySource, ScriptedTrainer, inProcessTrainer, runConfig, testDeps, testEngine, until } from "./test-helpers";

async function storeDataset(id: string, positions: number, seed: number): Promise<void> {
  const data = makeMaterialDataset(positions, seed);
  const chunks = Math.ceil(positions / POSITIONS_PER_CHUNK);
  const rec: DatasetRecord = { id, name: `Data ${id}`, description: "", createdAt: 1, updatedAt: 1, positions, games: 0, chunks, source: { kind: "import" } };
  await datasetsRepo.put(rec);
  for (let k = 0; k < chunks; k++) {
    const from = k * POSITIONS_PER_CHUNK;
    const count = Math.min(POSITIONS_PER_CHUNK, positions - from);
    await datasetsRepo.putChunk({ id: "", datasetId: id, index: k, count, data: data.slice(from * PACKED_SIZE, (from + count) * PACKED_SIZE).buffer });
  }
}

const run = (id: string) => runsRepo.get(id) as Promise<TrainingRunRecord>;

type LabService = ReturnType<typeof createLabService>;

/** Wraps a trainer so `hook` sees every progress report (after the run's own handler). */
function onProgress(trainer: TrainerLike, hook: (p: TrainProgress) => void): TrainerLike {
  return {
    start: (job, handlers = {}) =>
      trainer.start(job, {
        ...handlers,
        onProgress: (p) => {
          handlers.onProgress?.(p);
          hook(p);
        },
      }),
    stop: () => trainer.stop(),
    terminate: () => trainer.terminate(),
  };
}

async function waitStatus(id: string, statuses: TrainingRunStatus[], timeoutMs = 30_000): Promise<TrainingRunRecord> {
  let last: TrainingRunRecord | undefined;
  await until(
    async () => {
      last = await runsRepo.get(id);
      return !!last && statuses.includes(last.status);
    },
    timeoutMs,
    `status ${statuses.join("/")} (last: ${last?.status})`,
  );
  return last as TrainingRunRecord;
}

describe("training runs", () => {
  beforeEach(async () => {
    await resetStorage();
    ScriptedTrainer.jobs = [];
    useLiveRunStore.setState({ runs: {}, activeIds: [] });
  });
  afterEach(async () => {
    await resetStorage();
  });

  it("runs one cycle and keeps the epoch with the lowest validation loss", async () => {
    await storeDataset("ds", 500, 1);
    const losses = [0.3, 0.2, 0.25];
    const deps = testDeps({ createTrainer: () => new ScriptedTrainer({ valLoss: (e) => losses[e - 1] ?? null, stepsPerEpoch: 5 }) });
    const lab = createLabService(deps);
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: ["ds"], selfPlay: null } }));
    expect(lab.training.isActive(id)).toBe(true);
    const done = await waitStatus(id, ["finished", "error"]);
    expect(done.status).toBe("finished");
    expect(done.error).toBeNull();
    expect(done.networkHistory).toHaveLength(1);
    const entry = done.networkHistory[0]!;
    expect(entry).toMatchObject({ cycle: 0, valLoss: 0.2, gating: null });
    expect(done.networkId).toBe(entry.networkId);
    const net = await networksRepo.get(entry.networkId);
    expect(net).toMatchObject({ name: "Test run - c1", hidden: 16, parentId: null, stats: { epochs: 2, valLoss: 0.2, trainingRunId: id, datasetIds: ["ds"] } });
    const data = await networksRepo.getData(entry.networkId);
    // Epoch 2 ended after 10 steps: the scripted trainer adds 1e-3 to b1[0] per step.
    const start = createNetwork(16, 1, 7);
    expect(data!.float!.b1[0]).toBeCloseTo((start.b1[0] as number) + 0.01, 6);
    expect(data!.optimizer!.step).toBe(10);
    expect(new Uint8Array(data!.quantized)).toEqual(new Uint8Array(quantizeNetwork(data!.float!)));
    // Checkpoints are cleaned up, points / log recorded, live state and activity cleared.
    expect(await networksRepo.getData(checkpointDataId(id))).toBeUndefined();
    expect(await networksRepo.getData(bestDataId(id))).toBeUndefined();
    expect(done.points.length).toBeGreaterThan(5);
    expect(done.points.at(-1)).toMatchObject({ cycle: 0, epoch: 3, step: 15 });
    expect(done.log.map((l) => l.message)).toContain("Run finished.");
    expect(done.resume).toBeNull();
    expect(getLiveRun(id)).toBeNull();
    expect(lab.training.isActive(id)).toBe(false);
    expect(deps.notify.activityIds.has(`training:${id}`)).toBe(true);
    expect(deps.notify.activities.has(`training:${id}`)).toBe(false);
    expect(deps.notify.toasts.at(-1)).toMatchObject({ kind: "success", message: 'Training run "Test run" finished' });
    expect(ScriptedTrainer.jobs[0]).toMatchObject({ datasetIds: ["ds"], resume: null, checkpointEverySteps: 2, hyper: { seed: 7, threads: 1 } });
  });

  it("generates the cycle's self-play data, then trains on it and publishes an engine", async () => {
    await enginesRepo.put(testEngine("classic", { name: "Classic" }));
    const source = new FakeSelfPlaySource({ positionsPerGame: 50 });
    const deps = testDeps({ selfPlay: source });
    const lab = createLabService(deps);
    const sp = { engineId: "classic", limits: { nodes: 2000 }, randomPlies: 8, games: 6, concurrency: 8, maxPlies: 300, skipPlies: 8 };
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: [], selfPlay: sp }, publishEngine: true }));
    const done = await waitStatus(id, ["finished", "error"]);
    expect(done.status, done.error ?? "").toBe("finished");
    expect(done.datasetIds).toHaveLength(1);
    const ds = await datasetsRepo.get(done.datasetIds[0]!);
    expect(ds).toMatchObject({ name: "Test run - cycle 1", games: 6, positions: 300, source: { kind: "selfplay", engineId: "classic", trainingRunId: id } });
    expect(source.selfPlayJobs[0]).toMatchObject({ games: 6, concurrency: 4, firstGameIndex: 0 }); // capped by maxWorkers (4)
    expect(ScriptedTrainer.jobs[0]?.datasetIds).toEqual([ds!.id]);
    expect(done.engineId).not.toBeNull();
    const engine = await enginesRepo.get(done.engineId!);
    expect(engine).toMatchObject({ kind: "nnue", name: "Test run", networkId: done.networkId });
  });

  it("loops with gating: rejected networks are kept, self-play uses the last accepted one", async () => {
    await enginesRepo.put(testEngine("classic", { name: "Classic" }));
    const source = new FakeSelfPlaySource({
      positionsPerGame: 20,
      // Cycle 2's network (gated first) wins everything; cycle 3's loses everything.
      gatingResult: (_i, newIsWhite, job) => (job.names.new.endsWith("c2") ? (newIsWhite ? 2 : 0) : newIsWhite ? 0 : 2),
    });
    const deps = testDeps({ selfPlay: source });
    const lab = createLabService(deps);
    const sp = { engineId: "classic", limits: { nodes: 1000 }, randomPlies: 4, games: 3, concurrency: 2, maxPlies: 200, skipPlies: 4 };
    const id = await lab.training.createRun(
      runConfig({
        data: { datasetIds: [], selfPlay: sp },
        loop: { enabled: true, cycles: 4, selfPlayWithLatest: true, keepCycles: 2, gating: { games: 4, limits: { nodes: 500 }, minScore: 0.55 } },
        publishEngine: true,
      }),
    );
    const done = await waitStatus(id, ["finished", "error"], 60_000);
    expect(done.status, done.error ?? "").toBe("finished");
    const h = done.networkHistory;
    expect(h.map((e) => e.cycle)).toEqual([0, 1, 2, 3]);
    expect(h[0]!.gating).toBeNull(); // nothing to compare the first network with
    expect(h[1]!.gating).toEqual({ score: 1, games: 4, accepted: true });
    expect(h[2]!.gating).toEqual({ score: 0, games: 4, accepted: false });
    expect(h[3]!.gating).toEqual({ score: 0, games: 4, accepted: false });
    // Gating opponents: c2 vs c1, c3 vs c2 (accepted), c4 vs c2 (c3 was rejected).
    expect(source.gatingJobs.map((j) => `${j.names.new} vs ${j.names.old}`)).toEqual([
      "Test run - c2 vs Test run - c1",
      "Test run - c3 vs Test run - c2",
      "Test run - c4 vs Test run - c2",
    ]);
    // Self-play: cycle 1 with Classic, cycle 2 with c1, cycles 3 and 4 with c2 (the last accepted).
    const quantizedOf = async (networkId: string) => new Uint8Array((await networksRepo.getData(networkId))!.quantized);
    expect(source.selfPlayJobs[0]?.network).toBeNull();
    expect(new Uint8Array(source.selfPlayJobs[1]!.network!)).toEqual(await quantizedOf(h[0]!.networkId));
    expect(new Uint8Array(source.selfPlayJobs[2]!.network!)).toEqual(await quantizedOf(h[1]!.networkId));
    expect(new Uint8Array(source.selfPlayJobs[3]!.network!)).toEqual(await quantizedOf(h[1]!.networkId));
    // Training continues from the previous cycle's network (even a rejected one), keepCycles = 2.
    const jobs = ScriptedTrainer.jobs;
    expect(jobs).toHaveLength(4);
    expect(jobs[3]!.datasetIds).toEqual(done.datasetIds.slice(2, 4));
    expect(jobs[1]!.optimizer?.step).toBe(15);
    expect(jobs[3]!.optimizer?.step).toBe(45);
    // The newest network is c4; the published engine plays with the last accepted one (c2).
    expect(done.networkId).toBe(h[3]!.networkId);
    expect((await enginesRepo.get(done.engineId!))?.networkId).toBe(h[1]!.networkId);
    expect((await networksRepo.get(h[2]!.networkId))?.parentId).toBe(h[1]!.networkId);
  });

  it("pause → start resumes from the checkpoint bit-identically (real trainer)", async () => {
    await storeDataset("ds", 3000, 9);
    // 85 steps per epoch, 255 in all: the pause below lands well inside the run.
    const config = runConfig({
      data: { datasetIds: ["ds"], selfPlay: null },
      hyper: { ...runConfig().hyper, epochs: 3, batchSize: 32, validationSplit: 0.1, seed: 5 },
    });
    // Reference: uninterrupted.
    const refLab = createLabService(testDeps({ createTrainer: inProcessTrainer }));
    const refId = await refLab.training.createRun({ ...config, name: "Reference" });
    const ref = await waitStatus(refId, ["finished", "error"], 60_000);
    expect(ref.status, ref.error ?? "").toBe("finished");

    // Pause from inside the progress callback (a few steps into epoch 2), not by polling: the
    // in-process trainer is fast enough to finish the whole run between two polls.
    let id = "";
    let pausing: Promise<void> | null = null;
    const lab: LabService = createLabService(
      testDeps({
        createTrainer: () =>
          onProgress(inProcessTrainer(), (p) => {
            if (id && !pausing && p.epoch * p.stepsPerEpoch + p.step >= p.stepsPerEpoch + 3) pausing = lab.training.pause(id);
          }),
      }),
    );
    id = await lab.training.createRun(config);
    await until(() => pausing !== null, 60_000, "training progress");
    await pausing;
    const paused = await run(id);
    expect(paused.status).toBe("paused");
    expect(paused.resume?.cycle).toBe(0);
    expect(paused.resume!.epoch * 1000 + paused.resume!.step).toBeGreaterThan(0);
    const ckpt = (await networksRepo.getData(checkpointDataId(id))) as unknown as { cursor: { epoch: number; step: number } };
    expect(ckpt.cursor).toMatchObject({ epoch: paused.resume!.epoch, step: paused.resume!.step });
    expect(paused.networkHistory).toEqual([]);
    expect(paused.log.at(-1)?.message).toBe("Paused.");

    await lab.training.start(id);
    const done = await waitStatus(id, ["finished", "error"], 60_000);
    expect(done.status, done.error ?? "").toBe("finished");
    expect(done.log.some((l) => /Continuing training from the checkpoint/.test(l.message))).toBe(true);
    const a = await networksRepo.getData(ref.networkId!);
    const b = await networksRepo.getData(done.networkId!);
    expect(done.networkHistory[0]!.valLoss).toBe(ref.networkHistory[0]!.valLoss);
    expect(Array.from(b!.float!.w1)).toEqual(Array.from(a!.float!.w1));
    expect(Array.from(b!.float!.w2)).toEqual(Array.from(a!.float!.w2));
    expect(new Uint8Array(b!.quantized)).toEqual(new Uint8Array(a!.quantized));
  });

  it("stop saves the best network so far; start continues the cycle to the end", async () => {
    await storeDataset("ds", 400, 2);
    const deps = testDeps({ createTrainer: () => new ScriptedTrainer({ valLoss: (e) => 1 / e, stepsPerEpoch: 6, stepMs: 5 }) });
    const lab = createLabService(deps);
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: ["ds"], selfPlay: null }, hyper: { ...runConfig().hyper, epochs: 8 } }));
    await until(() => (getLiveRun(id)?.train?.epoch ?? 0) >= 2, 20_000, "two epochs");
    await lab.training.stop(id);
    const stopped = await run(id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.networkHistory).toHaveLength(1);
    const snap = await networksRepo.get(stopped.networkHistory[0]!.networkId);
    expect(snap?.name).toMatch(/^Test run - c1 \(stopped, epoch \d\/8\)$/);
    expect(snap?.stats.valLoss).toBe(1 / (snap?.stats.epochs ?? 0)); // the best epoch end so far
    expect(stopped.networkId).toBe(snap?.id);
    expect(stopped.resume?.cycle).toBe(0);

    await lab.training.start(id);
    const done = await waitStatus(id, ["finished", "error"]);
    expect(done.status, done.error ?? "").toBe("finished");
    expect(done.networkHistory).toHaveLength(2);
    const final = await networksRepo.get(done.networkId!);
    expect(final).toMatchObject({ name: "Test run - c1", stats: { epochs: 8, valLoss: 0.125 } });
    expect(ScriptedTrainer.jobs.at(-1)?.resume).toEqual({ epoch: stopped.resume!.epoch, step: stopped.resume!.step });
  });

  it("stopping a paused run also keeps the best network so far (once)", async () => {
    await storeDataset("ds", 400, 2);
    const deps = testDeps({ createTrainer: () => new ScriptedTrainer({ valLoss: (e) => 1 / e, stepsPerEpoch: 6, stepMs: 5 }) });
    const lab = createLabService(deps);
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: ["ds"], selfPlay: null }, hyper: { ...runConfig().hyper, epochs: 8 } }));
    await until(() => (getLiveRun(id)?.train?.epoch ?? 0) >= 2, 20_000, "two epochs");
    await lab.training.pause(id);
    expect((await run(id)).networkHistory).toEqual([]);
    expect(getLiveRun(id)).toBeNull();

    await lab.training.stop(id); // not executing: stopped from the stored checkpoints
    const stopped = await run(id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.log.at(-1)?.message).toBe("Stopped.");
    expect(stopped.networkHistory).toHaveLength(1);
    const snap = await networksRepo.get(stopped.networkHistory[0]!.networkId);
    expect(snap?.name).toMatch(/^Test run - c1 \(stopped, epoch \d\/8\)$/);
    expect(snap?.stats.valLoss).toBe(1 / (snap?.stats.epochs ?? 0)); // the best epoch end so far
    expect(stopped.networkId).toBe(snap?.id);
    expect(getLiveRun(id)).toBeNull();
    expect(deps.notify.activities.has(`training:${id}`)).toBe(false);

    // Continue, pause again before a better epoch end, stop: no second copy of the same network.
    await lab.training.start(id);
    await lab.training.pause(id);
    await lab.training.stop(id);
    const again = await run(id);
    expect(again.status).toBe("stopped");
    const snapshots = again.networkHistory.filter((h) => h.cycle === 0);
    const names = await Promise.all(snapshots.map(async (h) => (await networksRepo.get(h.networkId))?.stats.positionsSeen));
    expect(new Set(names).size).toBe(names.length);
  });

  it("errors leave a resumable run with the message in the log", async () => {
    await storeDataset("ds", 400, 3);
    let attempts = 0;
    const deps = testDeps({
      createTrainer: () => new ScriptedTrainer({ stepsPerEpoch: 5, failAtStep: attempts++ === 0 ? { step: 7, message: "the loss became NaN" } : null }),
    });
    const lab = createLabService(deps);
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: ["ds"], selfPlay: null } }));
    const failed = await waitStatus(id, ["error", "finished"]);
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/the loss became NaN/);
    expect(failed.log.at(-1)).toMatchObject({ level: "error" });
    expect(deps.notify.toasts.at(-1)).toMatchObject({ kind: "error" });
    expect(lab.training.isActive(id)).toBe(false);
    expect(failed.resume?.epoch).toBe(1); // the last persisted checkpoint (epoch 1 end / step 6)

    await lab.training.start(id);
    const done = await waitStatus(id, ["finished", "error"]);
    expect(done.status).toBe("finished");
    expect(done.error).toBeNull();
  });

  it("pausing during self-play continues the cycle's dataset up to its target", async () => {
    await enginesRepo.put(testEngine("classic"));
    const source = new FakeSelfPlaySource({ positionsPerGame: 10, gameDelayMs: 15 });
    const lab = createLabService(testDeps({ selfPlay: source }));
    const sp = { engineId: "classic", limits: { nodes: 1000 }, randomPlies: 4, games: 12, concurrency: 2, maxPlies: 200, skipPlies: 0 };
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: [], selfPlay: sp } }));
    await until(() => (getLiveRun(id)?.selfPlay?.gamesDone ?? 0) >= 3, 20_000, "some games");
    await lab.training.pause(id);
    const paused = await run(id);
    expect(paused.status).toBe("paused");
    const ds1 = await datasetsRepo.get(paused.datasetIds[0]!);
    expect(ds1!.games).toBeGreaterThanOrEqual(3);
    expect(ds1!.games).toBeLessThan(12);
    await lab.training.start(id);
    const done = await waitStatus(id, ["finished", "error"]);
    expect(done.status).toBe("finished");
    const ds = await datasetsRepo.get(done.datasetIds[0]!);
    expect(ds).toMatchObject({ games: 12, positions: 120 });
    expect(source.selfPlayJobs[1]).toMatchObject({ firstGameIndex: ds1!.games, games: 12 - ds1!.games });
  });

  it("only one tab runs a run; init resumes or pauses interrupted runs", async () => {
    await storeDataset("ds", 300, 4);
    const locks = new FakeLocks();
    const tabA = createLabService(testDeps({ locks }));
    const base = runConfig({ data: { datasetIds: ["ds"], selfPlay: null } });
    const auto = await tabA.training.createRun({ ...base, name: "Auto" }, { start: false, autoResume: true });
    const manual = await tabA.training.createRun({ ...base, name: "Manual" }, { start: false, autoResume: false });
    const elsewhere = await tabA.training.createRun({ ...base, name: "Elsewhere" }, { start: false, autoResume: true });
    const paused = await tabA.training.createRun({ ...base, name: "Paused" }, { start: false, autoResume: true });
    // Simulate a closed tab: running statuses without a lock holder; "Elsewhere" is held by another tab.
    await runsRepo.update(auto, { status: "training" });
    await runsRepo.update(manual, { status: "selfplay" });
    await runsRepo.update(elsewhere, { status: "training" });
    await runsRepo.update(paused, { status: "paused" });
    const otherTab = await locks.acquire(elsewhere);

    const deps = testDeps({ locks });
    const tabB = createLabService(deps);
    await expect(tabB.training.start(elsewhere)).rejects.toThrow(/another tab/);
    await expect(tabB.training.pause(elsewhere)).rejects.toThrow(/another tab/);
    await tabB.init();
    await tabB.init(); // idempotent
    expect(tabB.training.isActive(auto)).toBe(true);
    expect(tabB.training.activeRunIds()).toEqual([auto]);
    expect(deps.notify.toasts.some((t) => t.message === 'Resumed the training run "Auto"')).toBe(true);
    const m = await run(manual);
    expect(m.status).toBe("paused");
    expect(m.log.at(-1)).toMatchObject({ level: "warn", message: "Interrupted when the tab was closed" });
    expect((await run(elsewhere)).status).toBe("training");
    expect((await run(paused)).status).toBe("paused");
    const done = await waitStatus(auto, ["finished", "error"]);
    expect(done.status).toBe("finished");
    expect(done.log.some((l) => l.message.startsWith("Interrupted when the tab was closed; resuming"))).toBe(true);
    expect(locks.held.has(auto)).toBe(false); // released when the run ended
    otherTab?.release();
  });

  it("deletes a run with its checkpoints, networks and generated datasets", async () => {
    await enginesRepo.put(testEngine("classic"));
    await storeDataset("keep", 200, 5);
    const lab = createLabService(testDeps({ createTrainer: () => new ScriptedTrainer({ stepsPerEpoch: 4, stepMs: 3 }) }));
    const sp = { engineId: "classic", limits: { nodes: 1000 }, randomPlies: 4, games: 2, concurrency: 1, maxPlies: 200, skipPlies: 0 };
    const id = await lab.training.createRun(runConfig({ data: { datasetIds: ["keep"], selfPlay: sp }, hyper: { ...runConfig().hyper, epochs: 50 } }));
    await until(() => getLiveRun(id)?.phase === "training" && (getLiveRun(id)?.train?.epoch ?? 0) >= 1, 20_000, "training");
    await lab.training.stop(id);
    const rec = await run(id);
    expect(rec.networkHistory).toHaveLength(1);
    const generated = rec.datasetIds.filter((d) => d !== "keep");
    expect(await networksRepo.getData(checkpointDataId(id))).toBeDefined();
    await lab.training.deleteRun(id, { deleteNetworks: true, deleteDatasets: true });
    expect(await runsRepo.get(id)).toBeUndefined();
    expect(await networksRepo.getData(checkpointDataId(id))).toBeUndefined();
    expect(await networksRepo.get(rec.networkHistory[0]!.networkId)).toBeUndefined();
    expect(await datasetsRepo.get(generated[0]!)).toBeUndefined();
    expect(await datasetsRepo.get("keep")).toBeDefined();
  });

  it("thins stored points, keeping the newest half intact", () => {
    const pts = Array.from({ length: 4001 }, (_, i) => ({ t: i, cycle: 0, epoch: 0, step: i, positions: i, trainLoss: 1, valLoss: null, lr: 0.001 }));
    const thinned = thinPoints(pts, 4000);
    expect(thinned.length).toBeLessThanOrEqual(3001);
    expect(thinned.slice(-2000)).toEqual(pts.slice(-2000));
    expect(thinned[0]).toEqual(pts[0]);
  });
});
