// =====================================================================================
// main.ts — the engine's interface to the host (BoardForm Engine ABI v1)
// =====================================================================================
//
// Every function exported from this file becomes a WebAssembly export that the host calls
// (see docs/ENGINE_ABI.md for the full contract). The host:
//
//   1. calls cb_init() once,
//   2. optionally cb_set_option("Hash=N") and cb_nnue_alloc / cb_nnue_load,
//   3. calls cb_new_game(),
//   4. then repeatedly cb_position(...) followed by cb_go(...).
//
// Text arguments arrive in the input buffer (cb_in), text results go to the output buffer
// (cb_out); both are managed by io.ts.
//
// This file owns the global Position. cb_position parses into a second, spare Position and
// swaps the two only when everything parsed, so a bad command leaves the current position
// untouched.

import { Position, HISTORY_CAPACITY, initPosition, splitWhitespace } from "./position";
import { initBitboards } from "./bitboard";
import { perft } from "./movegen";
import { initSearch, clearSearch, think } from "./search";
import { evaluate } from "./eval";
import { setTracing, traceReset, traceWrite, traceAppendLine } from "./trace";
import { ttResize, ttClear, DEFAULT_HASH_MB } from "./tt";
import { inputPtr, outputPtr, inputString, outReset, outString, outMove, outLength, logMessage } from "./io";
import { MOVE_NONE } from "./types";
import { nnueAlloc, nnueLoad, nnueReady } from "./nnue";

/** Shown by cb_name. Change it to give your engine its own name. */
const ENGINE_NAME: string = "BoardForm Template 1.0";

let pos = new Position();
let spare = new Position();
let initialized = false;

/** Makes sure cb_init ran (the host always calls it first; this is only a safety net). */
@inline
function ensureInit(): void {
  if (!initialized) cb_init();
}

// --------------------------------------------------------------------- required exports

/** ABI version implemented by this engine. */
export function cb_abi_version(): i32 {
  return 1;
}

/** One-time initialisation: attack tables, hash keys, search tables, transposition table. */
export function cb_init(): void {
  if (initialized) return;
  initialized = true;
  initBitboards();
  initPosition();
  initSearch();
  ttResize(DEFAULT_HASH_MB);
  pos.setStartpos();
  spare.setStartpos();
}

/** Address of the input buffer (host -> engine, 65536 bytes). */
export function cb_in(): usize {
  return inputPtr();
}

/** Address of the output buffer (engine -> host, 65536 bytes). */
export function cb_out(): usize {
  return outputPtr();
}

/** Forgets everything learned in the previous game (hash table, move-ordering statistics). */
export function cb_new_game(): void {
  ensureInit();
  ttClear();
  clearSearch();
}

/**
 * Sets up a position. The input buffer holds the arguments of a UCI `position` command:
 * "startpos [moves e2e4 e7e5 ...]" or "fen <FEN> [moves ...]". Returns 1 on success, 0 for a
 * parse error or an illegal move (the previous position is then kept).
 */
export function cb_position(len: i32): i32 {
  ensureInit();
  const tokens = splitWhitespace(inputString(len));
  let i = 0;
  if (i < tokens.length && tokens[i] == "position") i++; // tolerate a full UCI command
  if (i >= tokens.length) return 0;

  if (tokens[i] == "startpos") {
    spare.setStartpos();
    i++;
  } else if (tokens[i] == "fen") {
    i++;
    let fen = "";
    let fields = 0;
    while (i < tokens.length && tokens[i] != "moves" && fields < 6) {
      fen += fields > 0 ? " " + tokens[i] : tokens[i];
      fields++;
      i++;
    }
    if (!spare.setFen(fen)) return 0;
  } else {
    return 0;
  }

  if (i < tokens.length) {
    if (tokens[i] != "moves") return 0;
    i++;
    for (; i < tokens.length; i++) {
      const m = spare.parseUci(tokens[i]);
      if (m == MOVE_NONE) return 0;
      spare.makeMove(m);
      // Very long games: drop history that can no longer matter for repetitions.
      if (spare.historyLength() >= HISTORY_CAPACITY) spare.compactHistory();
    }
  }

  const t = pos;
  pos = spare;
  spare = t;
  return 1;
}

/**
 * Searches the current position. Limits: depth (plies), nodes, movetime (ms), and a game
 * clock (wtime/btime/winc/binc ms, movestogo; wtime < 0 = no clock). No limit at all means
 * "infinite": search until the host's stop flag is set. Writes the best move (UCI) to the
 * output buffer and returns its length, or 0 when there is no legal move.
 */
export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  ensureInit();
  const best = think(pos, depth, nodes, movetime, wtime, btime, winc, binc, movestogo);
  if (best == MOVE_NONE) return 0;
  outReset();
  outMove(best);
  return outLength();
}

// --------------------------------------------------------------------- optional exports

/** Static evaluation of the current position, centipawns from White's point of view. */
export function cb_eval(): i32 {
  ensureInit();
  return evaluate(pos);
}

/**
 * Evaluation breakdown: one line "label\twhite\tblack\n" per term (see trace.ts), followed by
 * "total\t<evaluation>\t0\n". Returns the number of bytes written to the output buffer.
 */
export function cb_eval_trace(): i32 {
  ensureInit();
  traceReset();
  setTracing(true);
  const total = evaluate(pos);
  setTracing(false);
  traceWrite();
  const len = traceAppendLine("total", total, 0);
  traceReset();
  return len;
}

/** Number of leaf nodes of the legal move tree of the given depth (perft). */
export function cb_perft(depth: i32): f64 {
  ensureInit();
  return <f64>perft(pos, depth);
}

/**
 * Sets an option given as "name=value" in the input buffer. Recognised: "Hash" (transposition
 * table size in MiB). Returns 1 if the option was recognised and applied.
 */
export function cb_set_option(len: i32): i32 {
  ensureInit();
  const text = inputString(len).trim();
  const eq = text.indexOf("=");
  if (eq <= 0) return 0;
  const name = text.substring(0, eq).trim().toLowerCase();
  const value = text.substring(eq + 1).trim();
  if (name == "hash") {
    const mb = parsePositiveInt(value);
    if (mb <= 0) return 0;
    ttResize(mb);
    return 1;
  }
  return 0;
}

/** Returns a buffer of `size` bytes for an NNUE network file (see nnue.ts). */
export function cb_nnue_alloc(size: i32): usize {
  ensureInit();
  return nnueAlloc(size);
}

/** Activates the network copied into the cb_nnue_alloc buffer. Returns 1 on success. */
export function cb_nnue_load(size: i32): i32 {
  ensureInit();
  const ok = nnueLoad(size) && nnueReady();
  logMessage(ok ? "NNUE network loaded (" + size.toString() + " bytes)" : "NNUE network rejected");
  return ok ? 1 : 0;
}

/** Writes the engine's display name to the output buffer and returns its length. */
export function cb_name(): i32 {
  outReset();
  outString(ENGINE_NAME);
  return outLength();
}

// ------------------------------------------------------------------------------ helpers

/** Parses a positive decimal integer (up to 9 digits); returns -1 if invalid. */
function parsePositiveInt(s: string): i32 {
  if (s.length == 0 || s.length > 9) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
}
