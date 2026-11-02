#!/usr/bin/env node
// =====================================================================================
// NNUE engine tests: compiles the engine template with eval.ts replaced by
// engine/variants/eval-nnue.ts (same compiler flags as the app) and checks the engine's NNUE
// inference (engine/template/nnue.ts) against an independent JavaScript implementation of
// docs/NNUE_FORMAT.md that is written in this file, straight from the spec:
//
//   * cb_eval must EXACTLY equal the JS quantized evaluator (converted to White's point of
//     view and clamped like the engine) for random networks — both activations, hidden sizes
//     8 / 32 / 128 / 256 plus extra shapes — on positions from random playouts,
//   * malformed network files are rejected and the previously loaded network stays active,
//   * the evaluation trace, colour symmetry, searching with a network loaded,
//   * the fallback evaluation when no network is loaded,
//   * speed: evaluations per second and search nodes per second vs. the hand-crafted eval.
//
//   node scripts/nnue-test.mjs [--only a,b] [--skip a,b] [--positions N] [--bench-ms N]
//                              [--file name=path ...] [--list] [--verbose]
//
//   --file nnue.ts=my/nnue.ts   compile another file in place of a template file (for example
//                               a modified nnue.ts or eval.ts) in the NNUE build
//
// Nothing from src/nnue is imported: the CBNN writer and evaluator below are deliberately a
// second, independent implementation of the spec.
//
// Exit code: 0 when every executed test passed, 1 otherwise.
// =====================================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileEngine } from "./engine-test/compile.mjs";
import { TestEngine } from "./engine-test/host.mjs";
import { assert, assertEq, makeRng, mirrorFen, legalUci, randomPositions, playPv, Chess } from "./engine-test/util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.join(ROOT, "engine/template");
const NNUE_EVAL = path.join(ROOT, "engine/variants/eval-nnue.ts");

// ----------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { only: null, skip: [], list: false, verbose: false, positions: 600, benchMs: 400, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--only") args.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--skip") args.skip = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--positions") args.positions = Math.max(1, Number(next()) | 0);
    else if (a === "--bench-ms") args.benchMs = Math.max(20, Number(next()) | 0);
    else if (a === "--file") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq <= 0) throw new Error(`--file expects name=path, got ${spec}`);
      args.overrides[spec.slice(0, eq)] = path.resolve(spec.slice(eq + 1));
    }
    else if (a === "--list") args.list = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/nnue-test.mjs [--only a,b] [--skip a,b] [--positions N] [--bench-ms N] [--file name=path ...] [--list] [--verbose]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// ======================================================================================
// docs/NNUE_FORMAT.md, implemented independently
// ======================================================================================

const QA = 255;
const QB = 64;
const SCALE = 400;
const INPUTS = 768;
/** The engine clamps evaluations to ±(MATE_BOUND - 1) (docs/ENGINE_TEMPLATE.md: MATE_BOUND = 31000). */
const EVAL_LIMIT = 30999;
const fileSize = (hidden) => 68 + 1542 * hidden;
const ACTIVATION_NAMES = ["CReLU", "SCReLU"];

/**
 * A random quantized network. Integer ranges are inclusive [lo, hi] for W1q, b1q, W2q, b2q.
 * `w2Values` (optional) draws W2 from a fixed list instead (boundary values).
 */
function randomNetwork({ hidden, activation, seed, w1, b1, w2, b2, w2Values = null }) {
  const rng = makeRng(seed);
  const int = ([lo, hi]) => lo + Math.floor(rng() * (hi - lo + 1));
  const net = {
    hidden,
    activation,
    w1: new Int16Array(INPUTS * hidden),
    b1: new Int16Array(hidden),
    w2: new Int16Array(2 * hidden),
    b2: int(b2),
  };
  for (let i = 0; i < net.w1.length; i++) net.w1[i] = int(w1);
  for (let i = 0; i < net.b1.length; i++) net.b1[i] = int(b1);
  for (let i = 0; i < net.w2.length; i++) {
    net.w2[i] = w2Values ? w2Values[Math.floor(rng() * w2Values.length)] : int(w2);
  }
  return net;
}

/** Serialises a network as a CBNN v1 file. `header` overrides header fields (for corrupt files). */
function writeCbnn(net, header = {}) {
  const h = {
    magic: "CBNN", version: 1, inputs: INPUTS, hidden: net.hidden, activation: net.activation,
    qa: QA, qb: QB, scale: SCALE, flags: 0, ...header,
  };
  const hl = net.hidden;
  const bytes = new Uint8Array(fileSize(hl));
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = h.magic.charCodeAt(i) & 255;
  dv.setUint32(4, h.version >>> 0, true);
  dv.setUint32(8, h.inputs >>> 0, true);
  dv.setUint32(12, h.hidden >>> 0, true);
  dv.setUint32(16, h.activation >>> 0, true);
  dv.setUint32(20, h.qa >>> 0, true);
  dv.setUint32(24, h.qb >>> 0, true);
  dv.setUint32(28, h.scale >>> 0, true);
  dv.setUint32(32, h.flags >>> 0, true);
  // bytes 36..63: reserved, zero
  let o = 64;
  for (const v of net.w1) { dv.setInt16(o, v, true); o += 2; }
  assertEq(o, 64 + 1536 * hl, "W1 end offset");
  for (const v of net.b1) { dv.setInt16(o, v, true); o += 2; }
  assertEq(o, 64 + 1538 * hl, "b1 end offset");
  for (const v of net.w2) { dv.setInt16(o, v, true); o += 2; }
  assertEq(o, 64 + 1542 * hl, "W2 end offset");
  dv.setInt32(o, net.b2, true);
  assertEq(o + 4, bytes.length, "file size");
  return bytes;
}

/** Active features of a FEN for both perspectives (feature index formula of the spec). */
function features(fen) {
  const [board, side] = fen.trim().split(/\s+/);
  const white = [];
  const black = [];
  let rank = 7;
  let file = 0;
  for (const ch of board) {
    if (ch === "/") { rank--; file = 0; continue; }
    if (ch >= "1" && ch <= "8") { file += Number(ch); continue; }
    const color = ch === ch.toUpperCase() ? 0 : 1;
    const type = "pnbrqk".indexOf(ch.toLowerCase());
    assert(type >= 0, `bad piece ${ch} in ${fen}`);
    const sq = rank * 8 + file;
    white.push((color === 0 ? 0 : 384) + type * 64 + sq);
    black.push((color === 1 ? 0 : 384) + type * 64 + (sq ^ 56));
    file++;
  }
  return { stm: side === "b" ? 1 : 0, white, black };
}

/**
 * Exact quantized evaluation, side-to-move POV centipawns. Accumulators are stored as i16
 * (Int16Array), as in the spec; sums are exact JS integers (asserted below 2^53) and
 * Math.trunc of their quotients is truncating integer division.
 */
function evaluateQuantized(net, fen) {
  const { hidden: hl, activation, w1, b1, w2, b2 } = net;
  const f = features(fen);
  const acc = [new Int16Array(b1), new Int16Array(b1)]; // [White's perspective, Black's]
  for (const [p, list] of [[0, f.white], [1, f.black]]) {
    const a = acc[p];
    for (const feature of list) {
      const row = feature * hl;
      for (let j = 0; j < hl; j++) a[j] += w1[row + j];
    }
  }
  const us = acc[f.stm];
  const them = acc[f.stm ^ 1];
  const cr = (x) => Math.min(Math.max(x, 0), QA);
  let sum = 0;
  for (let j = 0; j < hl; j++) {
    const a = cr(us[j]);
    const b = cr(them[j]);
    sum += activation === 0 ? a * w2[j] + b * w2[hl + j] : a * a * w2[j] + b * b * w2[hl + j];
  }
  assert(Number.isSafeInteger(sum), "output sum is not an exact integer");
  const out = activation === 0 ? sum + b2 : Math.trunc(sum / QA) + b2;
  assert(Number.isSafeInteger(out * SCALE), "scaled output is not an exact integer");
  return Math.trunc((out * SCALE) / (QA * QB));
}

/** What the engine's cb_eval must return: White's POV, clamped below mate scores. */
function expectedWhiteEval(net, fen) {
  const stm = evaluateQuantized(net, fen);
  const white = features(fen).stm === 0 ? stm : -stm;
  return { value: Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, white)) || 0, clamped: Math.abs(white) > EVAL_LIMIT };
}

// ======================================================================================
// Engine helpers
// ======================================================================================

/** Copies `bytes` into the engine through cb_nnue_alloc and calls cb_nnue_load. */
function loadNetwork(engine, bytes, loadSize = bytes.length, allocSize = bytes.length) {
  const ptr = engine.exports.cb_nnue_alloc(allocSize);
  if (ptr === 0) return { ok: false, allocFailed: true };
  // Read memory.buffer only after the allocation: the memory may have grown.
  new Uint8Array(engine.memory.buffer, ptr, Math.min(bytes.length, allocSize)).set(bytes.subarray(0, allocSize));
  return { ok: engine.exports.cb_nnue_load(loadSize) === 1, ptr };
}

function evalFen(engine, fen) {
  assert(engine.position(`fen ${fen}`), `cb_position rejected ${fen}`);
  return engine.eval();
}

function parseTrace(text) {
  return text.split("\n").filter((l) => l.length > 0).map((line) => {
    const [label, w, b] = line.split("\t");
    return { label, white: Number(w), black: Number(b) };
  });
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

/** Hand-picked positions added to the random ones: extremes of piece count, promotions, Black to move. */
const SPECIAL_FENS = [
  START,
  KIWIPETE,
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "4k3/8/8/8/8/8/8/4K3 w - - 0 1", // bare kings
  "4k3/8/8/8/8/8/8/4K3 b - - 0 1",
  "QQQQQQQk/8/8/8/8/8/8/K7 b - - 0 1", // many promoted queens
  "1k6/8/8/8/8/8/qqqqqqq1/K7 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
];

// Shortest forced mates (from scripts/engine-test.mjs; the mate is independent of the eval).
const MATE_PUZZLES = [
  { fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", mate: 1 },
  { fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4", mate: 1 },
  { fen: "3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", mate: 1 },
  { fen: "7k/8/8/8/8/8/R7/1R4K1 w - - 0 1", mate: 2 },
  { fen: "1r4k1/r7/8/8/8/8/8/7K b - - 0 1", mate: 2 },
  { fen: "8/8/4k3/8/4K3/8/8/1R3R2 w - - 0 1", mate: 3 },
  { fen: "k7/8/1K6/8/8/8/8/7R b - - 0 1", mate: -1 },
];

const BENCH_POSITIONS = [
  START,
  KIWIPETE,
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  "8/8/1p1k4/p1pP4/P1P1K3/8/8/8 w - - 0 1",
];

// Weight ranges. "trained" resembles a real network: accumulators spread over the negative,
// active (0..255) and saturated regions; output weights use the full clipped range of W2.
const TRAINED = { w1: [-64, 64], b1: [-60, 200], w2: [-127, 127], b2: [-30000, 30000] };
// The extremes the trainer can produce (all weights clipped to ±1.98 before quantizing).
const CLIPPED_EXTREMES = { w1: [-505, 505], b1: [-505, 505], w2: [-127, 127], b2: [-32313, 32313] };
// A network for speed measurements: small output weights give evaluations of a few hundred
// centipawns, so the search behaves roughly as with a real network.
const BENCH = { w1: [-64, 64], b1: [-60, 200], w2: [-6, 6], b2: [-2000, 2000] };

/** The networks of the exactness test. */
function exactnessNetworks() {
  const nets = [];
  let seed = 1000;
  // Required matrix: both activations × HL 8 / 32 / 128 / 256.
  for (const hidden of [8, 32, 128, 256]) {
    for (const activation of [0, 1]) {
      nets.push({ label: `HL ${hidden} ${ACTIVATION_NAMES[activation]}`, net: randomNetwork({ hidden, activation, seed: seed++, ...TRAINED }) });
    }
  }
  // Extra shapes: a 64-value tile plus a remainder, HL = 16, the maximum HL.
  nets.push({ label: "HL 72 SCReLU", net: randomNetwork({ hidden: 72, activation: 1, seed: seed++, ...TRAINED }) });
  nets.push({ label: "HL 200 CReLU", net: randomNetwork({ hidden: 200, activation: 0, seed: seed++, ...TRAINED }) });
  nets.push({ label: "HL 16 SCReLU", net: randomNetwork({ hidden: 16, activation: 1, seed: seed++, ...TRAINED }) });
  nets.push({ label: "HL 2048 SCReLU", net: randomNetwork({ hidden: 2048, activation: 1, seed: seed++, ...TRAINED }) });
  nets.push({ label: "HL 2048 CReLU", net: randomNetwork({ hidden: 2048, activation: 0, seed: seed++, ...TRAINED }) });
  // Weight extremes of the format (what quantizing clipped float weights can give).
  nets.push({ label: "HL 128 SCReLU clipped extremes", net: randomNetwork({ hidden: 128, activation: 1, seed: seed++, ...CLIPPED_EXTREMES }) });
  nets.push({ label: "HL 128 CReLU clipped extremes", net: randomNetwork({ hidden: 128, activation: 0, seed: seed++, ...CLIPPED_EXTREMES }) });
  // SCReLU output weights exactly at the fast-path boundary (|W2| = 128 still uses it) ...
  nets.push({
    label: "HL 64 SCReLU W2 = ±128",
    net: randomNetwork({ hidden: 64, activation: 1, seed: seed++, ...TRAINED, w2Values: [-128, 128, -127, 127, 0, 1, -1] }),
  });
  // ... and just beyond it (any |W2| > 128 selects the general 64-bit loop).
  nets.push({
    label: "HL 64 SCReLU W2 = ±129",
    net: randomNetwork({ hidden: 64, activation: 1, seed: seed++, ...TRAINED, w2Values: [-129, 129, -128, 128, 0] }),
  });
  nets.push({ label: "HL 96 SCReLU wide W2", net: randomNetwork({ hidden: 96, activation: 1, seed: seed++, ...TRAINED, w2: [-1500, 1500] }) });
  // Not producible by the trainer: W1 / b1 over the whole i16 range, so the accumulators
  // overflow and wrap around (the spec stores them as i16, like Int16Array). Small output
  // weights keep the results unclamped, so the wrap-around is visible in the evaluations.
  const wrap = { w1: [-32768, 32767], b1: [-32768, 32767], w2: [-3, 3], b2: [-1000, 1000] };
  nets.push({ label: "HL 72 SCReLU i16 wrap-around", net: randomNetwork({ hidden: 72, activation: 1, seed: seed++, ...wrap }) });
  nets.push({ label: "HL 72 CReLU i16 wrap-around", net: randomNetwork({ hidden: 72, activation: 0, seed: seed++, ...wrap }) });
  // Everything at the extremes of i16 / i32: sums need 64 bits, nearly all results clamp.
  const wild = { w1: [-32768, 32767], b1: [-32768, 32767], w2: [-32768, 32767], b2: [-2147483648, 2147483647] };
  nets.push({ label: "HL 72 SCReLU full i16 range", net: randomNetwork({ hidden: 72, activation: 1, seed: seed++, ...wild }) });
  nets.push({ label: "HL 72 CReLU full i16 range", net: randomNetwork({ hidden: 72, activation: 0, seed: seed++, ...wild }) });
  return nets;
}

// ======================================================================================
// Tests
// ======================================================================================

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
let args;
let nnueModule = null; // template + eval-nnue.ts
let hceModule = null; // the stock template (hand-crafted eval)
let positions = []; // random playout FENs + SPECIAL_FENS
const detail = (...a) => console.log("      ", ...a);
const debug = (...a) => { if (args.verbose) detail(...a); };

async function freshEngine(module = nnueModule) {
  const e = await TestEngine.create(module);
  e.newGame();
  return e;
}

function assertLegalBest(fen, best, what) {
  const legal = legalUci(new Chess(fen));
  assert(best !== null, `${what}: no move returned (legal moves: ${legal.length})`);
  assert(legal.includes(best), `${what}: illegal best move ${best} in ${fen}`);
}

test("exports", async () => {
  const names = new Set(WebAssembly.Module.exports(nnueModule).map((x) => x.name));
  for (const name of ["cb_nnue_alloc", "cb_nnue_load", "cb_eval", "cb_eval_trace"]) {
    assert(names.has(name), `NNUE build does not export ${name}`);
  }
  const e = await freshEngine();
  assertEq(e.stubbedImports.length, 0, `unexpected imports ${e.stubbedImports.join(", ")}`);
  detail("cb_nnue_alloc, cb_nnue_load, cb_eval, cb_eval_trace exported; no unexpected imports");
});

test("exact-eval", async () => {
  // One engine instance loads every network in turn, so reloading with a larger or smaller
  // hidden size (re-allocation / reuse of the weight memory) is exercised as well.
  const e = await freshEngine();
  let comparisons = 0;
  let clampedTotal = 0;
  for (const { label, net } of exactnessNetworks()) {
    const bytes = writeCbnn(net);
    assertEq(bytes.length, fileSize(net.hidden), `${label}: file size`);
    const r = loadNetwork(e, bytes);
    assert(r.ok, `${label}: network rejected (log: ${e.logs.slice(-2).join(" | ")})`);
    let clamped = 0;
    let maxAbs = 0;
    for (const fen of positions) {
      const expected = expectedWhiteEval(net, fen);
      const actual = evalFen(e, fen);
      if (actual !== expected.value) {
        throw new Error(`${label}: cb_eval ${actual} != reference ${expected.value} for ${fen}`);
      }
      if (expected.clamped) clamped++;
      else maxAbs = Math.max(maxAbs, Math.abs(actual));
      comparisons++;
    }
    clampedTotal += clamped;
    detail(`${label.padEnd(32)} ${positions.length} positions equal  (${clamped} clamped, max |unclamped| ${fmt(maxAbs)} cp)`);
  }
  detail(`${fmt(comparisons)} evaluations identical to the JS reference (${fmt(clampedTotal)} of them clamped to ±${EVAL_LIMIT})`);
});

test("app-reference-vectors", async () => {
  // The app's own JS reference (src/nnue, written by another package) publishes test vectors:
  // CBNN files plus the evaluation it computes for each FEN. The engine must agree with them
  // too. Only the data file is read; if it is missing or has another shape the test is skipped.
  const file = path.join(ROOT, "src/nnue/fixtures/reference-vectors.json");
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  const valid = data && Array.isArray(data.networks) && data.networks.length > 0 && data.networks.every(
    (n) => typeof n.cbnnBase64 === "string" && Array.isArray(n.evals) &&
      n.evals.every((v) => typeof v.fen === "string" && Number.isInteger(v.cpWhite)),
  );
  if (!valid) return "skip: src/nnue/fixtures/reference-vectors.json not found (or in an unknown format)";
  let compared = 0;
  for (const n of data.networks) {
    const e = await freshEngine();
    const bytes = new Uint8Array(Buffer.from(n.cbnnBase64, "base64"));
    assert(loadNetwork(e, bytes).ok, `${n.name}: network rejected (${e.logs.slice(-2).join(" | ")})`);
    for (const v of n.evals) {
      const expected = Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, v.cpWhite));
      assertEq(evalFen(e, v.fen), expected, `${n.name}: cb_eval vs app reference for ${v.fen}`);
      compared++;
    }
  }
  detail(`${compared} evaluations of ${data.networks.length} networks equal the app's reference vectors`);
});

test("trace", async () => {
  const e = await freshEngine();
  const net = randomNetwork({ hidden: 64, activation: 1, seed: 77, ...TRAINED });
  assert(loadNetwork(e, writeCbnn(net)).ok, "network rejected");
  let checked = 0;
  for (const fen of positions.slice(0, 100)) {
    const value = evalFen(e, fen);
    const terms = parseTrace(e.evalTrace());
    const body = terms.filter((t) => t.label !== "total");
    const total = terms.find((t) => t.label === "total");
    assertEq(body.length, 1, `one trace term expected for ${fen}`);
    assertEq(body[0].label, "NNUE", "trace label");
    assert(body[0].white >= 0 && body[0].black >= 0, "NNUE term is split by sign (both non-negative)");
    assertEq(body[0].white - body[0].black, value, `trace term must equal cb_eval for ${fen}`);
    assert(total && total.white === value, `trace total for ${fen}`);
    assertEq(e.eval(), value, "cb_eval after cb_eval_trace");
    checked++;
  }
  detail(`${checked} traces: a single "NNUE" term equal to cb_eval`);
});

test("symmetry", async () => {
  const e = await freshEngine();
  let checked = 0;
  for (const [hidden, activation] of [[32, 0], [128, 1]]) {
    const net = randomNetwork({ hidden, activation, seed: 4242 + hidden, ...TRAINED });
    assert(loadNetwork(e, writeCbnn(net)).ok, "network rejected");
    for (const fen of positions.slice(0, 200)) {
      const a = evalFen(e, fen);
      const b = evalFen(e, mirrorFen(fen));
      assertEq(b, -a, `eval(mirror) must be -eval for ${fen}`);
      checked++;
    }
  }
  detail(`${checked} positions: eval(mirror(p)) == -eval(p) with a network loaded`);
});

test("malformed-files", async () => {
  const e = await freshEngine();
  const good = randomNetwork({ hidden: 32, activation: 1, seed: 9001, ...TRAINED });
  const goodBytes = writeCbnn(good);
  const sample = positions.slice(0, 25);
  const reference = sample.map((fen) => expectedWhiteEval(good, fen).value);
  const stillGood = (what) => {
    sample.forEach((fen, i) => assertEq(evalFen(e, fen), reference[i], `${what}: previous network must stay active (${fen})`));
  };

  // Allocation limits.
  assertEq(e.exports.cb_nnue_alloc(0), 0, "cb_nnue_alloc(0)");
  assertEq(e.exports.cb_nnue_alloc(-5), 0, "cb_nnue_alloc(-5)");
  assertEq(e.exports.cb_nnue_alloc(2147483647), 0, "cb_nnue_alloc(2^31 - 1)");
  assertEq(e.exports.cb_nnue_alloc(64 << 20), 0, "cb_nnue_alloc(64 MiB)");

  // cb_nnue_load before any cb_nnue_alloc (fresh engine): rejected, fallback still used.
  const fresh = await freshEngine();
  assertEq(fresh.exports.cb_nnue_load(goodBytes.length), 0, "load without alloc");
  assert(fresh.position("startpos"), "startpos");
  assertEq(parseTrace(fresh.evalTrace())[0].label, "Fallback (no network)", "fresh engine after failed load");

  assert(loadNetwork(e, goodBytes).ok, "valid network rejected");
  stillGood("baseline");

  const other = randomNetwork({ hidden: 40, activation: 1, seed: 9002, ...TRAINED });
  const truncated = goodBytes.slice(0, goodBytes.length - 1);
  const extended = new Uint8Array(goodBytes.length + 1);
  extended.set(goodBytes);
  // Files with an invalid hidden size but a size that matches it: only the HL rule rejects them.
  const withHidden = (hidden) => writeCbnn(randomNetwork({ hidden, activation: 1, seed: hidden, ...TRAINED }));
  const SIZE = /file has \d+ bytes, expected \d+/;
  const HIDDEN = /hidden size \d+ is not a multiple of 8 between 8 and 2048/;
  const bad = [
    { what: "bad magic CBNM", bytes: writeCbnn(good, { magic: "CBNM" }), log: /magic/ },
    { what: "lower-case magic", bytes: writeCbnn(good, { magic: "cbnn" }), log: /magic/ },
    { what: "zero magic", bytes: writeCbnn(good, { magic: "\0\0\0\0" }), log: /magic/ },
    { what: "version 0", bytes: writeCbnn(good, { version: 0 }), log: /version 0/ },
    { what: "version 2", bytes: writeCbnn(good, { version: 2 }), log: /version 2/ },
    { what: "version 0xffffffff", bytes: writeCbnn(good, { version: 0xffffffff }), log: /version 4294967295/ },
    { what: "inputs 767", bytes: writeCbnn(good, { inputs: 767 }), log: /input size 767/ },
    { what: "inputs 0", bytes: writeCbnn(good, { inputs: 0 }), log: /input size 0/ },
    { what: "HL 0", bytes: withHidden(0), log: HIDDEN },
    { what: "HL 4", bytes: withHidden(4), log: HIDDEN },
    { what: "HL 33 (not a multiple of 8)", bytes: withHidden(33), log: HIDDEN },
    { what: "HL 36", bytes: withHidden(36), log: HIDDEN },
    { what: "HL 2052", bytes: withHidden(2052), log: HIDDEN },
    { what: "HL 2056 (> 2048)", bytes: withHidden(2056), log: HIDDEN },
    { what: "HL 0xfffffff8", bytes: writeCbnn(good, { hidden: 0xfffffff8 }), log: HIDDEN },
    { what: "HL 40 in a file of HL 32", bytes: writeCbnn(good, { hidden: 40 }), log: SIZE },
    { what: "HL 32 in a file of HL 40", bytes: writeCbnn(other, { hidden: 32 }), log: SIZE },
    { what: "activation 2", bytes: writeCbnn(good, { activation: 2 }), log: /unknown activation 2/ },
    { what: "activation 0xffffffff", bytes: writeCbnn(good, { activation: 0xffffffff }), log: /unknown activation/ },
    { what: "QA 256", bytes: writeCbnn(good, { qa: 256 }), log: /quantization/ },
    { what: "QA 0", bytes: writeCbnn(good, { qa: 0 }), log: /quantization/ },
    { what: "QB 63", bytes: writeCbnn(good, { qb: 63 }), log: /quantization/ },
    { what: "scale 401", bytes: writeCbnn(good, { scale: 401 }), log: /quantization/ },
    { what: "truncated by 1 byte", bytes: truncated, log: SIZE },
    { what: "1 extra byte", bytes: extended, log: SIZE },
    { what: "header only", bytes: goodBytes.slice(0, 64), log: SIZE },
    { what: "63 bytes", bytes: goodBytes.slice(0, 63), log: /too short/ },
    { what: "1 byte", bytes: goodBytes.slice(0, 1), log: /too short/ },
    { what: "random bytes", bytes: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919 + 13) & 255), log: /magic/ },
  ];
  for (const c of bad.filter((x) => x.log === HIDDEN && x.what !== "HL 0xfffffff8")) {
    const hl = new DataView(c.bytes.buffer).getUint32(12, true);
    assertEq(c.bytes.length, fileSize(hl), `${c.what}: test file size must match its HL`);
  }
  for (const c of bad) {
    e.logs.length = 0;
    const r = loadNetwork(e, c.bytes);
    assert(!r.ok, `accepted a malformed file: ${c.what}`);
    if (!r.allocFailed) {
      const reason = e.logs.find((l) => l.startsWith("NNUE: ")) ?? "";
      assert(c.log.test(reason), `${c.what}: log "${reason}" does not explain the rejection (${c.log})`);
      debug(`${c.what.padEnd(28)} -> ${reason}`);
    }
    stillGood(c.what);
  }
  // A load whose size is larger than the size requested from cb_nnue_alloc (the engine's
  // buffer is bigger from earlier loads, but only 100 bytes were promised and copied).
  e.logs.length = 0;
  assert(!loadNetwork(e, goodBytes, goodBytes.length, 100).ok, "load size larger than the allocation");
  assert(/requested/.test(e.logs.find((l) => l.startsWith("NNUE: ")) ?? ""), "load size > alloc size: log");
  // A complete file, but cb_nnue_load is told a smaller size.
  e.logs.length = 0;
  assert(!loadNetwork(e, goodBytes, goodBytes.length - 2).ok, "load with a size smaller than the file");
  assert(SIZE.test(e.logs.find((l) => l.startsWith("NNUE: ")) ?? ""), "load size < file size: log");
  stillGood("size checks");

  // The spec does not ask loaders to reject non-zero flags / reserved bytes (the app's reader
  // ignores them as well), so such a file loads.
  const flagged = writeCbnn(other, { flags: 5 });
  flagged[40] = 1;
  assert(loadNetwork(e, flagged).ok, "file with non-zero flags / reserved bytes rejected");
  sample.forEach((fen) => assertEq(evalFen(e, fen), expectedWhiteEval(other, fen).value, `flagged file eval (${fen})`));
  // And the engine can switch back.
  assert(loadNetwork(e, goodBytes).ok, "reloading the valid network");
  stillGood("reload");
  detail(`${bad.length + 2} malformed files rejected with an explanation in the log; the active network stayed in use`);
  detail("alloc limits checked; load before alloc rejected; non-zero flags/reserved bytes accepted (as in the spec)");
});

test("no-network", async () => {
  const e = await freshEngine();
  let checked = 0;
  for (const fen of positions.slice(0, 150)) {
    const value = evalFen(e, fen);
    const terms = parseTrace(e.evalTrace());
    const body = terms.filter((t) => t.label !== "total");
    assertEq(body.length, 1, "one fallback term");
    assertEq(body[0].label, "Fallback (no network)", "fallback trace label");
    assertEq(body[0].white - body[0].black, value, `fallback trace adds up for ${fen}`);
    assertEq(evalFen(e, mirrorFen(fen)), -value, `fallback symmetric for ${fen}`);
    checked++;
  }
  assertEq(evalFen(e, START), 0, "start position");
  const queenUp = evalFen(e, "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert(queenUp > 800 && queenUp < 1000, `a queen up should be about +900, got ${queenUp}`);
  // It still plays: mates, legal moves.
  for (const p of MATE_PUZZLES.slice(0, 4)) {
    e.newGame();
    assert(e.position(`fen ${p.fen}`), "puzzle position");
    const r = e.go({ depth: 2 * Math.abs(p.mate) + 3 });
    assertEq(r.last?.mate, p.mate, `fallback search mate score for ${p.fen}`);
  }
  for (const fen of positions.slice(0, 30)) {
    e.position(`fen ${fen}`);
    const r = e.go({ depth: 4, nodes: 20000 });
    if (legalUci(new Chess(fen)).length > 0) assertLegalBest(fen, r.best, "fallback search");
  }
  detail(`${checked} positions: "Fallback (no network)" term adds up, symmetric; start = 0, queen up = ${queenUp}; searches fine`);
});

test("search-with-network", async () => {
  const e = await freshEngine();
  const net = randomNetwork({ hidden: 128, activation: 1, seed: 31337, ...BENCH });
  assert(loadNetwork(e, writeCbnn(net)).ok, "network rejected");
  // Mates are found whatever the network thinks.
  for (const p of MATE_PUZZLES) {
    e.newGame();
    assert(e.position(`fen ${p.fen}`), "puzzle position");
    const r = e.go({ depth: 2 * Math.abs(p.mate) + 4 });
    assertLegalBest(p.fen, r.best, "mate puzzle");
    assertEq(r.last?.mate, p.mate, `mate score for ${p.fen}`);
    const plies = p.mate > 0 ? 2 * p.mate - 1 : -2 * p.mate;
    const played = playPv(p.fen, r.last.pv.slice(0, plies));
    assert(played.ok && played.chess.isCheckmate(), `PV ${r.last.pv.join(" ")} must end in mate`);
  }
  // Legal best moves and PVs on random positions.
  let searched = 0;
  for (const fen of positions.slice(0, 80)) {
    const legal = legalUci(new Chess(fen));
    e.position(`fen ${fen}`);
    const r = e.go({ depth: 5, nodes: 30000 });
    if (legal.length === 0) {
      assertEq(r.best, null, `no legal move in ${fen}`);
      continue;
    }
    assertLegalBest(fen, r.best, "search with network");
    const played = playPv(fen, r.last.pv);
    assert(played.ok, `illegal PV move ${played.failedAt} from ${fen}`);
    searched++;
  }
  // Time and stop limits still hold with the slower evaluation.
  e.position(`fen ${KIWIPETE}`);
  const timed = e.go({ movetime: 200 });
  assertLegalBest(KIWIPETE, timed.best, "movetime 200");
  assert(timed.elapsedMs < 320 && timed.elapsedMs > 100, `movetime 200 took ${timed.elapsedMs.toFixed(0)} ms`);
  const clock = e.go({ wtime: 1000, btime: 1000 });
  assertLegalBest(KIWIPETE, clock.best, "clock");
  assert(clock.elapsedMs < 250, `1 s clock used ${clock.elapsedMs.toFixed(0)} ms`);
  e.stopMode = "afterFirstInfo"; // infinite search, stopped by the host after the first report
  const stopped = e.go({});
  e.stopMode = "never";
  assertLegalBest(KIWIPETE, stopped.best, "stop flag");
  const afterStop = stopped.t0 + stopped.elapsedMs - e.firstInfoAt;
  assert(afterStop < 100, `returned ${afterStop.toFixed(0)} ms after the stop request`);
  // A network can be replaced between searches.
  const net2 = randomNetwork({ hidden: 256, activation: 0, seed: 31338, ...BENCH });
  assert(loadNetwork(e, writeCbnn(net2)).ok, "second network rejected");
  e.position(`fen ${KIWIPETE}`);
  assertEq(e.eval(), expectedWhiteEval(net2, KIWIPETE).value, "eval after switching networks");
  assertLegalBest(KIWIPETE, e.go({ depth: 6 }).best, "search after switching networks");

  // The search really uses the network, and only the current one: in a quiet position (no
  // capture, promotion or check after any move) the depth-1 score is exactly the best child
  // evaluation. Searching with network A first must not leave A's evaluations in the hash
  // table once network B is loaded (no cb_new_game in between).
  const quiet = "8/5k2/8/2p5/8/2P5/5K2/8 w - - 0 1";
  const oracle = (net) => {
    let best = -Infinity;
    for (const m of new Chess(quiet).moves({ verbose: true })) {
      const child = new Chess(quiet);
      child.move(m);
      assert(!child.inCheck() && child.moves({ verbose: true }).every((x) => !x.captured && !x.promotion), "quiet test position");
      best = Math.max(best, -Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, evaluateQuantized(net, child.fen()))));
    }
    return best;
  };
  const netA = randomNetwork({ hidden: 64, activation: 1, seed: 808, ...BENCH });
  const netB = randomNetwork({ hidden: 64, activation: 1, seed: 909, ...BENCH });
  const s = await freshEngine();
  assert(loadNetwork(s, writeCbnn(netA)).ok, "network A");
  assert(s.position(`fen ${quiet}`), "quiet position");
  assertEq(s.go({ depth: 1 }).last.score, oracle(netA), "depth-1 score with network A");
  s.go({ depth: 10 }); // fills the hash table with network A's evaluations
  assert(loadNetwork(s, writeCbnn(netB)).ok, "network B");
  const scoreB = s.go({ depth: 1 }).last.score;
  assert(oracle(netA) !== oracle(netB), "the two networks must disagree for this check");
  assertEq(scoreB, oracle(netB), "depth-1 score after switching to network B (stale hash entries?)");
  detail(`${MATE_PUZZLES.length} mate puzzles, ${searched} random positions (legal moves and PVs), movetime ${timed.elapsedMs.toFixed(0)} ms, clock ${clock.elapsedMs.toFixed(0)} ms, stop flag`);
  detail(`depth-1 scores equal the JS reference (${oracle(netA)} with A, ${scoreB} with B after switching networks mid-game)`);
});

test("speed", async () => {
  // Evaluations per second (cb_eval in a loop) and nodes per second in searches with a fixed
  // time per position, against the stock template's hand-crafted evaluation.
  const configs = [
    { label: "HCE (stock template)", module: hceModule, net: null },
    { label: "NNUE build, no network", module: nnueModule, net: null },
    ...[[32, 1], [128, 1], [128, 0], [256, 1], [256, 0], [512, 1]].map(([hidden, activation]) => ({
      label: `NNUE HL ${hidden} ${ACTIVATION_NAMES[activation]}`,
      module: nnueModule,
      net: randomNetwork({ hidden, activation, seed: 555 + hidden + activation, ...BENCH }),
    })),
  ];
  // The configurations are measured in turns (interleaved), so that load from other processes
  // on the machine affects all of them alike.
  const rows = [];
  for (const c of configs) {
    const e = await freshEngine(c.module);
    if (c.net) assert(loadNetwork(e, writeCbnn(c.net)).ok, `${c.label}: network rejected`);
    // Warm-up: V8 optimises hot WebAssembly functions in the background after a while.
    e.position(`fen ${KIWIPETE}`);
    e.go({ movetime: 300 });
    rows.push({ label: c.label, engine: e, evalUs: Infinity, nodes: 0, ms: 0, depths: 0 });
  }
  // Evaluation cost: best of 5 rounds of 5000 cb_eval calls per bench position.
  for (let round = 0; round < 5; round++) {
    for (const row of rows) {
      let calls = 0;
      let ms = 0;
      for (const fen of BENCH_POSITIONS) {
        row.engine.position(`fen ${fen}`);
        const t0 = performance.now();
        for (let i = 0; i < 5000; i++) row.engine.eval();
        ms += performance.now() - t0;
        calls += 5000;
      }
      row.evalUs = Math.min(row.evalUs, (ms * 1000) / calls);
    }
  }
  // Search speed: every configuration searches each position for the same time.
  for (const fen of BENCH_POSITIONS) {
    for (const row of rows) {
      row.engine.newGame();
      row.engine.position(`fen ${fen}`);
      const r = row.engine.go({ movetime: args.benchMs });
      assertLegalBest(fen, r.best, `${row.label} bench`);
      row.nodes += r.last.nodes;
      row.ms += r.elapsedMs;
      row.depths += r.last.depth;
    }
  }
  const hce = rows[0];
  const hceNps = (hce.nodes / hce.ms) * 1000;
  for (const r of rows) {
    const nps = (r.nodes / r.ms) * 1000;
    detail(`${r.label.padEnd(26)} ${r.evalUs.toFixed(2).padStart(5)} µs/eval (${(r.evalUs / hce.evalUs).toFixed(2)}x HCE)  ` +
      `${fmt(nps).padStart(9)} nps (${((nps / hceNps) * 100).toFixed(0).padStart(3)}% of HCE)  avg depth ${(r.depths / BENCH_POSITIONS.length).toFixed(1)}`);
  }
  detail(`search: ${BENCH_POSITIONS.length} positions × ${args.benchMs} ms each; µs/eval is the best of 5 rounds and includes the JS -> wasm call`);
  detail("random networks steer the search differently from the HCE, so nps compares speed per node, not strength");
});

// =========================================================================== main

args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const t of tests) console.log(t.name);
  process.exit(0);
}

const tStart = performance.now();
const nnueOverrides = { "eval.ts": NNUE_EVAL, ...args.overrides };
console.log("engine: engine/template/main.ts");
for (const [name, file] of Object.entries(nnueOverrides)) console.log(`  ${name} <- ${path.relative(ROOT, file)}`);
try {
  const nnue = await compileEngine(TEMPLATE_DIR, "main.ts", nnueOverrides);
  console.log(`compiled NNUE build in ${(nnue.ms / 1000).toFixed(1)} s, ${fmt(nnue.wasm.length)} bytes${nnue.log ? `\n${nnue.log}` : ""}`);
  nnueModule = await WebAssembly.compile(nnue.wasm);
  const hce = await compileEngine(TEMPLATE_DIR, "main.ts");
  console.log(`compiled stock template (HCE, for speed comparison) in ${(hce.ms / 1000).toFixed(1)} s${hce.log ? `\n${hce.log}` : ""}`);
  hceModule = await WebAssembly.compile(hce.wasm);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
positions = [...randomPositions(args.positions, 20261102), ...SPECIAL_FENS];
console.log(`${positions.length} test positions (${args.positions} from random playouts + ${SPECIAL_FENS.length} hand-picked)`);

let passed = 0;
let failed = 0;
let skipped = 0;
for (const t of tests) {
  if (args.only && !args.only.includes(t.name)) continue;
  if (args.skip.includes(t.name)) {
    skipped++;
    continue;
  }
  const t0 = performance.now();
  try {
    console.log(`----  ${t.name}`);
    const outcome = await t.fn();
    if (typeof outcome === "string" && outcome.startsWith("skip: ")) {
      console.log(`SKIP  ${t.name} (${outcome.slice(6)})`);
      skipped++;
      continue;
    }
    console.log(`PASS  ${t.name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${t.name}: ${err.message}`);
    if (args.verbose && err.name !== "AssertionError") console.log(err.stack);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped in ${((performance.now() - tStart) / 1000).toFixed(1)} s`);
process.exit(failed > 0 ? 1 : 0);
