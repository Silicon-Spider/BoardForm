// Network construction: deterministic initialisation, function-preserving widening, copies.
import type { Activation, FloatNetworkData, OptimizerStateData } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { INPUTS, NetworkFormatError, assertValidHidden, validateFloatNetwork } from "./format";

/** Feature-transformer init range: U(±1/√768) for W1 and b1 (the usual fan-in rule). */
export const W1_INIT_RANGE = 1 / Math.sqrt(INPUTS);

/** Trainable parameters of a network with `hidden` neurons. */
export function parameterCount(hidden: number): number {
  return INPUTS * hidden + hidden + 2 * hidden + 1;
}

function assertActivation(activation: number): asserts activation is Activation {
  if (activation !== 0 && activation !== 1) {
    throw new NetworkFormatError(`Unknown activation ${String(activation)} (expected 0 = CReLU or 1 = SCReLU)`);
  }
}

/** All-zero network of the given shape. */
export function emptyNetwork(hidden: number, activation: Activation): FloatNetworkData {
  assertValidHidden(hidden);
  assertActivation(activation);
  return {
    hidden,
    activation,
    w1: new Float32Array(INPUTS * hidden),
    b1: new Float32Array(hidden),
    w2: new Float32Array(2 * hidden),
    b2: new Float32Array(1),
  };
}

/**
 * Fresh network, deterministic for a given seed (mulberry32). W1 and b1 are drawn from
 * U(±1/√768), W2 from U(±1/√(2·HL)) and b2 = 0, so the initial evaluation is close to 0 cp.
 */
export function createNetwork(hidden: number, activation: Activation, seed: number): FloatNetworkData {
  const net = emptyNetwork(hidden, activation);
  const rnd = mulberry32(seed);
  const r1 = W1_INIT_RANGE;
  for (let i = 0; i < net.w1.length; i++) net.w1[i] = (rnd() * 2 - 1) * r1;
  for (let i = 0; i < net.b1.length; i++) net.b1[i] = (rnd() * 2 - 1) * r1;
  const r2 = 1 / Math.sqrt(2 * hidden);
  for (let i = 0; i < net.w2.length; i++) net.w2[i] = (rnd() * 2 - 1) * r2;
  net.b2[0] = 0;
  return net;
}

/**
 * Grows the hidden layer HL → newHidden while computing exactly the same function: old weights
 * are copied, the new neurons get small random W1/b1 (same range as createNetwork) and their
 * W2 entries are exactly zero (docs/NNUE_FORMAT.md, "Widening"). Train a widened network with a
 * fresh optimizer state (`optimizer: null`).
 */
export function widenNetwork(net: FloatNetworkData, newHidden: number, seed: number): FloatNetworkData {
  validateFloatNetwork(net);
  assertValidHidden(newHidden);
  const hl = net.hidden;
  if (newHidden < hl) throw new RangeError(`Cannot widen a hidden-${hl} network to ${newHidden} (that would shrink it)`);
  if (newHidden === hl) return cloneNetwork(net);
  const nh = newHidden;
  const out = emptyNetwork(nh, net.activation);
  const rnd = mulberry32(seed);
  const r1 = W1_INIT_RANGE;
  for (let f = 0; f < INPUTS; f++) {
    out.w1.set(net.w1.subarray(f * hl, (f + 1) * hl), f * nh);
    for (let j = hl; j < nh; j++) out.w1[f * nh + j] = (rnd() * 2 - 1) * r1;
  }
  out.b1.set(net.b1);
  for (let j = hl; j < nh; j++) out.b1[j] = (rnd() * 2 - 1) * r1;
  // W2 layout: [stm half (HL) | other half (HL)] → [stm (HL') | other (HL')]; new entries stay 0.
  out.w2.set(net.w2.subarray(0, hl), 0);
  out.w2.set(net.w2.subarray(hl, 2 * hl), nh);
  out.b2[0] = net.b2[0] as number;
  return out;
}

/** Deep copy. */
export function cloneNetwork(net: FloatNetworkData): FloatNetworkData {
  return {
    hidden: net.hidden,
    activation: net.activation,
    w1: net.w1.slice(),
    b1: net.b1.slice(),
    w2: net.w2.slice(),
    b2: net.b2.slice(),
  };
}

/** Zero-filled network with the same shape (and activation). */
export function zerosLike(net: FloatNetworkData): FloatNetworkData {
  return {
    hidden: net.hidden,
    activation: net.activation,
    w1: new Float32Array(net.w1.length),
    b1: new Float32Array(net.b1.length),
    w2: new Float32Array(net.w2.length),
    b2: new Float32Array(net.b2.length),
  };
}

/** Fresh AdamW state (step 0, zero moments) for a network. */
export function createOptimizerState(net: FloatNetworkData): OptimizerStateData {
  return { step: 0, m: zerosLike(net), v: zerosLike(net) };
}

export function cloneOptimizerState(opt: OptimizerStateData): OptimizerStateData {
  return { step: opt.step, m: cloneNetwork(opt.m), v: cloneNetwork(opt.v) };
}

/** Throws unless `opt` matches the shape of `net`. */
export function validateOptimizerState(opt: OptimizerStateData, net: FloatNetworkData): void {
  if (!Number.isInteger(opt.step) || opt.step < 0) throw new NetworkFormatError(`Optimizer state: invalid step ${opt.step}`);
  for (const [name, part] of [
    ["m", opt.m],
    ["v", opt.v],
  ] as const) {
    if (part.hidden !== net.hidden) {
      throw new NetworkFormatError(`Optimizer state ${name} is for hidden size ${part.hidden}, network has ${net.hidden}`);
    }
    validateFloatNetwork({ ...part, activation: net.activation }, `optimizer state ${name}`);
  }
}
