import { describe, expect, it } from "vitest";
import type { FloatNetworkData, OptimizerStateData } from "@/types";
import { buildTrainingSet, type TrainingSet } from "./dataset";
import { createNetwork } from "./init";
import type { TrainCheckpoint, TrainProgress } from "./protocol";
import { TrainingDivergedError, TrainingSession, type TrainingSessionOptions } from "./session";
import { makeMaterialDataset } from "./synthetic";
import type { TrainerHyperParams } from "./trainer";

const HYPER: TrainerHyperParams = {
  epochs: 3,
  batchSize: 256,
  learningRate: 0.003,
  lrSchedule: "cosine",
  warmupSteps: 3,
  evalWeight: 0.75,
  weightDecay: 0.01,
  validationSplit: 0.1,
  threads: 1,
  seed: 42,
};

let cachedSet: TrainingSet | null = null;
function smallSet(): TrainingSet {
  // 6000 positions → 5400 train → 22 steps of 256 per epoch (last one partial).
  cachedSet ??= buildTrainingSet([makeMaterialDataset(6000, 8)], { validationSplit: HYPER.validationSplit, seed: HYPER.seed });
  return cachedSet;
}

function session(over: Partial<TrainingSessionOptions> = {}): TrainingSession {
  return new TrainingSession({
    network: createNetwork(16, 1, 3),
    optimizer: null,
    set: smallSet(),
    hyper: HYPER,
    sliceMs: 5,
    ...over,
  });
}

function expectSameNetwork(a: FloatNetworkData, b: FloatNetworkData): void {
  for (const k of ["w1", "b1", "w2", "b2"] as const) {
    expect(Buffer.compare(Buffer.from(a[k].buffer, a[k].byteOffset, a[k].byteLength), Buffer.from(b[k].buffer, b[k].byteOffset, b[k].byteLength))).toBe(0);
  }
}

function expectSameOptimizer(a: OptimizerStateData, b: OptimizerStateData): void {
  expect(a.step).toBe(b.step);
  expectSameNetwork(a.m, b.m);
  expectSameNetwork(a.v, b.v);
}

describe("TrainingSession", () => {
  it("runs all epochs and reports progress, epochs and checkpoints", async () => {
    const progress: TrainProgress[] = [];
    const checkpoints: TrainCheckpoint[] = [];
    const epochs: number[] = [];
    const logs: string[] = [];
    const s = session({
      checkpointEverySteps: 10,
      progressIntervalMs: 0,
      callbacks: {
        onProgress: (p) => progress.push(p),
        onCheckpoint: (c) => checkpoints.push(c),
        onEpoch: (e) => epochs.push(e.epoch),
        onLog: (m) => logs.push(m),
      },
    });
    expect(s.stepsPerEpoch).toBe(22);
    const final = await s.run();
    expect(final.finished).toBe(true);
    expect([final.epoch, final.step]).toEqual([3, 0]);
    expect(final.positionsSeen).toBe(3 * 5400);
    expect(final.optimizer.step).toBe(3 * 22);
    expect(epochs).toEqual([1, 2, 3]);
    // Mid-epoch checkpoints at global steps 10, 20, 30, 40, 50, 60 plus the epoch ends, plus the final.
    const cursors = checkpoints.map((c) => `${c.epoch}:${c.step}${c.finished ? "F" : ""}`);
    expect(cursors).toEqual(["0:10", "0:20", "1:0", "1:8", "1:18", "2:0", "2:6", "2:16", "3:0F"]);
    expect(checkpoints.at(-1)).toBe(final);
    // Progress: monotone, first report has the initial losses, final report is complete.
    expect(progress[0]?.positionsSeen).toBe(0);
    expect(progress[0]?.valLoss).not.toBeNull();
    for (let i = 1; i < progress.length; i++) {
      expect((progress[i] as TrainProgress).positionsSeen).toBeGreaterThanOrEqual((progress[i - 1] as TrainProgress).positionsSeen);
    }
    const last = progress.at(-1) as TrainProgress;
    expect([last.epoch, last.epochs, last.step, last.stepsPerEpoch]).toEqual([3, 3, 0, 22]);
    expect(Number.isFinite(last.trainLoss)).toBe(true);
    expect(logs.some((l) => l.startsWith("Starting"))).toBe(true);
    // The loss went down.
    expect(final.valLoss as number).toBeLessThan(progress[0]?.valLoss as number);
  });

  it("resuming from a mid-epoch checkpoint continues bit-identically", async () => {
    const full = await session().run();

    let stopAt: TrainCheckpoint | null = null;
    const first: TrainingSession = session({
      checkpointEverySteps: 7,
      callbacks: {
        onCheckpoint: (c) => {
          if (!stopAt && c.epoch === 1 && c.step > 0) {
            stopAt = c;
            first.stop();
          }
        },
      },
    });
    const stopped = await first.run();
    expect(stopAt).not.toBeNull();
    const cp = stopAt as unknown as TrainCheckpoint;
    expect(stopped.finished).toBe(false);
    expect([stopped.epoch, stopped.step]).toEqual([cp.epoch, cp.step]);
    expect([cp.epoch, cp.step]).toEqual([1, 6]); // global step 28 = 22 + 6

    const resumed = await session({ network: cp.network, optimizer: cp.optimizer, resume: { epoch: cp.epoch, step: cp.step } }).run();
    expect(resumed.finished).toBe(true);
    expect(resumed.positionsSeen).toBe(full.positionsSeen);
    expectSameNetwork(resumed.network, full.network);
    expectSameOptimizer(resumed.optimizer, full.optimizer);
    expect(resumed.valLoss).toBe(full.valLoss);
  });

  it("resuming from an epoch-boundary checkpoint continues bit-identically", async () => {
    const full = await session().run();
    let boundary: TrainCheckpoint | null = null;
    await session({
      callbacks: {
        onCheckpoint: (c) => {
          if (c.epoch === 2 && c.step === 0) boundary = c;
        },
      },
    }).run();
    const cp = boundary as unknown as TrainCheckpoint;
    expect(cp.finished).toBe(false);
    const resumed = await session({ network: cp.network, optimizer: cp.optimizer, resume: { epoch: 2, step: 0 } }).run();
    expectSameNetwork(resumed.network, full.network);
    expectSameOptimizer(resumed.optimizer, full.optimizer);
  });

  it("a resume cursor at the end finishes immediately", async () => {
    const s = session({ resume: { epoch: 3, step: 0 } });
    const net = createNetwork(16, 1, 3);
    const final = await s.run();
    expect(final.finished).toBe(true);
    expect(final.optimizer.step).toBe(0);
    expectSameNetwork(final.network, net);
  });

  it("pause holds training until resume; stop while paused returns the latest weights", async () => {
    let s: TrainingSession | null = null;
    let pausedProgress: TrainProgress | null = null;
    let progressAfterPause = 0;
    let paused = false;
    s = session({
      progressIntervalMs: 0,
      callbacks: {
        onProgress: (p) => {
          if (paused) progressAfterPause++;
          if (!paused && p.positionsSeen >= 2000) {
            paused = true;
            pausedProgress = p;
            s?.pause();
          }
        },
      },
    });
    const run = s.run();
    // Let the event loop spin for a while: the cursor must not move while paused.
    for (let i = 0; i < 20 && !pausedProgress; i++) await new Promise((r) => setTimeout(r, 5));
    expect(pausedProgress).not.toBeNull();
    expect(s.isPaused).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const c1 = s.cursor;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.cursor).toEqual(c1);
    expect(progressAfterPause).toBeLessThanOrEqual(1); // the "paused" report itself
    s.stop();
    const final = await run;
    expect(final.finished).toBe(false);
    expect([final.epoch, final.step]).toEqual([c1.epoch, c1.step]);
    expect(final.positionsSeen).toBeGreaterThanOrEqual(2000);
  });

  it("pause then resume completes normally with the same result as an uninterrupted run", async () => {
    const full = await session().run();
    let s: TrainingSession | null = null;
    let pausedOnce = false;
    s = session({
      progressIntervalMs: 0,
      callbacks: {
        onProgress: (p) => {
          if (!pausedOnce && p.positionsSeen > 3000) {
            pausedOnce = true;
            s?.pause();
            setTimeout(() => s?.resume(), 30);
          }
        },
      },
    });
    const final = await s.run();
    expect(pausedOnce).toBe(true);
    expect(final.finished).toBe(true);
    expectSameNetwork(final.network, full.network);
  });

  it("stop() before run() returns the untouched network", async () => {
    const s = session();
    s.stop();
    const final = await s.run();
    expect(final.finished).toBe(false);
    expect([final.epoch, final.step]).toEqual([0, 0]);
    expectSameNetwork(final.network, createNetwork(16, 1, 3));
  });

  it("rejects with TrainingDivergedError for NaN networks", async () => {
    const net = createNetwork(16, 1, 3);
    net.b2[0] = NaN;
    await expect(session({ network: net }).run()).rejects.toBeInstanceOf(TrainingDivergedError);
  });

  it("validates its inputs", () => {
    expect(() => session({ hyper: { ...HYPER, batchSize: 0 } })).toThrow(/batch size/);
    const empty = buildTrainingSet([], { validationSplit: 0.1, seed: 1 });
    expect(() => session({ set: empty })).toThrow(/No training positions/);
    expect(() => session({ optimizer: { step: 0, m: createNetwork(8, 1, 1), v: createNetwork(8, 1, 1) } })).toThrow(/hidden size/);
  });

  it("caps the batch size at the training-set size", () => {
    const s = session({ hyper: { ...HYPER, batchSize: 100_000 } });
    expect(s.batchSize).toBe(5400);
    expect(s.stepsPerEpoch).toBe(1);
  });

  it("can run several sessions from the same checkpoint independently (no shared state)", async () => {
    const a = await session({ hyper: { ...HYPER, epochs: 1 } }).run();
    const b = await session({ hyper: { ...HYPER, epochs: 1 } }).run();
    expectSameNetwork(a.network, b.network);
  });
});
