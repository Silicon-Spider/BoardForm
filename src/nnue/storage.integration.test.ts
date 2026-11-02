// Integration with the real storage package: datasets written through @/storage/repos into
// (fake) IndexedDB are read back by loadTrainingSet's default source and by the worker core,
// exactly as trainer.worker.ts does in the browser.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { DatasetRecord } from "@/types";
import { datasetsRepo } from "@/storage/repos";
import { loadTrainingSet } from "./dataset";
import { createNetwork } from "./init";
import { PACKED_SIZE, POSITIONS_PER_CHUNK } from "./pack";
import type { TrainCheckpoint, TrainerEvent } from "./protocol";
import { makeMaterialDataset } from "./synthetic";
import { createTrainerWorkerHandler } from "./workerCore";

async function storeDataset(id: string, data: Uint8Array): Promise<void> {
  const positions = data.length / PACKED_SIZE;
  const chunks = Math.ceil(positions / POSITIONS_PER_CHUNK);
  const record: DatasetRecord = {
    id,
    name: `Dataset ${id}`,
    description: "integration test",
    createdAt: 1,
    updatedAt: 1,
    positions,
    games: 0,
    chunks,
    source: { kind: "import" },
  };
  await datasetsRepo.put(record);
  for (let k = 0; k < chunks; k++) {
    const from = k * POSITIONS_PER_CHUNK;
    const count = Math.min(POSITIONS_PER_CHUNK, positions - from);
    await datasetsRepo.putChunk({
      id: `${id}:${String(k).padStart(6, "0")}`,
      datasetId: id,
      index: k,
      count,
      data: data.slice(from * PACKED_SIZE, (from + count) * PACKED_SIZE).buffer,
    });
  }
}

describe("training data from IndexedDB (@/storage/repos)", () => {
  it("loadTrainingSet reads every chunk of every dataset in order", async () => {
    const a = makeMaterialDataset(40_000, 5); // 3 chunks: 16384 + 16384 + 7232
    const b = makeMaterialDataset(1_000, 6);
    await storeDataset("ds-a", a);
    await storeDataset("ds-b", b);
    expect(await datasetsRepo.chunkCount("ds-a")).toBe(3);
    const progress: number[] = [];
    const set = await loadTrainingSet({ datasetIds: ["ds-a", "ds-b"], validationSplit: 0.1, seed: 1, onProgress: (p) => progress.push(p.chunksRead) });
    expect(set.positions).toBe(41_000);
    expect(set.data.subarray(0, a.length)).toEqual(a);
    expect(set.data.subarray(a.length)).toEqual(b);
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(set.warnings).toEqual([]);
  });

  it("the worker core trains on datasets it reads from IndexedDB itself", async () => {
    await storeDataset("ds-c", makeMaterialDataset(6_000, 7));
    const logs: string[] = [];
    const final = await new Promise<TrainCheckpoint>((resolve, reject) => {
      const handle = createTrainerWorkerHandler({
        post: (ev: TrainerEvent) => {
          if (ev.type === "log") logs.push(ev.message);
          if (ev.type === "done") resolve(ev.checkpoint);
          if (ev.type === "error") reject(new Error(ev.error));
        },
      });
      handle({
        type: "start",
        job: {
          network: createNetwork(16, 1, 3),
          optimizer: null,
          datasetIds: ["ds-c", "missing-dataset"],
          hyper: { epochs: 2, batchSize: 512, learningRate: 0.003, lrSchedule: "cosine", evalWeight: 0.75, weightDecay: 0.01, validationSplit: 0.1, threads: 1, seed: 4 },
        },
      });
    });
    expect(final.finished).toBe(true);
    expect(final.positionsSeen).toBe(2 * 5_400);
    expect(logs.some((l) => l.startsWith("Loaded 6,000 positions (2 datasets)"))).toBe(true);
    expect(logs).toContain("Warning: One of the selected datasets no longer exists, so it was left out.");
  });
});
