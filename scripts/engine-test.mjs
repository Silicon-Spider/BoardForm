#!/usr/bin/env node
// =====================================================================================
// Engine tests: compiles an AssemblyScript engine with the app's compiler flags and checks
// it against docs/ENGINE_ABI.md — move generation (perft), position parsing, search limits,
// mate finding, draw handling, evaluation symmetry / trace, options, plus a speed bench.
//
//   npm run test:engine                         # the canonical template (engine/template)
//   node scripts/engine-test.mjs --dir <dir> [--entry main.ts]
//                                               # another engine: tests whose optional
//                                               # exports are missing are skipped
//   node scripts/engine-test.mjs --file eval.ts=engine/variants/eval-nnue.ts
//                                               # replace single files of the engine
//   options: --only a,b   --skip a,b   --list   --verbose
//
// Exit code: 0 when every executed test passed, 1 otherwise.
// =====================================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileEngine } from "./engine-test/compile.mjs";
import { TestEngine, REQUIRED_EXPORTS, OPTIONAL_EXPORTS } from "./engine-test/host.mjs";
import {
  assert, assertEq, mirrorFen, legalUci, chessFromCommand, randomPositions, playPv, Chess,
} from "./engine-test/util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ----------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { dir: path.join(ROOT, "engine/template"), entry: "main.ts", only: null, skip: [], list: false, verbose: false, custom: false, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--dir") { args.dir = path.resolve(next()); args.custom = true; }
    else if (a === "--entry") args.entry = next();
    else if (a === "--file") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq <= 0) throw new Error(`--file expects name=path, got ${spec}`);
      args.overrides[spec.slice(0, eq)] = path.resolve(spec.slice(eq + 1));
      args.custom = true;
    }
    else if (a === "--only") args.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--skip") args.skip = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--list") args.list = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/engine-test.mjs [--dir <engine dir>] [--entry main.ts] [--file name=path ...] [--only a,b] [--skip a,b] [--list] [--verbose]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// --------------------------------------------------------------------------- data

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

const PERFT_SUITE = [
  { name: "startpos", fen: START, counts: [20, 400, 8902, 197281, 4865609] },
  { name: "kiwipete", fen: KIWIPETE, counts: [48, 2039, 97862, 4085603] },
  { name: "position 3", fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", counts: [14, 191, 2812, 43238, 674624] },
  { name: "position 4", fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", counts: [6, 264, 9467, 422333] },
  { name: "position 5", fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", counts: [44, 1486, 62379, 2103487] },
  // The standard "position 6" has a black bishop on g4. The same FEN without that bishop (as it
  // was written in the work order) has 47 / 1845 / 81467 / 3065277 nodes (verified with chess.js).
  { name: "position 6", fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", counts: [46, 2079, 89890, 3894594] },
  { name: "pos 6 no Bg4", fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", counts: [47, 1845, 81467, 3065277] },
];

// Shortest forced mates verified independently with a chess.js brute-force solver.
// mate > 0: side to move mates in N moves; mate < 0: side to move is mated in N moves.
const MATE_PUZZLES = [
  { fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", mate: 1, note: "back-rank mate" },
  { fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4", mate: 1, note: "scholar's mate" },
  { fen: "3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", mate: 1, note: "back-rank mate, Black" },
  { fen: "r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1", mate: 2, note: "Nf6+ gxf6 Bxf7#" },
  { fen: "7k/8/8/8/8/8/R7/1R4K1 w - - 0 1", mate: 2, note: "rook ladder" },
  { fen: "1r4k1/r7/8/8/8/8/8/7K b - - 0 1", mate: 2, note: "rook ladder, Black" },
  { fen: "8/8/4k3/8/4K3/8/8/1R3R2 w - - 0 1", mate: 3, note: "two rooks" },
  { fen: "5R2/6K1/k7/8/8/8/8/6R1 w - - 0 1", mate: 3, note: "two rooks" },
  { fen: "8/7q/8/8/8/K7/3k4/8 b - - 0 1", mate: 3, note: "queen, Black" },
  { fen: "k7/8/1K6/8/8/8/8/7R b - - 0 1", mate: -1, note: "side to move gets mated" },
];

// White can only save itself with a perpetual check: Qe8+ Kh7 Qh5+ Kg8 ...
const PERPETUAL = "6k1/pp4p1/8/7Q/8/8/q7/7K w - - 0 1";

const BENCH_POSITIONS = [
  START,
  KIWIPETE,
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  "8/8/1p1k4/p1pP4/P1P1K3/8/8/8 w - - 0 1",
];
const BENCH_DEPTH = 13;

// ------------------------------------------------------------------------- runner

const tests = [];
/** Registers a test. `requires` lists exports that must exist (otherwise the test is skipped). */
function test(name, requires, fn) {
  tests.push({ name, requires, fn });
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
let verbose = false;
const detail = (...a) => console.log("      ", ...a);
const debug = (...a) => { if (verbose) detail(...a); };

let engineModule = null;
async function freshEngine() {
  const e = await TestEngine.create(engineModule);
  e.newGame();
  return e;
}

/** Last info of a search, required to exist. */
function lastInfo(result, what) {
  assert(result.last, `${what}: no cb_info received`);
  return result.last;
}

function assertLegalBest(fen, best, what) {
  const legal = legalUci(new Chess(fen));
  assert(best !== null, `${what}: no move returned (legal moves: ${legal.length})`);
  assert(legal.includes(best), `${what}: illegal best move ${best} in ${fen}`);
}

// ---------------------------------------------------------------------- the tests

test("exports", [], async () => {
  const exportsList = WebAssembly.Module.exports(engineModule);
  const names = new Set(exportsList.map((x) => x.name));
  assert(exportsList.some((x) => x.name === "memory" && x.kind === "memory"), "memory export missing");
  const e = await TestEngine.create(engineModule, { init: false });
  for (const [name, params] of Object.entries(REQUIRED_EXPORTS)) {
    assert(names.has(name) && typeof e.exports[name] === "function", `required export ${name} missing`);
    assertEq(e.exports[name].length, params, `${name} parameter count`);
  }
  const optional = [];
  for (const [name, params] of Object.entries(OPTIONAL_EXPORTS)) {
    if (!names.has(name)) {
      assert(args.custom, `optional export ${name} missing (the template must export it)`);
      continue;
    }
    assertEq(e.exports[name].length, params, `${name} parameter count`);
    optional.push(name);
  }
  assertEq(e.exports.cb_abi_version(), 1, "cb_abi_version()");
  e.exports.cb_init();
  const inPtr = e.exports.cb_in();
  const outPtr = e.exports.cb_out();
  const memSize = e.memory.buffer.byteLength;
  assert(inPtr > 0 && inPtr + 65536 <= memSize, "input buffer outside memory");
  assert(outPtr > 0 && outPtr + 65536 <= memSize, "output buffer outside memory");
  assert(inPtr + 65536 <= outPtr || outPtr + 65536 <= inPtr, "input and output buffers overlap");
  const imports = WebAssembly.Module.imports(engineModule).map((i) => `${i.module}.${i.name}`);
  assert(e.stubbedImports.length === 0 || args.custom, `unexpected imports: ${e.stubbedImports.join(", ")}`);
  detail(`optional: ${optional.join(", ") || "none"}`);
  detail(`imports: ${imports.join(", ")}`);
});

test("perft", ["cb_perft"], async () => {
  const e = await freshEngine();
  let totalNodes = 0;
  let totalMs = 0;
  for (const p of PERFT_SUITE) {
    assert(e.position(`fen ${p.fen}`), `cb_position failed for ${p.name}`);
    const parts = [];
    for (let d = 1; d <= p.counts.length; d++) {
      const t0 = performance.now();
      const n = e.perft(d);
      const ms = performance.now() - t0;
      assertEq(n, p.counts[d - 1], `${p.name} perft(${d})`);
      if (d === p.counts.length) {
        totalNodes += n;
        totalMs += ms;
        parts.push(`d${d} ${fmt(n)} in ${ms.toFixed(0)} ms = ${fmt(n / Math.max(ms, 0.001) * 1000)} nodes/s`);
      }
    }
    detail(`${p.name.padEnd(12)} ok  ${parts.join("")}`);
  }
  detail(`total ${fmt(totalNodes)} leaf nodes in ${totalMs.toFixed(0)} ms = ${fmt(totalNodes / totalMs * 1000)} nodes/s`);
});

test("position-parsing", ["cb_perft"], async () => {
  const e = await freshEngine();
  const commands = [
    "startpos",
    "startpos moves",
    "startpos moves e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1", // white castles king-side
    "startpos moves d2d4 d7d5 b1c3 b8c6 c1f4 c8f5 d1d2 d8d7 e1c1 e8c8", // both castle queen-side
    "startpos moves e2e4 a7a6 e4e5 d7d5 e5d6", // en passant
    "startpos moves e2e4 g8f6 e4e5 d7d5", // en-passant square available
    "fen rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3 moves e5f6", // FEN e.p. square
    "fen 8/P7/8/8/8/8/8/k6K w - - 0 1 moves a7a8q", // promotion
    "fen 8/P7/8/8/8/8/8/k6K w - - 0 1 moves a7a8n", // under-promotion
    "fen 1n6/P7/8/8/8/8/8/k6K w - - 0 1 moves a7b8r", // capture-promotion
    "fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1c1 e8g8", // FEN + castling both ways
    "fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves a1a8", // rook captures rook: rights lost
    `fen ${KIWIPETE} moves e1g1 h3g2 d5e6 g2f1q`, // capture-promotion with check
    "fen 4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", // 4-field-only style castling with one side
    "fen rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", // 6 fields
    "fen rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -", // counters omitted
    "position startpos moves e2e4", // full UCI command tolerated
  ];
  for (const cmd of commands) {
    assert(e.position(cmd), `rejected valid command: ${cmd}`);
    const ref = chessFromCommand(cmd.replace(/^position\s+/, ""));
    for (let d = 1; d <= 3; d++) {
      assertEq(e.perft(d), ref.perft(d), `perft(${d}) after "${cmd}"`);
    }
    debug(`ok: ${cmd}`);
  }
  detail(`${commands.length} commands verified with perft(1..3) against chess.js`);
});

test("position-rejects", ["cb_perft"], async () => {
  const e = await freshEngine();
  const bad = [
    "",
    "   ",
    "foo",
    "startpos e2e4", // missing "moves"
    "startpos moves e2e5", // illegal move
    "startpos moves e2e4 e2e4", // second move illegal
    "startpos moves e1g1", // castling through pieces
    "startpos moves e7e5", // wrong side
    "startpos moves e2e4 e7e5 e4e5", // blocked pawn
    "startpos moves a2a1q", // nonsense promotion
    "startpos moves e2e4x",
    "fen",
    "fen 8/8/8/8/8/8/8/8 w - - 0 1", // no kings
    "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", // bad side
    "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1", // short rank
    "fen rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // 9 squares
    "fen rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // 7 ranks
    "fen 4k3/4R3/8/8/8/8/8/4K3 w - - 0 1", // side not to move is in check
    "fen 4k3/8/8/8/8/8/8/4K2P w - - 0 1", // pawn on the first rank
    "fen kk6/8/8/8/8/8/8/4K3 w - - 0 1", // two black kings
    "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1", // bad e.p. square
    "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - x 1", // bad counter
    "fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1f1 e8f8 f1e1 f8e8 e1g1", // castling rights lost after king moves
  ];
  assert(e.position("startpos moves e2e4 e7e5"), "baseline position");
  const baseline = [e.perft(1), e.perft(2)];
  for (const cmd of bad) {
    assert(!e.position(cmd), `accepted invalid command: "${cmd}"`);
    assertEq(e.perft(1), baseline[0], `position changed after rejected "${cmd}" (perft 1)`);
    assertEq(e.perft(2), baseline[1], `position changed after rejected "${cmd}" (perft 2)`);
  }
  detail(`${bad.length} invalid commands rejected, previous position kept`);
});

test("mate-puzzles", [], async () => {
  const e = await freshEngine();
  for (const p of MATE_PUZZLES) {
    e.newGame();
    assert(e.position(`fen ${p.fen}`), `cb_position failed: ${p.fen}`);
    const depth = 2 * Math.abs(p.mate) + 4;
    const r = e.go({ depth });
    const info = lastInfo(r, p.note);
    assertLegalBest(p.fen, r.best, p.note);
    assertEq(info.mate, p.mate, `${p.note} (${p.fen}) mate score`);
    assertEq(info.pv[0], r.best, `${p.note}: PV starts with the best move`);
    const plies = p.mate > 0 ? 2 * p.mate - 1 : -2 * p.mate;
    const played = playPv(p.fen, info.pv.slice(0, plies));
    assert(played.ok, `${p.note}: PV has an illegal move ${played.failedAt}`);
    assert(played.chess.isCheckmate(), `${p.note}: PV ${info.pv.slice(0, plies).join(" ")} does not end in mate`);
    debug(`${p.note}: ${r.best} mate ${info.mate} pv ${info.pv.join(" ")}`);
  }
  detail(`${MATE_PUZZLES.length} puzzles solved with the correct mate distance`);
});

test("limit-depth", [], async () => {
  const e = await freshEngine();
  e.position(`fen ${KIWIPETE}`);
  const r = e.go({ depth: 5 });
  const info = lastInfo(r, "depth 5");
  assertEq(Math.max(...r.infos.map((i) => i.depth)), 5, "deepest reported depth");
  assertEq(info.depth, 5, "last reported depth");
  assertLegalBest(KIWIPETE, r.best, "depth 5");
  const depths = r.infos.map((i) => i.depth);
  for (let i = 1; i < depths.length; i++) assert(depths[i] >= depths[i - 1], "depths must not decrease");
  detail(`depths ${depths.join(",")} in ${r.elapsedMs.toFixed(0)} ms`);
});

test("limit-nodes", [], async () => {
  const e = await freshEngine();
  e.position(`fen ${KIWIPETE}`);
  const r = e.go({ nodes: 20000 });
  const info = lastInfo(r, "nodes 20000");
  assertLegalBest(KIWIPETE, r.best, "nodes 20000");
  assert(info.nodes <= 40000, `searched ${info.nodes} nodes for a 20000 node limit`);
  const tiny = e.go({ nodes: 1 });
  assertLegalBest(KIWIPETE, tiny.best, "nodes 1");
  detail(`nodes=20000 -> ${fmt(info.nodes)} nodes (depth ${info.depth}), nodes=1 -> ${tiny.best}`);
});

test("limit-movetime", [], async () => {
  const e = await freshEngine();
  e.position(`fen ${KIWIPETE}`);
  const r = e.go({ movetime: 200 });
  assertLegalBest(KIWIPETE, r.best, "movetime 200");
  assert(r.elapsedMs < 320, `movetime 200 took ${r.elapsedMs.toFixed(0)} ms`);
  assert(r.elapsedMs > 100, `movetime 200 returned after only ${r.elapsedMs.toFixed(0)} ms`);
  detail(`movetime 200 -> ${r.elapsedMs.toFixed(0)} ms, depth ${lastInfo(r, "movetime").depth}`);
});

test("limit-clock", [], async () => {
  const e = await freshEngine();
  const cases = [
    { fen: KIWIPETE, limits: { wtime: 1000, btime: 1000, winc: 0, binc: 0 }, maxMs: 250 },
    { fen: mirrorFen(KIWIPETE), limits: { wtime: 1000, btime: 1000, winc: 0, binc: 0 }, maxMs: 250 },
    { fen: START, limits: { wtime: 10000, btime: 10000, winc: 100, binc: 100, movestogo: 0 }, maxMs: 2000 },
    { fen: START, limits: { wtime: 50, btime: 50, winc: 0, binc: 0 }, maxMs: 50 },
    { fen: START, limits: { wtime: 3000, btime: 3000, movestogo: 1 }, maxMs: 2500 },
  ];
  for (const c of cases) {
    e.position(`fen ${c.fen}`);
    const r = e.go(c.limits);
    assertLegalBest(c.fen, r.best, `clock ${JSON.stringify(c.limits)}`);
    assert(r.elapsedMs < c.maxMs, `clock ${JSON.stringify(c.limits)} used ${r.elapsedMs.toFixed(0)} ms (max ${c.maxMs})`);
    detail(`${JSON.stringify(c.limits)} -> ${r.elapsedMs.toFixed(0)} ms, depth ${r.last?.depth ?? 0}`);
  }
});

test("stop-flag", [], async () => {
  const e = await freshEngine();
  e.position(`fen ${KIWIPETE}`);
  e.stopMode = "afterFirstInfo";
  const r = e.go({}); // infinite search, stopped by the host after the first report
  e.stopMode = "never";
  assertLegalBest(KIWIPETE, r.best, "stop after first info");
  assert(r.infos.length > 0, "no info before stopping");
  const afterStop = performance.now() - e.firstInfoAt;
  assert(afterStop < 100, `returned ${afterStop.toFixed(0)} ms after the stop request`);

  e.stopMode = "always"; // stopped from the very beginning
  const r2 = e.go({});
  e.stopMode = "never";
  assertLegalBest(KIWIPETE, r2.best, "stop immediately");
  assert(r2.elapsedMs < 100, `immediate stop took ${r2.elapsedMs.toFixed(0)} ms`);
  detail(`stopped ${afterStop.toFixed(1)} ms after the request; immediate stop -> ${r2.best} in ${r2.elapsedMs.toFixed(1)} ms`);
});

test("no-legal-moves", [], async () => {
  const e = await freshEngine();
  const cases = [
    { fen: "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4", what: "checkmate" },
    { fen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", what: "stalemate" },
    { fen: "8/8/8/8/8/5k2/5p2/5K2 w - - 0 1", what: "stalemate (white)" },
  ];
  for (const c of cases) {
    const chess = new Chess(c.fen);
    assert(chess.moves().length === 0, `reference says ${c.what} has moves`);
    assert(e.position(`fen ${c.fen}`), `cb_position ${c.what}`);
    const r = e.go({ depth: 4 });
    assertEq(r.best, null, `${c.what}: cb_go must return 0`);
    const r2 = e.go({ movetime: 50 });
    assertEq(r2.best, null, `${c.what} (movetime): cb_go must return 0`);
  }
  detail("checkmate and stalemate positions return 0");
});

test("random-positions", [], async () => {
  const e = await freshEngine();
  const fens = randomPositions(220, 20261101);
  let searched = 0;
  let terminal = 0;
  for (const fen of fens) {
    const chess = new Chess(fen);
    assert(e.position(`fen ${fen}`), `cb_position rejected ${fen}`);
    const legal = legalUci(chess);
    if (e.has("cb_perft")) {
      assertEq(e.perft(1), legal.length, `perft(1) of ${fen}`);
      if (searched < 60) assertEq(e.perft(2), chess.perft(2), `perft(2) of ${fen}`);
    }
    const r = e.go({ depth: 4, nodes: 30000 });
    if (legal.length === 0) {
      assertEq(r.best, null, `no legal moves in ${fen}`);
      terminal++;
      continue;
    }
    assert(legal.includes(r.best), `illegal best move ${r.best} in ${fen}`);
    const info = lastInfo(r, fen);
    assertEq(info.pv[0], r.best, `PV must start with the best move in ${fen}`);
    const played = playPv(fen, info.pv);
    assert(played.ok, `illegal PV move ${played.failedAt} in "${info.pv.join(" ")}" from ${fen}`);
    searched++;
  }
  detail(`${searched} positions: legal best moves and PVs${e.has("cb_perft") ? ", perft cross-checked" : ""}; ${terminal} terminal positions`);
});

test("repetition", [], async () => {
  const e = await freshEngine();
  // 1. Perpetual check: the only way for White to avoid losing.
  assert(e.position(`fen ${PERPETUAL}`), "perpetual position");
  const staticEval = e.has("cb_eval") ? e.eval() : null;
  const r = e.go({ depth: 10 });
  const info = lastInfo(r, "perpetual");
  assertEq(info.mate, 0, "perpetual: no mate score");
  assertEq(info.score, 0, `perpetual check score (static eval ${staticEval})`);
  if (staticEval !== null) assert(staticEval < -150, `static eval ${staticEval} should be clearly bad for White`);
  assertEq(r.best, "h5e8", "perpetual: Qe8+ keeps checking");

  // 2. Repetition through the game history passed with cb_position: at depth 1 the engine
  //    can only see the draw if it remembers that Qe8+ repeats an earlier position.
  e.newGame();
  assert(e.position(`fen ${PERPETUAL}`), "position without history");
  const without = lastInfo(e.go({ depth: 1 }), "depth 1 without history");
  e.newGame();
  assert(e.position(`fen ${PERPETUAL} moves h5e8 g8h7 e8h5 h7g8`), "position with history");
  const withHistory = e.go({ depth: 1 });
  const withInfo = lastInfo(withHistory, "depth 1 with history");
  assert(without.score < -100, `without history depth 1 should look bad, got ${without.score}`);
  assertEq(withInfo.score, 0, "depth 1 with game history: repetition draw");
  assertEq(withHistory.best, "h5e8", "with history: repeat the position");

  // 3. Fifty-move rule: with the counter at 99 every quiet move ends the game in a draw.
  const fifty = "7k/8/8/8/8/8/8/1Q5K w - - 99 120";
  e.newGame();
  assert(e.position(`fen ${fifty}`), "fifty-move position");
  const drawn = lastInfo(e.go({ depth: 6 }), "fifty-move");
  e.newGame();
  assert(e.position(`fen ${fifty.replace(" 99 120", " 0 120")}`), "fifty-move position with counter 0");
  const winning = lastInfo(e.go({ depth: 6 }), "no fifty-move");
  assertEq(drawn.score, 0, "fifty-move rule draw");
  assert(winning.score > 500 || winning.mate > 0, `without the fifty-move counter KQ v K should be winning (${winning.score})`);
  detail(`perpetual score 0 (static eval ${staticEval}); history repetition 0 vs ${without.score} without; fifty-move 0 vs ${winning.mate ? "mate " + winning.mate : winning.score}`);
});

test("eval-symmetry", ["cb_eval"], async () => {
  const e = await freshEngine();
  const fens = [START, KIWIPETE, ...PERFT_SUITE.map((p) => p.fen), ...MATE_PUZZLES.map((p) => p.fen), ...randomPositions(220, 777)];
  let checked = 0;
  for (const fen of fens) {
    const mirrored = mirrorFen(fen);
    assert(e.position(`fen ${fen}`), `cb_position ${fen}`);
    const a = e.eval();
    assert(e.position(`fen ${mirrored}`), `cb_position ${mirrored}`);
    const b = e.eval();
    assertEq(b, -a, `eval(mirror) must be -eval for ${fen} (mirror ${mirrored})`);
    checked++;
  }
  detail(`${checked} positions: eval(mirror(p)) == -eval(p)`);
});

test("eval-trace", ["cb_eval", "cb_eval_trace"], async () => {
  const e = await freshEngine();
  const fens = [START, KIWIPETE, ...PERFT_SUITE.map((p) => p.fen), ...randomPositions(40, 99)];
  let terms = 0;
  for (const fen of fens) {
    e.position(`fen ${fen}`);
    const value = e.eval();
    const text = e.evalTrace();
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert(lines.length > 0, "empty trace");
    let net = 0;
    let total = null;
    for (const line of lines) {
      const parts = line.split("\t");
      assertEq(parts.length, 3, `trace line "${line}" fields`);
      const [label, w, b] = parts;
      assert(label.length > 0, "empty label");
      assert(/^-?\d+$/.test(w) && /^-?\d+$/.test(b), `non-integer values in "${line}"`);
      if (label === "total") total = Number(w);
      else {
        net += Number(w) - Number(b);
        terms++;
      }
    }
    if (total !== null) assertEq(total, value, `trace total for ${fen}`);
    // A custom evaluation may not report any terms (then only the total line is checked).
    const termLines = lines.filter((l) => !l.startsWith("total\t")).length;
    if (termLines > 0 || !args.custom) assertEq(net, value, `trace terms must add up to cb_eval for ${fen}`);
    assertEq(e.eval(), value, "cb_eval after cb_eval_trace");
  }
  if (terms === 0) detail(`${fens.length} traces parsed; the evaluation reports no terms (only "total")`);
  else detail(`${fens.length} traces add up exactly (${terms} terms)`);
});

test("odd-arguments", [], async () => {
  const e = await freshEngine();
  e.position(`fen ${KIWIPETE}`);
  // Out-of-range or non-finite limits must not crash the engine.
  const cases = [
    { depth: 1000 }, { depth: -5, nodes: 5000 }, { nodes: Infinity, depth: 3 }, { nodes: NaN, depth: 3 },
    { nodes: 1e300, depth: 3 }, { movetime: -10, depth: 3 }, { wtime: 0, btime: 0 }, { wtime: 1, btime: 1, movestogo: 1 },
  ];
  for (const c of cases) {
    const limits = { ...c };
    if (limits.depth === 1000) e.stopMode = () => e.infos.length >= 6; // keep it short
    const r = e.go(limits);
    e.stopMode = "never";
    assertLegalBest(KIWIPETE, r.best, `go(${JSON.stringify(c)})`);
  }
  // Very long move lists (repetition history beyond the undo stack capacity).
  const shuffle = Array.from({ length: 700 }, () => "g1f3 g8f6 f3g1 f6g8").join(" ");
  assert(e.position(`startpos moves ${shuffle} e2e4`), "position with 2801 moves");
  assertLegalBest(new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").fen(), e.go({ depth: 4 }).best, "after a long game");
  detail(`${cases.length} unusual limit combinations and a 2801-ply game handled`);
});

test("hash-option", ["cb_set_option"], async () => {
  const e = await TestEngine.create(engineModule);
  assert(e.setOption("Hash=32"), "Hash=32 not accepted");
  assert(e.setOption("hash = 8"), "hash = 8 not accepted");
  assert(e.setOption("Hash=1"), "Hash=1 not accepted");
  assert(!e.setOption("NoSuchOption=1"), "unknown option accepted");
  assert(!e.setOption("Hash=abc"), "Hash=abc accepted");
  assert(!e.setOption("Hash"), "Hash without value accepted");
  assert(e.setOption("Hash=64"), "Hash=64 not accepted");
  e.newGame();
  e.position(`fen ${KIWIPETE}`);
  const r = e.go({ depth: 6 });
  assertLegalBest(KIWIPETE, r.best, "search after Hash=64");
  detail(`Hash option accepted (memory now ${(e.memory.buffer.byteLength / 1048576).toFixed(0)} MiB)`);
});

test("nnue-exports", ["cb_nnue_alloc", "cb_nnue_load"], async () => {
  const e = await freshEngine();
  const size = 4096;
  const ptr = e.exports.cb_nnue_alloc(size);
  assert(ptr > 0 && ptr + size <= e.memory.buffer.byteLength, `cb_nnue_alloc(${size}) returned ${ptr}`);
  new Uint8Array(e.memory.buffer, ptr, size).fill(0); // not a CBNN file
  assertEq(e.exports.cb_nnue_load(size), 0, "garbage network must be rejected");
  e.position("startpos");
  assertLegalBest(START, e.go({ depth: 4 }).best, "search after rejected network");
  detail("buffer allocated, invalid network rejected, engine still works");
});

test("name", ["cb_name"], async () => {
  const e = await freshEngine();
  const name = e.name();
  assert(name.length > 0 && name.length < 200 && /^[\x20-\x7e]+$/.test(name), `bad name "${name}"`);
  detail(`"${name}"`);
});

test("bench", [], async () => {
  const e = await freshEngine();
  // Untimed warm-up: V8 first runs WebAssembly with a baseline compiler and optimises hot
  // functions in the background, so the first searches of a fresh module are slower.
  for (const fen of [START, KIWIPETE]) {
    e.position(`fen ${fen}`);
    e.go({ depth: 11 });
  }
  let totalNodes = 0;
  let totalMs = 0;
  for (const fen of BENCH_POSITIONS) {
    e.newGame();
    e.position(`fen ${fen}`);
    const r = e.go({ depth: BENCH_DEPTH });
    const info = lastInfo(r, "bench");
    assertLegalBest(fen, r.best, "bench");
    totalNodes += info.nodes;
    totalMs += r.elapsedMs;
    const score = info.mate ? `mate ${info.mate}` : `${info.score} cp`;
    detail(`${fen.padEnd(72)} ${r.best.padEnd(6)} ${score.padStart(8)} ${fmt(info.nodes).padStart(10)} nodes ${r.elapsedMs.toFixed(0).padStart(6)} ms`);
  }
  detail(`bench depth ${BENCH_DEPTH}: ${fmt(totalNodes)} nodes in ${totalMs.toFixed(0)} ms = ${fmt(totalNodes / totalMs * 1000)} nps`);
});

// --------------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
verbose = args.verbose;

if (args.list) {
  for (const t of tests) console.log(`${t.name}${t.requires.length ? `  (needs ${t.requires.join(", ")})` : ""}`);
  process.exit(0);
}

const tStart = performance.now();
console.log(`engine: ${path.relative(ROOT, path.join(args.dir, args.entry)) || args.entry}`);
for (const [name, file] of Object.entries(args.overrides)) console.log(`  ${name} <- ${path.relative(ROOT, file)}`);
let compiled;
try {
  compiled = await compileEngine(args.dir, args.entry, args.overrides);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`compiled in ${(compiled.ms / 1000).toFixed(1)} s, ${fmt(compiled.wasm.length)} bytes${compiled.log ? `\n${compiled.log}` : ""}`);
engineModule = await WebAssembly.compile(compiled.wasm);
const exportNames = new Set(WebAssembly.Module.exports(engineModule).map((x) => x.name));

let passed = 0;
let failed = 0;
let skipped = 0;
for (const t of tests) {
  if (args.only && !args.only.includes(t.name)) continue;
  if (args.skip.includes(t.name)) {
    skipped++;
    continue;
  }
  const missing = t.requires.filter((name) => !exportNames.has(name));
  if (missing.length > 0) {
    console.log(`SKIP  ${t.name} (engine does not export ${missing.join(", ")})`);
    skipped++;
    continue;
  }
  const t0 = performance.now();
  try {
    console.log(`----  ${t.name}`);
    await t.fn();
    console.log(`PASS  ${t.name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${t.name}: ${err.message}`);
    if (verbose && !(err.name === "AssertionError")) console.log(err.stack);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped in ${((performance.now() - tStart) / 1000).toFixed(1)} s`);
process.exit(failed > 0 ? 1 : 0);
