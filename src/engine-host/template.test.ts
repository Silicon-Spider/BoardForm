// The real engine template (engine/template) driven through EngineInstance: compiled with the app's
// build options via compileWithAsc, then every limit type, info streaming, eval / trace / perft,
// options, new game and positions with move lists; plus the stock NNUE engine loading real CBNN
// networks. Skipped until the template (and the NNUE variant) exist.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Chess } from "chess.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { SearchInfo, SearchLimits } from "@/types";
import { compileSources } from "./__fixtures__/compile";
import { BUILD_OPTIONS, stockNnueSources } from "./build";
import { EngineInstance, type EngineInstanceOptions, type GoOutcome } from "./instance";
import { templateFiles } from "./templates";
import { parseNetworkFile, quantizeNetwork } from "@/nnue/format";
import { createNetwork } from "@/nnue/init";
import { evaluateQuantized } from "@/nnue/reference";

const templateDir = new URL("../../engine/template/", import.meta.url);
const ready = existsSync(new URL("search.ts", templateDir)) && existsSync(new URL("main.ts", templateDir));
const nnueReady = ready && existsSync(new URL("../../engine/variants/eval-nnue.ts", import.meta.url));

const KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const MIDDLEGAME = "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 2 8";
const ENDGAME = "8/5pk1/6p1/3R4/1r5P/6P1/5PK1/8 b - - 3 41";
/** White is a queen up. */
const QUEEN_UP = "rnb1kbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
const MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"; // fool's mate
const STALEMATE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

// --- chess.js helpers (the reference rules) -------------------------------------------------------

function gameAt(startFen: string, moves: readonly string[]): Chess {
  const game = startFen === "startpos" ? new Chess() : new Chess(startFen);
  for (const m of moves) game.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return game;
}

function legalUci(startFen: string, moves: readonly string[]): string[] {
  return gameAt(startFen, moves)
    .moves({ verbose: true })
    .map((m) => m.lan);
}

/** Throws unless every move of `line` is legal in sequence after `moves`. */
function expectLegalLine(startFen: string, moves: readonly string[], line: readonly string[]): void {
  const game = gameAt(startFen, moves);
  for (const [i, m] of line.entries()) {
    const legal = game.moves({ verbose: true }).map((x) => x.lan);
    expect(legal, `PV move ${i + 1} (${m}) of "${line.join(" ")}"`).toContain(m);
    game.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  }
}

/** The same position with colours swapped (board flipped vertically, side to move swapped). */
function mirrorFen(fen: string): string {
  const [board, side, castling, ep, half, full] = fen.split(" ");
  const swap = (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
  const rows = board.split("/").reverse().map(swap);
  const rights = castling === "-" ? "-" : [..."KQkq"].filter((c) => swap(castling).includes(c)).join("");
  const epSquare = ep === "-" ? "-" : `${ep[0]}${ep[1] === "3" ? "6" : "3"}`;
  return [rows.join("/"), side === "w" ? "b" : "w", rights, epSquare, half, full].join(" ");
}

/** Deterministic pseudo-random legal game (stops early at mate / stalemate). */
function randomGame(plies: number, seed: number): string[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const game = new Chess();
  const out: string[] = [];
  while (out.length < plies) {
    const legal = game.moves({ verbose: true });
    if (legal.length === 0) break;
    const m = legal[Math.floor(rand() * legal.length)];
    game.move(m);
    out.push(m.lan);
  }
  return out;
}

// --- engine helpers ----------------------------------------------------------------------------------

let wasm: Uint8Array;
let compileMs = 0;

beforeAll(async () => {
  if (!ready) return;
  const r = await compileSources({ ...templateFiles }, "main.ts", { ...BUILD_OPTIONS });
  if (!r.ok || !r.wasm) throw new Error(`engine/template failed to compile:\n${r.log}`);
  wasm = r.wasm;
  compileMs = r.timeMs;
});

interface Harness {
  engine: EngineInstance;
  infos: SearchInfo[];
  logs: string[];
  flag: Int32Array;
}

/** A template instance with a shared stop flag; `onInfo` runs after the info is recorded. */
async function start(opts: EngineInstanceOptions = {}): Promise<Harness> {
  const infos: SearchInfo[] = [];
  const logs: string[] = [];
  const flag = opts.stopFlag ?? new Int32Array(new SharedArrayBuffer(4));
  const engine = await EngineInstance.create(wasm, {
    hashMb: 8,
    ...opts,
    stopFlag: flag,
    onLog: (s) => logs.push(s),
    onInfo: (i) => {
      infos.push(i);
      opts.onInfo?.(i);
    },
  });
  return { engine, infos, logs, flag };
}

/** Runs one search on a fresh info list and checks the move is legal. */
function search(h: Harness, startFen: string, moves: readonly string[], limits: SearchLimits): GoOutcome {
  expect(h.engine.position(startFen, [...moves])).toBe(true);
  h.infos.length = 0;
  const r = h.engine.go(limits);
  expect(legalUci(startFen, moves), `best move for ${JSON.stringify(limits)}`).toContain(r.bestMove);
  return r;
}

/** Shape and consistency of a streamed SearchInfo. */
function expectWellFormedInfo(info: SearchInfo, startFen: string, moves: readonly string[]): void {
  expect(Number.isInteger(info.depth) && info.depth >= 1).toBe(true);
  expect(info.seldepth).toBeGreaterThanOrEqual(info.depth);
  if (info.mate === null) expect(typeof info.scoreCp).toBe("number");
  else expect(info.scoreCp).toBeNull();
  expect(info.nodes).toBeGreaterThan(0);
  expect(info.timeMs).toBeGreaterThanOrEqual(0);
  expect(info.nps).toBe(info.timeMs > 0 ? Math.round((info.nodes * 1000) / info.timeMs) : 0);
  expect(info.pv.length).toBeGreaterThan(0);
  expectLegalLine(startFen, moves, info.pv);
}

describe.skipIf(!ready)("engine template through EngineInstance", () => {
  it("compiles with the app's build options and starts up with every optional capability", async () => {
    expect(wasm.byteLength).toBeGreaterThan(10_000);
    expect(compileMs).toBeGreaterThan(0);
    const { engine, logs } = await start({ hashMb: 32 });
    expect(engine.capabilities).toEqual({
      abiVersion: 1, eval: true, trace: true, perft: true, nnue: true, setOption: true, name: "Chess Builder Template 1.0", stopFlag: true,
    });
    expect(engine.stubbedImports).toEqual([]); // the template only imports what the host provides
    expect(logs.filter((l) => l.startsWith("[host]"))).toEqual([]); // e.g. Hash=32 was accepted
    expect(engine.broken).toBe(false);
  });

  it("perft matches the reference counts (perft(4) from startpos = 197281)", async () => {
    const { engine } = await start();
    expect(engine.position("startpos", [])).toBe(true);
    expect([0, 1, 2, 3, 4].map((d) => engine.perft(d))).toEqual([1, 20, 400, 8902, 197281]);
    const cases: Array<[string, number, number]> = [
      [KIWIPETE, 3, 97862],
      ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 4, 43238],
      ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 3, 9467],
      ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62379],
    ];
    for (const [fen, depth, nodes] of cases) {
      expect(engine.position(fen, [])).toBe(true);
      expect(engine.perft(depth), fen).toBe(nodes);
    }
  });

  it("sets up positions from startpos / FEN plus move lists (castling, en passant, promotions)", async () => {
    const { engine } = await start();
    const cases: Array<[string, string[]]> = [
      ["startpos", ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]],
      ["startpos", ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"]], // castling as a king move
      ["startpos", ["e2e4", "a7a6", "e4e5", "d7d5"]], // e.p. capture e5d6 available
      ["startpos", ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]], // ... and played
      ["4k3/P7/8/8/8/8/7p/4K3 w - - 0 1", ["a7a8n", "h2h1q"]], // promotions in the move list
      [KIWIPETE, ["e1c1", "e8g8"]],
      [MIDDLEGAME, []],
      [ENDGAME, ["b4b2", "d5d7"]],
      ["startpos", randomGame(300, 7)],
    ];
    for (const [fen, moves] of cases) {
      const label = `${fen} moves ${moves.slice(0, 8).join(" ")}${moves.length > 8 ? " …" : ""}`;
      expect(engine.position(fen, moves), label).toBe(true);
      const game = gameAt(fen, moves);
      expect(engine.perft(1), label).toBe(game.moves().length);
      expect(engine.perft(2), label).toBe(game.perft(2));
    }

    // A 2,400-ply knight shuffle (12 KB command, longer than the engine's game history buffer).
    const shuffle = Array.from({ length: 600 }, () => ["g1f3", "g8f6", "f3g1", "f6g8"]).flat();
    expect(engine.position("startpos", shuffle)).toBe(true);
    expect(engine.perft(3)).toBe(8902);
    const r = engine.go({ depth: 4 });
    expect(legalUci("startpos", [])).toContain(r.bestMove);
  });

  it("rejects bad positions and keeps the previous one", async () => {
    const { engine } = await start();
    const good: [string, string[]] = ["startpos", ["d2d4", "d7d5", "c2c4"]];
    expect(engine.position(...good)).toBe(true);
    const expected = { perft2: engine.perft(2), eval: engine.eval() };
    for (const [fen, moves] of [
      ["startpos", ["e2e5"]], // not a legal move
      ["startpos", ["e2e4", "e2e4"]], // the e2 square is empty now
      ["startpos", ["e2e4", "zz99"]],
      ["8/8/8 w - - 0 1", []], // malformed FEN
      ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", []], // bad side to move
      [MATED, ["e1f2"]], // no legal moves at all
    ] as Array<[string, string[]]>) {
      expect(engine.position(fen, moves), `${fen} ${moves.join(" ")}`).toBe(false);
      expect({ perft2: engine.perft(2), eval: engine.eval() }).toEqual(expected);
    }
    // Over-long commands are refused by the host without reaching the engine.
    expect(engine.position("startpos", Array.from({ length: 14_000 }, () => "g1f3"))).toBe(false);
    expect(engine.perft(2)).toBe(expected.perft2);
  });

  it("depth limit: one well-formed info per iteration, PV and best move legal", async () => {
    const h = await start();
    const moves = ["e2e4", "c7c5", "g1f3"];
    const r = search(h, "startpos", moves, { depth: 8 });
    expect(h.infos.map((i) => i.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const info of h.infos) expectWellFormedInfo(info, "startpos", moves);
    for (let i = 1; i < h.infos.length; i++) {
      expect(h.infos[i].nodes).toBeGreaterThanOrEqual(h.infos[i - 1].nodes);
      expect(h.infos[i].timeMs).toBeGreaterThanOrEqual(h.infos[i - 1].timeMs);
    }
    expect(r.info).toEqual(h.infos.at(-1));
    expect(r.info!.mate).toBeNull();
    expect(Math.abs(r.info!.scoreCp!)).toBeLessThan(300);
    expect(r.bestMove).toBe(r.info!.pv[0]);
    expect(h.engine.lastInfo).toEqual(r.info);
  });

  it("nodes limit: stops at the node budget, still with a legal move", async () => {
    const h = await start();
    const r = search(h, "startpos", [], { nodes: 30_000 });
    expect(r.info!.nodes).toBeGreaterThanOrEqual(30_000);
    expect(r.info!.nodes).toBeLessThanOrEqual(30_064);
    const tiny = search(h, MIDDLEGAME, [], { nodes: 1 });
    expect(tiny.bestMove).not.toBeNull();
  });

  it("movetime limit: uses (almost) all of the time and never overruns", async () => {
    const h = await start();
    const r = search(h, MIDDLEGAME, [], { movetimeMs: 250 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(r.elapsedMs).toBeLessThan(250 + 250); // generous: other processes may share the CPU
    expect(r.info!.depth).toBeGreaterThanOrEqual(3);
    for (const info of h.infos) expectWellFormedInfo(info, MIDDLEGAME, []);
  });

  it("clock: budgets from the side to move's own clock", async () => {
    const h = await start();
    const afterE4 = ["e2e4"]; // Black to move
    // Black has 400 ms (White plenty): a short think.
    const short = search(h, "startpos", afterE4, { clock: { wtime: 6000, btime: 400, winc: 0, binc: 0 } });
    expect(short.elapsedMs).toBeLessThan(150);
    // Black has 6 s: plans ~240 ms (soft limit), never more than 40 % of its time.
    const long = search(h, "startpos", afterE4, { clock: { wtime: 400, btime: 6000, winc: 0, binc: 0 } });
    expect(long.elapsedMs).toBeGreaterThan(150);
    expect(long.elapsedMs).toBeLessThan(6000 * 0.4);
    // Increment and moves-to-go are used, and a tiny clock still yields a move at once.
    const inc = search(h, "startpos", [], { clock: { wtime: 3000, btime: 3000, winc: 200, binc: 200, movestogo: 10 } });
    expect(inc.elapsedMs).toBeLessThan(3000 * 0.4);
    const panic = search(h, MIDDLEGAME, [], { clock: { wtime: 5, btime: 5, winc: 0, binc: 0 } });
    expect(panic.elapsedMs).toBeLessThan(100);
  });

  it("combined limits: the first limit reached ends the search", async () => {
    const h = await start();
    const byDepth = search(h, MIDDLEGAME, [], { depth: 3, movetimeMs: 5000 });
    expect(byDepth.info!.depth).toBe(3);
    expect(byDepth.elapsedMs).toBeLessThan(1000);
    const byTime = search(h, MIDDLEGAME, [], { depth: 60, movetimeMs: 150 });
    expect(byTime.elapsedMs).toBeLessThan(150 + 250);
    expect(byTime.info!.depth).toBeLessThan(60);
    const byNodes = search(h, MIDDLEGAME, [], { nodes: 5000, movetimeMs: 5000 });
    expect(byNodes.info!.nodes).toBeLessThanOrEqual(5064);
  });

  it("infinite: searches until the shared stop flag is raised (here from onInfo)", async () => {
    let raisedAt = 0;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const h = await start({
      stopFlag: flag,
      onInfo: (i) => {
        if (i.depth >= 9 && raisedAt === 0) {
          raisedAt = performance.now();
          Atomics.store(flag, 0, 1);
        }
      },
    });
    const r = search(h, "startpos", ["d2d4"], { infinite: true });
    const returnedAt = performance.now();
    expect(raisedAt).toBeGreaterThan(0);
    expect(returnedAt - raisedAt).toBeLessThan(250); // the engine polls the flag every 1024 nodes
    expect(Math.max(...h.infos.map((i) => i.depth))).toBeGreaterThanOrEqual(9);
    for (const info of h.infos) expectWellFormedInfo(info, "startpos", ["d2d4"]);
    expect(r.info).toEqual(h.infos.at(-1));

    // EngineInstance never clears the flag itself (EngineClient does), so it is still raised: the
    // next search ends at once, still with a legal (fallback) move.
    expect(Atomics.load(flag, 0)).toBe(1);
    const instant = search(h, MIDDLEGAME, [], { infinite: true });
    expect(instant.elapsedMs).toBeLessThan(100);
    Atomics.store(flag, 0, 0);
    // Cleared flag: normal searches work again.
    expect(search(h, MIDDLEGAME, [], { depth: 4 }).info!.depth).toBe(4);
  });

  it("infinite: another thread raising the flag ends the search (the engine.worker situation)", async () => {
    const h = await start();
    const raiser = new Worker(
      `const { workerData } = require("node:worker_threads");
       const flag = new Int32Array(workerData);
       setTimeout(() => Atomics.store(flag, 0, 1), 300);`,
      { eval: true, workerData: h.flag.buffer },
    );
    try {
      const r = search(h, KIWIPETE, [], { infinite: true });
      expect(r.elapsedMs).toBeGreaterThanOrEqual(250);
      expect(r.elapsedMs).toBeLessThan(300 + 1500); // includes starting the raiser thread
      expect(h.infos.length).toBeGreaterThan(2);
    } finally {
      await raiser.terminate();
      Atomics.store(h.flag, 0, 0);
    }
  });

  it("no legal move: go returns a null best move (mate and stalemate)", async () => {
    const h = await start();
    for (const fen of [MATED, STALEMATE]) {
      expect(h.engine.position(fen, [])).toBe(true);
      expect(h.engine.go({ depth: 4 }).bestMove).toBeNull();
      expect(h.engine.go({ movetimeMs: 50 }).bestMove).toBeNull();
    }
    // Mate in one is found and reported as a mate score from the side to move's point of view.
    expect(h.engine.position("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4", [])).toBe(true);
    const mate = h.engine.go({ depth: 4 });
    expect(mate.bestMove).toBe("f3f7");
    expect(mate.info).toMatchObject({ mate: 1, scoreCp: null });
  });

  it("eval(): White's point of view, colour-symmetric", async () => {
    const { engine } = await start();
    for (const fen of [KIWIPETE, MIDDLEGAME, ENDGAME, QUEEN_UP]) {
      expect(engine.position(fen, [])).toBe(true);
      const e = engine.eval()!;
      expect(engine.position(mirrorFen(fen), [])).toBe(true);
      expect(engine.eval(), mirrorFen(fen)).toBe(-e);
    }
    engine.position("startpos", []);
    expect(Math.abs(engine.eval()!)).toBeLessThan(50);
    engine.position(QUEEN_UP, []);
    expect(engine.eval()).toBeGreaterThan(600);
    engine.position(mirrorFen(QUEEN_UP), []);
    expect(engine.eval()).toBeLessThan(-600);
  });

  it("evalTrace(): labelled terms whose net (white - black) equals eval()", async () => {
    const { engine } = await start();
    for (const fen of ["startpos", KIWIPETE, MIDDLEGAME, ENDGAME, QUEEN_UP, mirrorFen(MIDDLEGAME)]) {
      expect(engine.position(fen, [])).toBe(true);
      const e = engine.eval()!;
      const trace = engine.evalTrace()!;
      expect(trace.length).toBeGreaterThan(3);
      const total = trace.at(-1)!;
      expect(total).toEqual({ label: "total", white: e, black: 0 });
      const terms = trace.slice(0, -1);
      for (const t of terms) {
        expect(t.label).toMatch(/\S/);
        expect(t.label).not.toBe("total");
        expect(Number.isInteger(t.white) && Number.isInteger(t.black)).toBe(true);
      }
      expect(new Set(terms.map((t) => t.label)).size).toBe(terms.length);
      expect(terms.reduce((sum, t) => sum + t.white - t.black, 0), fen).toBe(e);
      expect(engine.eval()).toBe(e); // tracing leaves nothing behind
    }
    engine.position("startpos", []);
    expect(engine.evalTrace()!.map((t) => t.label)).toEqual(expect.arrayContaining(["tempo"]));
    // Tracing does not disturb searching.
    expect(legalUci("startpos", [])).toContain(engine.go({ depth: 4 }).bestMove);
  });

  it("setOption Hash: accepted and applied; bad values and unknown options are refused", async () => {
    const { engine } = await start();
    expect(engine.setOption("Hash", "64")).toBe(true);
    expect(engine.setOption("Hash", "1")).toBe(true);
    expect(engine.setOption("hash", "4")).toBe(true); // names are case-insensitive in the template
    expect(engine.setOption("Hash", "0")).toBe(false);
    expect(engine.setOption("Hash", "lots")).toBe(false);
    expect(engine.setOption("Threads", "2")).toBe(false);
    engine.newGame();
    expect(engine.position(MIDDLEGAME, [])).toBe(true);
    expect(legalUci(MIDDLEGAME, [])).toContain(engine.go({ depth: 6 }).bestMove);
  });

  it("newGame clears what the engine learned: a repeated search then matches a fresh engine", async () => {
    const h = await start();
    const nodesAt = () => {
      expect(h.engine.position(MIDDLEGAME, [])).toBe(true);
      return h.engine.go({ depth: 8 }).info!.nodes;
    };
    const fresh = nodesAt();
    const warm = nodesAt(); // the transposition table remembers the first search
    expect(warm).toBeLessThan(fresh);
    h.engine.newGame();
    expect(nodesAt()).toBe(fresh);
  });
});

describe.skipIf(!nnueReady)("stock NNUE engine (template + variants/eval-nnue.ts) through EngineInstance", () => {
  let nnueWasm: Uint8Array;
  beforeAll(async () => {
    const src = stockNnueSources();
    const r = await compileSources(src.files, src.entry, { ...BUILD_OPTIONS });
    if (!r.ok || !r.wasm) throw new Error(`the stock NNUE engine failed to compile:\n${r.log}`);
    nnueWasm = r.wasm;
  });

  /** The JS reference evaluation (side to move POV) converted to White's POV. */
  const referenceWhite = (net: ArrayBuffer, fen: string) => {
    const stm = evaluateQuantized(parseNetworkFile(net), fen);
    return (fen.split(" ")[1] === "w" ? stm : -stm) + 0; // + 0: no -0
  };
  const FENS = [
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    KIWIPETE,
    MIDDLEGAME,
    ENDGAME,
  ];

  it("loads the network given at start-up (cb_nnue_alloc / cb_nnue_load) and evaluates exactly like the reference", async () => {
    for (const [hidden, activation] of [
      [32, 0],
      [128, 1],
    ] as const) {
      const net = quantizeNetwork(createNetwork(hidden, activation, 1000 + hidden));
      const logs: string[] = [];
      const engine = await EngineInstance.create(nnueWasm, { network: net, hashMb: 8, onLog: (s) => logs.push(s) });
      expect(engine.capabilities.nnue).toBe(true);
      expect(logs.some((l) => l.includes(`NNUE network loaded (${net.byteLength} bytes)`)), logs.join(" | ")).toBe(true);
      for (const fen of FENS) {
        expect(engine.position(fen, [])).toBe(true);
        expect(engine.eval(), `HL ${hidden}: ${fen}`).toBe(referenceWhite(net, fen));
        expect(engine.evalTrace()!.at(-1)!.white).toBe(engine.eval());
      }
      expect(engine.position(MIDDLEGAME, [])).toBe(true);
      expect(legalUci(MIDDLEGAME, [])).toContain(engine.go({ depth: 5 }).bestMove);
    }
  });

  it("swaps networks at run time with loadNetwork() and rejects corrupt files without breaking", async () => {
    const first = quantizeNetwork(createNetwork(32, 1, 1));
    const second = quantizeNetwork(createNetwork(64, 0, 2));
    const engine = await EngineInstance.create(nnueWasm, { network: first, hashMb: 8 });
    engine.position(KIWIPETE, []);
    expect(engine.eval()).toBe(referenceWhite(first, KIWIPETE));
    expect(engine.loadNetwork(second)).toBe(true);
    expect(engine.eval()).toBe(referenceWhite(second, KIWIPETE));
    const corrupt = new Uint8Array(second.slice(0));
    corrupt[0] ^= 0xff; // bad magic
    expect(engine.loadNetwork(corrupt.buffer)).toBe(false);
    expect(engine.broken).toBe(false);
    expect(legalUci(KIWIPETE, [])).toContain(engine.go({ depth: 3 }).bestMove);
    // A corrupt network at start-up is a descriptive error, not a broken engine.
    await expect(EngineInstance.create(nnueWasm, { network: corrupt.buffer })).rejects.toThrow(/rejected the network/);
  });
});
