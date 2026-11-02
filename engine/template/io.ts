// =====================================================================================
// io.ts — talking to the host: I/O buffers and imported host functions
// =====================================================================================
//
// The engine ABI (docs/ENGINE_ABI.md) passes only numbers across the WebAssembly boundary.
// Text travels through two fixed buffers in the engine's own memory:
//
//   * the input buffer  (host -> engine): commands such as "startpos moves e2e4" or "Hash=64"
//   * the output buffer (engine -> host): best move, principal variation, eval trace, logs
//
// The host learns their addresses from cb_in() / cb_out(), writes `len` bytes, and calls an
// export with `len`. The engine writes its answer at the start of the output buffer and
// returns (or passes to an import) the number of bytes written.
//
// The host also provides a few functions the engine can call ("imports"), declared below
// with @external: the clock, the stop flag, progress reports and debug logging.

import { MOVE_NONE, KNIGHT, moveFrom, moveTo, isPromotion, promotionType } from "./types";

/** Capacity of each buffer in bytes. */
export const IO_BUFFER_SIZE: i32 = 65536;

// Static (never moving, never garbage-collected) memory for the two buffers.
const INPUT: usize = memory.data(IO_BUFFER_SIZE, 16);
const OUTPUT: usize = memory.data(IO_BUFFER_SIZE, 16);

// --------------------------------------------------------------------- host imports

@external("env", "cb_now")
declare function host_now(): f64;

@external("env", "cb_should_stop")
declare function host_should_stop(): i32;

@external("env", "cb_info")
declare function host_info(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32): void;

@external("env", "cb_log")
declare function host_log(len: i32): void;

/** Milliseconds from a monotonic clock (the host's performance.now()). */
@inline
export function now(): f64 {
  return host_now();
}

/** True when the host asks the running search to stop as soon as possible. */
@inline
export function shouldStop(): bool {
  return host_should_stop() != 0;
}

/**
 * Sends a progress report. The principal variation must already be in the output buffer
 * (`pvLen` bytes). `score` is in centipawns from the side to move's point of view; `mate`
 * is "mate in N moves" (negative when the side to move gets mated) or 0.
 */
export function sendInfo(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32): void {
  host_info(depth, seldepth, score, mate, nodes, timeMs, pvLen);
}

/** Shows a line of text in the engine console (uses the output buffer). */
export function logMessage(message: string): void {
  outReset();
  outString(message);
  host_log(outLength());
}

// --------------------------------------------------------------------- input buffer

/** Address of the input buffer (returned by cb_in). */
export function inputPtr(): usize {
  return INPUT;
}

/** The first `len` bytes of the input buffer as a string. */
export function inputString(len: i32): string {
  if (len < 0) len = 0;
  if (len > IO_BUFFER_SIZE) len = IO_BUFFER_SIZE;
  return String.UTF8.decodeUnsafe(INPUT, <usize>len);
}

// -------------------------------------------------------------------- output buffer
// A tiny "writer": outReset() starts at the beginning, out*() append ASCII text,
// outLength() is the number of bytes written. Nothing here allocates memory.

let outPos: i32 = 0;

/** Address of the output buffer (returned by cb_out). */
export function outputPtr(): usize {
  return OUTPUT;
}

/** Starts writing at the beginning of the output buffer. */
export function outReset(): void {
  outPos = 0;
}

/** Number of bytes written since the last outReset(). */
export function outLength(): i32 {
  return outPos;
}

/** Appends one byte (silently ignored when the buffer is full). */
export function outByte(c: i32): void {
  if (outPos < IO_BUFFER_SIZE) {
    store<u8>(OUTPUT + <usize>outPos, <u8>c);
    outPos++;
  }
}

/**
 * Appends a string encoded as UTF-8, which is what the host decodes (docs/ENGINE_ABI.md).
 * AssemblyScript strings are UTF-16, so a surrogate pair (e.g. an emoji) is first combined into
 * one code point. With `singleLine`, tabs and line breaks become spaces so that the text cannot
 * break a line-based format such as the eval trace.
 */
export function outString(s: string, singleLine: bool = false): void {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < n) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (singleLine && (c == 9 || c == 10 || c == 13)) c = 32;
    outCodePoint(c);
  }
}

/** Appends one Unicode code point as 1-4 UTF-8 bytes (a lone surrogate becomes U+FFFD). */
export function outCodePoint(c: i32): void {
  if (c < 0x80) {
    outByte(c);
  } else if (c < 0x800) {
    outByte(0xc0 | (c >> 6));
    outByte(0x80 | (c & 0x3f));
  } else if (c < 0x10000) {
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    outByte(0xe0 | (c >> 12));
    outByte(0x80 | ((c >> 6) & 0x3f));
    outByte(0x80 | (c & 0x3f));
  } else {
    outByte(0xf0 | (c >> 18));
    outByte(0x80 | ((c >> 12) & 0x3f));
    outByte(0x80 | ((c >> 6) & 0x3f));
    outByte(0x80 | (c & 0x3f));
  }
}

/** Appends a signed decimal number. */
export function outInt(value: i32): void {
  let v = <i64>value;
  if (v < 0) {
    outByte(45); // '-'
    v = -v;
  }
  let divisor: i64 = 1;
  while (divisor * 10 <= v) divisor *= 10;
  while (divisor > 0) {
    outByte(48 + <i32>(v / divisor));
    v %= divisor;
    divisor /= 10;
  }
}

/** Appends a square name such as "e4". */
export function outSquare(sq: i32): void {
  outByte(97 + (sq & 7));
  outByte(49 + (sq >> 3));
}

/** Appends a move in UCI notation such as "e2e4" or "e7e8q". */
export function outMove(m: i32): void {
  if (m == MOVE_NONE) {
    outString("0000");
    return;
  }
  outSquare(moveFrom(m));
  outSquare(moveTo(m));
  if (isPromotion(m)) outByte("nbrq".charCodeAt(promotionType(m) - KNIGHT));
}
