import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import type { FloatNetworkData } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { boardToFen, NNUE_START_FEN, parseFenBoard } from "./fen";
import { INPUTS, parseNetworkFile, quantizeNetwork, type QuantizedNetwork } from "./format";
import { createNetwork, widenNetwork } from "./init";
import { evaluateFloat, evaluateQuantized } from "./reference";

function playoutFens(games: number, seed: number, plies = 120): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let g = 0; g < games; g++) {
    const chess = new Chess();
    for (let p = 0; p < plies && !chess.isGameOver(); p++) {
      const moves = chess.moves();
      chess.move(moves[Math.floor(rnd() * moves.length)] as string);
      if (p % 3 === 0) out.push(chess.fen());
    }
  }
  return out;
}

/** Independent implementation of the quantized inference in docs/NNUE_FORMAT.md, with BigInt. */
function bigIntEval(q: QuantizedNetwork, fen: string): number {
  const { pieces, stm } = parseFenBoard(fen);
  const hl = q.hidden;
  const acc = [0, 1].map(() => new Array<bigint>(hl).fill(0n).map((_, j) => BigInt(q.b1[j] as number)));
  for (const p of pieces) {
    const color = p.piece >= 6 ? 1 : 0;
    const type = p.piece % 6;
    const fw = (color === 0 ? 0 : 384) + type * 64 + p.sq;
    const fb = (color === 1 ? 0 : 384) + type * 64 + (p.sq ^ 56);
    for (let j = 0; j < hl; j++) {
      (acc[0] as bigint[])[j] = ((acc[0] as bigint[])[j] as bigint) + BigInt(q.w1[fw * hl + j] as number);
      (acc[1] as bigint[])[j] = ((acc[1] as bigint[])[j] as bigint) + BigInt(q.w1[fb * hl + j] as number);
    }
  }
  const us = acc[stm] as bigint[];
  const them = acc[1 - stm] as bigint[];
  const cr = (x: bigint) => (x < 0n ? 0n : x > 255n ? 255n : x);
  let sum = 0n;
  for (let j = 0; j < hl; j++) {
    const a = cr(us[j] as bigint);
    const b = cr(them[j] as bigint);
    const wa = BigInt(q.w2[j] as number);
    const wb = BigInt(q.w2[hl + j] as number);
    sum += q.activation === 0 ? a * wa + b * wb : a * a * wa + b * b * wb;
  }
  const out = (q.activation === 0 ? sum : sum / 255n) + BigInt(q.b2); // BigInt division truncates toward 0
  return Number((out * 400n) / (255n * 64n));
}

/** Random integer network using the full clipped range (±505 for W1/b1, ±127 for W2). */
function randomQuantized(hidden: number, activation: 0 | 1, seed: number): QuantizedNetwork {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const w1 = new Int16Array(INPUTS * hidden).map(() => int(-505, 505));
  const b1 = new Int16Array(hidden).map(() => int(-505, 505));
  const w2 = new Int16Array(2 * hidden).map(() => int(-127, 127));
  return { hidden, activation, w1, b1, w2, b2: int(-3_000_000, 3_000_000) };
}

/** Colour-flipped position: board mirrored vertically, colours and side to move swapped. */
function mirrorFen(fen: string): string {
  const { pieces, stm } = parseFenBoard(fen);
  return boardToFen(
    pieces.map((p) => ({ sq: p.sq ^ 56, piece: p.piece >= 6 ? p.piece - 6 : p.piece + 6 })),
    stm === 0 ? 1 : 0,
  );
}

/** A float network with outputs spread over hundreds of centipawns. */
function spreadNetwork(hidden: number, activation: 0 | 1, seed: number): FloatNetworkData {
  const net = createNetwork(hidden, activation, seed);
  const rnd = mulberry32(seed + 1);
  for (let i = 0; i < net.w1.length; i++) net.w1[i] = (rnd() * 2 - 1) * 0.12;
  for (let i = 0; i < net.b1.length; i++) net.b1[i] = rnd() * 0.5;
  for (let i = 0; i < net.w2.length; i++) net.w2[i] = (rnd() * 2 - 1) * 1.5;
  net.b2[0] = 0.05;
  return net;
}

const FENS = playoutFens(30, 77);

describe("evaluateQuantized (exact integer semantics)", () => {
  for (const activation of [0, 1] as const) {
    it(`matches an independent BigInt implementation (${activation === 0 ? "CReLU" : "SCReLU"}, extreme weights)`, () => {
      for (const [hidden, seed] of [
        [8, 1],
        [32, 2],
        [128, 3],
      ] as const) {
        const q = randomQuantized(hidden, activation, seed * 10 + activation);
        let nonZero = 0;
        for (const fen of FENS.slice(0, 250)) {
          const got = evaluateQuantized(q, fen);
          expect(got).toBe(bigIntEval(q, fen));
          if (got !== 0) nonZero++;
        }
        expect(nonZero).toBeGreaterThan(200);
      }
    });
  }

  it("matches the BigInt implementation through a CBNN file round trip", () => {
    for (const activation of [0, 1] as const) {
      const q = parseNetworkFile(quantizeNetwork(spreadNetwork(64, activation, 5)));
      for (const fen of FENS.slice(0, 200)) expect(evaluateQuantized(q, fen)).toBe(bigIntEval(q, fen));
    }
  });

  it("is colour-symmetric: eval(position) = eval(colour-flipped position)", () => {
    for (const activation of [0, 1] as const) {
      const q = parseNetworkFile(quantizeNetwork(spreadNetwork(32, activation, 9)));
      const net = spreadNetwork(32, activation, 9);
      for (const fen of FENS.slice(0, 300)) {
        const m = mirrorFen(fen);
        expect(evaluateQuantized(q, m)).toBe(evaluateQuantized(q, fen));
        expect(evaluateFloat(net, m)).toBeCloseTo(evaluateFloat(net, fen), 9);
      }
      expect(evaluateQuantized(q, NNUE_START_FEN)).toBe(evaluateQuantized(q, NNUE_START_FEN.replace(" w ", " b ")));
    }
  });

  it("returns +0, never -0", () => {
    const q = randomQuantized(8, 1, 4);
    q.w2.fill(0);
    q.b2 = -1; // trunc(-1·400/16320) = -0 in JS
    expect(Object.is(evaluateQuantized(q, NNUE_START_FEN), 0)).toBe(true);
  });
});

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe("quantized vs float evaluation", () => {
  for (const activation of [0, 1] as const) {
    const name = activation === 0 ? "CReLU" : "SCReLU";

    it(`agree within 1 cp when the float weights lie on the quantization grid (${name})`, () => {
      // Isolates the inference arithmetic from rounding: only the truncations can differ — the final
      // one (< 1 cp) and, for SCReLU, trunc(sum / QA) (< one QA·QB unit = 400 / 16320 cp).
      const bound = activation === 0 ? 1 : 1 + 400 / 16320;
      const net = spreadNetwork(128, activation, 21 + activation);
      for (let i = 0; i < net.w1.length; i++) net.w1[i] = Math.round((net.w1[i] as number) * 255) / 255;
      for (let i = 0; i < net.b1.length; i++) net.b1[i] = Math.round((net.b1[i] as number) * 255) / 255;
      for (let i = 0; i < net.w2.length; i++) net.w2[i] = Math.round((net.w2[i] as number) * 64) / 64;
      net.b2[0] = Math.round(0.05 * 255 * 64) / (255 * 64);
      const q = parseNetworkFile(quantizeNetwork(net));
      let spread = 0;
      for (const fen of FENS) {
        const f = evaluateFloat(net, fen);
        spread += Math.abs(f);
        expect(Math.abs(f - evaluateQuantized(q, fen))).toBeLessThanOrEqual(bound + 1e-6);
      }
      expect(spread / FENS.length).toBeGreaterThan(100); // non-trivial: evals average > 1 pawn
    });

    it(`stay close on an arbitrary non-trivial network (${name})`, () => {
      // Rounding W2 to 1/64 steps shifts all evaluations by a network-specific constant (the
      // activations are ≥ 0, so per-weight rounding errors do not average out across positions);
      // rounding W1 adds a smaller position-dependent error.
      const net = spreadNetwork(128, activation, 21 + activation);
      for (let i = 0; i < net.w2.length; i++) net.w2[i] = (net.w2[i] as number) * 0.2; // |W2| ≤ 0.3
      const q = parseNetworkFile(quantizeNetwork(net));
      const fl: number[] = [];
      const qu: number[] = [];
      for (const fen of FENS) {
        fl.push(evaluateFloat(net, fen));
        qu.push(evaluateQuantized(q, fen));
      }
      const errs = fl.map((f, i) => f - (qu[i] as number));
      const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
      const meanAbsCentred = errs.reduce((a, e) => a + Math.abs(e - bias), 0) / errs.length;
      expect(fl.reduce((a, f) => a + Math.abs(f), 0) / fl.length).toBeGreaterThan(100);
      expect(Math.abs(bias)).toBeLessThan(25);
      expect(meanAbsCentred).toBeLessThan(10);
      expect(pearson(fl, qu)).toBeGreaterThan(0.995);
    });
  }
});

describe("widenNetwork", () => {
  for (const activation of [0, 1] as const) {
    it(`preserves float and quantized outputs exactly (${activation === 0 ? "CReLU" : "SCReLU"})`, () => {
      const base = spreadNetwork(16, activation, 31);
      const qBase = parseNetworkFile(quantizeNetwork(base));
      for (const newHidden of [24, 64, 256]) {
        const wide = widenNetwork(base, newHidden, 99);
        expect(wide.hidden).toBe(newHidden);
        expect(wide.w2.subarray(16, newHidden).every((x) => x === 0)).toBe(true);
        expect(wide.w2.subarray(newHidden + 16).every((x) => x === 0)).toBe(true);
        // New neurons are live (non-zero W1/b1), so they can learn.
        expect(wide.b1.subarray(16).some((x) => x !== 0)).toBe(true);
        const qWide = parseNetworkFile(quantizeNetwork(wide));
        for (const fen of FENS.slice(0, 300)) {
          expect(evaluateFloat(wide, fen)).toBe(evaluateFloat(base, fen));
          expect(evaluateQuantized(qWide, fen)).toBe(evaluateQuantized(qBase, fen));
        }
      }
    });
  }

  it("is deterministic and rejects shrinking / invalid sizes", () => {
    const base = createNetwork(16, 1, 1);
    expect(widenNetwork(base, 32, 5).w1).toEqual(widenNetwork(base, 32, 5).w1);
    expect(() => widenNetwork(base, 8, 5)).toThrow(/shrink/);
    expect(() => widenNetwork(base, 20, 5)).toThrow(/multiple of 8/);
    expect(widenNetwork(base, 16, 5)).toEqual(base);
  });
});

describe("createNetwork", () => {
  it("is deterministic, seed-dependent and starts near 0 cp", () => {
    const a = createNetwork(128, 1, 7);
    expect(createNetwork(128, 1, 7)).toEqual(a);
    expect(createNetwork(128, 1, 8).w1).not.toEqual(a.w1);
    for (const fen of FENS.slice(0, 50)) expect(Math.abs(evaluateFloat(a, fen))).toBeLessThan(100);
    expect(() => createNetwork(100, 1, 1)).toThrow();
    expect(() => createNetwork(4096, 1, 1)).toThrow();
  });
});
