import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import type { SearchInfo } from "@/types";
import { goArguments, positionCommand } from "./abi";
import { compileFixture, compileInline, minimalEngineSource } from "./__fixtures__/compile";
import { EngineCrashError, EngineInstance, parseTrace, type EngineInstanceOptions } from "./instance";
import { compileModule } from "./module-info";

const FIXTURE_MAIN = readFileSync(new URL("./__fixtures__/tiny-engine/main.ts", import.meta.url), "utf8");
const MATED_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
const CBNN = new Uint8Array([0x43, 0x42, 0x4e, 0x4e, 1, 0, 0, 0]).buffer;

/** 1-based line/column of the first occurrence of `needle` in the fixture's main.ts. */
function fixtureLocation(needle: string): string {
  const idx = FIXTURE_MAIN.indexOf(needle);
  if (idx < 0) throw new Error(`"${needle}" not in fixture`);
  const before = FIXTURE_MAIN.slice(0, idx);
  const line = before.split("\n").length;
  const column = idx - before.lastIndexOf("\n");
  return `main.ts:${line}:${column}`;
}

let wasm: Uint8Array;
beforeAll(async () => {
  wasm = await compileFixture();
});

async function start(opts: EngineInstanceOptions = {}) {
  const logs: string[] = [];
  const infos: SearchInfo[] = [];
  const engine = await EngineInstance.create(wasm, { onLog: (s) => logs.push(s), onInfo: (i) => infos.push(i), ...opts });
  return { engine, logs, infos };
}

const goArg = (e: EngineInstance, i: number) => e.callRaw("dbg_go_arg", i) as number;
const goArgs = (e: EngineInstance) => Array.from({ length: 8 }, (_, i) => goArg(e, i));

describe("EngineInstance start-up", () => {
  it("runs cb_init once, reports capabilities and starts a new game", async () => {
    const { engine, logs } = await start();
    expect(engine.capabilities).toEqual({
      abiVersion: 1, eval: true, trace: true, perft: true, nnue: true, setOption: true, name: "Tiny Engine 1.0", stopFlag: false,
    });
    expect(engine.callRaw("dbg_init_calls")).toBe(1);
    expect(engine.callRaw("dbg_new_games")).toBe(1);
    expect(logs).toContain("tiny-engine ready");
    expect(engine.broken).toBe(false);
  });

  it("applies the hash size and loads the network before the first new game", async () => {
    const { engine } = await start({ hashMb: 32, network: CBNN });
    expect(engine.callRaw("dbg_hash")).toBe(32);
    expect(engine.callRaw("dbg_network")).toBe(1);
  });

  it("throws a descriptive error when the engine rejects the network", async () => {
    await expect(start({ network: new Uint8Array([1, 2, 3, 4, 5]).buffer })).rejects.toThrow(/rejected the network/);
  });

  it("throws when a network is given to an engine that cannot load one", async () => {
    const minimal = await compileInline(minimalEngineSource());
    await expect(EngineInstance.create(minimal, { network: CBNN })).rejects.toThrow(/cannot load NNUE networks/);
  });

  it("accepts a compiled Module, an ArrayBuffer and an offset Uint8Array view", async () => {
    const fromModule = await EngineInstance.create(await compileModule(wasm));
    expect(fromModule.capabilities.name).toBe("Tiny Engine 1.0");
    const fromBuffer = await EngineInstance.create(wasm.slice().buffer);
    expect(fromBuffer.capabilities.abiVersion).toBe(1);
    const padded = new Uint8Array(wasm.length + 16);
    padded.set(wasm, 16);
    const fromView = await EngineInstance.create(padded.subarray(16));
    expect(fromView.capabilities.abiVersion).toBe(1);
  });

  it("rejects modules that are not engines or speak another ABI version", async () => {
    const notEngine = await compileInline("export function foo(): i32 { return 1; }");
    await expect(EngineInstance.create(notEngine)).rejects.toThrow(/missing required exports cb_abi_version, cb_init, cb_in, cb_out, cb_new_game, cb_position, cb_go/);
    const v2 = await compileInline(minimalEngineSource({ abiVersion: 2 }));
    await expect(EngineInstance.create(v2)).rejects.toThrow(/Unsupported engine ABI version 2/);
  });

  it("works with an engine that has no optional exports", async () => {
    const e = await EngineInstance.create(await compileInline(minimalEngineSource({ move: "d2d4" })));
    expect(e.capabilities).toEqual({ abiVersion: 1, eval: false, trace: false, perft: false, nnue: false, setOption: false, name: null, stopFlag: false });
    expect(e.position("startpos", [])).toBe(true);
    expect(e.go({ depth: 1 }).bestMove).toBe("d2d4");
    expect(e.eval()).toBeNull();
    expect(e.evalTrace()).toBeNull();
    expect(e.perft(3)).toBeNull();
    expect(e.setOption("Hash", "16")).toBe(false);
    expect(e.loadNetwork(CBNN)).toBe(false);
  });
});

describe("EngineInstance searches", () => {
  it("plays the move for the position and decodes info (incl. nps)", async () => {
    const { engine, infos } = await start();
    expect(engine.position("startpos", [])).toBe(true);
    const r = engine.go({ depth: 2 });
    expect(r.bestMove).toBe("e2e4");
    expect(infos).toHaveLength(2);
    expect(r.info).toEqual({ depth: 2, seldepth: 4, scoreCp: 20, mate: null, nodes: 2000, timeMs: 2, nps: 1_000_000, pv: ["e2e4", "a7a6"] });
    expect(infos[0].pv).toEqual(["e2e4"]);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(engine.position("startpos", ["e2e4"])).toBe(true);
    expect(engine.go({ depth: 1 }).bestMove).toBe("e7e5");
    expect(engine.position("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", [])).toBe(true);
    expect(engine.go({ depth: 1 }).bestMove).toBe("g8f6");
    expect(engine.position("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", ["e7e5"])).toBe(true);
    expect(engine.go({ depth: 1 }).bestMove).toBe("g1f3");
  });

  it("returns a null move when the side to move has no legal move", async () => {
    const { engine } = await start();
    expect(engine.position(MATED_FEN, [])).toBe(true);
    expect(engine.go({ depth: 3 }).bestMove).toBeNull();
  });

  it("reports rejected positions", async () => {
    const { engine } = await start();
    expect(engine.position("startpos", ["e2e4", "zz99"])).toBe(false);
    expect(engine.position("8/8 w", [])).toBe(false);
    expect(engine.position("startpos", ["e2e4"])).toBe(true);
  });

  it("maps depth / nodes / movetime / clock / infinite onto the cb_go arguments", async () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const { engine } = await start({ stopFlag: flag });
    engine.position("startpos", []);

    engine.go({ depth: 3, nodes: 5000 });
    expect(goArgs(engine)).toEqual([3, 5000, 0, -1, -1, 0, 0, 0]);

    let r = engine.go({ movetimeMs: 40 });
    expect(goArgs(engine)).toEqual([0, 0, 40, -1, -1, 0, 0, 0]);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(35);
    expect(r.bestMove).toBe("e2e4");

    // White to move: the fixture budgets 600/20 + 40/2 = 50 ms.
    r = engine.go({ clock: { wtime: 600, btime: 300, winc: 40, binc: 20, movestogo: 20 } });
    expect(goArgs(engine)).toEqual([0, 0, 0, 600, 300, 40, 20, 20]);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(45);
    expect(r.elapsedMs).toBeLessThan(2000);

    // Infinite ignores other fields; with the flag already raised the engine stops at once.
    Atomics.store(flag, 0, 1);
    r = engine.go({ infinite: true, depth: 9, movetimeMs: 100 });
    expect(goArgs(engine)).toEqual([0, 0, 0, -1, -1, 0, 0, 0]);
    expect(r.bestMove).toBe("e2e4");
    expect(r.elapsedMs).toBeLessThan(1000);
  });

  it("decodes mate scores", async () => {
    const { engine } = await start();
    engine.position("startpos", []);
    expect(engine.go({ depth: 5 }).info).toMatchObject({ depth: 5, mate: 3, scoreCp: null, nodes: 5000, timeMs: 2, nps: 2_500_000 });
    expect(engine.go({ depth: 6 }).info).toMatchObject({ mate: -2, scoreCp: null });
  });

  it("re-reads memory after the engine grows it", async () => {
    const { engine, infos } = await start();
    engine.position("startpos", []);
    const r = engine.go({ depth: 7 });
    expect(r.bestMove).toBe("e2e4");
    expect(infos.map((i) => i.pv.join(" "))).toEqual(["e2e4", "e2e4 a7a6", "e2e4 a7a6 a2a3"]);
  });

  it("stops an infinite search when another thread raises the shared flag", async () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const { engine, infos } = await start({ stopFlag: flag });
    expect(engine.capabilities.stopFlag).toBe(true);
    engine.position("startpos", []);
    const raiser = new Worker(
      `const { workerData } = require("node:worker_threads");
       const flag = new Int32Array(workerData);
       setTimeout(() => Atomics.store(flag, 0, 1), 150);`,
      { eval: true, workerData: flag.buffer },
    );
    try {
      const r = engine.go({ infinite: true });
      expect(r.bestMove).toBe("e2e4");
      expect(r.elapsedMs).toBeGreaterThanOrEqual(100);
      expect(r.elapsedMs).toBeLessThan(10_000);
      expect(infos.length).toBeGreaterThanOrEqual(2); // progress was streamed while waiting
      expect(Atomics.load(flag, 0)).toBe(1);
    } finally {
      await raiser.terminate();
    }
  });
});

describe("EngineInstance optional functions", () => {
  it("evaluates, traces, runs perft and sets options", async () => {
    const { engine } = await start();
    engine.position("startpos", []);
    expect(engine.eval()).toBe(12);
    engine.position("startpos", ["e2e4"]);
    expect(engine.eval()).toBe(13);
    expect(engine.evalTrace()).toEqual([
      { label: "material", white: 3900, black: 3900 },
      { label: "mobility", white: 25, black: 20 },
      { label: "total", white: 5, black: 0 },
    ]);
    expect(engine.perft(2)).toBe(400);
    expect(engine.perft(3)).toBe(8902);
    expect(engine.setOption("Hash", "64")).toBe(true);
    expect(engine.callRaw("dbg_hash")).toBe(64);
    expect(engine.setOption("NoSuchOption", "1")).toBe(false);
    expect(engine.loadNetwork(CBNN)).toBe(true);
    expect(engine.loadNetwork(new ArrayBuffer(16))).toBe(false);
  });

  it("parses trace text leniently", () => {
    expect(parseTrace("a\t1\t2\r\n\n\tx\t1\nb\tnope\t3\n")).toEqual([
      { label: "a", white: 1, black: 2 },
      { label: "b", white: 0, black: 3 },
    ]);
  });
});

describe("EngineInstance failures and host imports", () => {
  it("turns abort() into an Error with the decoded message and marks the instance broken", async () => {
    const { engine } = await start();
    let err: unknown;
    try {
      engine.callRaw("dbg_abort");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineCrashError);
    expect((err as Error).message).toBe(`abort: kaboom at ${fixtureLocation('throw new Error("kaboom")')}`);
    expect(engine.broken).toBe(true);
    expect(engine.crashReason).toMatch(/^abort: kaboom/);
    expect(() => engine.go({ depth: 1 })).toThrow(/crashed earlier and must be restarted/);
  });

  it("reports an abort during a search, keeping the last info", async () => {
    const { engine } = await start();
    engine.position("startpos", []);
    expect(() => engine.go({ depth: 90 })).toThrow(`abort: search exploded at ${fixtureLocation('throw new Error("search exploded")')}`);
    expect(engine.lastInfo).toMatchObject({ depth: 1, pv: ["e2e4"] });
    expect(engine.broken).toBe(true);
  });

  it("reports WebAssembly traps", async () => {
    const { engine } = await start();
    engine.position("startpos", []);
    expect(() => engine.go({ depth: 91 })).toThrow(/^WebAssembly trap: unreachable/);
    expect(engine.broken).toBe(true);
  });

  it("stubs unknown imports (returning 0) and logs the first call only", async () => {
    const { engine, logs } = await start();
    expect(engine.stubbedImports).toContain("env.mystery_import");
    expect(engine.callRaw("dbg_unknown")).toBe(1);
    expect(engine.callRaw("dbg_unknown")).toBe(1);
    engine.position("startpos", []);
    expect(engine.go({ depth: 93 }).bestMove).toBe("a2a3");
    const notes = logs.filter((l) => l.includes("mystery_import"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^\[host\] .*env\.mystery_import.*stub returned 0/);
  });

  it("provides trace() and the Math.random seed", async () => {
    const { engine, logs } = await start();
    engine.callRaw("dbg_trace");
    expect(logs).toContain("trace: hello from trace 1.5, -2");
    const r = engine.callRaw("dbg_random") as number;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it("emulates enough WASI for stdout, clocks and random numbers", async () => {
    const { engine, logs } = await start();
    expect(engine.callRaw("dbg_wasi_write")).toBe("hello wasi\nsecond line\n".length);
    expect(logs).toEqual(expect.arrayContaining(["hello wasi", "second line"]));
    expect(engine.callRaw("dbg_wasi_partial")).toBe(0);
    expect(logs).toContain("[stderr] no newline");
    const clock = engine.callRaw("dbg_wasi_clock") as number;
    expect(Math.abs(clock - performance.now())).toBeLessThan(1000);
    const rnd = engine.callRaw("dbg_wasi_random") as number;
    expect(rnd >> 8).toBe(0); // errno
    expect(rnd & 255).toBeGreaterThan(16); // most of 32 random bytes are non-zero
    expect(engine.callRaw("dbg_wasi_prestat")).toBe(8); // EBADF: no preopened directories
    expect(engine.callRaw("dbg_wasi_unknown")).toBe(52); // ENOSYS
    expect(() => engine.callRaw("dbg_wasi_exit")).toThrow("Engine called proc_exit(3)");
    expect(engine.broken).toBe(true);
  });

  it("does not let a throwing callback abort the search", async () => {
    const e = await EngineInstance.create(wasm, {
      onInfo: () => {
        throw new Error("UI bug");
      },
    });
    e.position("startpos", []);
    const original = console.error;
    console.error = () => {};
    try {
      expect(e.go({ depth: 2 }).bestMove).toBe("e2e4");
    } finally {
      console.error = original;
    }
    expect(e.broken).toBe(false);
  });
});

describe("ABI helpers", () => {
  it("goArguments rounds and clamps limits without turning a real limit into 'none'", () => {
    expect(goArguments({})).toEqual([0, 0, 0, -1, -1, 0, 0, 0]);
    expect(goArguments({ depth: 0.4, movetimeMs: 0.2, nodes: 0.5 })).toEqual([1, 1, 1, -1, -1, 0, 0, 0]);
    expect(goArguments({ depth: -3, movetimeMs: Number.NaN })).toEqual([0, 0, 0, -1, -1, 0, 0, 0]);
    expect(goArguments({ clock: { wtime: -50, btime: 1e12, winc: 10.6, binc: 0 } })).toEqual([0, 0, 0, 0, 0x7fffffff, 11, 0, 0]);
    expect(goArguments({ infinite: true, depth: 5, clock: { wtime: 1, btime: 1, winc: 0, binc: 0 } })).toEqual([0, 0, 0, -1, -1, 0, 0, 0]);
  });

  it("positionCommand builds the UCI-style position text", () => {
    expect(positionCommand("startpos", [])).toBe("startpos");
    expect(positionCommand("", ["e2e4", " e7e5 "])).toBe("startpos moves e2e4 e7e5");
    expect(positionCommand("8/8/8/8/8/8/8/K6k w - - 0 1", ["a1a2"])).toBe("fen 8/8/8/8/8/8/8/K6k w - - 0 1 moves a1a2");
    expect(positionCommand("fen 8/8/8/8/8/8/8/K6k w - - 0 1", [])).toBe("fen 8/8/8/8/8/8/8/K6k w - - 0 1");
  });
});
