import { describe, expect, it } from "vitest";
import type { FloatNetworkData, TrainingHyperParams } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { buildTrainingSet } from "./dataset";
import { boardToFen } from "./fen";
import { WEIGHT_CLIP, parseNetworkFile, quantizeNetwork } from "./format";
import { createNetwork } from "./init";
import { PACKED_SIZE, decodePackedFeatures, packedToFen } from "./pack";
import { evaluateFloat, evaluateQuantized } from "./reference";
import { TrainingSession } from "./session";
import { makeMaterialDataset, materialBalance, randomPosition } from "./synthetic";
import { Trainer, learningRateAt, sigmoid, trainingTarget, validateHyperParams, type TrainerHyperParams } from "./trainer";

const iota = (n: number) => {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
};

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

/** Tiny network with weights large enough to visit all activation regions. */
function tinyNet(activation: 0 | 1, seed: number): FloatNetworkData {
  const net = createNetwork(8, activation, seed);
  const rnd = mulberry32(seed + 100);
  for (let i = 0; i < net.w1.length; i++) net.w1[i] = (rnd() * 2 - 1) * 0.25;
  for (let i = 0; i < net.b1.length; i++) net.b1[i] = rnd() * 0.6 - 0.1;
  for (let i = 0; i < net.w2.length; i++) net.w2[i] = (rnd() * 2 - 1) * 0.8;
  net.b2[0] = 0.1;
  return net;
}

const HYPER: TrainingHyperParams = {
  epochs: 3,
  batchSize: 256,
  learningRate: 0.002,
  lrSchedule: "cosine",
  evalWeight: 0.75,
  weightDecay: 0.01,
  validationSplit: 0.1,
  threads: 1,
  seed: 1,
};

describe("training target", () => {
  it("follows docs/NNUE_FORMAT.md", () => {
    expect(trainingTarget(0, 1, 0, 0.75)).toBeCloseTo(0.5, 12);
    expect(trainingTarget(400, 2, 0, 1)).toBeCloseTo(sigmoid(1), 12);
    expect(trainingTarget(400, 2, 1, 1)).toBeCloseTo(sigmoid(-1), 12); // Black to move: score negated
    expect(trainingTarget(0, 2, 1, 0)).toBe(0); // White won, Black to move → result_stm = 0
    expect(trainingTarget(0, 0, 1, 0)).toBe(1);
    expect(trainingTarget(-200, 0, 0, 0.6)).toBeCloseTo(0.6 * sigmoid(-0.5), 12);
  });
});

describe("Trainer forward", () => {
  it("equals the float reference evaluation", () => {
    for (const activation of [0, 1] as const) {
      const net = tinyNet(activation, 3);
      const data = makeMaterialDataset(200, 4);
      const t = new Trainer(net, null, { evalWeight: 0.75, weightDecay: 0 });
      for (let i = 0; i < 200; i++) {
        const off = i * PACKED_SIZE;
        expect(t.forwardPacked(data, off) * 400).toBeCloseTo(evaluateFloat(net, packedToFen(data, off)), 9);
      }
    }
  });

  it("copies the network passed in", () => {
    const net = createNetwork(8, 1, 1);
    const t = new Trainer(net, null, { evalWeight: 0.75, weightDecay: 0 });
    t.net.w1[0] = 123;
    expect(net.w1[0]).not.toBe(123);
  });
});

describe("Trainer backward (finite differences)", () => {
  for (const activation of [0, 1] as const) {
    it(`matches numerical gradients (${activation === 0 ? "CReLU" : "SCReLU"})`, () => {
      const N = 24;
      const data = makeMaterialDataset(N, 11 + activation);
      const order = iota(N);
      const t = new Trainer(tinyNet(activation, 5 + activation), null, { evalWeight: 0.6, weightDecay: 0 });
      t.computeGradients(data, order, 0, N);
      const grad = { w1: t.grad.w1.slice(), b1: t.grad.b1.slice(), w2: t.grad.w2.slice(), b2: t.grad.b2.slice() };
      const loss = () => t.lossSum(data, order, 0, N) / N;
      const l0 = loss();
      const h = 2e-3;
      let checked = 0;
      let kinks = 0;
      const check = (arr: Float32Array, i: number, analytic: number) => {
        const orig = arr[i] as number;
        arr[i] = orig + h;
        const wp = arr[i] as number;
        const lp = loss();
        arr[i] = orig - h;
        const wm = arr[i] as number;
        const lm = loss();
        arr[i] = orig;
        const central = (lp - lm) / (wp - wm);
        const fwd = (lp - l0) / (wp - orig);
        const bwd = (l0 - lm) / (orig - wm);
        if (Math.abs(fwd - bwd) > 0.05 * Math.abs(central) + 1e-5) {
          kinks++; // a clamp boundary lies within ±h: the derivative is not defined there
          return;
        }
        expect(Math.abs(analytic - central)).toBeLessThan(1e-6 + 2e-3 * Math.abs(central));
        checked++;
      };
      check(t.net.b2, 0, grad.b2[0] as number);
      for (let i = 0; i < t.net.w2.length; i++) check(t.net.w2, i, grad.w2[i] as number);
      for (let i = 0; i < t.net.b1.length; i++) check(t.net.b1, i, grad.b1[i] as number);
      // W1: every column of the rows that are active in the batch, plus inactive rows (gradient 0).
      const active = new Set<number>();
      const fw = new Int32Array(32);
      const fb = new Int32Array(32);
      for (let s = 0; s < N; s++) {
        const n = decodePackedFeatures(data, s * PACKED_SIZE, fw, fb);
        for (let k = 0; k < n; k++) {
          active.add(fw[k] as number);
          active.add(fb[k] as number);
        }
      }
      const rows = [...active].slice(0, 60);
      for (const r of rows) for (let j = 0; j < 8; j++) check(t.net.w1, r * 8 + j, grad.w1[r * 8 + j] as number);
      let inactiveChecked = 0;
      for (let r = 0; r < 768 && inactiveChecked < 10; r++) {
        if (active.has(r)) continue;
        for (let j = 0; j < 8; j++) expect(grad.w1[r * 8 + j]).toBe(0);
        check(t.net.w1, r * 8, 0);
        inactiveChecked++;
      }
      expect(inactiveChecked).toBe(10);
      expect(checked).toBeGreaterThan(400);
      expect(kinks).toBeLessThan(checked / 10);
    });
  }
});

describe("AdamW", () => {
  it("matches a naive reference implementation (decoupled decay on W1/W2, clipping, no b2 clip)", () => {
    const net = createNetwork(8, 1, 2);
    net.w1[5] = 1.97;
    net.b1[1] = -1.975;
    net.w2[2] = 1.979;
    net.b2[0] = 1.979;
    const lr = 0.01;
    const wd = 0.1;
    const t = new Trainer(net, null, { evalWeight: 0.75, weightDecay: wd });
    const rnd = mulberry32(9);
    // naive state
    const ref = { w1: Array.from(net.w1), b1: Array.from(net.b1), w2: Array.from(net.w2), b2: Array.from(net.b2) };
    const m = { w1: ref.w1.map(() => 0), b1: ref.b1.map(() => 0), w2: ref.w2.map(() => 0), b2: [0] };
    const v = { w1: ref.w1.map(() => 0), b1: ref.b1.map(() => 0), w2: ref.w2.map(() => 0), b2: [0] };
    for (let step = 1; step <= 5; step++) {
      for (const k of ["w1", "b1", "w2", "b2"] as const) {
        const g = t.grad[k];
        for (let i = 0; i < g.length; i++) g[i] = (rnd() * 2 - 1) * 1e-3;
        // push the near-limit weights outwards
        if (k === "w1") g[5] = -1;
        if (k === "b1") g[1] = 1;
        if (k === "w2") g[2] = -1;
        if (k === "b2") g[0] = -1;
        const decayed = k === "w1" || k === "w2";
        const clip = k !== "b2";
        for (let i = 0; i < g.length; i++) {
          const gi = g[i] as number;
          const mi = 0.9 * (m[k][i] as number) + 0.1 * gi;
          const vi = 0.999 * (v[k][i] as number) + 0.001 * gi * gi;
          m[k][i] = Math.fround(mi);
          v[k][i] = Math.fround(vi);
          const mhat = mi / (1 - 0.9 ** step);
          const vhat = vi / (1 - 0.999 ** step);
          let p = (ref[k][i] as number) * (decayed ? 1 - lr * wd : 1) - (lr * mhat) / (Math.sqrt(vhat) + 1e-8);
          if (clip) p = Math.min(WEIGHT_CLIP, Math.max(-WEIGHT_CLIP, p));
          ref[k][i] = Math.fround(p);
        }
      }
      t.applyAdamW(lr);
      expect(t.opt.step).toBe(step);
      for (const k of ["w1", "b1", "w2", "b2"] as const) {
        const got = t.net[k];
        for (let i = 0; i < got.length; i++) expect(got[i] as number).toBeCloseTo(ref[k][i] as number, 6);
        for (let i = 0; i < got.length; i++) expect(t.opt.m[k][i] as number).toBeCloseTo(m[k][i] as number, 9);
      }
    }
    expect(t.net.w1[5]).toBe(Math.fround(WEIGHT_CLIP));
    expect(t.net.b1[1]).toBe(Math.fround(-WEIGHT_CLIP));
    expect(t.net.w2[2]).toBe(Math.fround(WEIGHT_CLIP));
    expect(t.net.b2[0] as number).toBeGreaterThan(WEIGHT_CLIP); // b2 is not clipped
  });
});

describe("learning-rate schedules", () => {
  const base: TrainerHyperParams = { ...HYPER, epochs: 9, learningRate: 0.01 };
  it("constant", () => {
    const h = { ...base, lrSchedule: "constant" as const };
    for (const [e, s] of [
      [0, 0],
      [4, 7],
      [8, 9],
    ] as const)
      expect(learningRateAt(h, e, s, 10)).toBe(0.01);
  });
  it("step", () => {
    const h = { ...base, lrSchedule: "step" as const, lrGamma: 0.5, lrStepEpochs: 3 };
    expect([0, 2, 3, 5, 6, 8].map((e) => learningRateAt(h, e, 4, 10))).toEqual([0.01, 0.01, 0.005, 0.005, 0.0025, 0.0025]);
    // defaults: gamma 0.1 every round(epochs / 3) epochs
    const d = { ...base, lrSchedule: "step" as const };
    expect(learningRateAt(d, 3, 0, 10)).toBeCloseTo(0.001, 12);
    expect(learningRateAt(d, 2, 9, 10)).toBe(0.01);
  });
  it("cosine", () => {
    const h = { ...base, lrSchedule: "cosine" as const, finalLearningRate: 0.001 };
    const steps = 10;
    const total = 9 * steps;
    expect(learningRateAt(h, 0, 0, steps)).toBeCloseTo(0.01, 12);
    const mid = Math.floor(total / 2);
    expect(learningRateAt(h, Math.floor(mid / steps), mid % steps, steps)).toBeCloseTo(0.0055, 9);
    expect(learningRateAt(h, 8, 9, steps)).toBeGreaterThan(0.001);
    expect(learningRateAt(h, 8, 9, steps)).toBeLessThan(0.00101);
    let prev = Infinity;
    for (let g = 0; g < total; g++) {
      const lr = learningRateAt(h, Math.floor(g / steps), g % steps, steps);
      expect(lr).toBeLessThanOrEqual(prev);
      prev = lr;
    }
    // default floor: 1 % of the base rate
    expect(learningRateAt({ ...base, lrSchedule: "cosine" }, 9, 0, steps)).toBeCloseTo(0.0001, 12);
  });
  it("warm-up", () => {
    const h = { ...base, lrSchedule: "constant" as const, warmupSteps: 4 };
    expect([0, 1, 2, 3, 4, 5].map((g) => learningRateAt(h, 0, g, 10))).toEqual([0.0025, 0.005, 0.0075, 0.01, 0.01, 0.01]);
  });
  it("rejects invalid settings", () => {
    const bad: Array<Partial<TrainerHyperParams>> = [
      { epochs: 0 },
      { batchSize: 0 },
      { learningRate: 0 },
      { learningRate: NaN },
      { lrSchedule: "linear" as never },
      { evalWeight: 1.5 },
      { weightDecay: -1 },
      { validationSplit: 0.7 },
      { warmupSteps: -2 },
      { lrGamma: 0 },
    ];
    for (const b of bad) expect(() => validateHyperParams({ ...HYPER, ...b }), JSON.stringify(b)).toThrow(RangeError);
    expect(() => validateHyperParams(HYPER)).not.toThrow();
  });
});

describe("training on a synthetic material dataset", () => {
  it("drives the loss down and the quantized network learns material", async () => {
    const data = makeMaterialDataset(40_000, 3);
    const set = buildTrainingSet([data], { validationSplit: 0.1, seed: 1 });
    const epochs: Array<{ epoch: number; trainLoss: number; valLoss: number | null }> = [];
    let firstVal: number | null = null;
    const session = new TrainingSession({
      network: createNetwork(32, 1, 5),
      optimizer: null,
      set,
      hyper: { ...HYPER, epochs: 6, batchSize: 512, learningRate: 0.004, evalWeight: 1, weightDecay: 0.01, seed: 2 },
      callbacks: {
        onProgress: (p) => {
          if (firstVal === null) firstVal = p.valLoss;
        },
        onEpoch: (e) => epochs.push(e),
      },
      sliceMs: 1000,
    });
    const final = await session.run();
    expect(final.finished).toBe(true);
    expect(epochs.map((e) => e.epoch)).toEqual([1, 2, 3, 4, 5, 6]);
    const v0 = firstVal as unknown as number;
    const v1 = final.valLoss as number;
    expect(v1).toBeLessThan(v0 * 0.15);
    expect((epochs[5] as { trainLoss: number }).trainLoss).toBeLessThan((epochs[0] as { trainLoss: number }).trainLoss);

    // Held-out random positions: the quantized evaluation tracks material (side-to-move POV).
    const q = parseNetworkFile(quantizeNetwork(final.network));
    const rnd = mulberry32(999);
    const evals: number[] = [];
    const mats: number[] = [];
    const floats: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const { pieces, stm } = randomPosition(rnd);
      const fen = boardToFen(pieces, stm);
      const mat = materialBalance(pieces) * (stm === 0 ? 1 : -1);
      if (Math.abs(mat) > 1200) continue; // beyond that σ saturates and the target carries little signal
      evals.push(evaluateQuantized(q, fen));
      floats.push(evaluateFloat(final.network, fen));
      mats.push(mat);
    }
    expect(evals.length).toBeGreaterThan(500);
    const r = pearson(evals, mats);
    expect(r).toBeGreaterThan(0.95);
    // Float vs quantized on a trained network: W2 rounding (1/64 steps) shifts every evaluation
    // by a network-specific constant; the position-dependent part is small.
    const errs = floats.map((f, i) => f - (evals[i] as number));
    const bias = errs.reduce((a, e) => a + e, 0) / errs.length;
    const centred = errs.reduce((a, e) => a + Math.abs(e - bias), 0) / errs.length;
    expect(Math.abs(bias)).toBeLessThan(25);
    expect(centred).toBeLessThan(10);
    expect(pearson(floats, evals)).toBeGreaterThan(0.999);
    console.log(
      `material run: val loss ${v0.toFixed(5)} → ${v1.toFixed(5)}, corr(quantized eval, material) = ${r.toFixed(4)}, ` +
        `float − quantized: offset ${bias.toFixed(2)} cp, mean |centred error| ${centred.toFixed(2)} cp`,
    );
  });
});

describe("throughput", () => {
  it("trains HL=128 at a useful speed (measured, logged)", () => {
    const N = 4096 * 12;
    const data = makeMaterialDataset(N, 1);
    const order = iota(N);
    const results: string[] = [];
    for (const activation of [1, 0] as const) {
      const t = new Trainer(createNetwork(128, activation, 1), null, { evalWeight: 0.75, weightDecay: 0.01 });
      for (let s = 0; s < 4; s++) t.trainBatch(data, order, s * 4096, 4096, 1e-3); // warm up the JIT
      const t0 = performance.now();
      for (let s = 0; s < 12; s++) t.trainBatch(data, order, s * 4096, 4096, 1e-3);
      const posPerSec = N / ((performance.now() - t0) / 1000);
      results.push(`${activation === 1 ? "SCReLU" : "CReLU"} ${Math.round(posPerSec)} pos/s`);
      // Lenient floor so a loaded CI machine does not fail; the target is ≥ 30k pos/s.
      expect(posPerSec).toBeGreaterThan(8000);
    }
    console.log(`trainer throughput, HL=128, batch 4096, single thread: ${results.join(", ")}`);
  });
});
