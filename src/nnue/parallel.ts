// Data-parallel training: helper threads compute the gradients of slices of every batch over
// weights shared through SharedArrayBuffer; the coordinating thread (the trainer worker) sums
// the slices in a fixed order and runs AdamW. Same model, loss and optimizer as Trainer; results
// are deterministic for a given thread count (but not bit-identical across thread counts,
// because floating-point sums are grouped differently).
//
// Synchronisation uses one Int32 control block:
//   coordinator: write slices / params / indices → Atomics.add(GEN) → Atomics.notify(GEN)
//   helper:      Atomics.wait(GEN) → Atomics.load(GEN) → work → Atomics.add(DONE) → notify(DONE)
//   coordinator: Atomics.wait(DONE) until every helper is done → read gradients / losses
// Each atomic write → atomic read pair orders the plain (non-atomic) reads and writes around it,
// so weights, indices and gradients are always seen complete. Atomics.wait blocks, so the
// coordinator must run in a worker (never on the main thread).
import type { Activation, FloatNetworkData, OptimizerStateData } from "@/types";
import { INPUTS } from "./format";
import {
  GradientKernel,
  Trainer,
  sharedAllocator,
  type BatchTrainer,
  type Gradients,
  type TrainerConfig,
} from "./trainer";

/** Control block slots (Int32Array). */
export const CTL_GEN = 0;
export const CTL_DONE = 1;
export const CTL_OP = 2;
export const CTL_ERROR = 3;
/** Per-helper [start, count] pairs follow the header. */
export const CTL_HEADER = 4;

export const OP_GRAD = 1;
export const OP_LOSS = 2;
export const OP_EXIT = 3;

/** A helper gets no answer for this long → the step fails instead of hanging forever. */
const HELPER_TIMEOUT_MS = 60_000;

/** Everything a helper thread needs (all buffers are SharedArrayBuffers; posted at start-up). */
export interface HelperInit {
  index: number;
  hidden: number;
  activation: Activation;
  evalWeight: number;
  weights: { w1: SharedArrayBuffer; b1: SharedArrayBuffer; w2: SharedArrayBuffer; b2: SharedArrayBuffer };
  grads: { w1: SharedArrayBuffer; b1: SharedArrayBuffer; w2: SharedArrayBuffer; b2: SharedArrayBuffer };
  data: { buffer: SharedArrayBuffer; byteOffset: number; byteLength: number };
  indices: SharedArrayBuffer;
  control: SharedArrayBuffer;
  /** Float64: [scale, loss of helper 0, loss of helper 1, …]. */
  params: SharedArrayBuffer;
}

export interface HelperState {
  index: number;
  kernel: GradientKernel;
  data: Uint8Array;
  indices: Uint32Array;
  ctl: Int32Array;
  params: Float64Array;
  /** Last generation this helper completed. */
  gen: number;
}

function sabOf(a: ArrayBufferView): SharedArrayBuffer {
  const b = a.buffer;
  if (typeof SharedArrayBuffer === "undefined" || !(b instanceof SharedArrayBuffer)) {
    throw new Error("Parallel training needs SharedArrayBuffer-backed arrays");
  }
  return b;
}

export function createHelperState(init: HelperInit): HelperState {
  const net: FloatNetworkData = {
    hidden: init.hidden,
    activation: init.activation,
    w1: new Float32Array(init.weights.w1),
    b1: new Float32Array(init.weights.b1),
    w2: new Float32Array(init.weights.w2),
    b2: new Float32Array(init.weights.b2),
  };
  const grad: Gradients = {
    w1: new Float64Array(init.grads.w1),
    b1: new Float64Array(init.grads.b1),
    w2: new Float64Array(init.grads.w2),
    b2: new Float64Array(init.grads.b2),
  };
  const ctl = new Int32Array(init.control);
  return {
    index: init.index,
    kernel: new GradientKernel(net, grad, init.evalWeight),
    data: new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength),
    indices: new Uint32Array(init.indices),
    ctl,
    params: new Float64Array(init.params),
    gen: Atomics.load(ctl, CTL_GEN),
  };
}

/** Runs the current generation's job for one helper. Returns false on OP_EXIT. */
export function executeHelperOp(s: HelperState): boolean {
  s.gen = Atomics.load(s.ctl, CTL_GEN); // pairs with the coordinator's Atomics.add(GEN)
  const op = Atomics.load(s.ctl, CTL_OP);
  if (op === OP_EXIT) return false;
  const start = s.ctl[CTL_HEADER + 2 * s.index] as number;
  const count = s.ctl[CTL_HEADER + 2 * s.index + 1] as number;
  try {
    if (op === OP_GRAD) {
      s.kernel.zeroGradients();
      s.params[1 + s.index] = count > 0 ? s.kernel.accumulateGradients(s.data, s.indices, start, count, s.params[0] as number) : 0;
    } else if (op === OP_LOSS) {
      s.params[1 + s.index] = count > 0 ? s.kernel.lossSum(s.data, s.indices, start, count) : 0;
    }
  } catch {
    Atomics.store(s.ctl, CTL_ERROR, 1);
  }
  Atomics.add(s.ctl, CTL_DONE, 1); // publishes the results above
  Atomics.notify(s.ctl, CTL_DONE);
  return true;
}

/** Blocking loop of a helper thread: sleep until the next generation, run it, repeat. */
export function helperLoop(s: HelperState): void {
  for (;;) {
    Atomics.wait(s.ctl, CTL_GEN, s.gen);
    if (Atomics.load(s.ctl, CTL_GEN) === s.gen) continue; // spurious wake-up
    if (!executeHelperOp(s)) return;
  }
}

/** The helper threads of a ParallelTrainer. */
export interface HelperPool {
  /** True when helpers run on other threads (woken with Atomics.notify, awaited with Atomics.wait). */
  readonly threaded: boolean;
  /** Same-thread pools (tests): runs the current generation on every helper synchronously. */
  runInline?(): void;
  dispose(): void;
}

/** Runs the helpers on the calling thread, one after another (for tests and debugging). */
export function inlineHelperPool(inits: HelperInit[]): HelperPool {
  const states = inits.map(createHelperState);
  return {
    threaded: false,
    runInline: () => {
      for (const s of states) executeHelperOp(s);
    },
    dispose: () => {},
  };
}

export interface ParallelTrainerOptions {
  network: FloatNetworkData;
  optimizer: OptimizerStateData | null;
  config: TrainerConfig;
  /** Training data; must be backed by a SharedArrayBuffer (see TrainingSetBuilder `alloc`). */
  data: Uint8Array;
  /** Total threads including the calling one (≥ 2). */
  threads: number;
  /** Most positions per call (≥ the batch size); larger loss evaluations are chunked. */
  capacity: number;
  /** Starts the helper threads (worker-based in the app, inline in tests). */
  startPool(inits: HelperInit[]): Promise<HelperPool> | HelperPool;
}

/**
 * Coordinator of data-parallel training. Batch k is split into `threads` contiguous slices; the
 * calling thread computes slice 0, helpers 1..n the others, then the gradients are summed in
 * helper order and AdamW runs here. Implements BatchTrainer, so TrainingSession uses it like a
 * Trainer. Call dispose() when done (terminates the helpers).
 */
export class ParallelTrainer implements BatchTrainer {
  readonly threads: number;
  private readonly main: Trainer;
  private readonly data: Uint8Array;
  private readonly indices: Uint32Array;
  private readonly ctl: Int32Array;
  private readonly params: Float64Array;
  private readonly helperGrads: Gradients[];
  private pool: HelperPool | null = null;
  private disposed = false;

  private constructor(opts: ParallelTrainerOptions) {
    if (!Number.isInteger(opts.threads) || opts.threads < 2) throw new RangeError("ParallelTrainer needs at least 2 threads");
    sabOf(opts.data);
    this.threads = opts.threads;
    this.main = new Trainer(opts.network, opts.optimizer, opts.config, sharedAllocator);
    this.data = opts.data;
    const helpers = opts.threads - 1;
    this.indices = new Uint32Array(new SharedArrayBuffer(Math.max(1, opts.capacity) * 4));
    this.ctl = new Int32Array(new SharedArrayBuffer((CTL_HEADER + 2 * helpers) * 4));
    this.params = new Float64Array(new SharedArrayBuffer((1 + helpers) * 8));
    this.helperGrads = [];
    for (let h = 0; h < helpers; h++) {
      const g = this.main.grad;
      this.helperGrads.push({
        w1: new Float64Array(new SharedArrayBuffer(g.w1.byteLength)),
        b1: new Float64Array(new SharedArrayBuffer(g.b1.byteLength)),
        w2: new Float64Array(new SharedArrayBuffer(g.w2.byteLength)),
        b2: new Float64Array(new SharedArrayBuffer(g.b2.byteLength)),
      });
    }
  }

  /** Builds the shared buffers and starts the helpers. */
  static async create(opts: ParallelTrainerOptions): Promise<ParallelTrainer> {
    const t = new ParallelTrainer(opts);
    const net = t.main.net;
    const inits: HelperInit[] = t.helperGrads.map((g, index) => ({
      index,
      hidden: net.hidden,
      activation: net.activation,
      evalWeight: opts.config.evalWeight,
      weights: { w1: sabOf(net.w1), b1: sabOf(net.b1), w2: sabOf(net.w2), b2: sabOf(net.b2) },
      grads: { w1: sabOf(g.w1), b1: sabOf(g.b1), w2: sabOf(g.w2), b2: sabOf(g.b2) },
      data: { buffer: sabOf(t.data), byteOffset: t.data.byteOffset, byteLength: t.data.byteLength },
      indices: sabOf(t.indices),
      control: sabOf(t.ctl),
      params: sabOf(t.params),
    }));
    t.pool = await opts.startPool(inits);
    return t;
  }

  get hidden(): number {
    return this.main.hidden;
  }
  get activation(): Activation {
    return this.main.activation;
  }
  get net(): FloatNetworkData {
    return this.main.net;
  }
  /** Live AdamW state. */
  get opt(): OptimizerStateData {
    return this.main.opt;
  }

  /**
   * Runs one operation over `order[start .. start + count)` on all threads (count ≤ capacity).
   * Returns the summed loss; for OP_GRAD the helpers' gradients are ready afterwards.
   */
  private run(op: number, order: Uint32Array, start: number, count: number, scale: number): number {
    const pool = this.pool;
    if (!pool || this.disposed) throw new Error("ParallelTrainer is not running");
    const ctl = this.ctl;
    this.indices.set(order.subarray(start, start + count), 0);
    // Contiguous, near-equal slices: slice 0 for this thread, slice h + 1 for helper h.
    const parts = this.threads;
    const base = Math.floor(count / parts);
    const extra = count % parts;
    let offset = 0;
    let ownStart = 0;
    let ownCount = 0;
    for (let p = 0; p < parts; p++) {
      const len = base + (p < extra ? 1 : 0);
      if (p === 0) {
        ownStart = offset;
        ownCount = len;
      } else {
        ctl[CTL_HEADER + 2 * (p - 1)] = offset;
        ctl[CTL_HEADER + 2 * (p - 1) + 1] = len;
      }
      offset += len;
    }
    this.params[0] = scale;
    Atomics.store(ctl, CTL_DONE, 0);
    Atomics.store(ctl, CTL_ERROR, 0);
    Atomics.store(ctl, CTL_OP, op);
    Atomics.add(ctl, CTL_GEN, 1); // publishes everything written above
    if (pool.threaded) Atomics.notify(ctl, CTL_GEN);

    let loss =
      op === OP_GRAD
        ? this.main.accumulateGradients(this.data, this.indices, ownStart, ownCount, scale)
        : this.main.lossSum(this.data, this.indices, ownStart, ownCount);

    const helpers = this.threads - 1;
    if (pool.threaded) {
      let waitedMs = 0;
      for (;;) {
        const done = Atomics.load(ctl, CTL_DONE);
        if (done >= helpers) break;
        if (Atomics.wait(ctl, CTL_DONE, done, 1000) === "timed-out") {
          waitedMs += 1000;
          if (waitedMs >= HELPER_TIMEOUT_MS) throw new Error("A training thread stopped responding");
        }
      }
    } else {
      pool.runInline?.();
    }
    if (Atomics.load(ctl, CTL_ERROR) !== 0) throw new Error("A training thread failed while computing gradients");
    for (let h = 0; h < helpers; h++) loss += this.params[1 + h] as number;
    return loss;
  }

  /** Adds the helpers' gradients to the main buffers, in helper order (deterministic). */
  private reduce(): void {
    const g = this.main.grad;
    for (const hg of this.helperGrads) {
      const a = g.w1;
      const b = hg.w1;
      for (let i = 0; i < a.length; i++) a[i] = (a[i] as number) + (b[i] as number);
      for (let i = 0; i < g.b1.length; i++) g.b1[i] = (g.b1[i] as number) + (hg.b1[i] as number);
      for (let i = 0; i < g.w2.length; i++) g.w2[i] = (g.w2[i] as number) + (hg.w2[i] as number);
      g.b2[0] = (g.b2[0] as number) + (hg.b2[0] as number);
    }
  }

  trainBatch(data: Uint8Array, order: Uint32Array, start: number, count: number, lr: number): number {
    if (data !== this.data) throw new Error("ParallelTrainer: batches must come from the shared training data");
    if (count <= 0) return 0;
    if (count > this.indices.length) throw new RangeError(`ParallelTrainer: batch of ${count} exceeds capacity ${this.indices.length}`);
    this.main.zeroGradients();
    const loss = this.run(OP_GRAD, order, start, count, 1 / count);
    this.reduce();
    this.main.applyAdamW(lr);
    return loss / count;
  }

  lossSum(data: Uint8Array, order: Uint32Array, start: number, count: number): number {
    if (data !== this.data) throw new Error("ParallelTrainer: positions must come from the shared training data");
    let total = 0;
    const cap = this.indices.length;
    for (let s = 0; s < count; s += cap) total += this.run(OP_LOSS, order, start + s, Math.min(cap, count - s), 0);
    return total;
  }

  snapshot(): { network: FloatNetworkData; optimizer: OptimizerStateData } {
    return this.main.snapshot(); // slice() copies into plain ArrayBuffers
  }

  /** Stops and releases the helper threads. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Atomics.store(this.ctl, CTL_OP, OP_EXIT);
    Atomics.add(this.ctl, CTL_GEN, 1);
    if (this.pool?.threaded) Atomics.notify(this.ctl, CTL_GEN);
    this.pool?.dispose();
    this.pool = null;
  }
}

/** Whether helper threads can be used here; `reason` explains why not. */
export function threadSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof SharedArrayBuffer === "undefined") return { ok: false, reason: "SharedArrayBuffer is not available" };
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (isolated === false) return { ok: false, reason: "the page is not cross-origin isolated" };
  if (typeof Atomics === "undefined" || typeof Atomics.wait !== "function") return { ok: false, reason: "Atomics.wait is not available" };
  if (typeof Worker === "undefined") return { ok: false, reason: "this browser cannot start workers from a worker" };
  return { ok: true };
}

/** Memory budget for the helpers' private gradient buffers (one W1-sized float64 buffer each). */
export const HELPER_GRADIENT_BUDGET_BYTES = 256 * 1024 * 1024;

/** Most threads (coordinator + helpers) whose gradient buffers fit the memory budget. */
export function maxThreadsForHidden(hidden: number): number {
  const perHelper = (INPUTS * hidden + 3 * hidden + 1) * 8;
  return 1 + Math.max(1, Math.floor(HELPER_GRADIENT_BUDGET_BYTES / perHelper));
}

/** Usable thread count for a request: clamped to [1, min(32, hardwareConcurrency)]. */
export function clampThreads(requested: number): number {
  const hw = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  const want = Number.isFinite(requested) ? Math.floor(requested) : 1;
  return Math.max(1, Math.min(want, 32, Math.max(1, hw)));
}
