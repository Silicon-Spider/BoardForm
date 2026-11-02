// Reference inference (docs/NNUE_FORMAT.md). The quantized path defines the exact integer
// semantics the AssemblyScript engine must reproduce bit for bit; the float path is the
// training model (what the trainer optimises), used for diagnostics and tests.
import type { FloatNetworkData } from "@/types";
import { extractFeatures, type FeatureSet } from "./features";
import { QA, QB, SCALE, type QuantizedNetwork } from "./format";

// Local copies of imported constants used in hot loops (see the note in trainer.ts).
const Q_A = QA;
const Q_AB = QA * QB;
const OUT_SCALE = SCALE;

/** Raw float output `out` (before × SCALE) for pre-extracted features. */
export function forwardFloatFeatures(net: FloatNetworkData, f: FeatureSet): number {
  const hl = net.hidden;
  const w1 = net.w1;
  const accW = new Float64Array(hl);
  const accB = new Float64Array(hl);
  for (let j = 0; j < hl; j++) {
    accW[j] = net.b1[j] as number;
    accB[j] = net.b1[j] as number;
  }
  for (let i = 0; i < f.count; i++) {
    const rw = (f.white[i] as number) * hl;
    const rb = (f.black[i] as number) * hl;
    for (let j = 0; j < hl; j++) {
      accW[j] = (accW[j] as number) + (w1[rw + j] as number);
      accB[j] = (accB[j] as number) + (w1[rb + j] as number);
    }
  }
  const us = f.stm === 0 ? accW : accB;
  const them = f.stm === 0 ? accB : accW;
  const w2 = net.w2;
  let sum = 0;
  for (let j = 0; j < hl; j++) {
    let a = us[j] as number;
    let b = them[j] as number;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    if (net.activation === 1) {
      a *= a;
      b *= b;
    }
    sum += a * (w2[j] as number) + b * (w2[hl + j] as number);
  }
  return sum + (net.b2[0] as number);
}

/** Float model evaluation in centipawns (side-to-move POV, not rounded). */
export function evaluateFloatFeatures(net: FloatNetworkData, f: FeatureSet): number {
  return forwardFloatFeatures(net, f) * OUT_SCALE;
}

/** Float model evaluation of a FEN in centipawns (side-to-move POV, not rounded). */
export function evaluateFloat(net: FloatNetworkData, fen: string): number {
  return evaluateFloatFeatures(net, extractFeatures(fen));
}

/**
 * Exact quantized evaluation (side-to-move POV centipawns, an integer). Accumulators are
 * Int16Array, i.e. i16 storage like the engine's; with clipped weights they never overflow for
 * positions with at most 32 pieces. All sums are exact integers below 2^53, and `Math.trunc`
 * of an exact quotient equals truncating i64 division.
 */
export function evaluateQuantizedFeatures(net: QuantizedNetwork, f: FeatureSet): number {
  const hl = net.hidden;
  const w1 = net.w1;
  const accW = new Int16Array(hl);
  const accB = new Int16Array(hl);
  accW.set(net.b1);
  accB.set(net.b1);
  for (let i = 0; i < f.count; i++) {
    const rw = (f.white[i] as number) * hl;
    const rb = (f.black[i] as number) * hl;
    for (let j = 0; j < hl; j++) {
      accW[j] = (accW[j] as number) + (w1[rw + j] as number);
      accB[j] = (accB[j] as number) + (w1[rb + j] as number);
    }
  }
  const us = f.stm === 0 ? accW : accB;
  const them = f.stm === 0 ? accB : accW;
  const w2 = net.w2;
  let sum = 0;
  let out: number;
  if (net.activation === 0) {
    for (let j = 0; j < hl; j++) {
      const a = Math.min(Math.max(us[j] as number, 0), Q_A);
      const b = Math.min(Math.max(them[j] as number, 0), Q_A);
      sum += a * (w2[j] as number) + b * (w2[hl + j] as number);
    }
    out = sum + net.b2;
  } else {
    for (let j = 0; j < hl; j++) {
      const a = Math.min(Math.max(us[j] as number, 0), Q_A);
      const b = Math.min(Math.max(them[j] as number, 0), Q_A);
      sum += a * a * (w2[j] as number) + b * b * (w2[hl + j] as number);
    }
    out = Math.trunc(sum / Q_A) + net.b2;
  }
  const cp = Math.trunc((out * OUT_SCALE) / Q_AB);
  return cp === 0 ? 0 : cp; // normalise -0
}

/** Exact quantized evaluation of a FEN (side-to-move POV centipawns). */
export function evaluateQuantized(net: QuantizedNetwork, fen: string): number {
  return evaluateQuantizedFeatures(net, extractFeatures(fen));
}
