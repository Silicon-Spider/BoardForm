// Guards src/nnue/fixtures/reference-vectors.json: the bit-exact test vectors for engine-side
// NNUE implementations (engine/template/nnue.ts). If this fails, either the reference inference
// changed (a spec violation) or the fixture was edited by hand.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFenBoard } from "./fen";
import { parseNetworkFile, type QuantizedNetwork } from "./format";
import { evaluateQuantized } from "./reference";

interface VectorFile {
  description: string;
  networks: Array<{
    name: string;
    hidden: number;
    activation: 0 | 1;
    cbnnBase64: string;
    evals: Array<{ fen: string; cpStm: number; cpWhite: number }>;
  }>;
}

const vectors = JSON.parse(readFileSync(new URL("./fixtures/reference-vectors.json", import.meta.url), "utf8")) as VectorFile;

/** Spec formula with BigInt (independent of reference.ts). */
function bigIntEval(q: QuantizedNetwork, fen: string): number {
  const { pieces, stm } = parseFenBoard(fen);
  const hl = q.hidden;
  const acc = [new Array<bigint>(hl), new Array<bigint>(hl)];
  for (let j = 0; j < hl; j++) {
    (acc[0] as bigint[])[j] = BigInt(q.b1[j] as number);
    (acc[1] as bigint[])[j] = BigInt(q.b1[j] as number);
  }
  for (const p of pieces) {
    const color = p.piece >= 6 ? 1 : 0;
    const type = p.piece % 6;
    const f = [(color === 0 ? 0 : 384) + type * 64 + p.sq, (color === 1 ? 0 : 384) + type * 64 + (p.sq ^ 56)];
    for (let persp = 0; persp < 2; persp++) {
      for (let j = 0; j < hl; j++) {
        (acc[persp] as bigint[])[j] = ((acc[persp] as bigint[])[j] as bigint) + BigInt(q.w1[(f[persp] as number) * hl + j] as number);
      }
    }
  }
  const cr = (x: bigint) => (x < 0n ? 0n : x > 255n ? 255n : x);
  let sum = 0n;
  for (let j = 0; j < hl; j++) {
    const a = cr((acc[stm] as bigint[])[j] as bigint);
    const b = cr((acc[1 - stm] as bigint[])[j] as bigint);
    const wa = BigInt(q.w2[j] as number);
    const wb = BigInt(q.w2[hl + j] as number);
    sum += q.activation === 0 ? a * wa + b * wb : a * a * wa + b * b * wb;
  }
  const out = (q.activation === 0 ? sum : sum / 255n) + BigInt(q.b2);
  return Number((out * 400n) / 16320n);
}

describe("reference vectors fixture", () => {
  it("has networks of both activations and non-trivial evaluations", () => {
    expect(vectors.networks.map((n) => n.activation).sort()).toEqual([0, 0, 1, 1]);
    for (const n of vectors.networks) {
      const distinct = new Set(n.evals.map((e) => e.cpStm));
      expect(distinct.size).toBeGreaterThan(n.evals.length / 2);
      expect(n.evals.some((e) => e.cpStm < 0) && n.evals.some((e) => e.cpStm > 0)).toBe(true);
    }
  });

  for (const n of vectors.networks) {
    it(`${n.name}: reference.ts and the BigInt formula reproduce every value`, () => {
      const q = parseNetworkFile(Buffer.from(n.cbnnBase64, "base64"));
      expect([q.hidden, q.activation]).toEqual([n.hidden, n.activation]);
      for (const e of n.evals) {
        const cp = evaluateQuantized(q, e.fen);
        expect(cp, e.fen).toBe(e.cpStm);
        expect(bigIntEval(q, e.fen), e.fen).toBe(e.cpStm);
        expect(e.cpWhite).toBe(e.fen.split(" ")[1] === "w" ? e.cpStm : -e.cpStm || 0);
      }
    });
  }
});
