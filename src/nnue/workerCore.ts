// Message handling of the trainer worker, independent of the worker global so it can run
// in-process (Node tests drive it through a fake Worker). trainer.worker.ts wires it to `self`.
import { LoadAbortedError, loadTrainingSet, type ChunkSource } from "./dataset";
import { validateFloatNetwork } from "./format";
import { cloneNetwork, cloneOptimizerState, createOptimizerState, validateOptimizerState } from "./init";
import { checkpointTransferables, type TrainCheckpoint, type TrainJob, type TrainerEvent, type TrainerRequest } from "./protocol";
import { ParallelTrainer, clampThreads, maxThreadsForHidden, threadSupport, type HelperInit, type HelperPool } from "./parallel";
import { TrainingSession, type TrainingSessionOptions } from "./session";
import { sharedAllocator, validateHyperParams, type BatchTrainer } from "./trainer";

/** Positions per loss-evaluation call in TrainingSession (sizes the shared index buffer). */
const EVAL_CHUNK = 4096;

export interface TrainerWorkerPort {
  post(event: TrainerEvent, transfer?: Transferable[]): void;
}

export interface TrainerWorkerDeps {
  /** Dataset source (default: IndexedDB through @/storage/repos). */
  source?: ChunkSource;
  /** Overrides for tests (time slicing, clock, yielding). */
  sessionOptions?: Partial<Pick<TrainingSessionOptions, "sliceMs" | "progressIntervalMs" | "now" | "yieldFn" | "maxValidationPositions">>;
  /** Starts helper threads for hyper.threads > 1 (default: nested workers, see helperPool.ts). */
  startPool?(inits: HelperInit[]): Promise<HelperPool> | HelperPool;
  /** Capability check for helper threads (default: threadSupport()). */
  threadSupport?(): { ok: true } | { ok: false; reason: string };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Checkpoint for a job that ended before training started (stopped while loading). */
function untouchedCheckpoint(job: TrainJob): TrainCheckpoint {
  return {
    network: cloneNetwork(job.network),
    optimizer: job.optimizer ? cloneOptimizerState(job.optimizer) : createOptimizerState(job.network),
    epoch: job.resume?.epoch ?? 0,
    step: job.resume?.step ?? 0,
    positionsSeen: 0,
    trainLoss: NaN,
    valLoss: null,
    finished: false,
  };
}

/** Returns the handler for TrainerRequest messages. One job per handler (one job per worker). */
export function createTrainerWorkerHandler(port: TrainerWorkerPort, deps: TrainerWorkerDeps = {}): (msg: TrainerRequest) => void {
  let started = false;
  let stopRequested = false;
  let pauseRequested = false;
  let session: TrainingSession | null = null;

  const log = (message: string) => port.post({ type: "log", message });
  const finish = (c: TrainCheckpoint) => port.post({ type: "done", checkpoint: c }, checkpointTransferables(c));

  async function run(job: TrainJob): Promise<void> {
    // Helper threads, when used; always released in the finally block below.
    let trainer: BatchTrainer | undefined;
    try {
      validateFloatNetwork(job.network, "job network");
      if (job.optimizer) validateOptimizerState(job.optimizer, job.network);
      validateHyperParams(job.hyper);
      const datasetIds = job.datasetIds ?? [];
      const memChunks = job.data ?? [];
      if (datasetIds.length === 0 && memChunks.length === 0) throw new Error("Nothing to train on: no datasets were selected");

      // Threads: hyper.threads, clamped to the device, and only where shared memory works.
      const requested = Math.max(1, Math.floor(job.hyper.threads || 1));
      let threads = clampThreads(requested);
      if (threads > 1) {
        const support = (deps.threadSupport ?? threadSupport)();
        if (!support.ok) {
          log(`Training on 1 thread instead of ${requested}: ${support.reason}.`);
          threads = 1;
        }
      }
      if (threads > 1 && threads < requested) log(`Using ${threads} threads (the most this device offers) instead of ${requested}.`);
      const memCap = maxThreadsForHidden(job.network.hidden);
      if (threads > memCap) {
        log(`Using ${memCap} threads: more would need too much memory for gradient buffers at hidden size ${job.network.hidden}.`);
        threads = memCap;
      }

      let lastLoadLog = 0;
      const set = await loadTrainingSet({
        datasetIds,
        data: memChunks,
        validationSplit: job.hyper.validationSplit,
        seed: job.hyper.seed,
        maxPositions: job.maxPositions,
        alloc: threads > 1 ? sharedAllocator : undefined,
        source: deps.source,
        shouldAbort: () => stopRequested,
        onProgress: (p) => {
          const t = Date.now();
          if (t - lastLoadLog >= 1000) {
            lastLoadLog = t;
            log(`Loading training data: ${p.chunksRead}/${p.chunksTotal} chunks, ${p.positions.toLocaleString("en-US")} positions`);
          }
        },
      });
      for (const w of set.warnings) log(`Warning: ${w}`);
      log(
        `Loaded ${set.positions.toLocaleString("en-US")} positions ` +
          `(${datasetIds.length} dataset${datasetIds.length === 1 ? "" : "s"}${memChunks.length > 0 ? ` + ${memChunks.length} in-memory buffer(s)` : ""}).`,
      );
      if (stopRequested) {
        finish(untouchedCheckpoint(job));
        return;
      }
      if (threads > 1 && set.train.length > 0) {
        try {
          const startPool = deps.startPool ?? (await import("./helperPool")).startWorkerHelpers;
          trainer = await ParallelTrainer.create({
            network: job.network,
            optimizer: job.optimizer,
            config: { evalWeight: job.hyper.evalWeight, weightDecay: job.hyper.weightDecay },
            data: set.data,
            threads,
            capacity: Math.max(Math.min(job.hyper.batchSize, set.train.length), EVAL_CHUNK),
            startPool,
          });
          log(`Training on ${threads} threads.`);
        } catch (e) {
          log(`Warning: could not start helper threads (${errorMessage(e)}); training on 1 thread.`);
          trainer = undefined;
        }
      }
      if (stopRequested) {
        finish(untouchedCheckpoint(job));
        return;
      }
      session = new TrainingSession({
        network: job.network,
        optimizer: job.optimizer,
        set,
        hyper: job.hyper,
        trainer,
        resume: job.resume ?? null,
        checkpointEverySteps: job.checkpointEverySteps,
        emitFinalCheckpoint: false, // delivered once, as "done"
        callbacks: {
          onProgress: (progress) => port.post({ type: "progress", progress }),
          onCheckpoint: (checkpoint) => port.post({ type: "checkpoint", checkpoint }, checkpointTransferables(checkpoint)),
          onEpoch: (summary) => port.post({ type: "epoch", summary }),
          onLog: log,
        },
        ...deps.sessionOptions,
      });
      if (pauseRequested) session.pause();
      if (stopRequested) session.stop();
      finish(await session.run());
    } catch (e) {
      if (e instanceof LoadAbortedError) {
        finish(untouchedCheckpoint(job));
        return;
      }
      port.post({ type: "error", error: errorMessage(e) });
    } finally {
      trainer?.dispose?.();
      session = null;
    }
  }

  return (msg: TrainerRequest) => {
    switch (msg.type) {
      case "start":
        if (started) {
          port.post({ type: "error", error: "This trainer worker already ran a job" });
          return;
        }
        started = true;
        void run(msg.job);
        return;
      case "pause":
        pauseRequested = true;
        session?.pause();
        return;
      case "resume":
        pauseRequested = false;
        session?.resume();
        return;
      case "stop":
        stopRequested = true;
        session?.stop();
        return;
    }
  };
}
