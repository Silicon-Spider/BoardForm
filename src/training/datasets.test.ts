import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SelfPlayConfig } from "@/types";
import { datasetsRepo, enginesRepo } from "@/storage/repos";
import { resetStorage } from "@/storage/test-utils";
import { PACKED_SIZE, packPosition, packedToFen } from "@/nnue/pack";
import { makeMaterialDataset } from "@/nnue/synthetic";
import { CBDS_HEADER_SIZE, cbdsHeader, parseTextLine } from "./dataset-files";
import { getDatasetJob } from "./live";
import { createLabService } from "./service";
import { FakeLocks, FakeSelfPlaySource, testDeps, testEngine, until } from "./test-helpers";

async function allPositions(id: string): Promise<Uint8Array> {
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

function cbdsFile(data: Uint8Array<ArrayBuffer>, name = "data.cbds"): File {
  return new File([cbdsHeader(data.length / PACKED_SIZE), data], name);
}

const SELFPLAY: SelfPlayConfig = { engineId: "e1", limits: { nodes: 1000 }, randomPlies: 8, games: 7, concurrency: 2, maxPlies: 300, skipPlies: 8 };

describe("dataset files and the dataset service", () => {
  beforeEach(async () => {
    await resetStorage();
    await enginesRepo.put(testEngine("e1", { name: "Classic" }));
  });
  afterEach(async () => {
    await resetStorage();
  });

  it(".cbds export → import round trip keeps every position", async () => {
    const lab = createLabService(testDeps());
    const data = makeMaterialDataset(250, 11);
    const id = await lab.datasets.importFile(cbdsFile(data, "material.cbds"));
    const rec = await datasetsRepo.get(id);
    expect(rec).toMatchObject({ name: "material", positions: 250, chunks: 3, games: 0, source: { kind: "import" } });
    expect(await allPositions(id)).toEqual(data);

    const blob = await lab.datasets.exportFile(id);
    expect(blob.size).toBe(CBDS_HEADER_SIZE + 250 * PACKED_SIZE);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("CBDS");
    expect(new DataView(bytes.buffer).getUint32(8, true)).toBe(250);
    expect(bytes.subarray(CBDS_HEADER_SIZE)).toEqual(data);

    const again = await lab.datasets.importFile(new File([blob], "copy.cbds"), { name: "Copy" });
    expect((await datasetsRepo.get(again))?.name).toBe("Copy");
    expect(await allPositions(again)).toEqual(data);
  });

  it("rejects damaged .cbds files and skips invalid positions", async () => {
    const deps = testDeps();
    const lab = createLabService(deps);
    const data = makeMaterialDataset(10, 12);
    const short = new File([cbdsHeader(11), data], "short.cbds");
    await expect(lab.datasets.importFile(short)).rejects.toThrow(/damaged.*11 positions/);
    const header = new Uint8Array(cbdsHeader(10));
    new DataView(header.buffer).setUint32(4, 2, true);
    await expect(lab.datasets.importFile(new File([header, data], "v2.cbds"))).rejects.toThrow(/version 2/);
    expect(await datasetsRepo.list()).toEqual([]); // nothing left behind

    const corrupt = data.slice();
    corrupt[3 * PACKED_SIZE + 26] = 7; // invalid result byte
    const id = await lab.datasets.importFile(cbdsFile(corrupt));
    expect((await datasetsRepo.get(id))?.positions).toBe(9);
    expect(deps.notify.toasts.at(-1)).toMatchObject({ kind: "warn" });
    expect(deps.notify.toasts.at(-1)?.detail).toMatch(/Skipped 1 invalid position \(position 4: invalid result 7\)/);
  });

  it("imports the text format and reports malformed lines", async () => {
    const deps = testDeps();
    const lab = createLabService(deps);
    const text = [
      "# exported by some tool",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1 | 35 | 0.5",
      "",
      "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1 | 950 | 1.0",
      "4k3/8/8/8/8/8/4q3/4K3 w - - 0 1 | -940.6 | 0.0",
      "not a fen | 10 | 0.5",
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1 | abc | 0.5",
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1 | 0 | 2",
      "only two | fields",
    ].join("\r\n");
    const id = await lab.datasets.importFile(new File([text], "positions.txt"));
    const rec = await datasetsRepo.get(id);
    expect(rec?.positions).toBe(3);
    expect(rec?.description).toMatch(/Skipped 4 invalid lines/);
    const bytes = await allPositions(id);
    const expected = new Uint8Array(3 * PACKED_SIZE);
    packPosition("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", 35, 1, expected, 0);
    packPosition("4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1", 950, 2, expected, PACKED_SIZE);
    packPosition("4k3/8/8/8/8/8/4q3/4K3 w - - 0 1", -941, 0, expected, 2 * PACKED_SIZE);
    expect(bytes).toEqual(expected);
    expect(deps.notify.toasts.at(-1)?.detail).toMatch(/line 6: invalid FEN/);

    await expect(lab.datasets.importFile(new File(["hello\nworld\n"], "junk.txt"))).rejects.toThrow(/No positions found.*line 1/);
    expect((await datasetsRepo.list()).length).toBe(1);
  });

  it("parseTextLine accepts the usual result spellings", () => {
    const out = new Uint8Array(PACKED_SIZE);
    for (const [r, code] of [["1.0", 2], ["1", 2], ["0.5", 1], ["1/2-1/2", 1], ["0.0", 0], ["0-1", 0], ["1-0", 2]] as const) {
      expect(parseTextLine(`8/8/8/8/8/8/8/K6k w - - 0 1 | 12 | ${r}`, out, 0)).toBeNull();
      expect(out[26]).toBe(code);
    }
    expect(parseTextLine("8/8/8/8/8/8/8/K6k w - - 0 1 | 12 | 0.7", out, 0)).toMatch(/invalid result/);
  });

  it("merges datasets and samples positions", async () => {
    const lab = createLabService(testDeps());
    const a = makeMaterialDataset(150, 1);
    const b = makeMaterialDataset(70, 2);
    const ia = await lab.datasets.importFile(cbdsFile(a), { name: "A" });
    const ib = await lab.datasets.importFile(cbdsFile(b), { name: "B" });
    await datasetsRepo.update(ia, { games: 3 });
    await datasetsRepo.update(ib, { games: 2 });
    const m = await lab.datasets.merge([ia, ib], "A+B");
    const rec = await datasetsRepo.get(m);
    expect(rec).toMatchObject({ name: "A+B", positions: 220, games: 5, chunks: 3, source: { kind: "merge" } });
    const expected = new Uint8Array(220 * PACKED_SIZE);
    expected.set(a, 0);
    expected.set(b, 150 * PACKED_SIZE);
    expect(await allPositions(m)).toEqual(expected);
    await expect(lab.datasets.merge([ia, "missing"], "x")).rejects.toThrow(/no longer exists/);
    await expect(lab.datasets.merge([ia], "  ")).rejects.toThrow(/name/);

    const samples = await lab.datasets.samplePositions(m, 25);
    expect(samples).toHaveLength(25);
    const fens = new Set(Array.from({ length: 220 }, (_, i) => packedToFen(expected, i * PACKED_SIZE)));
    for (const s of samples) {
      expect(fens.has(s.fen)).toBe(true);
      expect([0, 1, 2]).toContain(s.result);
      expect(Number.isInteger(s.scoreWhite)).toBe(true);
    }
    expect(await lab.datasets.samplePositions(m, 0)).toEqual([]);
    // Chunks hold 100, 100 and 20 positions: whichever chunks are picked, the count is honoured.
    for (let i = 0; i < 12; i++) expect(await lab.datasets.samplePositions(m, 30)).toHaveLength(30);
    expect(await lab.datasets.samplePositions(m, 500)).toHaveLength(220);
  });

  it("generates a dataset in the background and appends to it", async () => {
    const source = new FakeSelfPlaySource({ positionsPerGame: 30 });
    const deps = testDeps({ selfPlay: source });
    const lab = createLabService(deps);
    const id = await lab.datasets.generate({ name: "Classic games", selfPlay: SELFPLAY });
    expect(lab.datasets.isGenerating(id)).toBe(true);
    expect(deps.notify.activities.get(`dataset:${id}`)?.href).toBe(`/lab/datasets/${id}`);
    await until(() => !lab.datasets.isGenerating(id), 10_000, "generation");
    const rec = await datasetsRepo.get(id);
    expect(rec).toMatchObject({ positions: 210, games: 7, chunks: 3, source: { kind: "selfplay", engineId: "e1", engineName: "Classic", randomPlies: 8 } });
    expect(getDatasetJob(id)).toMatchObject({ status: "finished", progress: { gamesDone: 7, gamesTotal: 7, positions: 210 } });
    expect(deps.notify.activities.has(`dataset:${id}`)).toBe(false);
    expect(deps.notify.toasts.at(-1)).toMatchObject({ kind: "success", message: "Dataset “Classic games” is ready" });
    expect(source.selfPlayJobs[0]).toMatchObject({ games: 7, concurrency: 2, firstGameIndex: 0, engineName: "Classic" });
    expect(source.selfPlayJobs[0]?.settings.limits).toEqual({ nodes: 1000 });

    await lab.datasets.generate({ name: "", appendTo: id, selfPlay: { ...SELFPLAY, games: 2 } });
    await until(() => !lab.datasets.isGenerating(id), 10_000, "append");
    expect(await datasetsRepo.get(id)).toMatchObject({ positions: 270, games: 9, chunks: 4 });
    expect(source.selfPlayJobs[1]?.firstGameIndex).toBe(7); // openings continue, never repeat
  });

  it("stop() keeps what was generated; remove() refuses while generating", async () => {
    const source = new FakeSelfPlaySource({ positionsPerGame: 10, gameDelayMs: 20 });
    const deps = testDeps({ selfPlay: source });
    const lab = createLabService(deps);
    const id = await lab.datasets.generate({ name: "Endless", selfPlay: { ...SELFPLAY, games: 1000 } });
    const activity = () => deps.notify.activities.get(`dataset:${id}`);
    expect(activity()).toMatchObject({ detail: "Preparing the engine…", href: `/lab/datasets/${id}` });
    await until(async () => ((await datasetsRepo.get(id))?.games ?? 0) >= 2, 10_000, "a few games");
    await expect(lab.datasets.remove(id)).rejects.toThrow(/still being generated/);
    // The header activity is refreshed every second and switches to the game count once playing.
    await until(() => /^\d+\/1000 games · /.test(activity()?.detail ?? ""), 5_000, "activity with the game count");
    await lab.datasets.stop(id);
    expect(activity()).toBeUndefined();
    expect(lab.datasets.isGenerating(id)).toBe(false);
    expect(getDatasetJob(id)?.status).toBe("stopped");
    const rec = await datasetsRepo.get(id);
    expect(rec?.games).toBeGreaterThanOrEqual(2);
    expect(rec?.positions).toBe((rec?.games ?? 0) * 10);
    await lab.datasets.remove(id);
    expect(await datasetsRepo.get(id)).toBeUndefined();
    expect(await datasetsRepo.chunkCount(id)).toBe(0);
  });

  it("only one tab writes to a dataset at a time", async () => {
    const locks = new FakeLocks();
    const tabA = createLabService(testDeps({ locks, selfPlay: new FakeSelfPlaySource({ positionsPerGame: 5, gameDelayMs: 20 }) }));
    const tabB = createLabService(testDeps({ locks }));
    const id = await tabA.datasets.generate({ name: "Shared", selfPlay: { ...SELFPLAY, games: 1000 } });
    await expect(tabB.datasets.generate({ name: "", appendTo: id, selfPlay: SELFPLAY })).rejects.toThrow(/being generated in another tab/);
    await expect(tabB.datasets.remove(id)).rejects.toThrow(/being generated in another tab/);
    await tabA.datasets.stop(id);
    await tabB.datasets.remove(id); // released once the job ended
    expect(locks.held.size).toBe(0);
  });

  it("reports generation failures and validates the options", async () => {
    const source = new FakeSelfPlaySource({ positionsPerGame: 10, failAfterGames: { games: 3, message: "engine crashed" } });
    const deps = testDeps({ selfPlay: source });
    const lab = createLabService(deps);
    await expect(lab.datasets.generate({ name: "x", selfPlay: { ...SELFPLAY, engineId: "nope" } })).rejects.toThrow(/no longer exists/);
    await expect(lab.datasets.generate({ name: "x", selfPlay: { ...SELFPLAY, games: 0 } })).rejects.toThrow(/at least 1 game/);
    await expect(lab.datasets.generate({ name: "x", selfPlay: { ...SELFPLAY, engineId: "$network" } })).rejects.toThrow(/network/);
    const id = await lab.datasets.generate({ name: "Fails", selfPlay: { ...SELFPLAY, games: 10 } });
    await until(() => !lab.datasets.isGenerating(id), 10_000, "failure");
    expect(getDatasetJob(id)).toMatchObject({ status: "error", error: "engine crashed" });
    expect(await datasetsRepo.get(id)).toMatchObject({ games: 3, positions: 30 }); // kept
    expect(deps.notify.toasts.at(-1)).toMatchObject({ kind: "error", detail: "engine crashed" });
  });
});
