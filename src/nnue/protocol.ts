// Training job contract shared by TrainingSession (in-process), trainer.worker and TrainerClient.
import type { FloatNetworkData, OptimizerStateData } from "@/types";
import type { TrainerHyperParams } from "./trainer";

/**
 * Position inside a job: `epoch` = completed epochs (the 0-based index of the epoch in
 * progress), `step` = completed mini-batches within that epoch. A checkpoint's
 * `{ epoch, step }` passed back as `resume` continues exactly where it left off.
 */
export interface TrainCursor {
  epoch: number;
  step: number;
}

export interface TrainJob {
  network: FloatNetworkData;
  /** AdamW state to continue from; null = fresh optimizer. */
  optimizer: OptimizerStateData | null;
  /** Datasets (IndexedDB) to train on. */
  datasetIds: string[];
  /**
   * TrainingHyperParams (+ optional `warmupSteps`). `threads > 1` trains data-parallel on helper
   * threads when the page is cross-origin isolated (otherwise 1 thread, with a log message).
   * Results are deterministic for a given thread count; resume with the same count to get
   * bit-identical continuations.
   */
  hyper: TrainerHyperParams;
  /** Continue a previous job of the same network, data and seed (from its last checkpoint). */
  resume?: TrainCursor | null;
  /**
   * Also checkpoint whenever the global step index (epoch · stepsPerEpoch + step) is a multiple of
   * N, so a resumed job keeps the same rhythm; 0/unset = only at epoch ends (and at the end / stop).
   */
  checkpointEverySteps?: number;
  /** Cap on positions loaded (uniform random sample beyond it). The memory cap (256 MB) always applies. */
  maxPositions?: number;
  /** In-memory buffers of packed positions (32 bytes each), used in addition to `datasetIds`. */
  data?: ArrayBuffer[];
}

export interface TrainProgress {
  /** Completed epochs (0-based index of the epoch in progress; equals `epochs` when done). */
  epoch: number;
  epochs: number;
  /** Completed steps in the current epoch. */
  step: number;
  stepsPerEpoch: number;
  /** Positions trained on in this job (deterministic: also counts the part before a resume). */
  positionsSeen: number;
  /** Mean training loss of the batches since the previous progress report. */
  trainLoss: number;
  /** Latest validation loss (computed at the start and after every epoch); null without validation data. */
  valLoss: number | null;
  /** Learning rate of the most recent step. */
  lr: number;
  /** Training throughput since the previous report (0 while paused). */
  posPerSec: number;
}

export interface TrainCheckpoint {
  network: FloatNetworkData;
  optimizer: OptimizerStateData;
  /** Cursor to resume from (see TrainCursor). */
  epoch: number;
  step: number;
  positionsSeen: number;
  /** Mean training loss of the current epoch so far (of the finished epoch at an epoch boundary). */
  trainLoss: number;
  valLoss: number | null;
  /** True once all epochs are done; false for intermediate and stop checkpoints. */
  finished: boolean;
}

export interface TrainEpochSummary {
  /** Number of the epoch just finished, 1-based (= completed epochs). */
  epoch: number;
  trainLoss: number;
  valLoss: number | null;
}

export interface TrainHandlers {
  onProgress?(p: TrainProgress): void;
  /** Every checkpoint, including the final one that start()/run() resolves with. */
  onCheckpoint?(c: TrainCheckpoint): void;
  onEpoch?(e: TrainEpochSummary): void;
  onLog?(msg: string): void;
  onError?(err: string): void;
}

/** Main thread → trainer worker. */
export type TrainerRequest = { type: "start"; job: TrainJob } | { type: "pause" } | { type: "resume" } | { type: "stop" };

/** Trainer worker → main thread. */
export type TrainerEvent =
  | { type: "progress"; progress: TrainProgress }
  | { type: "checkpoint"; checkpoint: TrainCheckpoint }
  | { type: "epoch"; summary: TrainEpochSummary }
  | { type: "log"; message: string }
  /** Final checkpoint (finished, or the stop checkpoint); the job is over. */
  | { type: "done"; checkpoint: TrainCheckpoint }
  | { type: "error"; error: string };

/** Transferable buffers of a checkpoint (its arrays are fresh copies, safe to transfer). */
export function checkpointTransferables(c: TrainCheckpoint): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const n of [c.network, c.optimizer.m, c.optimizer.v]) {
    for (const a of [n.w1, n.b1, n.w2, n.b2]) {
      const b = a.buffer;
      if (b instanceof ArrayBuffer && !out.includes(b)) out.push(b);
    }
  }
  return out;
}
