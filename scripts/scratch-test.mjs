#!/usr/bin/env node
// Tests for the "start from scratch" engine variants:
//   engine/variants/scratch-empty    bare Engine ABI v1 skeleton
//   engine/variants/scratch-minimal  small self-contained 0x88 engine
//
// Each variant is compiled the way the app compiles a scratch engine — its own
// folder is the entire source tree (no template files) — with
//   asc main.ts -O3 --runtime incremental --enable simd --noColors
// then instantiated with a minimal ABI host (env: abort, cb_now, cb_should_stop,
// cb_info, cb_log, seed, trace) and exercised: exports, perft, position parsing,
// legality of cb_go moves under depth / nodes / movetime / clock / stop limits
// (checked with chess.js), mate finding, evaluation symmetry.
//
// Usage: node scripts/scratch-test.mjs [--quick] [--write-wasm]
//   --quick       fewer random positions and shallower cross-checks
//   --write-wasm  also write the compiled modules to .scratch/scratch/
// Exit code 0 = all checks passed.

import asc from "assemblyscript/asc";
import { Chess } from "chess.js";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VARIANTS_DIR = path.join(ROOT, "engine", "variants");
const ASC_FLAGS = ["-O3", "--runtime", "incremental", "--enable", "simd", "--noColors"];
const QUICK = process.argv.includes("--quick");
const WRITE_WASM = process.argv.includes("--write-wasm");
const BUFFER_SIZE = 65536;

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n== ${title}`);
}

function note(text) {
  console.log(`  ${text}`);
}

/** Runs fn; a thrown error (e.g. a wasm trap) becomes a failed check instead of a crash. */
function guarded(name, fn) {
  try {
    return fn();
  } catch (err) {
    check(name, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Compiling a variant folder with the programmatic asc API
// ---------------------------------------------------------------------------

/** All .ts files below `dir`, keyed by forward-slash path relative to `dir`. */
async function loadTree(dir, prefix = "") {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await loadTree(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out[rel] = await readFile(path.join(dir, entry.name), "utf8");
  }
  return out;
}

/** Normalises a virtual path ("./a/../b.ts" -> "b.ts"). */
function virtualPath(baseDir, name) {
  return path.posix.normalize(path.posix.join((baseDir || ".").replace(/\\/g, "/"), name.replace(/\\/g, "/"))).replace(/^\.\//, "");
}

/** Compiles a virtual source tree; nothing outside `files` is visible to the compiler. */
async function compileTree(files, entry = "main.ts") {
  const stdout = asc.createMemoryStream();
  const stderr = asc.createMemoryStream();
  let wasm = null;
  const t0 = performance.now();
  const { error } = await asc.main([entry, "--outFile", "out.wasm", ...ASC_FLAGS], {
    stdout,
    stderr,
    readFile: (name, baseDir) => {
      const key = virtualPath(baseDir, name);
      return Object.prototype.hasOwnProperty.call(files, key) ? files[key] : null;
    },
    writeFile: (name, contents) => {
      if (name.endsWith(".wasm")) wasm = contents;
    },
    listFiles: (dirname, baseDir) => {
      const dir = virtualPath(baseDir, dirname);
      const prefix = dir === "." ? "" : `${dir}/`;
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
    },
  });
  const log = `${stderr.toString()}${stdout.toString()}`;
  return {
    ok: !error && wasm !== null,
    wasm,
    log,
    errors: (log.match(/^ERROR/gm) || []).length,
    warnings: (log.match(/^WARNING/gm) || []).length,
    ms: performance.now() - t0,
    error,
  };
}

// ---------------------------------------------------------------------------
// A minimal Engine ABI v1 host
// ---------------------------------------------------------------------------

const ALLOWED_IMPORTS = new Set(["abort", "cb_now", "cb_should_stop", "cb_info", "cb_log", "seed", "trace"]);
const REQUIRED_EXPORTS = {
  cb_abi_version: 0,
  cb_init: 0,
  cb_in: 0,
  cb_out: 0,
  cb_new_game: 0,
  cb_position: 1,
  cb_go: 8,
};
const OPTIONAL_EXPORTS = { cb_eval: 0, cb_eval_trace: 0, cb_perft: 1, cb_set_option: 1, cb_nnue_alloc: 1, cb_nnue_load: 1, cb_name: 0 };

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

class TestEngine {
  static async create(wasmBytes) {
    const module = await WebAssembly.compile(wasmBytes);
    const engine = new TestEngine(module);
    const instance = await WebAssembly.instantiate(module, engine.#imports());
    engine.exports = instance.exports;
    engine.memory = instance.exports.memory;
    engine.exports.cb_init();
    engine.inPtr = engine.exports.cb_in();
    engine.outPtr = engine.exports.cb_out();
    return engine;
  }

  constructor(module) {
    this.module = module;
    this.infos = [];
    this.logs = [];
    this.aborts = [];
    this.stubbed = [];
    this.stopCheck = null;
  }

  #imports() {
    const env = {
      abort: (msg, file, line, col) => {
        const text = `abort: ${this.#asString(msg)} at ${this.#asString(file)}:${line}:${col}`;
        this.aborts.push(text);
        throw new Error(text);
      },
      cb_now: () => performance.now(),
      cb_should_stop: () => (this.stopCheck && this.stopCheck() ? 1 : 0),
      cb_info: (depth, seldepth, score, mate, nodes, timeMs, pvLen) => {
        this.infos.push({ depth, seldepth, score, mate, nodes, timeMs, pv: this.readOut(pvLen) });
      },
      cb_log: (len) => {
        this.logs.push(this.readOut(len));
      },
      seed: () => 12345,
      trace: (msg, n, ...args) => {
        this.logs.push(`trace: ${this.#asString(msg)} ${args.slice(0, n).join(", ")}`);
      },
    };
    // Like the real host: harmless stubs for any other env function import.
    for (const imp of WebAssembly.Module.imports(this.module)) {
      if (imp.module === "env" && imp.kind === "function" && !(imp.name in env)) {
        this.stubbed.push(imp.name);
        env[imp.name] = () => 0;
      }
    }
    return { env };
  }

  /** AssemblyScript string: UTF-16LE, byte length stored as u32 at ptr - 4. */
  #asString(ptr) {
    if (!ptr || !this.memory) return "null";
    const buf = this.memory.buffer;
    const len = new DataView(buf).getUint32(ptr - 4, true);
    return new TextDecoder("utf-16le").decode(new Uint8Array(buf, ptr, len));
  }

  readOut(len) {
    return utf8.decode(new Uint8Array(this.memory.buffer, this.outPtr, len));
  }

  writeIn(text) {
    const bytes = utf8Encoder.encode(text);
    if (bytes.length > BUFFER_SIZE) throw new Error("input too long");
    new Uint8Array(this.memory.buffer, this.inPtr, bytes.length).set(bytes);
    return bytes.length;
  }

  position(command) {
    return this.exports.cb_position(this.writeIn(command));
  }

  go({ depth = 0, nodes = 0, movetime = 0, wtime = -1, btime = -1, winc = 0, binc = 0, movestogo = 0, stopAfterMs = null } = {}) {
    this.infos = [];
    this.logs = [];
    const t0 = performance.now();
    this.stopCheck = stopAfterMs === null ? null : () => performance.now() - t0 >= stopAfterMs;
    try {
      const len = this.exports.cb_go(depth, nodes, movetime, wtime, btime, winc, binc, movestogo);
      const elapsed = performance.now() - t0;
      return { move: len > 0 ? this.readOut(len) : null, len, elapsed, infos: this.infos, logs: this.logs };
    } finally {
      this.stopCheck = null;
    }
  }

  perft(depth) {
    return this.exports.cb_perft(depth);
  }

  eval() {
    return this.exports.cb_eval();
  }

  evalTrace() {
    return this.readOut(this.exports.cb_eval_trace());
  }

  name() {
    return this.readOut(this.exports.cb_name());
  }
}

/** Checks imports and exports against the ABI. */
function checkInterface(label, engine, expectOptional) {
  const imports = WebAssembly.Module.imports(engine.module);
  const unexpected = imports.filter((i) => i.kind === "function" && (i.module !== "env" || !ALLOWED_IMPORTS.has(i.name)));
  check(`${label}: imports only from the ABI env set`, unexpected.length === 0, unexpected.map((i) => `${i.module}.${i.name}`).join(", "));
  note(`imports: ${imports.map((i) => i.name).join(", ")}`);
  check(`${label}: exports memory`, engine.exports.memory instanceof WebAssembly.Memory);
  for (const [name, arity] of Object.entries(REQUIRED_EXPORTS)) {
    const fn = engine.exports[name];
    check(`${label}: exports ${name}/${arity}`, typeof fn === "function" && fn.length === arity, typeof fn === "function" ? `arity ${fn.length}` : "missing");
  }
  for (const name of expectOptional) {
    const fn = engine.exports[name];
    check(`${label}: exports optional ${name}/${OPTIONAL_EXPORTS[name]}`, typeof fn === "function" && fn.length === OPTIONAL_EXPORTS[name]);
  }
  check(`${label}: cb_abi_version() == 1`, engine.exports.cb_abi_version() === 1);
  const memBytes = engine.memory.buffer.byteLength;
  const { inPtr, outPtr } = engine;
  check(`${label}: input buffer (${inPtr}) holds 64 KiB inside memory`, inPtr > 0 && inPtr + BUFFER_SIZE <= memBytes);
  check(`${label}: output buffer (${outPtr}) holds 64 KiB inside memory`, outPtr > 0 && outPtr + BUFFER_SIZE <= memBytes);
  check(`${label}: buffers don't overlap`, inPtr + BUFFER_SIZE <= outPtr || outPtr + BUFFER_SIZE <= inPtr);
}

// ---------------------------------------------------------------------------
// chess.js helpers
// ---------------------------------------------------------------------------

function legalUcis(chess) {
  return chess.moves({ verbose: true }).map((m) => m.lan);
}

/** Plays a UCI move on a chess.js game if it is legal there; returns success. */
function playUci(chess, uci) {
  const move = chess.moves({ verbose: true }).find((m) => m.lan === uci);
  if (!move) return false;
  chess.move(move);
  return true;
}

/** Null if the PV is a legal sequence from `fen`, else a description of the problem. */
function pvProblem(fen, pv) {
  const chess = new Chess(fen);
  const moves = pv.trim() === "" ? [] : pv.trim().split(/\s+/);
  for (let i = 0; i < moves.length; i++) {
    if (!playUci(chess, moves[i])) return `PV move ${i + 1} '${moves[i]}' illegal in "${pv}"`;
  }
  return null;
}

/** Colour-flipped equivalent of a FEN (White and Black swap, board mirrored vertically). */
function mirrorFen(fen) {
  const [placement, sideToMove, castlingRights, ep, half = "0", full = "1"] = fen.split(/\s+/);
  const swapCase = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const board = placement.split("/").reverse().map(swapCase).join("/");
  const castle = castlingRights === "-" ? "-" : swapCase(castlingRights).split("").sort((a, b) => "KQkq".indexOf(a) - "KQkq".indexOf(b)).join("");
  const epSquare = ep === "-" ? "-" : ep[0] + String(9 - Number(ep[1]));
  return `${board} ${sideToMove === "w" ? "b" : "w"} ${castle} ${epSquare} ${half} ${full}`;
}

/** Can the side to move force checkmate within n of its own moves? (brute force) */
function canForceMate(chess, n) {
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    let ok = chess.isCheckmate();
    if (!ok && n > 1 && !chess.isGameOver()) {
      ok = chess.moves({ verbose: true }).every((reply) => {
        chess.move(reply);
        const res = canForceMate(chess, n - 1);
        chess.undo();
        return res;
      });
    }
    chess.undo();
    if (ok) return true;
  }
  return false;
}

/** Does playing `uci` in `fen` force mate within n moves (counting this one)? */
function moveForcesMate(fen, uci, n) {
  const chess = new Chess(fen);
  if (!playUci(chess, uci)) return false;
  if (chess.isCheckmate()) return true;
  if (n === 1 || chess.isGameOver()) return false;
  return chess.moves({ verbose: true }).every((reply) => {
    chess.move(reply);
    const res = canForceMate(chess, n - 1);
    chess.undo();
    return res;
  });
}

/** Random legal game from the start position (seeded). */
function randomGame(rng, maxPlies, { stopOnDraw = true } = {}) {
  const chess = new Chess();
  const moves = [];
  const plies = Math.floor(rng() * (maxPlies + 1));
  for (let i = 0; i < plies; i++) {
    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) break;
    // Prefer captures and promotions a little, to reach more varied positions.
    const tactical = legal.filter((m) => m.captured || m.promotion);
    const pool = tactical.length > 0 && rng() < 0.3 ? tactical : legal;
    const move = pool[Math.floor(rng() * pool.length)];
    chess.move(move);
    moves.push(move.lan);
    const over = stopOnDraw ? chess.isGameOver() : chess.isCheckmate() || chess.isStalemate();
    if (over) {
      chess.undo();
      moves.pop();
      break;
    }
  }
  return { fen: chess.fen(), moves };
}

// ---------------------------------------------------------------------------
// scratch-empty
// ---------------------------------------------------------------------------

async function testEmpty() {
  section("scratch-empty: compile");
  const files = await loadTree(path.join(VARIANTS_DIR, "scratch-empty"));
  check("scratch-empty: has main.ts", "main.ts" in files);
  const result = await compileTree(files);
  check("scratch-empty: compiles", result.ok, result.log.slice(0, 2000));
  check("scratch-empty: no compiler warnings", result.warnings === 0, result.log.slice(0, 2000));
  note(`compiled in ${result.ms.toFixed(0)} ms, ${result.wasm ? result.wasm.length : 0} bytes`);
  if (!result.ok) return;
  if (WRITE_WASM) await saveWasm("scratch-empty.wasm", result.wasm);

  section("scratch-empty: ABI");
  const engine = await TestEngine.create(result.wasm);
  checkInterface("scratch-empty", engine, ["cb_name"]);
  guarded("scratch-empty: runs", () => {
    engine.exports.cb_new_game();
    const command = "startpos moves e2e4 e7e5 g1f3";
    check("scratch-empty: cb_position accepts a command", engine.position(command) === 1);
    const res = engine.go({ depth: 3 });
    check("scratch-empty: cb_go returns 0 (no move yet)", res.len === 0);
    check(
      "scratch-empty: cb_go logs a TODO that shows the stored position command",
      res.logs.some((l) => l.includes("TODO") && l.includes(command)),
      JSON.stringify(res.logs),
    );
    check("scratch-empty: cb_name", engine.name().length > 0, engine.name());
    check("scratch-empty: out-of-range cb_position lengths don't trap", engine.exports.cb_position(-1) === 1 && engine.exports.cb_position(100000) === 1);
    check("scratch-empty: survives a second game", (engine.exports.cb_new_game(), engine.position("startpos")) === 1 && engine.go({ movetime: 10 }).len === 0);
  });
  check("scratch-empty: never trapped", engine.aborts.length === 0, engine.aborts.join("; "));

  // AssemblyScript only compiles functions that are used, so prove that every
  // helper offered to the user compiles and behaves once it is called.
  section("scratch-empty: helpers compile and work when used");
  const probe = `
// --- appended by scripts/scratch-test.mjs ---
export function __probe_write(len: i32): i32 {
  const text = readInput(len);
  const at = writeOutput(text);
  return writeOutput("!", at);
}
export function __probe_log_info(len: i32): void {
  log("helper log " + readInput(len));
  sendInfo(3, 25, 0, 1234, cb_now() - 5, "e2e4 e7e5");
}
export function __probe_stop(): i32 {
  if (stopNow(cb_now() + 100000)) return -1;
  if (!stopNow(cb_now() - 1)) return -2;
  return 1;
}
export function __probe_overflow(): i32 {
  return writeOutput("x".repeat(70000));
}
`;
  const probed = await compileTree({ ...files, "main.ts": files["main.ts"] + probe });
  check("scratch-empty+probe: compiles", probed.ok, probed.log.slice(0, 2000));
  if (!probed.ok) return;
  const pe = await TestEngine.create(probed.wasm);
  guarded("scratch-empty+probe: runs", () => {
    const at = pe.exports.__probe_write(pe.writeIn("héllo"));
    check("readInput/writeOutput round-trip UTF-8 (6 bytes + 1)", at === 7, `returned ${at}`);
    check("writeOutput wrote the text", pe.readOut(7) === "héllo!", pe.readOut(Math.max(0, at)));
    check("writeOutput refuses text larger than the buffer", pe.exports.__probe_overflow() === 0);
    check("stopNow() checks the deadline", pe.exports.__probe_stop() === 1);
    pe.exports.__probe_log_info(pe.writeIn("héllo"));
    check("log() reaches cb_log", pe.logs.includes("helper log héllo"), JSON.stringify(pe.logs));
    const info = pe.infos[0];
    check(
      "sendInfo() reaches cb_info with the PV",
      pe.infos.length === 1 && info.depth === 3 && info.score === 25 && info.mate === 0 && info.nodes === 1234 && info.pv === "e2e4 e7e5" && info.timeMs >= 5,
      JSON.stringify(info),
    );
  });
  check("scratch-empty+probe: never trapped", pe.aborts.length === 0, pe.aborts.join("; "));
}

// ---------------------------------------------------------------------------
// scratch-minimal
// ---------------------------------------------------------------------------

const PERFT_SUITE = [
  { name: "startpos", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", counts: [20, 400, 8902, 197281] },
  { name: "kiwipete", fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", counts: [48, 2039, 97862] },
  { name: "position 3", fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", counts: [14, 191, 2812, 43238] },
  { name: "position 5 (promotions)", fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", counts: [44, 1486, 62379] },
];

const MATE_IN_1 = [
  { name: "back rank", fen: "1k6/ppp5/8/8/8/8/5PPP/3R2K1 w - - 0 1" },
  { name: "scholar's mate", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4" },
  { name: "back rank (Black)", fen: mirrorFen("1k6/ppp5/8/8/8/8/5PPP/3R2K1 w - - 0 1") },
];

const MATE_IN_2 = [
  { name: "Morphy (1.Ra6!)", fen: "kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1" },
  { name: "knight sacrifice (1.Nf6+)", fen: "r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1" },
  { name: "Morphy (Black)", fen: mirrorFen("kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1") },
];

async function testMinimal() {
  section("scratch-minimal: compile");
  const files = await loadTree(path.join(VARIANTS_DIR, "scratch-minimal"));
  check("scratch-minimal: has main.ts", "main.ts" in files);
  const result = await compileTree(files);
  check("scratch-minimal: compiles", result.ok, result.log.slice(0, 2000));
  check("scratch-minimal: no compiler warnings", result.warnings === 0, result.log.slice(0, 2000));
  const lines = Object.values(files).reduce((n, src) => n + src.split("\n").length, 0);
  note(`compiled in ${result.ms.toFixed(0)} ms, ${result.wasm ? result.wasm.length : 0} bytes, ${lines} source lines`);
  if (!result.ok) return;
  if (WRITE_WASM) await saveWasm("scratch-minimal.wasm", result.wasm);

  section("scratch-minimal: ABI");
  const engine = await TestEngine.create(result.wasm);
  checkInterface("scratch-minimal", engine, ["cb_eval", "cb_eval_trace", "cb_perft", "cb_name"]);
  note(`name: ${engine.name()}`);
  engine.exports.cb_new_game();

  section("scratch-minimal: perft");
  guarded("perft suite", () => {
    for (const { name, fen, counts } of PERFT_SUITE) {
      check(`perft ${name}: position accepted`, engine.position(`fen ${fen}`) === 1);
      counts.forEach((expected, i) => {
        const t0 = performance.now();
        const got = engine.perft(i + 1);
        const ms = performance.now() - t0;
        check(`perft ${name} d${i + 1} = ${expected}`, got === expected, `got ${got}`);
        if (i === counts.length - 1) note(`perft ${name} d${i + 1}: ${got} in ${ms.toFixed(0)} ms (${((got / ms) * 1000 / 1e6).toFixed(2)} M leaves/s)`);
      });
    }
    engine.position("startpos");
    check("perft(0) == 1", engine.perft(0) === 1);
  });

  section("scratch-minimal: position parsing");
  guarded("position parsing", () => {
    const bad = [
      "",
      "garbage",
      "fen",
      "fen 8/8/8/8/8/8/8/8 w - - 0 1",
      "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
      "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1",
      "fen rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1",
      "fen 4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", // side not to move is in check
      "fen 4k2P/8/8/8/8/8/8/4K3 w - - 0 1", // pawn on the last rank
      "startpos moves e2e5",
      "startpos moves e7e5",
      "startpos moves e2e4 e7e5 e1e2 e8e7 e2e1q",
      "startpos e2e4",
      "fen 4k3/4r3/8/8/8/8/8/4K2R w K - 0 1 moves e1g1", // castling out of check
      "fen 4k3/8/8/8/8/8/5r2/4K2R w K - 0 1 moves e1g1", // castling through check
      "fen 4k3/P7/8/8/8/8/8/4K3 w - - 0 1 moves a7a8", // promotion without piece
      "fen 4k3/P7/8/8/8/8/8/4K3 w - - 0 1 moves a7a8k",
    ];
    for (const command of bad) check(`rejects "${command}"`, engine.position(command) === 0);
    const good = [
      "startpos",
      "  startpos   moves  e2e4   e7e5  ",
      "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
      "fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - moves e2e4",
      "fen 4k3/8/8/8/8/8/8/4K2R w K - 0 1 moves e1g1",
      "fen r3k3/8/8/8/8/8/8/4K3 b q - 0 1 moves e8c8",
      "startpos moves e2e4 e7e6 e4e5 d7d5 e5d6",
      "fen 4k3/P7/8/8/8/8/8/4K3 w - - 0 1 moves a7a8n",
      "fen 4k3/8/8/8/8/8/4R3/4K3 b - - 0 1", // side to move in check is fine
    ];
    for (const command of good) check(`accepts "${command}"`, engine.position(command) === 1);
    // Inconsistent FEN details are repaired, not trusted.
    check("en-passant square on the wrong rank is ignored", engine.position("fen 4k3/8/8/8/8/8/8/4K3 w - e8 0 1") === 1 && engine.perft(1) === 5);
    check("castling rights without rooks are dropped", engine.position("fen 4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1") === 1 && engine.perft(1) === 5);
    check("castling rights with the king moved are dropped", engine.position("fen r3k2r/8/8/8/8/8/8/R2K3R w KQkq - 0 1") === 1 && engine.perft(1) === new Chess("r3k2r/8/8/8/8/8/8/R2K3R w kq - 0 1").perft(1));
    // Out-of-range lengths from a buggy host must not trap.
    check("cb_position(-5) returns 0", engine.exports.cb_position(-5) === 0);
    check("cb_position(100000) returns without trapping", [0, 1].includes(engine.exports.cb_position(100000)));
    engine.logs = [];
    engine.position("startpos moves e2e4 e7e5 e2e5");
    check("rejection reason is logged", engine.logs.some((l) => l.includes("illegal move") && l.includes("e2e5")), JSON.stringify(engine.logs));
    // After a failed command the engine must still be usable.
    engine.position("fen garbage");
    engine.position("startpos");
    const res = engine.go({ depth: 2 });
    check("usable after a rejected position", legalUcis(new Chess()).includes(res.move), String(res.move));
  });

  section("scratch-minimal: random positions — perft vs chess.js, FEN vs move list, eval symmetry");
  const rng = mulberry32(20261101);
  const randomCount = QUICK ? 30 : 100;
  const positions = [];
  for (let i = 0; i < randomCount; i++) positions.push(randomGame(rng, i % 4 === 0 ? 160 : 70));
  guarded("random positions", () => {
    let perftOk = 0;
    let pathOk = 0;
    let symOk = 0;
    positions.forEach(({ fen, moves }, i) => {
      const depth = !QUICK && i % 5 === 0 ? 3 : 2;
      const chess = new Chess(fen);
      const expected = chess.perft(depth);
      engine.position(`fen ${fen}`);
      const viaFen = engine.perft(depth);
      const evalFen = engine.eval();
      engine.position(`startpos moves ${moves.join(" ")}`.trim());
      const viaMoves = engine.perft(depth);
      if (check(`perft d${depth} matches chess.js: ${fen}`, viaFen === expected, `engine ${viaFen}, chess.js ${expected}`)) perftOk++;
      if (check(`"startpos moves..." == "fen...": ${fen}`, viaMoves === viaFen, `${viaMoves} vs ${viaFen}`)) pathOk++;
      engine.position(`fen ${mirrorFen(fen)}`);
      const evalMirror = engine.eval();
      if (check(`eval(mirror) == -eval: ${fen}`, evalMirror === -evalFen, `${evalFen} vs mirrored ${evalMirror}`)) symOk++;
    });
    note(`perft agrees with chess.js on ${perftOk}/${positions.length}, move-list path on ${pathOk}/${positions.length}, eval symmetric on ${symOk}/${positions.length}`);
  });

  section("scratch-minimal: evaluation");
  guarded("evaluation", () => {
    engine.position("startpos");
    check("startpos eval == 0", engine.eval() === 0, String(engine.eval()));
    engine.position("fen 4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
    const whiteUp = engine.eval();
    engine.position("fen 4k3/8/8/8/8/8/8/3QK3 b - - 0 1");
    check("eval is White POV (White a queen up: > 800 either side to move)", whiteUp > 800 && engine.eval() === whiteUp, `${whiteUp}, ${engine.eval()}`);
    const kiwi = PERFT_SUITE[1].fen;
    engine.position(`fen ${kiwi}`);
    const total = engine.eval();
    const lines = engine.evalTrace().split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
    const wellFormed = lines.every((p) => p.length === 3 && p.slice(1).every((x) => /^-?\d+$/.test(x)));
    const terms = lines.filter((p) => p[0] !== "total");
    const sum = terms.reduce((s, p) => s + Number(p[1]) - Number(p[2]), 0);
    const totalLine = lines.find((p) => p[0] === "total");
    check("cb_eval_trace is label\\twhite\\tblack lines", wellFormed && terms.length >= 2, JSON.stringify(lines));
    check("cb_eval_trace terms add up to cb_eval", sum === total && totalLine && Number(totalLine[1]) === total, `sum ${sum}, total line ${totalLine}, eval ${total}`);
  });

  section("scratch-minimal: cb_go under depth / nodes / movetime limits (legal moves, legal PVs)");
  guarded("search limits", () => {
    const kinds = ["depth", "nodes", "movetime"];
    const depthValues = [1, 2, 3, 4];
    const nodeValues = [1, 100, 1000, 20000];
    const timeValues = [1, 5, 20, 50];
    let legal = 0;
    let maxOvershoot = -Infinity;
    let totalNodes = 0;
    let totalMs = 0;
    positions.forEach(({ fen, moves }, i) => {
      const kind = kinds[i % 3];
      const value = (kind === "depth" ? depthValues : kind === "nodes" ? nodeValues : timeValues)[Math.floor(i / 3) % 4];
      const command = i % 2 === 0 ? `fen ${fen}` : `startpos moves ${moves.join(" ")}`.trim();
      check(`position ${i}`, engine.position(command) === 1, command);
      const res = engine.go({ [kind]: value });
      const legalMoves = legalUcis(new Chess(fen));
      const label = `${kind} ${value} @ ${fen}`;
      if (check(`legal move (${label})`, legalMoves.includes(res.move), `got ${res.move}`)) legal++;
      for (const info of res.infos) {
        const problem = pvProblem(fen, info.pv);
        check(`legal PV (${label}, depth ${info.depth})`, problem === null && info.pv.length > 0, problem ?? "empty PV");
      }
      const last = res.infos.at(-1);
      if (last) {
        totalNodes += last.nodes;
        totalMs += last.timeMs;
        check(`best move == first PV move (${label})`, last.pv.split(" ")[0] === res.move, `${res.move} vs ${last.pv}`);
        // A search stopped by a limit ends with one more report (total nodes and time) at the
        // depth of the last finished iteration.
        const finalRepeat = (inf, k) => k === res.infos.length - 1 && kind !== "depth" && inf.depth === Math.max(k, 1);
        check(`depths increase 1,2,3.. (${label})`, res.infos.every((inf, k) => inf.depth === k + 1 || finalRepeat(inf, k)), JSON.stringify(res.infos.map((x) => x.depth)));
      }
      if (kind === "depth") {
        const mateFound = last && last.mate !== 0;
        check(`depth ${value} reached (${label})`, last && (last.depth === value || (mateFound && last.depth < value)), JSON.stringify(last));
      } else if (kind === "nodes") {
        check(`node limit respected (${label})`, !last || last.nodes <= value, JSON.stringify(last));
      } else {
        const overshoot = res.elapsed - value;
        maxOvershoot = Math.max(maxOvershoot, overshoot);
        check(`movetime respected (${label})`, res.elapsed <= value + 30 + value * 0.1, `${res.elapsed.toFixed(1)} ms`);
      }
    });
    note(`legal best move in ${legal}/${positions.length}; max movetime overshoot ${maxOvershoot.toFixed(1)} ms; ~${totalMs > 0 ? ((totalNodes / totalMs) * 1000 / 1e6).toFixed(2) : "?"} M nodes/s`);
  });

  section("scratch-minimal: clock, infinite + stop, no-legal-move, long games");
  guarded("clock and stop", () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const legalStart = legalUcis(new Chess(start));
    engine.position("startpos");
    let res = engine.go({ wtime: 3000, btime: 3000 });
    check(`clock 3s+0: uses about 1/30 (${res.elapsed.toFixed(1)} ms)`, legalStart.includes(res.move) && res.elapsed <= 3000 / 30 + 30);
    res = engine.go({ wtime: 20, btime: 60000 });
    check(`clock: White with 20 ms left moves fast (${res.elapsed.toFixed(1)} ms)`, legalStart.includes(res.move) && res.elapsed <= 30);
    res = engine.go({ wtime: 400, btime: 400, movestogo: 1 });
    check(`clock: movestogo 1 uses <= 80% (${res.elapsed.toFixed(1)} ms)`, legalStart.includes(res.move) && res.elapsed <= 320 + 30);
    res = engine.go({ wtime: 1000, btime: 1000, winc: 100, binc: 100, depth: 2 });
    check("clock + depth: the depth limit wins", legalStart.includes(res.move) && res.infos.at(-1)?.depth === 2);
    engine.position("startpos moves e2e4");
    const legalAfterE4 = legalUcis(new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"));
    res = engine.go({ wtime: 600000, btime: 300, binc: 0 });
    check(`clock: Black uses Black's clock (${res.elapsed.toFixed(1)} ms)`, legalAfterE4.includes(res.move) && res.elapsed <= 300 / 30 + 30);
    res = engine.go({ stopAfterMs: 150 });
    check(
      `infinite search stops on cb_should_stop (${res.elapsed.toFixed(1)} ms)`,
      legalAfterE4.includes(res.move) && res.elapsed >= 149 && res.elapsed <= 150 + 40,
    );
    res = engine.go({ stopAfterMs: 0 });
    check("stop requested immediately: still a legal move", legalAfterE4.includes(res.move), String(res.move));
    res = engine.go({ nodes: 1 });
    check("nodes 1: still a legal move", legalAfterE4.includes(res.move), String(res.move));

    engine.position("startpos");
    res = engine.go({ depth: 5 });
    const d5 = res.infos.at(-1);
    note(`startpos depth 5: ${res.move}, ${d5?.nodes} nodes, ${res.elapsed.toFixed(0)} ms, score ${d5?.score}, pv ${d5?.pv}`);
    check("startpos depth 5 completes", legalStart.includes(res.move) && d5?.depth === 5);

    engine.position("fen rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
    check("checkmated side: cb_go returns 0", engine.go({ depth: 3 }).len === 0);
    engine.position("fen k7/8/1Q6/8/8/8/8/7K b - - 0 1");
    check("stalemated side: cb_go returns 0", engine.go({ depth: 3 }).len === 0);

    // 1200 plies of knight shuffling: exercises the history-stack reset and repetition detection.
    const shuffle = Array.from({ length: 300 }, () => "g1f3 g8f6 f3g1 f6g8").join(" ");
    check("1200-ply move list accepted", engine.position(`startpos moves ${shuffle}`) === 1);
    res = engine.go({ depth: 4 });
    check("after 1200 plies: legal move", legalStart.includes(res.move), String(res.move));
    const longGame = randomGame(mulberry32(7), 700, { stopOnDraw: false });
    const longChess = new Chess(longGame.fen);
    check(`random ${longGame.moves.length}-ply game accepted`, engine.position(`startpos moves ${longGame.moves.join(" ")}`) === 1);
    check("long game: perft 1 matches chess.js", engine.perft(1) === legalUcis(longChess).length);
    res = engine.go({ depth: 3 });
    check("long game: legal move", legalUcis(longChess).includes(res.move), `${res.move} @ ${longGame.fen}`);
  });

  section("scratch-minimal: mates");
  guarded("mates", () => {
    for (const { name, fen } of MATE_IN_1) {
      const chess = new Chess(fen);
      if (!check(`test data: ${name} is mate in 1`, canForceMate(chess, 1))) continue;
      engine.position(`fen ${fen}`);
      const res = engine.go({ depth: 4 });
      const last = res.infos.at(-1);
      check(`mate in 1 found: ${name}`, moveForcesMate(fen, res.move, 1), `played ${res.move}`);
      check(`mate in 1 reported as mate 1: ${name}`, last?.mate === 1, JSON.stringify(last));
    }
    for (const { name, fen } of MATE_IN_2) {
      const chess = new Chess(fen);
      if (!check(`test data: ${name} is mate in 2 (not 1)`, canForceMate(chess, 2) && !canForceMate(chess, 1))) continue;
      engine.position(`fen ${fen}`);
      const res = engine.go({ depth: 6 });
      const last = res.infos.at(-1);
      check(`mate in 2 found: ${name}`, moveForcesMate(fen, res.move, 2), `played ${res.move}, pv ${last?.pv}`);
      check(`mate in 2 reported as mate 2: ${name}`, last?.mate === 2, JSON.stringify(last));
      note(`${name}: ${res.move} (pv ${last?.pv}), ${last?.nodes} nodes, ${res.elapsed.toFixed(0)} ms`);
    }
    // Also under a time limit instead of a depth limit.
    const morphy = MATE_IN_2[0].fen;
    engine.position(`fen ${morphy}`);
    const timed = engine.go({ movetime: 1000 });
    check("mate in 2 found under movetime 1000", moveForcesMate(morphy, timed.move, 2), String(timed.move));
    // The side being mated reports a negative mate score.
    const mated = "k7/8/1K6/8/8/8/8/7R b - - 0 1";
    const matedChess = new Chess(mated);
    const allLose = matedChess.moves({ verbose: true }).every((m) => {
      matedChess.move(m);
      const r = canForceMate(matedChess, 1);
      matedChess.undo();
      return r;
    });
    if (check("test data: every Black move allows mate in 1", allLose)) {
      engine.position(`fen ${mated}`);
      const res = engine.go({ depth: 4 });
      check("getting mated: legal move and mate -1", legalUcis(new Chess(mated)).includes(res.move) && res.infos.at(-1)?.mate === -1, JSON.stringify(res.infos.at(-1)));
    }
  });

  check("scratch-minimal: never trapped", engine.aborts.length === 0, engine.aborts.join("; "));
  check("scratch-minimal: no stubbed imports", engine.stubbed.length === 0, engine.stubbed.join(", "));
}

async function saveWasm(name, bytes) {
  const dir = path.join(ROOT, ".scratch", "scratch");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
  note(`wrote ${path.join(dir, name)}`);
}

// ---------------------------------------------------------------------------

const t0 = performance.now();
await testEmpty();
await testMinimal();
const seconds = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n${passed} checks passed, ${failures.length} failed (${seconds} s)`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures.slice(0, 50)) console.log(`  - ${f}`);
  process.exitCode = 1;
}
