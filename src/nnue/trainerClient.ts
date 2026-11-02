// Main-thread handle for one training job at a time in a dedicated trainer worker.
//
//   const client = new TrainerClient();
//   const final = await client.start(job, { onProgress, onCheckpoint, onEpoch, onLog, onError });
//
// pause() / resume() / stop() are messages to the worker (handled between ~40 ms slices).
// stop() resolves start() with the latest weights (finished = false); terminate() kills the
// worker at once and rejects start() with an AbortError. A new worker is spawned per job and
// terminated when the job ends, which releases the training set's memory.
import type { TrainCheckpoint, TrainHandlers, TrainJob, TrainerEvent, TrainerRequest } from "./protocol";

/** The subset of the Worker API the client needs (a fake can be injected in tests). */
export interface TrainerWorkerLike {
  postMessage(message: TrainerRequest): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export function createTrainerWorker(): TrainerWorkerLike {
  return new Worker(new URL("./trainer.worker.ts", import.meta.url), { type: "module", name: "nnue-trainer" });
}

/** Rejection reason of start() after terminate(). */
export class TrainerTerminatedError extends Error {
  constructor() {
    super("The training worker was terminated");
    this.name = "AbortError";
  }
}

interface PendingJob {
  worker: TrainerWorkerLike;
  handlers: TrainHandlers;
  resolve(c: TrainCheckpoint): void;
  reject(e: Error): void;
}

export class TrainerClient {
  private readonly createWorker: () => TrainerWorkerLike;
  private job: PendingJob | null = null;
  private pausedFlag = false;

  constructor(createWorker: () => TrainerWorkerLike = createTrainerWorker) {
    this.createWorker = createWorker;
  }

  /** True while a job runs (between start() and its settlement). */
  get running(): boolean {
    return this.job !== null;
  }

  /** True after pause() until resume() (or the end of the job). */
  get paused(): boolean {
    return this.pausedFlag;
  }

  /** Runs one job; resolves with the final checkpoint (finished, or the stop checkpoint). */
  start(job: TrainJob, handlers: TrainHandlers = {}): Promise<TrainCheckpoint> {
    if (this.job) return Promise.reject(new Error("A training job is already running on this TrainerClient"));
    let worker: TrainerWorkerLike;
    try {
      worker = this.createWorker();
    } catch (e) {
      return Promise.reject(new Error(`Could not start the training worker: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.pausedFlag = false;
    return new Promise<TrainCheckpoint>((resolve, reject) => {
      const pending: PendingJob = { worker, handlers, resolve, reject };
      this.job = pending;
      worker.onmessage = (ev: MessageEvent) => this.onEvent(pending, ev.data as TrainerEvent);
      worker.onerror = (ev: ErrorEvent) => {
        ev.preventDefault?.();
        this.fail(pending, ev.message ? `Training worker error: ${ev.message}` : "The training worker failed to load or crashed");
      };
      worker.onmessageerror = () => this.fail(pending, "The training worker sent a message that could not be decoded");
      try {
        worker.postMessage({ type: "start", job });
      } catch (e) {
        this.fail(pending, `Could not send the job to the training worker: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  private onEvent(p: PendingJob, ev: TrainerEvent): void {
    if (this.job !== p) return; // stale message from a terminated job
    const h = p.handlers;
    switch (ev.type) {
      case "progress":
        h.onProgress?.(ev.progress);
        break;
      case "checkpoint":
        h.onCheckpoint?.(ev.checkpoint);
        break;
      case "epoch":
        h.onEpoch?.(ev.summary);
        break;
      case "log":
        h.onLog?.(ev.message);
        break;
      case "done":
        this.release(p);
        try {
          h.onCheckpoint?.(ev.checkpoint);
        } finally {
          p.resolve(ev.checkpoint);
        }
        break;
      case "error":
        this.fail(p, ev.error);
        break;
    }
  }

  private release(p: PendingJob): void {
    if (this.job === p) {
      this.job = null;
      this.pausedFlag = false;
    }
    p.worker.onmessage = null;
    p.worker.onerror = null;
    p.worker.onmessageerror = null;
    p.worker.terminate();
  }

  private fail(p: PendingJob, message: string): void {
    if (this.job !== p) return;
    this.release(p);
    try {
      p.handlers.onError?.(message);
    } finally {
      p.reject(new Error(message));
    }
  }

  private send(msg: TrainerRequest): void {
    this.job?.worker.postMessage(msg);
  }

  /** Pauses after the current step. */
  pause(): void {
    if (!this.job) return;
    this.pausedFlag = true;
    this.send({ type: "pause" });
  }

  resume(): void {
    if (!this.job) return;
    this.pausedFlag = false;
    this.send({ type: "resume" });
  }

  /** Graceful stop: start() resolves with the latest weights (finished = false). */
  stop(): void {
    this.send({ type: "stop" });
  }

  /** Kills the worker immediately; start() rejects with TrainerTerminatedError. */
  terminate(): void {
    const p = this.job;
    if (!p) return;
    this.release(p);
    p.reject(new TrainerTerminatedError());
  }
}
