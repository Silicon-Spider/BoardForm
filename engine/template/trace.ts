// =====================================================================================
// trace.ts — evaluation breakdown for the editor's test panel
// =====================================================================================
//
// When the host calls cb_eval_trace, main.ts switches `tracing` on, calls evaluate() once
// and serialises what the evaluation reported. An evaluation reports a term like this:
//
//     if (tracing) traceTerm("passed pawns", whiteBonus, blackBonus);
//
// `white` and `black` are that term's contributions in centipawns for each side, positive =
// good for that side, so the term's net effect on the (White point of view) score is
// `white - black`. During normal searches `tracing` is false and nothing is recorded, so the
// check costs a single comparison.
//
// Output format (docs/ENGINE_ABI.md): one line per term, "label\twhite\tblack\n".

import { outReset, outLength, outByte, outString, outInt } from "./io";

/** True while cb_eval_trace runs; evaluation functions record terms only then. */
export let tracing: bool = false;

const labels = new Array<string>();
const whiteValues = new Array<i32>();
const blackValues = new Array<i32>();

/**
 * Switches tracing on or off. (AssemblyScript would also accept `tracing = true` in another
 * file, but TypeScript-based editors treat imported variables as read-only, so main.ts uses this.)
 */
export function setTracing(enabled: bool): void {
  tracing = enabled;
}

/** Forgets all recorded terms. */
export function traceReset(): void {
  labels.length = 0;
  whiteValues.length = 0;
  blackValues.length = 0;
}

/** Records one evaluation term (ignored unless `tracing` is on). */
export function traceTerm(label: string, white: i32, black: i32): void {
  if (!tracing) return;
  labels.push(label);
  whiteValues.push(white);
  blackValues.push(black);
}

/** Number of terms recorded since the last traceReset(). */
export function traceCount(): i32 {
  return labels.length;
}

/** Sum of (white - black) over all recorded terms. */
export function traceNetTotal(): i32 {
  let total = 0;
  for (let i = 0; i < labels.length; i++) total += whiteValues[i] - blackValues[i];
  return total;
}

/** Writes the recorded terms into the output buffer and returns the number of bytes. */
export function traceWrite(): i32 {
  outReset();
  for (let i = 0; i < labels.length; i++) {
    // UTF-8, with tabs and line breaks turned into spaces (they would break the line format).
    outString(labels[i], true);
    outByte(9);
    outInt(whiteValues[i]);
    outByte(9);
    outInt(blackValues[i]);
    outByte(10);
  }
  return outLength();
}

/** Appends a line "label\twhite\tblack\n" to the output buffer (used by main.ts for "total"). */
export function traceAppendLine(label: string, white: i32, black: i32): i32 {
  outString(label, true);
  outByte(9);
  outInt(white);
  outByte(9);
  outInt(black);
  outByte(10);
  return outLength();
}
