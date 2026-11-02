import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { datasetsRepo } from "@/storage/repos";
import { makeDataset, resetStorage } from "@/storage/test-utils";
import { PACKED_SIZE } from "@/nnue/pack";
import { makeMaterialDataset } from "@/nnue/synthetic";
import { DatasetWriter } from "./dataset-writer";

const OPTS = { chunkPositions: 10, partialFlushMs: 0, recordUpdateMs: 0 };

async function storedBytes(id: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of datasetsRepo.iterateChunks(id)) parts.push(new Uint8Array(c.data, 0, c.count * PACKED_SIZE));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function chunkCounts(id: string): Promise<number[]> {
  const counts: number[] = [];
  for await (const c of datasetsRepo.iterateChunks(id)) counts.push(c.count);
  return counts;
}

describe("DatasetWriter", () => {
  beforeEach(async () => {
    await resetStorage();
    await datasetsRepo.put(makeDataset("ds"));
  });
  afterEach(async () => {
    await resetStorage();
  });

  it("writes full chunks at the boundary and the partial chunk on flush", async () => {
    const data = makeMaterialDataset(27, 1);
    const w = await DatasetWriter.open(datasetsRepo, "ds", OPTS);
    await w.add(data.subarray(0, 7 * PACKED_SIZE), 7); // 7 buffered
    expect(await datasetsRepo.chunkCount("ds")).toBe(0);
    await w.add(data.subarray(7 * PACKED_SIZE, 13 * PACKED_SIZE), 6); // crosses the boundary: chunk 0 full
    expect(await chunkCounts("ds")).toEqual([10]);
    await w.add(data.subarray(13 * PACKED_SIZE), 14); // 13 + 14 = 27 → chunk 1 full, 7 buffered
    expect(await chunkCounts("ds")).toEqual([10, 10]);
    expect(w.positions).toBe(27);
    expect(w.storedPositions).toBe(20);
    await w.close();
    expect(await chunkCounts("ds")).toEqual([10, 10, 7]);
    expect(await storedBytes("ds")).toEqual(data);
    const rec = await datasetsRepo.get("ds");
    expect(rec).toMatchObject({ positions: 27, chunks: 3, games: 3 });
  });

  it("only counts games whose positions are all stored", async () => {
    const data = makeMaterialDataset(14, 2);
    const w = await DatasetWriter.open(datasetsRepo, "ds", { ...OPTS, recordUpdateMs: 0 });
    await w.add(data.subarray(0, 4 * PACKED_SIZE), 4); // game 1: buffered
    await w.add(data.subarray(4 * PACKED_SIZE, 12 * PACKED_SIZE), 8); // game 2 straddles chunk 0
    await w.add(new Uint8Array(0), 0); // game 3: no positions, after game 2
    // Wait for the throttled record update.
    await new Promise((r) => setTimeout(r, 20));
    let rec = await datasetsRepo.get("ds");
    expect(rec).toMatchObject({ positions: 10, chunks: 1, games: 1 });
    await w.flush();
    rec = await datasetsRepo.get("ds");
    expect(rec).toMatchObject({ positions: 12, chunks: 2, games: 3 });
    await w.close();
  });

  it("appends after a flush at the next chunk index and reopens existing datasets", async () => {
    const a = makeMaterialDataset(13, 3);
    const b = makeMaterialDataset(5, 4);
    const w1 = await DatasetWriter.open(datasetsRepo, "ds", OPTS);
    await w1.add(a, 13);
    await w1.flush(); // chunks: 10, 3
    await w1.add(b.subarray(0, 2 * PACKED_SIZE), 2); // new chunk 2, never rewrites chunk 1
    await w1.close();
    expect(await chunkCounts("ds")).toEqual([10, 3, 2]);

    const w2 = await DatasetWriter.open(datasetsRepo, "ds", OPTS);
    expect(w2.positions).toBe(15);
    await w2.add(b.subarray(2 * PACKED_SIZE), 3);
    await w2.close();
    expect(await chunkCounts("ds")).toEqual([10, 3, 2, 3]);
    const expected = new Uint8Array(18 * PACKED_SIZE);
    expected.set(a, 0);
    expected.set(b, 13 * PACKED_SIZE);
    expect(await storedBytes("ds")).toEqual(expected);
    expect(await datasetsRepo.get("ds")).toMatchObject({ positions: 18, chunks: 4, games: 3 });
  });

  it("periodically rewrites the chunk being filled", async () => {
    const data = makeMaterialDataset(6, 5);
    const w = await DatasetWriter.open(datasetsRepo, "ds", { chunkPositions: 10, partialFlushMs: 15, recordUpdateMs: 0 });
    await w.add(data.subarray(0, 3 * PACKED_SIZE), 3);
    await new Promise((r) => setTimeout(r, 60));
    expect(await chunkCounts("ds")).toEqual([3]);
    await w.add(data.subarray(3 * PACKED_SIZE), 3);
    await new Promise((r) => setTimeout(r, 60));
    expect(await chunkCounts("ds")).toEqual([6]); // same chunk index, rewritten
    expect((await datasetsRepo.get("ds"))?.positions).toBe(6);
    await w.close();
    expect(await chunkCounts("ds")).toEqual([6]);
  });

  it("reconciles counts that disagree with the stored chunks", async () => {
    const data = makeMaterialDataset(4, 6);
    await datasetsRepo.putChunk({ id: "x", datasetId: "ds", index: 0, count: 4, data: data.slice().buffer });
    // The record still says 0 (as if the tab closed before the record update).
    const w = await DatasetWriter.open(datasetsRepo, "ds", OPTS);
    expect(await datasetsRepo.get("ds")).toMatchObject({ positions: 4, chunks: 1 });
    expect(w.positions).toBe(4);
    await w.add(data, 4);
    await w.close();
    expect(await chunkCounts("ds")).toEqual([4, 4]);
  });

  it("rejects opening a dataset that does not exist", async () => {
    await expect(DatasetWriter.open(datasetsRepo, "missing", OPTS)).rejects.toThrow(/no longer exists/);
  });
});
