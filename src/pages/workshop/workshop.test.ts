// Unit tests for the Workshop's pure logic: test positions and the perft reference table, record
// builders (duplicate / convert / save patches), file-tree helpers, formatting and the autosave
// draft store.
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChessGame, START_FEN, validateFen } from "@/chess";
import { DEFAULT_WORKSPACE, GENERATOR_VERSION, generateEvalSource } from "@/blocks";
import { assembleSources, sourceHashOf } from "@/engine-host/build";
import { TEMPLATE_VERSION, defaultFilesFor, templateFiles } from "@/engine-host/templates";
import type { CompileResult, EngineRecord } from "@/types";
import { EngineDraft } from "./draft";
import { closeTab, newFileContents, openTab, pruneTabs, renameInFiles, renameTab, sortPaths, withExtension, withoutFile } from "./files";
import { fenShapeProblem, groupDigits, numberedLine, signedInt, whitePovScore } from "./format";
import { BENCH_POSITIONS, PERFT_SUITE, PRESET_POSITIONS, expectedPerft, perftSuiteNodes } from "./positions";
import { buildPillFor } from "./status";
import { missingRequiredExports, type BuildRun, type EngineBuildState } from "./build-store";
import { REQUIRED_FUNCTIONS } from "@/engine-host/abi";
import { clearBackup, editsToRestore, readBackup, writeBackup } from "./unsaved";
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

  it("keeps the build of a converted engine only while the code is identical", () => {
    const code = generateEvalSource(DEFAULT_WORKSPACE).code;
    const build = { sourceHash: "h", wasm: new ArrayBuffer(8), builtAt: 1, compiler: "asc", sizeBytes: 8, compileMs: 1, warnings: 0 };
    const src = engine({ kind: "blocks", name: "Blocky", blocks: structuredClone(DEFAULT_WORKSPACE), files: { "eval.ts": code }, build });
    expect(blocksToCodeRecord(src, code, deps, TEMPLATE_VERSION).build).toBe(build);
    expect(blocksToCodeRecord(src, convertedEvalSource(code, "Blocky"), deps, TEMPLATE_VERSION).build).toBeNull();
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

describe("build status pill", () => {
  const idle: EngineBuildState = { running: 0, statusText: null, last: null };
  const build = { sourceHash: "h1", wasm: new ArrayBuffer(4), builtAt: 1, compiler: "assemblyscript 0.28.20", sizeBytes: 75_776, compileMs: 900, warnings: 0 };
  const failed = (hash: string | null, errors: number): BuildRun => {
    const result: CompileResult = {
      ok: false,
      wasm: null,
      diagnostics: Array.from({ length: errors }, (_, i) => ({ severity: "error" as const, message: `problem ${i + 1}`, file: "eval.ts", line: 3, column: 1, code: 2304 })),
      log: "",
      timeMs: 10,
      compilerVersion: "assemblyscript 0.28.20",
    };
    return { seq: 1, at: 1, ok: false, compiled: true, result, sourceHash: hash, wallMs: 10, sizeBytes: null, problem: null };
  };

  it("shows up to date, needs build and not built yet", () => {
    expect(buildPillFor(engine({ build }), idle, { hash: "h1", problem: null })).toMatchObject({ tone: "ok", text: "Up to date · 74.0 KB" });
    expect(buildPillFor(engine({ build }), idle, { hash: "h2", problem: null })).toMatchObject({ tone: "warn", text: "Needs build" });
    expect(buildPillFor(engine({ build: null }), idle, { hash: "h2", problem: null })).toMatchObject({ tone: "warn", text: "Not built yet" });
    expect(buildPillFor(engine({ build }), idle, { hash: null, problem: null })).toMatchObject({ text: "Checking…" });
  });

  it("shows building progress, errors of the current sources and source problems", () => {
    expect(buildPillFor(engine(), { running: 1, statusText: "Compiling…", last: null }, { hash: "h1", problem: null })).toMatchObject({ tone: "accent", text: "Compiling…", spinner: true });
    expect(buildPillFor(engine(), { ...idle, last: failed("h1", 3) }, { hash: "h1", problem: null })).toMatchObject({ tone: "danger", text: "3 errors", title: "problem 1" });
    expect(buildPillFor(engine(), { ...idle, last: failed("h1", 1) }, { hash: "h1", problem: null }).text).toBe("1 error");
    // A failed build of other (older) sources does not count: the saved build matches these.
    expect(buildPillFor(engine({ build }), { ...idle, last: failed("h0", 2) }, { hash: "h1", problem: null }).text).toBe("Up to date · 74.0 KB");
    expect(buildPillFor(engine(), idle, { hash: null, problem: "The entry file main.ts does not exist." })).toMatchObject({ tone: "danger", text: "Can't build" });
  });

  it("warns when a successful build of the current sources is not a working engine", () => {
    const run: BuildRun = { seq: 2, at: 1, ok: true, compiled: true, result: null, sourceHash: "h1", wallMs: 10, sizeBytes: 25, problem: null, missingExports: ["cb_go", "memory"] };
    expect(buildPillFor(engine({ build }), { ...idle, last: run }, { hash: "h1", problem: null })).toMatchObject({ tone: "warn", text: "Not a working engine", title: "Built, but the module does not export cb_go, memory" });
    // Edited since that build: the usual "Needs build".
    expect(buildPillFor(engine({ build }), { ...idle, last: run }, { hash: "h2", problem: null }).text).toBe("Needs build");
    expect(buildPillFor(engine({ build }), { ...idle, last: { ...run, missingExports: [] } }, { hash: "h1", problem: null }).text).toBe("Up to date · 74.0 KB");
  });

  it("describes uploaded modules", () => {
    expect(buildPillFor(engine({ kind: "wasm", files: undefined, wasm: new ArrayBuffer(2048) }), idle, { hash: null, problem: null }).text).toBe("Module · 2.0 KB");
    expect(buildPillFor(engine({ kind: "wasm", files: undefined }), idle, { hash: null, problem: null }).text).toBe("No module");
  });
});

/** A tiny WebAssembly module exporting empty functions with the given names (and a memory). */
function wasmModule(functions: readonly string[], withMemory: boolean): ArrayBuffer {
  const leb = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...leb(n >> 7)]);
  const name = (s: string) => [...leb(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const section = (id: number, body: number[]) => bytes.push(id, ...leb(body.length), ...body);
  const n = functions.length;
  section(1, [1, 0x60, 0, 0]); // one type: () -> ()
  section(3, [...leb(n), ...functions.map(() => 0)]);
  if (withMemory) section(5, [1, 0x00, 1]);
  const exports = [...functions.flatMap((f, i) => [...name(f), 0x00, ...leb(i)]), ...(withMemory ? [...name("memory"), 0x02, 0] : [])];
  section(7, [...leb(n + (withMemory ? 1 : 0)), ...exports]);
  section(10, [...leb(n), ...functions.flatMap(() => [2, 0, 0x0b])]);
  return new Uint8Array(bytes).buffer;
}

describe("missingRequiredExports", () => {
  it("lists the required ABI exports a compiled module lacks", async () => {
    expect(await missingRequiredExports(wasmModule([...REQUIRED_FUNCTIONS], true))).toEqual([]);
    expect(await missingRequiredExports(wasmModule(["cb_abi_version", "cb_init", "cb_in", "cb_out", "cb_new_game", "cb_position"], true))).toEqual(["cb_go"]);
    expect(await missingRequiredExports(wasmModule([], false))).toEqual([...REQUIRED_FUNCTIONS, "memory"]);
  });

  it("says nothing when it cannot tell (not a module)", async () => {
    expect(await missingRequiredExports(new Uint8Array([1, 2, 3]).buffer)).toEqual([]);
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

  it("explains text that is not shaped like a FEN", () => {
    expect(fenShapeProblem(START_FEN)).toBeNull();
    expect(fenShapeProblem("8/8/8/8/8/8/8/K6k w")).toBeNull();
    expect(fenShapeProblem("not a fen")).toMatch(/8 ranks/);
    expect(fenShapeProblem("   ")).toMatch(/Paste or type/);
    expect(fenShapeProblem("8/8/8/8/8/8/8/K6k")).toMatch(/side to move/);
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

describe("unsaved edits backup", () => {
  /** An in-memory stand-in for localStorage. */
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it("lists what is not stored yet: the write in flight plus newer edits", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn((_id: string, patch: Partial<EngineRecord>) => new Promise<EngineRecord>((resolve) => setTimeout(() => resolve(engine({ ...patch, updatedAt: 200 })), 20)));
      const draft = new EngineDraft(engine(), save, { delayMs: 100 });
      expect(draft.unsaved()).toBeNull();
      draft.edit({ name: "A" });
      expect(draft.unsaved()).toEqual({ name: "A" });
      draft.close(); // the write of "A" starts
      draft.edit({ description: "late" });
      expect(draft.unsaved()).toEqual({ name: "A", description: "late" });
      await vi.advanceTimersByTimeAsync(100);
      expect(draft.unsaved()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips through storage without module bytes and restores only newer edits", () => {
    const storage = memoryStorage();
    expect(writeBackup("e1", { files: { "eval.ts": "x" }, name: "N", wasm: new ArrayBuffer(4) }, 1_000, storage)).toBe(true);
    const backup = readBackup("e1", storage);
    expect(backup).toEqual({ at: 1_000, patch: { files: { "eval.ts": "x" }, name: "N" } });
    // The stored record is older than the backup: the edits are missing from it.
    expect(editsToRestore(backup, engine({ updatedAt: 900 }))).toEqual({ files: { "eval.ts": "x" }, name: "N" });
    // Stored at or after the backup (the write made it, or another tab changed it since).
    expect(editsToRestore(backup, engine({ updatedAt: 1_000 }))).toEqual({ files: { "eval.ts": "x" }, name: "N" });
    expect(editsToRestore(backup, engine({ updatedAt: 1_001 }))).toBeNull();
    expect(editsToRestore(null, engine())).toBeNull();
    clearBackup("e1", storage);
    expect(readBackup("e1", storage)).toBeNull();
  });

  it("ignores nothing-to-save patches, garbage and broken storage", () => {
    const storage = memoryStorage();
    expect(writeBackup("e1", { wasm: new ArrayBuffer(2) }, 1, storage)).toBe(false);
    storage.setItem("cb.workshop.unsaved.e1", "{not json");
    expect(readBackup("e1", storage)).toBeNull();
    storage.setItem("cb.workshop.unsaved.e1", JSON.stringify({ at: "soon", patch: {} }));
    expect(readBackup("e1", storage)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(writeBackup("e1", { name: "x" }, 1, broken)).toBe(false);
    expect(readBackup("e1", broken)).toBeNull();
    expect(() => clearBackup("e1", broken)).not.toThrow();
    expect(writeBackup("e1", { name: "x" }, 1, null)).toBe(false);
  });
});
