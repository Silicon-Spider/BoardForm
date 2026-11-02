// Trainer core: forward / backward over mini-batches of PackedPositions, AdamW, LR schedules.
//
// Model, target and loss are defined in docs/NNUE_FORMAT.md:
//   target = λ·σ(score_stm / 400) + (1 − λ)·result_stm,  pred = σ(out),  loss = (pred − target)²
//
// Performance notes (this is the hot path of the whole Lab):
//  * Inputs are sparse (≤ 32 active features per perspective), so the forward pass sums ≤ 32
//    rows of W1 per perspective and the backward pass scatters the accumulator gradient into the
//    same rows of a dense W1 gradient buffer. Everything lives in preallocated typed arrays;
//    nothing is allocated per sample or per batch.
//  * AdamW runs densely over all parameters after every batch (cheap next to the batch itself:
//    768·HL parameters vs. batch·64·HL multiply-adds). Rows that received no gradient still decay
//    and follow their momentum, exactly like a dense PyTorch AdamW.
//  * Weight decay is applied to W1 and W2, not to the biases (common practice).
import type { Activation, FloatNetworkData, LrSchedule, OptimizerStateData, TrainingHyperParams } from "@/types";
import { INPUTS, SCALE, WEIGHT_CLIP, validateFloatNetwork } from "./format";
import { cloneNetwork, cloneOptimizerState, createOptimizerState, validateOptimizerState } from "./init";
import { MAX_PACKED_PIECES, PACKED_SIZE, decodePackedFeatures } from "./pack";

// Module-local copies of imported bindings used in hot loops: some module runners (vitest's SSR
// transform) turn every use of an imported binding into a property read on a namespace object,
// which costs a getter call per iteration. Local consts are free everywhere.
const CLIP = WEIGHT_CLIP;
const RECORD = PACKED_SIZE;
const SCORE_SCALE = SCALE;
const decode = decodePackedFeatures;

/** TrainingHyperParams plus trainer-only extras (all optional). */
export interface TrainerHyperParams extends TrainingHyperParams {
  /** Linear LR warm-up over the first N steps of the job (default 0 = none). */
  warmupSteps?: number;
}

export const ADAM_BETA1 = 0.9;
export const ADAM_BETA2 = 0.999;
export const ADAM_EPS = 1e-8;
/** Step schedule defaults: ×0.1 every max(1, round(epochs / 3)) epochs. */
export const DEFAULT_LR_GAMMA = 0.1;
/** Cosine schedule floor when `finalLearningRate` is unset: 1% of the base rate. */
export const DEFAULT_COSINE_FLOOR_RATIO = 0.01;

export const DEFAULT_HYPER_PARAMS: Readonly<TrainingHyperParams> = {
  epochs: 10,
  batchSize: 4096,
  learningRate: 0.001,
  lrSchedule: "cosine",
  lrGamma: DEFAULT_LR_GAMMA,
  evalWeight: 0.75,
  weightDecay: 0.01,
  validationSplit: 0.05,
  threads: 1,
  seed: 1,
};

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Training target (docs/NNUE_FORMAT.md) for a score (cp, White POV), a result (0/1/2, White
 * POV) and the side to move (0 White, 1 Black), with evalWeight λ.
 */
export function trainingTarget(scoreWhite: number, result: number, stm: number, evalWeight: number): number {
  const scoreStm = stm === 0 ? scoreWhite : -scoreWhite;
  const resultStm = stm === 0 ? result * 0.5 : 1 - result * 0.5;
  return evalWeight * sigmoid(scoreStm / SCORE_SCALE) + (1 - evalWeight) * resultStm;
}

export function defaultLrStepEpochs(epochs: number): number {
  return Math.max(1, Math.round(epochs / 3));
}

export interface LrScheduleParams {
  learningRate: number;
  lrSchedule: LrSchedule;
  epochs: number;
  lrGamma?: number;
  lrStepEpochs?: number;
  finalLearningRate?: number;
  warmupSteps?: number;
}

/**
 * Learning rate for the step about to run: `epoch` = completed epochs, `step` = completed steps
 * within the current epoch.
 *  - constant: the base rate
 *  - step:     base · gamma^floor(epoch / lrStepEpochs)
 *  - cosine:   floor + ½(base − floor)(1 + cos(π·t)), t = fraction of all steps of the job done
 * An optional linear warm-up scales the first `warmupSteps` steps by (k + 1) / warmupSteps.
 */
export function learningRateAt(h: LrScheduleParams, epoch: number, step: number, stepsPerEpoch: number): number {
  const base = h.learningRate;
  let lr = base;
  if (h.lrSchedule === "step") {
    const every = h.lrStepEpochs !== undefined && h.lrStepEpochs >= 1 ? Math.floor(h.lrStepEpochs) : defaultLrStepEpochs(h.epochs);
    const gamma = h.lrGamma !== undefined && h.lrGamma > 0 ? h.lrGamma : DEFAULT_LR_GAMMA;
    lr = base * Math.pow(gamma, Math.floor(epoch / every));
  } else if (h.lrSchedule === "cosine") {
    const floor = h.finalLearningRate !== undefined && h.finalLearningRate >= 0 ? h.finalLearningRate : base * DEFAULT_COSINE_FLOOR_RATIO;
    const total = h.epochs * stepsPerEpoch;
    const t = total > 0 ? Math.min(1, Math.max(0, (epoch * stepsPerEpoch + step) / total)) : 0;
    lr = floor + 0.5 * (base - floor) * (1 + Math.cos(Math.PI * t));
  }
  const warm = h.warmupSteps ?? 0;
  const global = epoch * stepsPerEpoch + step;
  if (warm > 0 && global < warm) lr *= (global + 1) / warm;
  return lr;
}

/** Throws a RangeError with a user-readable message for invalid settings. */
export function validateHyperParams(h: TrainerHyperParams): void {
  const fail = (msg: string): never => {
    throw new RangeError(`Invalid training settings: ${msg}`);
  };
  if (!Number.isInteger(h.epochs) || h.epochs < 1) fail(`epochs must be a positive integer (got ${h.epochs})`);
  if (!Number.isInteger(h.batchSize) || h.batchSize < 1) fail(`batch size must be a positive integer (got ${h.batchSize})`);
  if (!Number.isFinite(h.learningRate) || h.learningRate <= 0) fail(`learning rate must be > 0 (got ${h.learningRate})`);
  if (h.lrSchedule !== "constant" && h.lrSchedule !== "step" && h.lrSchedule !== "cosine") {
    fail(`unknown learning-rate schedule "${String(h.lrSchedule)}"`);
  }
  if (h.lrGamma !== undefined && !(Number.isFinite(h.lrGamma) && h.lrGamma > 0)) fail(`LR gamma must be > 0 (got ${h.lrGamma})`);
  if (h.finalLearningRate !== undefined && !(Number.isFinite(h.finalLearningRate) && h.finalLearningRate >= 0)) {
    fail(`final learning rate must be ≥ 0 (got ${h.finalLearningRate})`);
  }
  if (!(h.evalWeight >= 0 && h.evalWeight <= 1)) fail(`eval weight must be between 0 and 1 (got ${h.evalWeight})`);
  if (!(Number.isFinite(h.weightDecay) && h.weightDecay >= 0)) fail(`weight decay must be ≥ 0 (got ${h.weightDecay})`);
  if (!(h.validationSplit >= 0 && h.validationSplit <= 0.5)) fail(`validation split must be between 0 and 0.5 (got ${h.validationSplit})`);
  if (!Number.isFinite(h.seed)) fail(`seed must be a number (got ${h.seed})`);
  if (h.warmupSteps !== undefined && !(Number.isInteger(h.warmupSteps) && h.warmupSteps >= 0)) {
    fail(`warm-up steps must be a non-negative integer (got ${h.warmupSteps})`);
  }
}

export interface TrainerConfig {
  /** λ: weight of the search score vs. the game result in the target. */
  evalWeight: number;
  /** Decoupled (AdamW) weight decay. */
  weightDecay: number;
  beta1?: number;
  beta2?: number;
  eps?: number;
}

/** Gradient buffers in float64, same layouts as the network. */
export interface Gradients {
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
  b2: Float64Array;
}

function adamUpdate(
  w: Float32Array,
  g: Float64Array,
  m: Float32Array,
  v: Float32Array,
  decay: number,
  stepSize: number,
  invSqrtBc2: number,
  beta1: number,
  beta2: number,
  eps: number,
  clip: boolean,
): void {
  const c1 = 1 - beta1;
  const c2 = 1 - beta2;
  const n = w.length;
  for (let i = 0; i < n; i++) {
    const gi = g[i] as number;
    const mi = beta1 * (m[i] as number) + c1 * gi;
    const vi = beta2 * (v[i] as number) + c2 * gi * gi;
    m[i] = mi;
    v[i] = vi;
    // PyTorch AdamW: p ← p·(1 − lr·wd) − (lr / bc1) · m / (√v / √bc2 + ε)
    let p = (w[i] as number) * decay - (stepSize * mi) / (Math.sqrt(vi) * invSqrtBc2 + eps);
    if (clip) p = p < -CLIP ? -CLIP : p > CLIP ? CLIP : p;
    w[i] = p;
  }
}


/** Allocates the backing store for a typed array (plain ArrayBuffer by default). */
export type BufferAllocator = (byteLength: number) => ArrayBufferLike;
const plainAllocator: BufferAllocator = (n) => new ArrayBuffer(n);
/** Backs arrays with SharedArrayBuffer (multi-threaded training; needs crossOriginIsolated). */
export const sharedAllocator: BufferAllocator = (n) => new SharedArrayBuffer(n);

/** Copy of `src` whose arrays live in buffers from `alloc`. */
export function copyNetworkTo(src: FloatNetworkData, alloc: BufferAllocator = plainAllocator): FloatNetworkData {
  const copy = (a: Float32Array) => {
    const out = new Float32Array(alloc(a.length * 4));
    out.set(a);
    return out;
  };
  return { hidden: src.hidden, activation: src.activation, w1: copy(src.w1), b1: copy(src.b1), w2: copy(src.w2), b2: copy(src.b2) };
}

/** Zeroed gradient buffers for a hidden size. */
export function allocGradients(hidden: number, alloc: BufferAllocator = plainAllocator): Gradients {
  return {
    w1: new Float64Array(alloc(INPUTS * hidden * 8)),
    b1: new Float64Array(alloc(hidden * 8)),
    w2: new Float64Array(alloc(2 * hidden * 8)),
    b2: new Float64Array(alloc(8)),
  };
}

/**
 * Forward / backward passes over packed positions for one set of weights, accumulating into one
 * set of gradient buffers. Uses the arrays it is given as they are (no copies), so helper
 * threads can run kernels over shared weights with private gradients. Positions are addressed
 * through an index array: `order[start .. start + count)`, position `i` at byte `i · 32` of `data`.
 */
export class GradientKernel {
  readonly hidden: number;
  readonly activation: Activation;
  /** Weights (read only here). */
  readonly net: FloatNetworkData;
  /** Gradient accumulators. */
  readonly grad: Gradients;
  evalWeight: number;

  private readonly accW: Float64Array;
  private readonly accB: Float64Array;
  private readonly dW: Float64Array;
  private readonly dB: Float64Array;
  private readonly fW = new Int32Array(MAX_PACKED_PIECES);
  private readonly fB = new Int32Array(MAX_PACKED_PIECES);

  constructor(net: FloatNetworkData, grad: Gradients, evalWeight: number) {
    this.hidden = net.hidden;
    this.activation = net.activation;
    this.net = net;
    this.grad = grad;
    this.evalWeight = evalWeight;
    const hl = net.hidden;
    this.accW = new Float64Array(hl);
    this.accB = new Float64Array(hl);
    this.dW = new Float64Array(hl);
    this.dB = new Float64Array(hl);
  }

  /** Fills the accumulators for the record at `off`; returns the number of active features. */
  private accumulate(data: Uint8Array, off: number): number {
    const hl = this.hidden;
    const w1 = this.net.w1;
    const b1 = this.net.b1;
    const accW = this.accW;
    const accB = this.accB;
    const fW = this.fW;
    const fB = this.fB;
    const n = decode(data, off, fW, fB);
    for (let j = 0; j < hl; j++) {
      const b = b1[j] as number;
      accW[j] = b;
      accB[j] = b;
    }
    for (let i = 0; i < n; i++) {
      const rw = (fW[i] as number) * hl;
      const rb = (fB[i] as number) * hl;
      for (let j = 0; j < hl; j++) {
        accW[j] = (accW[j] as number) + (w1[rw + j] as number);
        accB[j] = (accB[j] as number) + (w1[rb + j] as number);
      }
    }
    return n;
  }

  /** Output `out` (before σ / ×SCALE) from the current accumulators. */
  private output(stm: number): number {
    const hl = this.hidden;
    const w2 = this.net.w2;
    const us = stm === 0 ? this.accW : this.accB;
    const them = stm === 0 ? this.accB : this.accW;
    let sum = 0;
    if (this.activation === 1) {
      for (let j = 0; j < hl; j++) {
        let a = us[j] as number;
        let b = them[j] as number;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        b = b < 0 ? 0 : b > 1 ? 1 : b;
        sum += a * a * (w2[j] as number) + b * b * (w2[hl + j] as number);
      }
    } else {
      for (let j = 0; j < hl; j++) {
        let a = us[j] as number;
        let b = them[j] as number;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        b = b < 0 ? 0 : b > 1 ? 1 : b;
        sum += a * (w2[j] as number) + b * (w2[hl + j] as number);
      }
    }
    return sum + (this.net.b2[0] as number);
  }

  private targetOf(data: Uint8Array, off: number): number {
    const score = (((data[off + 24] as number) | ((data[off + 25] as number) << 8)) << 16) >> 16;
    return trainingTarget(score, data[off + 26] as number, data[off + 27] as number, this.evalWeight);
  }

  /** Raw float output for one packed position (`out`; eval_cp = out · 400). */
  forwardPacked(data: Uint8Array, offset: number): number {
    this.accumulate(data, offset);
    return this.output(data[offset + 27] as number);
  }

  /** Loss of one packed position under the current weights. */
  lossPacked(data: Uint8Array, offset: number): number {
    const d = sigmoid(this.forwardPacked(data, offset)) - this.targetOf(data, offset);
    return d * d;
  }

  /** Sum (not mean) of the losses of `order[start .. start + count)`; forward only. */
  lossSum(data: Uint8Array, order: Uint32Array, start: number, count: number): number {
    let total = 0;
    for (let s = 0; s < count; s++) {
      const off = (order[start + s] as number) * RECORD;
      const out = this.forwardPacked(data, off);
      const d = sigmoid(out) - this.targetOf(data, off);
      total += d * d;
    }
    return total;
  }

  /** Zeroes the gradient buffers. */
  zeroGradients(): void {
    this.grad.w1.fill(0);
    this.grad.b1.fill(0);
    this.grad.w2.fill(0);
    this.grad.b2.fill(0);
  }

  /**
   * Adds `scale · ∂loss/∂θ` of every position in `order[start .. start + count)` to the gradient
   * buffers and returns the summed loss. Trainer.computeGradients() uses scale = 1 / count, i.e.
   * the gradient of the mean batch loss.
   */
  accumulateGradients(data: Uint8Array, order: Uint32Array, start: number, count: number, scale: number): number {
    const hl = this.hidden;
    const w2 = this.net.w2;
    const gW1 = this.grad.w1;
    const gB1 = this.grad.b1;
    const gW2 = this.grad.w2;
    const accW = this.accW;
    const accB = this.accB;
    const dW = this.dW;
    const dB = this.dB;
    const fW = this.fW;
    const fB = this.fB;
    const screlu = this.activation === 1;
    let gB2 = 0;
    let lossTotal = 0;

    for (let s = 0; s < count; s++) {
      const off = (order[start + s] as number) * RECORD;
      const n = this.accumulate(data, off);
      const stm = data[off + 27] as number;
      const out = this.output(stm);
      const pred = sigmoid(out);
      const diff = pred - this.targetOf(data, off);
      lossTotal += diff * diff;
      // dLoss/dOut = 2(pred - target) * sigmoid'(out), scaled for the batch mean.
      const g = 2 * diff * pred * (1 - pred) * scale;
      if (g === 0) continue;
      gB2 += g;

      // Output layer and activation derivatives, written straight into White/Black buffers.
      const us = stm === 0 ? accW : accB;
      const them = stm === 0 ? accB : accW;
      const dUs = stm === 0 ? dW : dB;
      const dThem = stm === 0 ? dB : dW;
      if (screlu) {
        for (let j = 0; j < hl; j++) {
          const xu = us[j] as number;
          const xt = them[j] as number;
          const cu = xu < 0 ? 0 : xu > 1 ? 1 : xu;
          const ct = xt < 0 ? 0 : xt > 1 ? 1 : xt;
          gW2[j] = (gW2[j] as number) + g * cu * cu;
          gW2[hl + j] = (gW2[hl + j] as number) + g * ct * ct;
          // d/dx clamp(x, 0, 1)^2 = 2x inside (0, 1), 0 outside.
          dUs[j] = xu > 0 && xu < 1 ? 2 * g * (w2[j] as number) * xu : 0;
          dThem[j] = xt > 0 && xt < 1 ? 2 * g * (w2[hl + j] as number) * xt : 0;
        }
      } else {
        for (let j = 0; j < hl; j++) {
          const xu = us[j] as number;
          const xt = them[j] as number;
          const cu = xu < 0 ? 0 : xu > 1 ? 1 : xu;
          const ct = xt < 0 ? 0 : xt > 1 ? 1 : xt;
          gW2[j] = (gW2[j] as number) + g * cu;
          gW2[hl + j] = (gW2[hl + j] as number) + g * ct;
          dUs[j] = xu > 0 && xu < 1 ? g * (w2[j] as number) : 0;
          dThem[j] = xt > 0 && xt < 1 ? g * (w2[hl + j] as number) : 0;
        }
      }

      // Feature transformer: bias + the rows of the active features (sparse scatter).
      for (let j = 0; j < hl; j++) gB1[j] = (gB1[j] as number) + (dW[j] as number) + (dB[j] as number);
      for (let i = 0; i < n; i++) {
        const rw = (fW[i] as number) * hl;
        const rb = (fB[i] as number) * hl;
        for (let j = 0; j < hl; j++) {
          gW1[rw + j] = (gW1[rw + j] as number) + (dW[j] as number);
          gW1[rb + j] = (gW1[rb + j] as number) + (dB[j] as number);
        }
      }
    }
    this.grad.b2[0] = (this.grad.b2[0] as number) + gB2;
    return lossTotal;
  }
}

/** What TrainingSession needs from a trainer (Trainer, or ParallelTrainer for several threads). */
export interface BatchTrainer {
  readonly hidden: number;
  readonly activation: Activation;
  /** Live weights. */
  readonly net: FloatNetworkData;
  /** One optimizer step on `order[start .. start + count)`; returns the mean loss before the update. */
  trainBatch(data: Uint8Array, order: Uint32Array, start: number, count: number, lr: number): number;
  /** Summed loss over `order[start .. start + count)` (forward only). */
  lossSum(data: Uint8Array, order: Uint32Array, start: number, count: number): number;
  /** Deep copies (plain ArrayBuffers) of the weights and optimizer state. */
  snapshot(): { network: FloatNetworkData; optimizer: OptimizerStateData };
  /** Releases threads / resources (optional). */
  dispose?(): void;
}

/**
 * Float network + AdamW state + preallocated work buffers: the single-threaded trainer.
 * `alloc` chooses where the live weights and gradients live (SharedArrayBuffer for helpers).
 */
export class Trainer extends GradientKernel implements BatchTrainer {
  /** Live AdamW state. */
  readonly opt: OptimizerStateData;
  weightDecay: number;
  readonly beta1: number;
  readonly beta2: number;
  readonly eps: number;

  constructor(network: FloatNetworkData, optimizer: OptimizerStateData | null, config: TrainerConfig, alloc?: BufferAllocator) {
    validateFloatNetwork(network);
    if (optimizer) validateOptimizerState(optimizer, network);
    super(copyNetworkTo(network, alloc), allocGradients(network.hidden, alloc), config.evalWeight);
    this.opt = optimizer ? cloneOptimizerState(optimizer) : createOptimizerState(network);
    this.weightDecay = config.weightDecay;
    this.beta1 = config.beta1 ?? ADAM_BETA1;
    this.beta2 = config.beta2 ?? ADAM_BETA2;
    this.eps = config.eps ?? ADAM_EPS;
  }

  /** Gradient of the mean loss over the batch into `grad`; returns the mean loss. */
  computeGradients(data: Uint8Array, order: Uint32Array, start: number, count: number): number {
    this.zeroGradients();
    if (count <= 0) return 0;
    return this.accumulateGradients(data, order, start, count, 1 / count) / count;
  }

  /** One AdamW step with the current gradients, then clips W1, b1, W2 to [-1.98, 1.98]. */
  applyAdamW(lr: number): void {
    const t = this.opt.step + 1;
    this.opt.step = t;
    const b1 = this.beta1;
    const b2 = this.beta2;
    const bc1 = 1 - Math.pow(b1, t);
    const bc2 = 1 - Math.pow(b2, t);
    const stepSize = lr / bc1;
    const invSqrtBc2 = 1 / Math.sqrt(bc2);
    const decay = 1 - lr * this.weightDecay;
    const { net, opt, grad } = this;
    adamUpdate(net.w1, grad.w1, opt.m.w1, opt.v.w1, decay, stepSize, invSqrtBc2, b1, b2, this.eps, true);
    adamUpdate(net.b1, grad.b1, opt.m.b1, opt.v.b1, 1, stepSize, invSqrtBc2, b1, b2, this.eps, true);
    adamUpdate(net.w2, grad.w2, opt.m.w2, opt.v.w2, decay, stepSize, invSqrtBc2, b1, b2, this.eps, true);
    adamUpdate(net.b2, grad.b2, opt.m.b2, opt.v.b2, 1, stepSize, invSqrtBc2, b1, b2, this.eps, false);
  }

  /** computeGradients + applyAdamW; returns the mean loss of the batch (before the update). */
  trainBatch(data: Uint8Array, order: Uint32Array, start: number, count: number, lr: number): number {
    const loss = this.computeGradients(data, order, start, count);
    if (count > 0) this.applyAdamW(lr);
    return loss;
  }

  /** Deep copies of the current weights and optimizer state. */
  snapshot(): { network: FloatNetworkData; optimizer: OptimizerStateData } {
    return { network: cloneNetwork(this.net), optimizer: cloneOptimizerState(this.opt) };
  }
}
