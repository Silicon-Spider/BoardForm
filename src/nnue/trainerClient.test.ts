import { describe, expect, it } from "vitest";
import type { DatasetChunkRecord } from "@/types";
import type { ChunkSource } from "./dataset";
import { createNetwork } from "./init";
import { PACKED_SIZE } from "./pack";
import type { TrainCheckpoint, TrainJob, TrainProgress, TrainerRequest } from "./protocol";
import { makeMaterialDataset } from "./synthetic";
import type { TrainerHyperParams } from "./trainer";
import { TrainerClient, type TrainerWorkerLike } from "./trainerClient";
import { createTrainerWorkerHandler, type TrainerWorkerDeps } from "./workerCore";

/** In-process stand-in for `new Worker(...)`: structured-clones every message both ways. */
class FakeWorker implements TrainerWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = false;
  readonly received: TrainerRequest[] = [];
  private readonly handle: (msg: TrainerRequest) => void;

  constructor(deps: TrainerWorkerDeps = {}) {
    this.handle = createTrainerWorkerHandler(
      {
        post: (event, transfer) => {
          if (this.terminated) return;
          const copy = structuredClone(event, { transfer });
          setTimeout(() => {
            if (!this.terminated) this.onmessage?.({ data: copy } as MessageEvent);
          }, 0);
        },
      },
      { ...deps, sessionOptions: { sliceMs: 2, progressIntervalMs: 0, ...deps.sessionOptions } },
    );
  }

  postMessage(message: TrainerRequest): void {
    const copy = structuredClone(message);
    this.received.push(copy);
    setTimeout(() => {
      if (!this.terminated) this.handle(copy);
    }, 0);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.handle({ type: "stop" }); // end the in-process loop, like killing the thread
  }
}

const HYPER: TrainerHyperParams = {
  epochs: 2,
  batchSize: 256,
  learningRate: 0.003,
  lrSchedule: "constant",
  evalWeight: 0.75,
  weightDecay: 0.01,
  validationSplit: 0.1,
  threads: 1,
  seed: 3,
};

function job(over: Partial<TrainJob> = {}): TrainJob {
  return {
    network: createNetwork(16, 1, 1),
    optimizer: null,
    datasetIds: [],
    hyper: HYPER,
    data: [makeMaterialDataset(4000, 2).buffer],
    checkpointEverySteps: 5,
    ...over,
  };
}

function clientWith(deps: TrainerWorkerDeps = {}): { client: TrainerClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new TrainerClient(() => {
    const w = new FakeWorker(deps);
    workers.push(w);
    return w;
  });
  return { client, workers };
}

describe("TrainerClient + worker core", () => {
  it("runs a job to completion and delivers every event", async () => {
    const { client, workers } = clientWith();
    const progress: TrainProgress[] = [];
    const checkpoints: TrainCheckpoint[] = [];
    const epochs: number[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const promise = client.start(job(), {
      onProgress: (p) => progress.push(p),
      onCheckpoint: (c) => checkpoints.push(c),
      onEpoch: (e) => epochs.push(e.epoch),
      onLog: (m) => logs.push(m),
      onError: (e) => errors.push(e),
    });
    expect(client.running).toBe(true);
    const final = await promise;
    expect(final.finished).toBe(true);
    expect(final.epoch).toBe(2);
    expect(final.network.w1).toBeInstanceOf(Float32Array);
    expect(final.network.w1.length).toBe(768 * 16);
    expect(final.optimizer.step).toBe(2 * 15); // 3600 train positions / 256 → 15 steps per epoch
    expect(epochs).toEqual([1, 2]);
    expect(checkpoints.at(-1)).toEqual(final);
    expect(checkpoints.filter((c) => c.finished).length).toBe(1);
    expect(checkpoints.length).toBeGreaterThan(4);
    expect(progress.length).toBeGreaterThan(5);
    expect(logs.some((l) => l.startsWith("Loaded 4,000 positions"))).toBe(true);
    expect(errors).toEqual([]);
    expect(client.running).toBe(false);
    expect(workers[0]?.terminated).toBe(true); // released after the job
  });

  it("stop() resolves with the latest weights (finished = false)", async () => {
    const { client } = clientWith();
    let stopped = false;
    const final = await client.start(job({ hyper: { ...HYPER, epochs: 50 } }), {
      onProgress: (p) => {
        if (!stopped && p.positionsSeen > 1000) {
          stopped = true;
          client.stop();
        }
      },
    });
    expect(final.finished).toBe(false);
    expect(final.positionsSeen).toBeGreaterThan(1000);
    expect(final.epoch).toBeLessThan(50);
    expect(final.optimizer.step).toBeGreaterThan(0);
  });

  it("pause() and resume() hold and continue the job", async () => {
    const { client, workers } = clientWith();
    let pausedAt = -1;
    let pausedReport = -1; // index of the report the worker sends when the pause takes effect
    let resumeIndex = -1;
    let reports = 0;
    let stillPausedAtResume = false;
    const final = await client.start(job(), {
      onProgress: (p) => {
        reports++;
        if (pausedAt < 0 && p.positionsSeen > 500) {
          pausedAt = p.positionsSeen;
          client.pause(); // reports already in flight may still arrive
        } else if (pausedAt >= 0 && pausedReport < 0 && p.posPerSec === 0) {
          pausedReport = reports;
          setTimeout(() => {
            stillPausedAtResume = client.paused;
            resumeIndex = reports;
            client.resume();
          }, 80);
        }
      },
    });
    expect(final.finished).toBe(true);
    expect(pausedAt).toBeGreaterThan(0);
    expect(pausedReport).toBeGreaterThan(0);
    expect(stillPausedAtResume).toBe(true);
    // Nothing was reported between the "paused" report and resume() …
    expect(resumeIndex).toBe(pausedReport);
    // … and training continued afterwards.
    expect(reports).toBeGreaterThan(resumeIndex);
    const types = workers[0]?.received.map((m) => m.type);
    expect(types).toEqual(["start", "pause", "resume"]);
  });

  it("reports invalid jobs through onError and rejects", async () => {
    const { client, workers } = clientWith();
    const errors: string[] = [];
    await expect(client.start(job({ hyper: { ...HYPER, learningRate: -1 } }), { onError: (e) => errors.push(e) })).rejects.toThrow(
      /learning rate/,
    );
    expect(errors[0]).toMatch(/learning rate/);
    expect(client.running).toBe(false);
    expect(workers[0]?.terminated).toBe(true);
    await expect(client.start(job({ data: [], datasetIds: [] }))).rejects.toThrow(/Nothing to train on/);
    const bad = createNetwork(16, 1, 1);
    await expect(client.start(job({ network: { ...bad, w2: new Float32Array(3) } }))).rejects.toThrow(/w2/);
  });

  it("terminate() rejects start() with an AbortError", async () => {
    const { client, workers } = clientWith();
    const p = client.start(job({ hyper: { ...HYPER, epochs: 100 } }));
    setTimeout(() => client.terminate(), 30);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(client.running).toBe(false);
    expect(workers[0]?.terminated).toBe(true);
  });

  it("refuses a second concurrent job and can run another afterwards", async () => {
    const { client } = clientWith();
    const first = client.start(job({ hyper: { ...HYPER, epochs: 1 } }));
    await expect(client.start(job())).rejects.toThrow(/already running/);
    await first;
    const second = await client.start(job({ hyper: { ...HYPER, epochs: 1 } }));
    expect(second.finished).toBe(true);
  });

  it("surfaces worker load errors", async () => {
    const client = new TrainerClient(() => {
      const w: TrainerWorkerLike = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage: () => {
          setTimeout(() => w.onerror?.({ message: "Failed to fetch module", preventDefault() {} } as unknown as ErrorEvent), 0);
        },
        terminate: () => {},
      };
      return w;
    });
    await expect(client.start(job())).rejects.toThrow(/Failed to fetch module/);
  });

  it("loads datasets through the chunk source, resumes from a checkpoint", async () => {
    const data = makeMaterialDataset(3000, 9);
    const chunks: DatasetChunkRecord[] = [0, 1, 2].map((k) => ({
      id: `ds:${String(k).padStart(6, "0")}`,
      datasetId: "ds",
      index: k,
      count: 1000,
      data: data.slice(k * 1000 * PACKED_SIZE, (k + 1) * 1000 * PACKED_SIZE).buffer,
    }));
    const source: ChunkSource = {
      chunkCount: async () => 3,
      iterateChunks: async function* () {
        yield* chunks;
      },
    };
    const { client } = clientWith({ source });
    const base = { datasetIds: ["ds"], data: undefined, checkpointEverySteps: 4 };
    const full = await client.start(job(base));

    let mid: TrainCheckpoint | null = null;
    const partial = await client.start(job(base), {
      onCheckpoint: (c) => {
        if (!mid && !c.finished) {
          mid = c;
          client.stop();
        }
      },
    });
    expect(partial.finished).toBe(false);
    const cp = mid as unknown as TrainCheckpoint;
    const resumed = await client.start(job({ ...base, network: cp.network, optimizer: cp.optimizer, resume: { epoch: cp.epoch, step: cp.step } }));
    expect(resumed.finished).toBe(true);
    expect(Array.from(resumed.network.w1)).toEqual(Array.from(full.network.w1));
    expect(Array.from(resumed.network.w2)).toEqual(Array.from(full.network.w2));
  });

  it("stop() while the data is still loading returns the untouched network", async () => {
    const data = makeMaterialDataset(1000, 1);
    const slow: ChunkSource = {
      chunkCount: async () => 50,
      iterateChunks: async function* () {
        for (let k = 0; k < 50; k++) {
          await new Promise((r) => setTimeout(r, 10));
          yield { id: `s:${k}`, datasetId: "s", index: k, count: 1000, data: data.slice().buffer };
        }
      },
    };
    const { client } = clientWith({ source: slow });
    const net = createNetwork(16, 1, 77);
    const p = client.start(job({ network: net, datasetIds: ["s"], data: undefined }));
    setTimeout(() => client.stop(), 40);
    const final = await p;
    expect(final.finished).toBe(false);
    expect(final.positionsSeen).toBe(0);
    expect(Number.isNaN(final.trainLoss)).toBe(true);
    expect(Array.from(final.network.w1)).toEqual(Array.from(net.w1));
  });
});
