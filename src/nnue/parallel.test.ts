import { describe, expect, it } from "vitest";
import type { FloatNetworkData } from "@/types";
import { buildTrainingSet } from "./dataset";
import { createNetwork } from "./init";
import { ParallelTrainer, clampThreads, inlineHelperPool, threadSupport } from "./parallel";
import type { TrainCheckpoint, TrainerEvent } from "./protocol";
import { TrainingSession } from "./session";
import { makeMaterialDataset } from "./synthetic";
import { Trainer, sharedAllocator, type TrainerHyperParams } from "./trainer";
import { createTrainerWorkerHandler } from "./workerCore";

const HYPER: TrainerHyperParams = {
  epochs: 2,
  batchSize: 500,
  learningRate: 0.003,
  lrSchedule: "cosine",
  evalWeight: 0.75,
  weightDecay: 0.01,
  validationSplit: 0.1,
  threads: 4,
  seed: 11,
};

function sharedData(n: number, seed: number): Uint8Array {
  const plain = makeMaterialDataset(n, seed);
  const shared = new Uint8Array(new SharedArrayBuffer(plain.length));
  shared.set(plain);
  return shared;
}

function maxAbsDiff(a: FloatNetworkData, b: FloatNetworkData): number {
  let m = 0;
  for (const k of ["w1", "b1", "w2", "b2"] as const) {
    for (let i = 0; i < a[k].length; i++) m = Math.max(m, Math.abs((a[k][i] as number) - (b[k][i] as number)));
  }
  return m;
}

function sameBits(a: FloatNetworkData, b: FloatNetworkData): boolean {
  for (const k of ["w1", "b1", "w2", "b2"] as const) {
    for (let i = 0; i < a[k].length; i++) if (!Object.is(a[k][i], b[k][i])) return false;
  }
  return true;
}

const iota = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

describe("ParallelTrainer (inline helper pool)", () => {
  for (const activation of [0, 1] as const) {
    it(`matches the single-threaded Trainer up to summation order (${activation === 0 ? "CReLU" : "SCReLU"})`, async () => {
      const N = 5000;
      const data = sharedData(N, 3);
      const order = iota(N);
      const net = createNetwork(32, activation, 7);
      const config = { evalWeight: 0.75, weightDecay: 0.01 };
      const single = new Trainer(net, null, config);
      const par = await ParallelTrainer.create({ network: net, optimizer: null, config, data, threads: 4, capacity: 1000, startPool: inlineHelperPool });
      for (let s = 0; s < 5; s++) {
        const l1 = single.trainBatch(data, order, s * 1000, 1000, 0.002);
        const l2 = par.trainBatch(data, order, s * 1000, 1000, 0.002);
        expect(l2).toBeCloseTo(l1, 12);
      }
      expect(maxAbsDiff(single.net, par.net)).toBeLessThan(1e-5);
      expect(par.opt.step).toBe(5);
      const ls1 = single.lossSum(data, order, 0, N);
      const ls2 = par.lossSum(data, order, 0, N); // larger than capacity: chunked
      expect(Math.abs(ls1 - ls2) / ls1).toBeLessThan(1e-6);
      // Snapshots are plain (transferable) copies.
      const snap = par.snapshot();
      expect(snap.network.w1.buffer).toBeInstanceOf(ArrayBuffer);
      expect(snap.optimizer.m.w1.buffer).toBeInstanceOf(ArrayBuffer);
      par.dispose();
      par.dispose(); // idempotent
      expect(() => par.trainBatch(data, order, 0, 10, 0.001)).toThrow(/not running/);
    });
  }

  it("is deterministic for a given thread count, including uneven splits", async () => {
    const data = sharedData(3001, 4);
    const order = iota(3001);
    const run = async () => {
      const t = await ParallelTrainer.create({
        network: createNetwork(16, 1, 1),
        optimizer: null,
        config: { evalWeight: 0.5, weightDecay: 0.01 },
        data,
        threads: 3,
        capacity: 1001,
        startPool: inlineHelperPool,
      });
      for (let s = 0; s < 3; s++) t.trainBatch(data, order, s * 1000, s === 2 ? 1001 : 1000, 0.003);
      t.trainBatch(data, order, 0, 2, 0.003); // fewer positions than threads
      return t.snapshot().network;
    };
    expect(sameBits(await run(), await run())).toBe(true);
  });

  it("rejects unshared data, foreign arrays and oversized batches", async () => {
    const plain = makeMaterialDataset(100, 1);
    const opts = { network: createNetwork(8, 1, 1), optimizer: null, config: { evalWeight: 0.75, weightDecay: 0 }, threads: 2, capacity: 64, startPool: inlineHelperPool };
    await expect(ParallelTrainer.create({ ...opts, data: plain })).rejects.toThrow(/SharedArrayBuffer/);
    await expect(ParallelTrainer.create({ ...opts, data: sharedData(100, 1), threads: 1 })).rejects.toThrow(/at least 2/);
    const t = await ParallelTrainer.create({ ...opts, data: sharedData(100, 1) });
    expect(() => t.trainBatch(plain, iota(100), 0, 10, 0.001)).toThrow(/shared training data/);
    expect(() => t.trainBatch((t as unknown as { data: Uint8Array }).data, iota(100), 0, 100, 0.001)).toThrow(/capacity/);
  });

  it("drives a TrainingSession, and resuming with the same thread count is bit-identical", async () => {
    const set = buildTrainingSet([makeMaterialDataset(4000, 5)], { validationSplit: 0.1, seed: HYPER.seed, alloc: sharedAllocator });
    expect(set.data.buffer).toBeInstanceOf(SharedArrayBuffer);
    const make = async (network: FloatNetworkData, optimizer: TrainCheckpoint["optimizer"] | null) =>
      ParallelTrainer.create({ network, optimizer, config: { evalWeight: HYPER.evalWeight, weightDecay: HYPER.weightDecay }, data: set.data, threads: 3, capacity: 4096, startPool: inlineHelperPool });
    const net = createNetwork(16, 1, 2);
    let initialVal: number | null = null;
    const full = await new TrainingSession({
      network: net,
      optimizer: null,
      set,
      hyper: HYPER,
      trainer: await make(net, null),
      sliceMs: 50,
      callbacks: { onProgress: (p) => (initialVal ??= p.valLoss) },
    }).run();
    expect(full.finished).toBe(true);
    // Same job on one thread: same losses up to summation order.
    const single = await new TrainingSession({ network: net, optimizer: null, set, hyper: HYPER, sliceMs: 50 }).run();
    expect(full.valLoss as number).toBeLessThan(initialVal as unknown as number);
    expect(Math.abs((full.valLoss as number) - (single.valLoss as number))).toBeLessThan(1e-6);
    expect(maxAbsDiff(full.network, single.network)).toBeLessThan(1e-4);

    let mid: TrainCheckpoint | null = null;
    const first: TrainingSession = new TrainingSession({
      network: net,
      optimizer: null,
      set,
      hyper: HYPER,
      trainer: await make(net, null),
      checkpointEverySteps: 3,
      callbacks: {
        onCheckpoint: (c) => {
          if (!mid && c.epoch === 1 && c.step > 0) {
            mid = c;
            first.stop();
          }
        },
      },
    });
    await first.run();
    const cp = mid as unknown as TrainCheckpoint;
    const resumed = await new TrainingSession({
      network: cp.network,
      optimizer: cp.optimizer,
      set,
      hyper: HYPER,
      trainer: await make(cp.network, cp.optimizer),
      resume: { epoch: cp.epoch, step: cp.step },
    }).run();
    expect(sameBits(resumed.network, full.network)).toBe(true);
  });
});

describe("worker core with threads", () => {
  function runJob(deps: Parameters<typeof createTrainerWorkerHandler>[1], threads: number) {
    return new Promise<{ final: TrainCheckpoint; logs: string[] }>((resolve, reject) => {
      const logs: string[] = [];
      const handle = createTrainerWorkerHandler(
        {
          post: (ev: TrainerEvent) => {
            if (ev.type === "log") logs.push(ev.message);
            if (ev.type === "done") resolve({ final: ev.checkpoint, logs });
            if (ev.type === "error") reject(new Error(ev.error));
          },
        },
        deps,
      );
      handle({
        type: "start",
        job: {
          network: createNetwork(16, 0, 9),
          optimizer: null,
          datasetIds: [],
          hyper: { ...HYPER, threads },
          data: [makeMaterialDataset(3000, 6).buffer],
        },
      });
    });
  }

  it("trains on several threads when supported", async () => {
    const { final, logs } = await runJob({ threadSupport: () => ({ ok: true }), startPool: inlineHelperPool }, 3);
    expect(final.finished).toBe(true);
    expect(logs).toContain("Training on 3 threads.");
    const single = await runJob({}, 1);
    expect(maxAbsDiff(final.network, single.final.network)).toBeLessThan(1e-3);
  });

  it("falls back to one thread when helpers cannot start or threads are unsupported", async () => {
    const failing = await runJob(
      {
        threadSupport: () => ({ ok: true }),
        startPool: () => {
          throw new Error("nested workers unavailable");
        },
      },
      4,
    );
    expect(failing.final.finished).toBe(true);
    expect(failing.logs.join("\n")).toMatch(/could not start helper threads \(nested workers unavailable\); training on 1 thread/);

    const unsupported = await runJob({ threadSupport: () => ({ ok: false, reason: "the page is not cross-origin isolated" }) }, 4);
    expect(unsupported.final.finished).toBe(true);
    expect(unsupported.logs.join("\n")).toMatch(/Training on 1 thread instead of 4: the page is not cross-origin isolated/);
  });
});

describe("thread helpers", () => {
  it("clamps the thread count to the device", () => {
    expect(clampThreads(1)).toBe(1);
    expect(clampThreads(0)).toBe(1);
    expect(clampThreads(NaN)).toBe(1);
    expect(clampThreads(1000)).toBeLessThanOrEqual(32);
    expect(clampThreads(2)).toBeLessThanOrEqual(2);
  });
  it("reports why threads are unavailable in plain Node (no Worker global)", () => {
    const s = threadSupport();
    expect(s.ok).toBe(false);
  });
});
