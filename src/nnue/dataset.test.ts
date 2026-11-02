import { describe, expect, it } from "vitest";
import type { DatasetChunkRecord } from "@/types";
import {
  LoadAbortedError,
  TrainingSetBuilder,
  buildTrainingSet,
  emptyDatasetWarning,
  epochPermutation,
  loadTrainingSet,
  splitTrainValidation,
  type ChunkSource,
} from "./dataset";
import { NNUE_START_FEN } from "./fen";
import { PACKED_SIZE, packPosition, packedScore } from "./pack";
import { makeMaterialDataset } from "./synthetic";

/** n valid records whose score field encodes their index (0..n-1, n ≤ 32000). */
function indexedRecords(n: number, base = 0): Uint8Array {
  const out = new Uint8Array(n * PACKED_SIZE);
  const one = packPosition(NNUE_START_FEN, 0, 1);
  for (let i = 0; i < n; i++) {
    out.set(one, i * PACKED_SIZE);
    const s = base + i;
    out[i * PACKED_SIZE + 24] = s & 255;
    out[i * PACKED_SIZE + 25] = (s >> 8) & 255;
  }
  return out;
}

function chunkRecords(datasetId: string, data: Uint8Array, perChunk: number): DatasetChunkRecord[] {
  const out: DatasetChunkRecord[] = [];
  const n = data.length / PACKED_SIZE;
  for (let i = 0, k = 0; i < n; i += perChunk, k++) {
    const count = Math.min(perChunk, n - i);
    out.push({
      id: `${datasetId}:${String(k).padStart(6, "0")}`,
      datasetId,
      index: k,
      count,
      data: data.slice(i * PACKED_SIZE, (i + count) * PACKED_SIZE).buffer,
    });
  }
  return out;
}

function fakeSource(datasets: Record<string, DatasetChunkRecord[]>, positions?: Record<string, number>): ChunkSource {
  return {
    chunkCount: async (id) => datasets[id]?.length ?? 0,
    iterateChunks: async function* (id) {
      for (const c of datasets[id] ?? []) yield c;
    },
    positions: async (id) => positions?.[id] ?? null,
  };
}

describe("splitTrainValidation", () => {
  it("partitions all positions deterministically with the requested fraction", () => {
    for (const [n, split] of [
      [100_000, 0.05],
      [10_000, 0.1],
      [999, 0.5],
      [150, 0.1],
      [2, 0.5],
    ] as const) {
      const a = splitTrainValidation(n, split, 7);
      const b = splitTrainValidation(n, split, 7);
      expect(a.train).toEqual(b.train);
      expect(a.validation).toEqual(b.validation);
      const all = [...a.train, ...a.validation].sort((x, y) => x - y);
      expect(all).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(a.validation.length).toBeGreaterThanOrEqual(1);
      expect(a.train.length).toBeGreaterThanOrEqual(1);
      const block = Math.max(1, Math.min(512, Math.floor(n / 100)));
      expect(Math.abs(a.validation.length - n * split)).toBeLessThanOrEqual(block);
    }
    expect(splitTrainValidation(10_000, 0.1, 7).validation).not.toEqual(splitTrainValidation(10_000, 0.1, 8).validation);
  });

  it("assigns contiguous blocks (positions of one game stay on one side)", () => {
    const { validation } = splitTrainValidation(100_000, 0.05, 3);
    let runs = 1;
    for (let i = 1; i < validation.length; i++) if (validation[i] !== (validation[i - 1] as number) + 1) runs++;
    expect(validation.length / runs).toBeGreaterThanOrEqual(400);
  });

  it("handles edge cases", () => {
    expect(splitTrainValidation(0, 0.1, 1)).toEqual({ train: new Uint32Array(0), validation: new Uint32Array(0) });
    expect(splitTrainValidation(1, 0.5, 1).train.length).toBe(1);
    const none = splitTrainValidation(500, 0, 1);
    expect(none.validation.length).toBe(0);
    expect(none.train.length).toBe(500);
  });
});

describe("epochPermutation", () => {
  it("is a deterministic per-epoch shuffle of the training indices", () => {
    const train = splitTrainValidation(5000, 0.1, 1).train;
    const p0 = epochPermutation(train, 9, 0);
    expect([...p0].sort((a, b) => a - b)).toEqual([...train]);
    expect(epochPermutation(train, 9, 0)).toEqual(p0);
    expect(epochPermutation(train, 9, 1)).not.toEqual(p0);
    expect(epochPermutation(train, 10, 0)).not.toEqual(p0);
    // Reusing the output buffer gives the same result (only depends on seed + epoch).
    const buf = new Uint32Array(train.length);
    epochPermutation(train, 9, 5, buf);
    expect(epochPermutation(train, 9, 0, buf)).toEqual(p0);
  });
});

describe("TrainingSetBuilder", () => {
  it("keeps everything below the cap", () => {
    const set = buildTrainingSet([indexedRecords(3000), indexedRecords(500, 3000).buffer], { validationSplit: 0.1, seed: 1 });
    expect(set.positions).toBe(3500);
    expect(set.sampled).toBe(false);
    expect(set.warnings).toEqual([]);
    for (let i = 0; i < 3500; i++) expect(packedScore(set.data, i * PACKED_SIZE)).toBe(i);
  });

  it("keeps a deterministic, uniform sample above the cap", () => {
    const make = () => buildTrainingSet([indexedRecords(20_000)], { validationSplit: 0, seed: 4, maxPositions: 2000 });
    const set = make();
    expect(set.positions).toBe(2000);
    expect(set.sourcePositions).toBe(20_000);
    expect(set.sampled).toBe(true);
    expect(set.warnings[0]).toMatch(/uniform random sample of 2,000/);
    expect(make().data).toEqual(set.data);
    const buckets = new Array<number>(10).fill(0);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const s = packedScore(set.data, i * PACKED_SIZE);
      seen.add(s);
      buckets[Math.floor(s / 2000)]!++;
    }
    expect(seen.size).toBe(2000); // no duplicates
    for (const b of buckets) {
      expect(b).toBeGreaterThan(140);
      expect(b).toBeLessThan(260);
    }
  });

  it("respects the memory cap", () => {
    const set = buildTrainingSet([indexedRecords(5000)], { validationSplit: 0.1, seed: 1, maxBytes: 1000 * PACKED_SIZE });
    expect(set.positions).toBe(1000);
    expect(set.sampled).toBe(true);
  });

  it("skips corrupt records with a warning", () => {
    const data = indexedRecords(100);
    data[10 * PACKED_SIZE + 26] = 7; // bad result
    data[20 * PACKED_SIZE + 8] = 0xee; // bad piece codes
    const set = buildTrainingSet([data, new Uint8Array(40)], { validationSplit: 0.1, seed: 1 });
    expect(set.positions).toBe(99); // 98 good + the first 32 bytes of the 40-byte buffer (an all-empty board is valid)
    expect(set.invalidPositions).toBe(2);
    expect(set.warnings.join(" ")).toMatch(/Skipped 2 corrupt/);
    expect(set.warnings.join(" ")).toMatch(/not a multiple of 32/);
  });

  it("grows its buffer across many small additions", () => {
    const b = new TrainingSetBuilder({ maxPositions: 1_000_000, seed: 1, expectedPositions: 10 });
    for (let i = 0; i < 50; i++) b.add(indexedRecords(100, i * 100));
    const set = b.build(0.1, 1);
    expect(set.positions).toBe(5000);
    expect(packedScore(set.data, 4999 * PACKED_SIZE)).toBe(4999);
  });
});

describe("loadTrainingSet", () => {
  it("reads every chunk of every dataset (plus in-memory data) through the chunk source", async () => {
    const a = makeMaterialDataset(5000, 1);
    const b = makeMaterialDataset(1234, 2);
    const source = fakeSource({ a: chunkRecords("a", a, 2048), b: chunkRecords("b", b, 1000) }, { a: 5000 });
    const progress: number[] = [];
    const set = await loadTrainingSet({
      datasetIds: ["a", "b", "a"], // duplicates are ignored
      data: [makeMaterialDataset(100, 3).buffer],
      validationSplit: 0.1,
      seed: 5,
      source,
      onProgress: (p) => progress.push(p.chunksRead),
    });
    expect(set.positions).toBe(5000 + 1234 + 100);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(set.data.subarray(0, a.length)).toEqual(a);
    expect(set.data.subarray(a.length, a.length + b.length)).toEqual(b);
    expect(set.train.length + set.validation.length).toBe(set.positions);
  });

  it("warns about empty datasets and inconsistent chunks", async () => {
    const recs = chunkRecords("a", makeMaterialDataset(300, 1), 100);
    (recs[1] as DatasetChunkRecord).count = 150; // declares more than it holds
    const set = await loadTrainingSet({ datasetIds: ["a", "missing"], validationSplit: 0.1, seed: 1, source: fakeSource({ a: recs }) });
    expect(set.positions).toBe(300);
    // No names known: the messages never show internal dataset ids.
    expect(set.warnings).toContain("One of the selected datasets no longer exists, so it was left out.");
    expect(set.warnings).toContain("Part 2 of a selected dataset declares 150 positions but holds 100; using 100.");
    expect(set.warnings.join("\n")).not.toMatch(/missing|\ba:/);
  });

  it("names datasets in warnings when the source knows their names", async () => {
    const recs = chunkRecords("a", makeMaterialDataset(300, 1), 100);
    (recs[0] as DatasetChunkRecord).count = 99;
    const names: Record<string, string> = { a: "Opening games", empty: "Fresh dataset" };
    const source: ChunkSource = {
      ...fakeSource({ a: recs, empty: [] }, { a: 300, empty: 0 }),
      name: async (id) => names[id] ?? null,
    };
    const set = await loadTrainingSet({ datasetIds: ["a", "empty", "gone"], validationSplit: 0.1, seed: 1, source });
    expect(set.warnings).toContain("The dataset “Fresh dataset” has no positions yet, so it adds nothing to the training data.");
    expect(set.warnings).toContain("One of the selected datasets no longer exists, so it was left out.");
    expect(set.warnings).toContain("Part 1 of the dataset “Opening games” declares 99 positions but holds 100; using 99.");
  });

  it("words the empty-dataset warning for sources that cannot tell missing from empty", () => {
    expect(emptyDatasetWarning(null, null)).toBe("One of the selected datasets has no positions (or no longer exists), so it adds nothing to the training data.");
    expect(emptyDatasetWarning("Mine", false)).toBe("The dataset “Mine” no longer exists, so it was left out.");
  });

  it("can be cancelled between chunks", async () => {
    let calls = 0;
    const source = fakeSource({ a: chunkRecords("a", makeMaterialDataset(1000, 1), 100) });
    await expect(
      loadTrainingSet({ datasetIds: ["a"], validationSplit: 0.1, seed: 1, source, shouldAbort: () => ++calls > 3 }),
    ).rejects.toBeInstanceOf(LoadAbortedError);
  });

  it("samples uniformly across datasets when over the cap", async () => {
    const source = fakeSource({ a: chunkRecords("a", indexedRecords(4000, 0), 1000), b: chunkRecords("b", indexedRecords(4000, 4000), 1000) });
    const set = await loadTrainingSet({ datasetIds: ["a", "b"], validationSplit: 0, seed: 3, maxPositions: 2000, source });
    expect(set.positions).toBe(2000);
    let fromA = 0;
    for (let i = 0; i < 2000; i++) if (packedScore(set.data, i * PACKED_SIZE) < 4000) fromA++;
    expect(fromA).toBeGreaterThan(850);
    expect(fromA).toBeLessThan(1150);
  });
});
