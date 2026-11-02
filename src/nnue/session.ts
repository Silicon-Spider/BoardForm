// TrainingSession: the epoch / step loop around Trainer — LR schedule, deterministic shuffles,
// validation, progress reports, checkpoints, pause / resume / stop. Plain class with callbacks
// so it runs (and is unit-tested) in Node; workerCore.ts / trainer.worker.ts wire it to messages.
//
// Determinism: the data order depends only on (seed, epoch), the LR only on the cursor, and the
// complete optimizer state is part of every checkpoint — so a job resumed from a checkpoint
// produces bit-identical weights to an uninterrupted run with the same seed.
import type { FloatNetworkData, OptimizerStateData } from "@/types";
import { epochPermutation, type TrainingSet } from "./dataset";
import type { TrainCheckpoint, TrainCursor, TrainEpochSummary, TrainProgress } from "./protocol";
import { Trainer, learningRateAt, validateHyperParams, type BatchTrainer, type TrainerHyperParams } from "./trainer";

export interface SessionCallbacks {
  onProgress?(p: TrainProgress): void;
  onCheckpoint?(c: TrainCheckpoint): void;
  onEpoch?(e: TrainEpochSummary): void;
  onLog?(msg: string): void;
}

/** Validation loss is computed on at most this many positions (an evenly strided subset). */
export const DEFAULT_MAX_VALIDATION_POSITIONS = 262_144;
const INITIAL_LOSS_SAMPLE = 8192;
const EVAL_CHUNK = 4096;

export interface TrainingSessionOptions {
  network: FloatNetworkData;
  optimizer: OptimizerStateData | null;
  /**
   * Pre-built trainer holding `network` / `optimizer` (e.g. a ParallelTrainer over shared memory);
   * by default a single-threaded Trainer is created from them.
   */
  trainer?: BatchTrainer;
  set: TrainingSet;
  hyper: TrainerHyperParams;
  resume?: TrainCursor | null;
  /** Checkpoint whenever the global step (epoch·stepsPerEpoch + step) is a multiple of N; 0 = epoch ends only. */
  checkpointEverySteps?: number;
  callbacks?: SessionCallbacks;
  /** Deliver the final checkpoint through onCheckpoint too (default true). */
  emitFinalCheckpoint?: boolean;
  /** Compute time between yields to the event loop (default 40 ms). */
  sliceMs?: number;
  /** Progress report interval (default 250 ms). */
  progressIntervalMs?: number;
  maxValidationPositions?: number;
  /** Clock (default performance.now). */
  now?: () => number;
  /** How to yield to the event loop (default: a MessageChannel round trip). */
  yieldFn?: () => Promise<void>;
}

/** Thrown when the loss or the weights become NaN / infinite. */
export class TrainingDivergedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingDivergedError";
  }
}

/** Resolves after the event loop had a chance to process pending messages. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stridedSubset(src: Uint32Array, max: number): Uint32Array {
  if (src.length <= max) return src;
  const out = new Uint32Array(max);
  for (let i = 0; i < max; i++) out[i] = src[Math.floor((i * src.length) / max)] as number;
  return out;
}

export class TrainingSession {
  readonly trainer: BatchTrainer;
  readonly set: TrainingSet;
  readonly hyper: TrainerHyperParams;
  readonly stepsPerEpoch: number;
  /** Effective batch size (≤ number of training positions). */
  readonly batchSize: number;

  private epoch = 0;
  private step = 0;
  private positionsSeen = 0;
  private lr = 0;
  private valLoss: number | null = null;
  /** Most recent training loss (window mean; initial estimate before the first step). */
  private trainLoss = NaN;
  /** Mean loss of the last finished epoch (checkpoints taken at an epoch boundary report it). */
  private lastEpochLoss: number | null = null;
  private epochLossSum = 0;
  private epochLossCount = 0;
  private windowLossSum = 0;
  private windowLossCount = 0;
  private windowPositions = 0;
  private windowStart = 0;
  private windowPausedMs = 0;
  private lastProgressAt = 0;
  private sliceStart = 0;

  private started = false;
  private stopRequested = false;
  private pauseRequested = false;
  private pauseWaiter: (() => void) | null = null;

  private readonly callbacks: SessionCallbacks;
  private readonly checkpointEvery: number;
  private readonly emitFinal: boolean;
  private readonly sliceMs: number;
  private readonly progressMs: number;
  private readonly now: () => number;
  private readonly yieldFn: () => Promise<void>;
  private readonly valOrder: Uint32Array;
  private readonly initialCursor: TrainCursor;

  constructor(opts: TrainingSessionOptions) {
    validateHyperParams(opts.hyper);
    this.hyper = opts.hyper;
    this.set = opts.set;
    const trainCount = opts.set.train.length;
    if (trainCount === 0) throw new Error("No training positions: the selected datasets are empty");
    this.trainer =
      opts.trainer ?? new Trainer(opts.network, opts.optimizer, { evalWeight: opts.hyper.evalWeight, weightDecay: opts.hyper.weightDecay });
    this.batchSize = Math.min(opts.hyper.batchSize, trainCount);
    this.stepsPerEpoch = Math.ceil(trainCount / this.batchSize);
    this.callbacks = opts.callbacks ?? {};
    this.checkpointEvery = Math.max(0, Math.floor(opts.checkpointEverySteps ?? 0));
    this.emitFinal = opts.emitFinalCheckpoint ?? true;
    this.sliceMs = opts.sliceMs ?? 40;
    this.progressMs = opts.progressIntervalMs ?? 250;
    this.now = opts.now ?? (() => performance.now());
    this.yieldFn = opts.yieldFn ?? yieldToEventLoop;
    this.valOrder = stridedSubset(opts.set.validation, opts.maxValidationPositions ?? DEFAULT_MAX_VALIDATION_POSITIONS);

    let epoch = Math.max(0, Math.floor(opts.resume?.epoch ?? 0));
    let step = Math.max(0, Math.floor(opts.resume?.step ?? 0));
    if (step >= this.stepsPerEpoch) {
      // Only possible if the data changed since the checkpoint: continue with the next epoch.
      epoch += 1;
      step = 0;
    }
    if (epoch >= opts.hyper.epochs) {
      epoch = opts.hyper.epochs;
      step = 0;
    }
    this.initialCursor = { epoch, step };
    this.epoch = epoch;
    this.step = step;
    this.positionsSeen = epoch * trainCount + Math.min(step * this.batchSize, trainCount);
    this.lr = learningRateAt(opts.hyper, epoch, step, this.stepsPerEpoch);
  }

  /** Current cursor. */
  get cursor(): TrainCursor {
    return { epoch: this.epoch, step: this.step };
  }

  get isPaused(): boolean {
    return this.pauseRequested;
  }

  /** Pauses after the current step (no-op once stopped). */
  pause(): void {
    if (this.stopRequested) return;
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    const w = this.pauseWaiter;
    this.pauseWaiter = null;
    w?.();
  }

  /** Stops after the current step; run() then resolves with the latest weights (finished = false). */
  stop(): void {
    this.stopRequested = true;
    this.resume();
  }

  private log(msg: string): void {
    this.callbacks.onLog?.(msg);
  }

  private async maybeYield(): Promise<void> {
    if (this.now() - this.sliceStart >= this.sliceMs) {
      await this.yieldFn();
      this.sliceStart = this.now();
    }
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.pauseRequested || this.stopRequested) return;
    const pausedAt = this.now();
    this.emitProgress(pausedAt, true);
    while (this.pauseRequested && !this.stopRequested) {
      await new Promise<void>((resolve) => {
        this.pauseWaiter = resolve;
      });
    }
    const t = this.now();
    this.windowPausedMs += t - pausedAt;
    this.sliceStart = t;
  }

  private emitProgress(t: number, paused = false): void {
    const elapsed = t - this.windowStart - this.windowPausedMs;
    const posPerSec = !paused && elapsed > 0 ? (this.windowPositions * 1000) / elapsed : 0;
    if (this.windowLossCount > 0) this.trainLoss = this.windowLossSum / this.windowLossCount;
    this.callbacks.onProgress?.({
      epoch: this.epoch,
      epochs: this.hyper.epochs,
      step: this.step,
      stepsPerEpoch: this.stepsPerEpoch,
      positionsSeen: this.positionsSeen,
      trainLoss: this.trainLoss,
      valLoss: this.valLoss,
      lr: this.lr,
      posPerSec,
    });
    this.windowLossSum = 0;
    this.windowLossCount = 0;
    this.windowPositions = 0;
    this.windowStart = t;
    this.windowPausedMs = 0;
    this.lastProgressAt = t;
  }

  private checkpoint(finished: boolean): TrainCheckpoint {
    const snap = this.trainer.snapshot();
    const epochLoss = this.epochLossCount > 0 ? this.epochLossSum / this.epochLossCount : (this.lastEpochLoss ?? this.trainLoss);
    return {
      network: snap.network,
      optimizer: snap.optimizer,
      epoch: this.epoch,
      step: this.step,
      positionsSeen: this.positionsSeen,
      trainLoss: epochLoss,
      valLoss: this.valLoss,
      finished,
    };
  }

  /** Mean loss over `order` (forward only), yielding between chunks; null if stopped meanwhile. */
  private async meanLoss(order: Uint32Array): Promise<number | null> {
    if (order.length === 0) return null;
    let sum = 0;
    for (let start = 0; start < order.length; start += EVAL_CHUNK) {
      if (this.stopRequested) return null;
      await this.waitWhilePaused();
      const count = Math.min(EVAL_CHUNK, order.length - start);
      sum += this.trainer.lossSum(this.set.data, order, start, count);
      await this.maybeYield();
    }
    const mean = sum / order.length;
    if (!Number.isFinite(mean)) throw new TrainingDivergedError("The network produces NaN / infinite outputs; it cannot be trained further.");
    return mean;
  }

  /** Runs to the end (or until stopped). Resolves with the final checkpoint. Call once. */
  async run(): Promise<TrainCheckpoint> {
    if (this.started) throw new Error("TrainingSession.run() can only be called once");
    this.started = true;
    const { hyper, set, trainer } = this;
    const epochs = hyper.epochs;
    const B = this.batchSize;
    const trainCount = set.train.length;
    const t0 = this.now();
    this.sliceStart = t0;
    this.windowStart = t0;
    this.lastProgressAt = t0;

    const resumed = this.initialCursor.epoch > 0 || this.initialCursor.step > 0;
    this.log(
      `${resumed ? `Resuming at epoch ${this.initialCursor.epoch + 1}, step ${this.initialCursor.step}` : "Starting"}: ` +
        `${trainCount.toLocaleString("en-US")} training / ${set.validation.length.toLocaleString("en-US")} validation positions, ` +
        `${this.stepsPerEpoch} steps of ${B} per epoch, hidden ${trainer.hidden}, ${trainer.activation === 1 ? "SCReLU" : "CReLU"}.`,
    );

    // Starting point for the charts: loss of the incoming network.
    const initialTrain = await this.meanLoss(stridedSubset(set.train, INITIAL_LOSS_SAMPLE));
    if (initialTrain !== null) this.trainLoss = initialTrain;
    const initialVal = await this.meanLoss(this.valOrder);
    if (initialVal !== null) this.valLoss = initialVal;
    this.emitProgress(this.now());

    let perm: Uint32Array | null = null;
    let permEpoch = -1;
    while (this.epoch < epochs && !this.stopRequested) {
      if (permEpoch !== this.epoch) {
        perm = epochPermutation(set.train, hyper.seed, this.epoch, perm ?? undefined);
        permEpoch = this.epoch;
      }
      const order = perm as Uint32Array;
      while (this.step < this.stepsPerEpoch) {
        if (this.stopRequested) break;
        if (this.pauseRequested) {
          await this.waitWhilePaused();
          continue;
        }
        const start = this.step * B;
        const count = Math.min(B, trainCount - start);
        const lr = learningRateAt(hyper, this.epoch, this.step, this.stepsPerEpoch);
        const loss = trainer.trainBatch(set.data, order, start, count, lr);
        if (!Number.isFinite(loss) || !Number.isFinite(trainer.net.b2[0] as number)) {
          throw new TrainingDivergedError(
            `Training diverged at epoch ${this.epoch + 1}, step ${this.step + 1} (the loss became ${String(loss)}). ` +
              "Try a lower learning rate.",
          );
        }
        this.lr = lr;
        this.step++;
        this.positionsSeen += count;
        this.epochLossSum += loss * count;
        this.epochLossCount += count;
        this.windowLossSum += loss * count;
        this.windowLossCount += count;
        this.windowPositions += count;
        const globalStep = this.epoch * this.stepsPerEpoch + this.step;
        if (this.checkpointEvery > 0 && globalStep % this.checkpointEvery === 0 && this.step < this.stepsPerEpoch) {
          this.callbacks.onCheckpoint?.(this.checkpoint(false));
        }
        const t = this.now();
        if (t - this.lastProgressAt >= this.progressMs) this.emitProgress(t);
        await this.maybeYield();
      }
      if (this.step < this.stepsPerEpoch) break; // stopped mid-epoch

      // Epoch finished.
      const epochTrainLoss = this.epochLossCount > 0 ? this.epochLossSum / this.epochLossCount : this.trainLoss;
      const val = await this.meanLoss(this.valOrder);
      if (val !== null) this.valLoss = val;
      this.epoch++;
      this.step = 0;
      this.epochLossSum = 0;
      this.epochLossCount = 0;
      this.lastEpochLoss = epochTrainLoss;
      this.callbacks.onEpoch?.({ epoch: this.epoch, trainLoss: epochTrainLoss, valLoss: this.valLoss });
      this.log(
        `Epoch ${this.epoch}/${epochs}: train loss ${epochTrainLoss.toFixed(6)}` +
          (this.valLoss !== null ? `, validation loss ${this.valLoss.toFixed(6)}` : "") +
          (val === null && this.valOrder.length > 0 ? " (validation skipped: stopped)" : ""),
      );
      if (this.epoch < epochs) this.callbacks.onCheckpoint?.(this.checkpoint(false));
      this.emitProgress(this.now());
    }

    const finished = this.epoch >= epochs;
    const final = this.checkpoint(finished);
    if (!finished) this.log(`Stopped at epoch ${this.epoch + 1}, step ${this.step} of ${this.stepsPerEpoch}.`);
    this.emitProgress(this.now(), true);
    if (this.emitFinal) this.callbacks.onCheckpoint?.(final);
    return final;
  }
}
