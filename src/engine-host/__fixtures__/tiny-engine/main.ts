// @ts-nocheck — AssemblyScript source (test fixture). The app's TypeScript program must not check it.
//
// tiny-engine: a deliberately silly engine implementing the Chess Builder ABI (docs/ENGINE_ABI.md)
// with canned answers, so the host (src/engine-host) can be tested end to end.
//
// Positions
//   "startpos"                -> best move e2e4
//   "startpos moves e2e4"     -> e7e5
//   anything else             -> g1f3 (White to move) / g8f6 (Black to move)
//   MATED_FEN (fool's mate)   -> no legal move: cb_go returns 0
//   cb_position returns 0 for a malformed command, a FEN with < 4 fields or a malformed move.
//
// Searches (cb_go) — the eight arguments are recorded (dbg_go_arg)
//   no limit at all (infinite) -> busy-waits, polling cb_should_stop, info every ~20 ms
//   movetime > 0               -> busy-waits `movetime` ms (polling the stop flag)
//   clock (wtime >= 0)         -> busy-waits own time / 20 + own increment / 2
//   depth 1..4                 -> one info per depth d: score 10d, nodes 1000d (or the node limit), time d ms
//   depth 5 / 6                -> mate in 3 / mated in 2
//   depth 7                    -> grows memory before every info (host must refresh its views)
//   depth 90                   -> one info, then abort("search exploded") via throw
//   depth 91                   -> one info, then an `unreachable` trap
//   depth 92                   -> one info, then spins WITHOUT polling the stop flag (needs terminate)
//   depth 93                   -> calls the unknown import; returns a2a3 if the stub returned 0

import { cb_info, cb_log, cb_now, cb_should_stop, mystery_import } from "./env";
import { clock_time_get, fd_prestat_get, fd_write, proc_exit, random_get, sock_accept } from "./wasi_snapshot_preview1";

const BUF_SIZE: i32 = 65536;
const IN: usize = memory.data(BUF_SIZE);
const OUT: usize = memory.data(BUF_SIZE);
const SCRATCH: usize = memory.data(256);

const MATED_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

let initCalls: i32 = 0;
let newGames: i32 = 0;
let hashMb: i32 = 0;
let nnuePtr: usize = 0;
let networkLoaded: i32 = 0;

let isStartpos = true;
let isMated = false;
let moveCount: i32 = 0;
let whiteToMove = true;
const goArgs = new StaticArray<f64>(8);

// --- helpers --------------------------------------------------------------------------------------

/** Writes ASCII text to the output buffer and returns its length. */
function writeOut(s: string): i32 {
  const n = s.length;
  for (let i = 0; i < n; i++) store<u8>(OUT + <usize>i, <u8>s.charCodeAt(i));
  return n;
}

function log(s: string): void {
  cb_log(writeOut(s));
}

function readIn(len: i32): string {
  return String.UTF8.decodeUnsafe(IN, <usize>len);
}

function isMoveToken(t: string): bool {
  if (t.length != 4 && t.length != 5) return false;
  for (let i = 0; i < 4; i++) {
    const c = t.charCodeAt(i);
    if ((i & 1) == 0) {
      if (c < 97 || c > 104) return false; // a..h
    } else if (c < 49 || c > 56) return false; // 1..8
  }
  if (t.length == 5) {
    const p = t.charCodeAt(4);
    if (p != 113 && p != 114 && p != 98 && p != 110) return false; // q r b n
  }
  return true;
}

function bestMove(): string {
  if (isStartpos && moveCount == 0) return "e2e4";
  if (isStartpos && moveCount == 1) return "e7e5";
  return whiteToMove ? "g1f3" : "g8f6";
}

/** Reports one iteration; the PV is the best move plus filler moves, min(depth, 4) moves long. */
function report(depth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, best: string): void {
  let pv = best;
  const n = min(depth, 4);
  if (n >= 2) pv += " a7a6";
  if (n >= 3) pv += " a2a3";
  if (n >= 4) pv += " h7h6";
  cb_info(depth, depth + 2, score, mate, nodes, timeMs, writeOut(pv));
}

// --- required ABI ---------------------------------------------------------------------------------

export function cb_abi_version(): i32 {
  return 1;
}

export function cb_init(): void {
  initCalls++;
  log("tiny-engine ready");
}

export function cb_in(): usize {
  return IN;
}

export function cb_out(): usize {
  return OUT;
}

export function cb_new_game(): void {
  newGames++;
}

export function cb_position(len: i32): i32 {
  const cmd = readIn(len);
  const movesAt = cmd.indexOf(" moves ");
  const head = movesAt >= 0 ? cmd.substring(0, movesAt) : cmd;
  let startpos = false;
  let fen = "";
  if (head == "startpos") {
    startpos = true;
  } else if (head.startsWith("fen ")) {
    fen = head.substring(4).trim();
    if (fen.split(" ").length < 4) return 0;
  } else {
    return 0;
  }

  let count = 0;
  if (movesAt >= 0) {
    const tokens = cmd.substring(movesAt + 7).split(" ");
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.length == 0) continue;
      if (!isMoveToken(t)) return 0;
      count++;
    }
  }

  let white = true;
  if (!startpos) white = fen.split(" ")[1] != "b";
  isStartpos = startpos;
  moveCount = count;
  isMated = !startpos && count == 0 && fen == MATED_FEN;
  whiteToMove = (count & 1) == 0 ? white : !white;
  return 1;
}

export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  goArgs[0] = <f64>depth;
  goArgs[1] = nodes;
  goArgs[2] = <f64>movetime;
  goArgs[3] = <f64>wtime;
  goArgs[4] = <f64>btime;
  goArgs[5] = <f64>winc;
  goArgs[6] = <f64>binc;
  goArgs[7] = <f64>movestogo;
  if (isMated) return 0;

  const best = bestMove();
  const start = cb_now();

  if (depth == 90) {
    report(1, 5, 0, 100, 1, best);
    throw new Error("search exploded");
  }
  if (depth == 91) {
    report(1, 5, 0, 100, 1, best);
    unreachable();
  }
  if (depth == 92) {
    report(1, 5, 0, 100, 1, best);
    // Ignores the stop flag on purpose: only terminating the worker ends this search.
    while (cb_now() - start < 600000) {}
    return writeOut(best);
  }
  if (depth == 93) {
    return writeOut(mystery_import(41) == 0 ? "a2a3" : "h2h3");
  }
  if (depth == 5) {
    report(5, 0, 3, 5000, 2, best);
    return writeOut(best);
  }
  if (depth == 6) {
    report(6, 0, -2, 6000, 3, best);
    return writeOut(best);
  }
  if (depth == 7) {
    for (let d = 1; d <= 3; d++) {
      memory.grow(1); // detaches the host's previous view of memory.buffer
      report(d, 10 * d, 0, <f64>(1000 * d), <f64>d, best);
    }
    return writeOut(best);
  }

  // Time-based "searches": busy-wait, polling the stop flag, with an info about every 20 ms.
  let budget: f64 = -1;
  const infinite = depth <= 0 && nodes <= 0 && movetime <= 0 && wtime < 0;
  if (infinite) budget = 600000;
  else if (movetime > 0) budget = <f64>movetime;
  else if (wtime >= 0) budget = <f64>(whiteToMove ? wtime : btime) / 20 + <f64>(whiteToMove ? winc : binc) / 2;
  if (budget >= 0) {
    let iteration = 0;
    let next = start + 20;
    while (true) {
      if (cb_should_stop() != 0) break;
      const now = cb_now();
      if (now - start >= budget) break;
      if (now >= next) {
        iteration++;
        report(iteration, iteration, 0, <f64>(iteration * 1000), now - start, best);
        next = now + 20;
      }
    }
    return writeOut(best);
  }

  // Depth / node "searches": canned iterations.
  const iterations = depth > 0 ? min(depth, 4) : 1;
  for (let d = 1; d <= iterations; d++) report(d, 10 * d, 0, nodes > 0 ? nodes : <f64>(1000 * d), <f64>d, best);
  return writeOut(best);
}

// --- optional ABI ---------------------------------------------------------------------------------

export function cb_eval(): i32 {
  return isStartpos ? 12 + moveCount : -7;
}

export function cb_eval_trace(): i32 {
  return writeOut("material\t3900\t3900\nmobility\t25\t20\ntotal\t5\t0\n");
}

export function cb_perft(depth: i32): f64 {
  if (depth == 0) return 1;
  if (depth == 1) return 20;
  if (depth == 2) return 400;
  if (depth == 3) return 8902;
  return -1;
}

export function cb_set_option(len: i32): i32 {
  const s = readIn(len);
  const eq = s.indexOf("=");
  if (eq < 0) return 0;
  const name = s.substring(0, eq);
  const value = s.substring(eq + 1);
  if (name == "Hash") {
    hashMb = <i32>parseInt(value);
    return 1;
  }
  if (name == "Contempt") return 1;
  return 0;
}

export function cb_nnue_alloc(size: i32): usize {
  if (size <= 0 || size > 1 << 24) return 0;
  nnuePtr = heap.alloc(<usize>size);
  return nnuePtr;
}

/** Accepts any buffer that starts with the CBNN magic. */
export function cb_nnue_load(size: i32): i32 {
  if (nnuePtr == 0 || size < 4) return 0;
  const ok = load<u8>(nnuePtr) == 67 && load<u8>(nnuePtr + 1) == 66 && load<u8>(nnuePtr + 2) == 78 && load<u8>(nnuePtr + 3) == 78;
  networkLoaded = ok ? 1 : 0;
  return networkLoaded;
}

export function cb_name(): i32 {
  return writeOut("Tiny Engine 1.0");
}

// --- debug exports used by the tests --------------------------------------------------------------

export function dbg_go_arg(i: i32): f64 {
  return goArgs[i];
}

export function dbg_hash(): i32 {
  return hashMb;
}

export function dbg_network(): i32 {
  return networkLoaded;
}

export function dbg_init_calls(): i32 {
  return initCalls;
}

export function dbg_new_games(): i32 {
  return newGames;
}

export function dbg_abort(): void {
  throw new Error("kaboom");
}

export function dbg_unknown(): i32 {
  return mystery_import(41) + 1;
}

export function dbg_trace(): void {
  trace("hello from trace", 2, 1.5, -2.0);
}

export function dbg_random(): f64 {
  return Math.random();
}

export function dbg_grow(): i32 {
  return memory.grow(1);
}

/** Two lines to stdout through fd_write; returns the bytes written (or -errno). */
export function dbg_wasi_write(): i32 {
  const text = SCRATCH + 64;
  const msg = "hello wasi\nsecond line\n";
  for (let i = 0; i < msg.length; i++) store<u8>(text + <usize>i, <u8>msg.charCodeAt(i));
  store<u32>(SCRATCH, <u32>text); // iovec.buf
  store<u32>(SCRATCH + 4, <u32>msg.length); // iovec.len
  const errno = fd_write(1, SCRATCH, 1, SCRATCH + 8);
  return errno == 0 ? <i32>load<u32>(SCRATCH + 8) : -errno;
}

/** Text without a trailing newline to stderr (the host flushes it when the call returns). */
export function dbg_wasi_partial(): i32 {
  const text = SCRATCH + 64;
  const msg = "no newline";
  for (let i = 0; i < msg.length; i++) store<u8>(text + <usize>i, <u8>msg.charCodeAt(i));
  store<u32>(SCRATCH, <u32>text);
  store<u32>(SCRATCH + 4, <u32>msg.length);
  return fd_write(2, SCRATCH, 1, SCRATCH + 8);
}

/** Monotonic clock in ms (or -1 on error). */
export function dbg_wasi_clock(): f64 {
  const errno = clock_time_get(1, 1000, SCRATCH);
  return errno == 0 ? <f64>load<u64>(SCRATCH) / 1e6 : -1;
}

/** (errno << 8) | number of non-zero bytes among 32 random bytes. */
export function dbg_wasi_random(): i32 {
  const buf = SCRATCH + 128;
  const errno = random_get(buf, 32);
  let nonzero = 0;
  for (let i = 0; i < 32; i++) if (load<u8>(buf + <usize>i) != 0) nonzero++;
  return (errno << 8) | nonzero;
}

export function dbg_wasi_prestat(): i32 {
  return fd_prestat_get(3, SCRATCH);
}

export function dbg_wasi_unknown(): i32 {
  return sock_accept(0, 0, SCRATCH);
}

export function dbg_wasi_exit(): void {
  proc_exit(3);
}
