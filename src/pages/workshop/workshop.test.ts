// Unit tests for the Workshop's pure logic: test positions and the perft reference table, record
// builders (duplicate / convert / save patches), file-tree helpers, formatting and the autosave
// draft store.
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChessGame, START_FEN, validateFen } from "@/chess";
import { DEFAULT_WORKSPACE, GENERATOR_VERSION, generateEvalSource } from "@/blocks";
import { assembleSources, sourceHashOf } from "@/engine-host/build";
import { TEMPLATE_VERSION, defaultFilesFor, templateFiles } from "@/engine-host/templates";
import type { EngineRecord } from "@/types";
import { EngineDraft } from "./draft";
import { closeTab, newFileContents, openTab, pruneTabs, renameInFiles, renameTab, sortPaths, withExtension, withoutFile } from "./files";
import { groupDigits, numberedLine, signedInt, whitePovScore } from "./format";
import { BENCH_POSITIONS, PERFT_SUITE, PRESET_POSITIONS, expectedPerft, perftSuiteNodes } from "./positions";
import { blocksPatch, blocksToCodeRecord, conversionFor, convertedEvalSource, duplicateRecord, filePatch, parseTags, uniqueName, unlockFullRecord } from "./records";

function engine(overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    id: "e1",
    name: "Classic",
    description: "desc",
    kind: "eval",
    createdAt: 100,
    updatedAt: 100,
    color: "#5b9cf5",
    options: { hashMb: 16 },
    files: { "eval.ts": "// eval" },
    entry: "main.ts",
    templateVersion: 1,
    networkId: null,
    parentId: null,
    builtin: true,
    tags: ["starter", "mine"],
    build: null,
    ...overrides,
  };
}

let ids = 0;
const deps = { newId: () => `new-${++ids}`, now: () => 5_000 };

// ---------------------------------------------------------------------------------------------

describe("test positions", () => {
  it("every preset, perft and bench FEN is valid", () => {
    for (const p of [...PRESET_POSITIONS, ...PERFT_SUITE, ...BENCH_POSITIONS]) {
      expect(validateFen(p.fen), p.fen).toEqual({ ok: true });
    }
  });

  it("the perft table matches chess.js up to depth 3 (depth 4 for the small trees)", () => {
    for (const c of PERFT_SUITE) {
      const chess = new Chess(c.fen);
      const maxDepth = c.counts[3] !== undefined && c.counts[3] < 500_000 ? 4 : 3;
      for (let d = 1; d <= maxDepth; d++) expect(chess.perft(d), `${c.name} depth ${d}`).toBe(c.counts[d - 1]);
    }
  });

  it("includes the position-6 numbers from the task", () => {
    const pos6 = PERFT_SUITE.find((c) => c.id === "pos6")!;
    expect(pos6.fen).toBe("r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10");
    expect(pos6.counts.slice(0, 4)).toEqual([46, 2079, 89890, 3894594]);
    expect(PERFT_SUITE).toHaveLength(6);
    expect(PERFT_SUITE[0].fen).toBe(START_FEN);
    expect(expectedPerft(PERFT_SUITE[0], 4)).toBe(197281);
    expect(expectedPerft(PERFT_SUITE[0], 9)).toBeNull();
    expect(perftSuiteNodes(1)).toBe(20 + 48 + 14 + 6 + 44 + 46);
  });

  it("the mate-in-2 preset is a mate in two and not in one", () => {
    const fen = PRESET_POSITIONS.find((p) => p.id === "mate2")!.fen;
    const isMate = (g: ChessGame) => g.outcome()?.termination === "checkmate";
    const mateInOne = (g: ChessGame) =>
      g.legalMoves().some((m) => {
        const c = g.clone();
        c.play(m);
        return isMate(c);
      });
    const root = new ChessGame(fen);
    expect(mateInOne(root)).toBe(false);
    const winning = root.legalMoves().filter((m) => {
      const after = root.clone();
      after.play(m);
      const replies = after.legalMoves();
      if (replies.length === 0) return false;
      return replies.every((r) => {
        const c = after.clone();
        c.play(r);
        return mateInOne(c);
      });
    });
    expect(winning).toEqual(["c4g8"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("record builders", () => {
  it("builds complete save patches", () => {
    const e = engine({ files: { "eval.ts": "old", "extra.ts": "x" } });
    const ws = { blocks: { blocks: [] } };
    expect(blocksPatch(e, ws, "new code", 2)).toEqual({ blocks: ws, files: { "eval.ts": "new code", "extra.ts": "x" }, generatorVersion: 2 });
    expect(filePatch(e, "extra.ts", "y")).toEqual({ files: { "eval.ts": "old", "extra.ts": "y" } });
    expect(filePatch(engine({ files: undefined }), "main.ts", "z")).toEqual({ files: { "main.ts": "z" } });
    // The source record is never mutated.
    expect(e.files).toEqual({ "eval.ts": "old", "extra.ts": "x" });
  });

  it("names copies uniquely", () => {
    expect(uniqueName("A (copy)", ["A"])).toBe("A (copy)");
    expect(uniqueName("A (copy)", ["a (COPY)"])).toBe("A (copy) (2)");
    expect(uniqueName("A (copy)", ["A (copy)", "A (copy) (2)"])).toBe("A (copy) (3)");
  });

  it("duplicates an engine as an independent user engine", () => {
    const src = engine({ kind: "blocks", blocks: { a: [1, 2] }, networkId: "n1" });
    const copy = duplicateRecord(src, deps, ["Classic"]);
    expect(copy).toMatchObject({ name: "Classic (copy)", kind: "blocks", parentId: "e1", builtin: false, tags: ["mine"], networkId: "n1", createdAt: 5000, updatedAt: 5000 });
    expect(copy.id).not.toBe(src.id);
    expect(copy.files).toEqual(src.files);
    expect(copy.files).not.toBe(src.files);
    expect(copy.blocks).toEqual(src.blocks);
    expect(copy.blocks).not.toBe(src.blocks);
    expect(copy.options).not.toBe(src.options);
  });

  it("offers the right conversion per kind", () => {
    expect(conversionFor("blocks")).toBe("to-code");
    expect(conversionFor("eval")).toBe("unlock-full");
    expect(conversionFor("nnue")).toBe("unlock-full");
    expect(conversionFor("full")).toBeNull();
    expect(conversionFor("scratch")).toBeNull();
    expect(conversionFor("wasm")).toBeNull();
  });

  it("converts blocks to an eval engine with the same assembled sources", async () => {
    const code = generateEvalSource(DEFAULT_WORKSPACE).code;
    const src = engine({ kind: "blocks", name: "Blocky", blocks: structuredClone(DEFAULT_WORKSPACE), files: { "eval.ts": code }, generatorVersion: GENERATOR_VERSION });
    const out = blocksToCodeRecord(src, code, deps, TEMPLATE_VERSION, ["Blocky"]);
    expect(out).toMatchObject({ kind: "eval", name: "Blocky (code)", files: { "eval.ts": code }, entry: "main.ts", parentId: "e1", builtin: false, tags: ["mine"] });
    expect(out.blocks).toBeUndefined();
    const [a, b] = [assembleSources(src), assembleSources(out)];
    expect(b).toEqual(a);
    expect(await sourceHashOf(b)).toBe(await sourceHashOf(a));
  });

  it("rewrites the generator's do-not-edit header of converted code", () => {
    const NL = String.fromCharCode(10);
    const code = generateEvalSource(DEFAULT_WORKSPACE).code;
    expect(code.split(NL)[0]).toMatch(/generated by Chess Builder/);
    const out = convertedEvalSource(code, "Blocky");
    expect(out.split(NL)[0]).toBe("// eval.ts — converted from the blocks of “Blocky”. This is ordinary AssemblyScript now:");
    expect(out).not.toMatch(/Don't edit this file by hand/);
    // Everything after the header is untouched.
    expect(out.split(NL).slice(2).join(NL)).toBe(code.split(NL).slice(2).join(NL));
    expect(convertedEvalSource(`// my own code${NL}`, "X")).toBe(`// my own code${NL}`);
  });

  it("unlocks the full source of eval and nnue engines, keeping the network", async () => {
    const nnue = engine({ kind: "nnue", name: "Net", files: defaultFilesFor("nnue"), networkId: "net-7" });
    const full = unlockFullRecord(nnue, templateFiles, deps, TEMPLATE_VERSION);
    expect(full).toMatchObject({ kind: "full", name: "Net (full)", networkId: "net-7", entry: "main.ts", parentId: "e1" });
    expect(Object.keys(full.files!).sort()).toEqual(Object.keys(templateFiles).sort());
    expect(full.files!["eval.ts"]).toBe(nnue.files!["eval.ts"]);
    expect(full.files!["search.ts"]).toBe(templateFiles["search.ts"]);
    expect(await sourceHashOf(assembleSources(full))).toBe(await sourceHashOf(assembleSources(nnue)));
  });

  it("parses tags", () => {
    expect(parseTags(" fast, Fast ,  slow  engine,,")).toEqual(["fast", "slow engine"]);
    expect(parseTags("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("file helpers", () => {
  it("adds the .ts extension like the file tree and starts new files with a hint", () => {
    expect(withExtension("helpers")).toBe("helpers.ts");
    expect(withExtension("lib/pawns")).toBe("lib/pawns.ts");
    expect(withExtension("notes.txt")).toBe("notes.txt");
    expect(withExtension("lib/")).toBe("lib/");
    expect(newFileContents("lib/pawns.ts")).toContain('from "./pawns"');
  });

  it("renames and deletes files", () => {
    const files = { "main.ts": "m", "eval.ts": "e" };
    expect(renameInFiles(files, "eval.ts", "score.ts")).toEqual({ "main.ts": "m", "score.ts": "e" });
    expect(Object.keys(renameInFiles(files, "main.ts", "entry.ts"))).toEqual(["entry.ts", "eval.ts"]);
    expect(withoutFile(files, "eval.ts")).toEqual({ "main.ts": "m" });
    expect(sortPaths(["z.ts", "main.ts", "lib/a.ts", "a.ts"], "main.ts")).toEqual(["main.ts", "lib/a.ts", "a.ts", "z.ts"]);
  });

  it("manages open tabs", () => {
    expect(openTab(["a"], "b")).toEqual(["a", "b"]);
    expect(openTab(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], active: "c" });
    expect(closeTab(["a", "b", "c"], "c", "c")).toEqual({ tabs: ["a", "b"], active: "b" });
    expect(closeTab(["a"], "a", "a")).toEqual({ tabs: [], active: null });
    expect(closeTab(["a", "b"], "a", "b")).toEqual({ tabs: ["b"], active: "b" });
    expect(renameTab(["a", "b"], "b", "c")).toEqual(["a", "c"]);
    expect(pruneTabs(["a", "gone", "b", "c"], ["a", "b", "c"], 2)).toEqual(["b", "c"]);
  });
});

describe("formatting", () => {
  it("numbers SAN lines from the FEN", () => {
    expect(numberedLine(START_FEN, ["e4", "e5", "Nf3"])).toBe("1. e4 e5 2. Nf3");
    expect(numberedLine("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 12", ["O-O", "O-O-O", "Kf7"])).toBe("12... O-O 13. O-O-O Kf7");
    expect(numberedLine(START_FEN, [])).toBe("");
  });

  it("converts scores to White's point of view", () => {
    expect(whitePovScore({ scoreCp: 35, mate: null }, "w")).toEqual({ cp: 35, mate: null });
    expect(whitePovScore({ scoreCp: 35, mate: null }, "b")).toEqual({ cp: -35, mate: null });
    expect(whitePovScore({ scoreCp: null, mate: 2 }, "b")).toEqual({ cp: null, mate: -2 });
    expect(signedInt(35)).toBe("+35");
    expect(signedInt(-12)).toBe("−12");
    expect(signedInt(0)).toBe("0");
    expect(groupDigits(197281)).toBe("197,281");
  });
});

// ---------------------------------------------------------------------------------------------

describe("EngineDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake repo: update() merges like enginesRepo.update and resolves after `latency` ms. */
  function fakeRepo(initial: EngineRecord, latency = 20) {
    let stored = initial;
    const calls: Array<Partial<EngineRecord>> = [];
    let failNext: Error | null = null;
    const save = vi.fn((_id: string, patch: Partial<EngineRecord>) => {
      calls.push(patch);
      return new Promise<EngineRecord>((resolve, reject) =>
        setTimeout(() => {
          if (failNext) {
            const e = failNext;
            failNext = null;
            reject(e);
            return;
          }
          stored = { ...stored, ...patch, updatedAt: stored.updatedAt + 1 };
          resolve(stored);
        }, latency),
      );
    });
    return { save, calls, get stored() { return stored; }, failOnce(e: Error) { failNext = e; } };
  }

  it("shows edits at once and saves them debounced in one write", async () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 500 });
    draft.edit({ name: "A" });
    draft.edit({ name: "AB" });
    draft.edit({ description: "d2" });
    expect(draft.view.name).toBe("AB");
    expect(draft.getSnapshot().state).toBe("pending");
    await vi.advanceTimersByTimeAsync(499);
    expect(repo.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(repo.calls).toEqual([{ name: "AB", description: "d2" }]);
    expect(draft.getSnapshot().state).toBe("saving");
    await vi.advanceTimersByTimeAsync(20);
    expect(draft.getSnapshot().state).toBe("saved");
    expect(draft.getSnapshot().saved.name).toBe("AB");
  });

  it("keeps the newest local value through stale store updates and save round trips", async () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 100 });
    draft.edit({ files: { "eval.ts": "v1" } });
    await vi.advanceTimersByTimeAsync(100); // write of v1 starts
    draft.edit({ files: { "eval.ts": "v2" } }); // typed while saving
    expect(draft.view.files!["eval.ts"]).toBe("v2");
    // A stale copy from the storage hook arrives (older updatedAt): ignored.
    draft.receive(engine({ updatedAt: 50, files: { "eval.ts": "stale" } }));
    expect(draft.view.files!["eval.ts"]).toBe("v2");
    await vi.advanceTimersByTimeAsync(20); // v1 saved
    expect(draft.view.files!["eval.ts"]).toBe("v2");
    // The hook now delivers the record with v1 (newer than the initial one): still v2 on screen.
    draft.receive(repo.stored);
    expect(draft.view.files!["eval.ts"]).toBe("v2");
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.calls.map((c) => c.files!["eval.ts"])).toEqual(["v1", "v2"]);
    expect(draft.getSnapshot().state).toBe("saved");
    expect(draft.view.files!["eval.ts"]).toBe("v2");
  });

  it("adopts newer stored changes to fields it is not editing", () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save);
    draft.edit({ name: "Mine" });
    draft.receive(engine({ updatedAt: 200, description: "from another tab", build: null }));
    expect(draft.view.description).toBe("from another tab");
    expect(draft.view.name).toBe("Mine");
  });

  it("flush() writes immediately and waits for running writes", async () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 10_000 });
    draft.edit({ name: "X" });
    const done = draft.flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toBe(true);
    expect(repo.calls).toEqual([{ name: "X" }]);
    expect(draft.dirty).toBe(false);
  });

  it("keeps failed edits and retries them with the next save", async () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 100 });
    repo.failOnce(new Error("Disk full"));
    draft.edit({ name: "Y" });
    const first = draft.flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe(false);
    expect(draft.getSnapshot()).toMatchObject({ state: "error", error: "Disk full" });
    expect(draft.view.name).toBe("Y");
    draft.edit({ description: "z" });
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.calls[1]).toEqual({ name: "Y", description: "z" });
    expect(draft.getSnapshot()).toMatchObject({ state: "saved", error: null });
  });

  it("stops saving when the engine is gone", async () => {
    const repo = fakeRepo(engine());
    const gone = new Error("not found");
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 100, isGoneError: (e) => e === gone });
    repo.failOnce(gone);
    draft.edit({ name: "Z" });
    await vi.advanceTimersByTimeAsync(200);
    expect(draft.getSnapshot()).toMatchObject({ state: "error", gone: true });
    draft.edit({ name: "ZZ" });
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.calls).toHaveLength(1);
  });

  it("saves late edits immediately after close() and discards on delete", async () => {
    const repo = fakeRepo(engine());
    const draft = new EngineDraft(engine(), repo.save, { delayMs: 10_000 });
    draft.edit({ name: "before close" });
    draft.close();
    draft.edit({ description: "late edit from an unmounting editor" });
    await vi.advanceTimersByTimeAsync(100);
    expect(repo.stored).toMatchObject({ name: "before close", description: "late edit from an unmounting editor" });

    const other = new EngineDraft(engine({ id: "e2" }), repo.save, { delayMs: 100 });
    other.edit({ name: "never saved" });
    other.discard();
    await vi.advanceTimersByTimeAsync(500);
    expect(repo.calls.some((c) => c.name === "never saved")).toBe(false);
  });
});
