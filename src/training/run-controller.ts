// RunController: executes one training run in this tab (one instance per active run).
//
// Every cycle goes through these stages; which ones are still to do is derived from what is
// stored, so a run can be paused, stopped, crash or have its tab closed at any point and
// continue later (start() → a new controller):
//
//   a) self-play   config.data.selfPlay set, training of the cycle not started, and the cycle's
//                  dataset ("<run> - cycle N") has fewer games than the target.
//   b) training    the cycle has no network yet, or run.resume points into this cycle. Resumes
//                  from the "checkpoint:<runId>" record when it belongs to this cycle; the
//                  checkpoint also stores the cycle's plan (datasets, seed, threads), which stays
//                  fixed within a cycle so a resumed job continues bit-identically.
//   c) save        the epoch-end checkpoint with the lowest validation loss (or the final one
//                  without validation) becomes the network "<run> - cN".
//   d) gating      loop.gating set and an earlier accepted network exists: new vs. previous.
//   e) publish     config.publishEngine: one engine, kept pointing at the newest accepted network.
//   f) next cycle  while the loop has cycles left; otherwise "finished".
//
// Pause stops the workers / trainer (the trainer's final checkpoint is persisted) → "paused".
// Stop does the same → "stopped", and additionally saves the best network trained in the cycle
// so far as "<run> - cN (stopped …)". Errors → "error" with a log entry; the stored state stays
// resumable. The controller never leaves the record in a running status when it exits normally.
import type {
  FloatNetworkData,
  NetworkDataRecord,
  NetworkRecord,
  OptimizerStateData,
  TrainingLogEntry,
  TrainingPoint,
  TrainingRunConfig,
  TrainingRunRecord,
  TrainingRunStatus,
} from "@/types";
import type { TrainCheckpoint, TrainHandlers, TrainJob, TrainProgress } from "@/nnue/protocol";
import { dequantizeNetwork, parseNetworkFile, quantizeNetwork, validateFloatNetwork } from "@/nnue/format";
import { createNetwork, validateOptimizerState, widenNetwork } from "@/nnue/init";
import { clampThreads, maxThreadsForHidden } from "@/nnue/parallel";
import { formatCount, formatPercent } from "@/utils/format";
import { MAX_RUN_LOG, MAX_RUN_POINTS, bestDataId, checkpointDataId, datasetLockKey } from "./constants";
import { DatasetWriter } from "./dataset-writer";
import type { GenerationRegistry } from "./datasets";
import type { ServiceDeps, TrainerLike } from "./deps";
import { Throttled, clearLiveRun, emptySelfPlayProgress, setDatasetJob, setLiveRun } from "./live";
import { gatingOutcome } from "./selfplay-pool";
import { gameSettingsFor, resolveSelfPlayEngine, runSelfPlayJob, NETWORK_ENGINE_ID, type SelfPlayEngineSpec } from "./selfplay-job";
import { mixSeeds } from "./scores";
import type { GatingProgress, LiveRunState, NetworkService, SelfPlayProgress } from "./types";

type HistoryEntry = TrainingRunRecord["networkHistory"][number];
type LivePhase = LiveRunState["phase"];

/** Statuses in which a run is (supposed to be) executing somewhere. */
export const ACTIVE_STATUSES: ReadonlySet<TrainingRunStatus> = new Set<TrainingRunStatus>(["queued", "selfplay", "training", "evaluating"]);

/** Settings that stay fixed for the whole training phase of one cycle (stored with its checkpoint). */
export interface CyclePlan {
  cycle: number;
  datasetIds: string[];
  seed: number;
  threads: number;
  checkpointEverySteps: number;
}

/** "checkpoint:<runId>" in the networkData store: the latest training state of the current cycle. */
export interface RunCheckpointData extends NetworkDataRecord {
  kind: "run-checkpoint";
  runId: string;
  cursor: { cycle: number; epoch: number; step: number; positionsSeen: number };
  plan: CyclePlan;
}

/** "best:<runId>": the epoch-end checkpoint of the current cycle with the lowest validation loss. */
export interface RunBestData extends NetworkDataRecord {
  kind: "run-best";
  runId: string;
  meta: { cycle: number; epoch: number; step: number; valLoss: number; trainLoss: number | null; positionsSeen: number };
}

/** A network to save as the result of a cycle. */
interface CycleResult {
  float: FloatNetworkData;
  optimizer: OptimizerStateData | null;
  quantized: ArrayBuffer | null;
  epoch: number;
  step: number;
  positionsSeen: number;
  trainLoss: number | null;
  valLoss: number | null;
}

export interface RunControllerContext {
  deps: ServiceDeps;
  registry: GenerationRegistry;
  networks: NetworkService;
  /** Called once when the controller has finished (any outcome). */
  onExit(): void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Quantizes for storage; an empty buffer when the weights cannot be quantized (NaN). */
function safeQuantize(net: FloatNetworkData): ArrayBuffer {
  try {
    return quantizeNetwork(net);
  } catch {
    return new ArrayBuffer(0);
  }
}

/**
 * Keeps at most `max` points: the newer half untouched, every other point of the older half
 * dropped (repeated thinning leaves a density that decreases towards the past).
 */
export function thinPoints(points: TrainingPoint[], max: number = MAX_RUN_POINTS): TrainingPoint[] {
  if (points.length <= max) return points;
  const keepNew = Math.floor(max / 2);
  const older = points.slice(0, points.length - keepNew);
  const newer = points.slice(points.length - keepNew);
  return [...older.filter((_, i) => i % 2 === 0 || i === older.length - 1), ...newer];
}

export class RunController {
  readonly runId: string;
  /** Resolves when the controller has exited (after the final record write). */
  readonly finished: Promise<void>;

  private readonly deps: ServiceDeps;
  private readonly ctx: RunControllerContext;
  private readonly rec: TrainingRunRecord;
  private readonly config: TrainingRunConfig;
  private stopMode: "pause" | "stop" | null = null;
  private readonly abort = new AbortController();
  private trainer: TrainerLike | null = null;
  private trainerStarted = false;
  private resolveFinished!: () => void;

  // live state
  private live: LiveRunState;
  private readonly liveThrottle: Throttled;
  // record persistence
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private exited = false;
  /** saveIdleStopSnapshot(): the run is not executing, so no live state / activity is published. */
  private idle = false;
  // training points
  private lastPoint: { t: number; cycle: number; step: number; epoch: number; valLoss: number | null } | null = null;
  /** Latest trainer checkpoint not yet persisted (for an early write when the tab is hidden). */
  private unsavedCheckpoint: (() => Promise<void>) | null = null;

  constructor(ctx: RunControllerContext, record: TrainingRunRecord) {
    this.ctx = ctx;
    this.deps = ctx.deps;
    this.runId = record.id;
    this.rec = structuredClone(record);
    this.config = this.rec.config;
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.live = {
      runId: this.runId,
      status: "queued",
      cycle: this.rec.cycle,
      phase: "idle",
      selfPlay: null,
      train: null,
      gating: null,
      lastLog: this.rec.log.at(-1)?.message ?? null,
      startedAt: Date.now(),
    };
    this.liveThrottle = new Throttled(() => this.publishLive(), this.deps.timing.liveThrottleMs);
  }

  get name(): string {
    return this.config.name;
  }

  /** The run as this controller currently sees it (for in-use checks). */
  snapshot(): TrainingRunRecord {
    return this.rec;
  }

  /** Asks the run to pause or stop; resolves once it has exited. "stop" overrides "pause". */
  requestStop(mode: "pause" | "stop"): Promise<void> {
    if (this.stopMode !== "stop") this.stopMode = mode;
    this.abort.abort();
    if (this.trainer && this.trainerStarted) this.trainer.stop();
    return this.finished;
  }

  /**
   * Stops a run that is not executing anywhere (paused, error, queued) instead of run(): like a
   * stop during training, the best network trained in the current cycle so far (from the stored
   * checkpoints) is kept as "<run> - cN (stopped …)". The caller holds the run's lock and writes
   * the "stopped" status afterwards. Never publishes live state.
   */
  async saveIdleStopSnapshot(): Promise<void> {
    this.idle = true;
    try {
      const c = this.rec.cycle;
      if (this.rec.resume?.cycle !== c) return; // the cycle's training has not started
      const ckpt = await this.loadCheckpoint(c);
      if (!ckpt || (ckpt.cursor.epoch === 0 && ckpt.cursor.step === 0)) {
        this.log("info", "Stopped before training made progress in this cycle; no new network was saved.");
        await this.flushNow();
        return;
      }
      const best = await this.loadBest(c);
      const final: TrainCheckpoint = {
        network: ckpt.float as FloatNetworkData,
        optimizer: ckpt.optimizer as OptimizerStateData,
        epoch: ckpt.cursor.epoch,
        step: ckpt.cursor.step,
        positionsSeen: ckpt.cursor.positionsSeen,
        trainLoss: Number.NaN, // not stored with the checkpoint
        valLoss: null,
        finished: false,
      };
      await this.saveCycleNetwork(c, ckpt.plan, this.resultOf(final, best), await this.parentOf(c), { snapshot: true });
    } finally {
      this.exit();
    }
  }

  /** Writes pending state now (the tab is being hidden and may be closed). */
  async persistNow(): Promise<void> {
    const pending = this.unsavedCheckpoint;
    this.unsavedCheckpoint = null;
    if (pending) await pending().catch((e) => console.warn("[training] early checkpoint failed", e));
    await this.flushNow().catch(() => undefined);
  }

  // --- main loop ---------------------------------------------------------------------------------

  async run(): Promise<void> {
    try {
      const resumed = this.rec.networkHistory.length > 0 || this.rec.resume || this.rec.datasetIds.length > this.config.data.datasetIds.length;
      this.rec.error = null;
      this.setStatus("queued", "idle");
      this.log("info", resumed ? `Resumed${this.config.loop.enabled ? ` in cycle ${this.rec.cycle + 1}` : ""}.` : "Started.");
      await this.flushNow();
      for (;;) {
        if (this.stopMode) break;
        const c = this.rec.cycle;
        if (await this.needsSelfPlay(c)) {
          await this.selfPlayPhase(c);
          if (this.stopMode) break;
        }
        if (this.needsTraining(c)) {
          const complete = await this.trainingPhase(c);
          if (!complete || this.stopMode) break;
        }
        if (this.needsGating(c)) {
          await this.gatingPhase(c);
          if (this.stopMode) break;
        }
        if (this.config.publishEngine) await this.publish();
        if (this.hasNextCycle(c)) {
          this.rec.cycle = c + 1;
          this.rec.resume = null;
          this.live.cycle = c + 1;
          await this.flushNow();
          continue;
        }
        await this.finish();
        return;
      }
      await this.interrupted();
    } catch (err) {
      await this.fail(err);
    } finally {
      this.exit();
    }
  }

  private hasNextCycle(c: number): boolean {
    const loop = this.config.loop;
    return loop.enabled && (loop.cycles === null || c + 1 < loop.cycles);
  }

  // --- derived state -----------------------------------------------------------------------------

  /** Datasets generated by this run, in cycle order (run.datasetIds minus the configured ones). */
  private generatedIds(): string[] {
    const configured = new Set(this.config.data.datasetIds);
    return this.rec.datasetIds.filter((id) => !configured.has(id));
  }

  /** The last network saved for cycle `c` (a stop snapshot until the cycle completes). */
  private cycleNetwork(c: number): HistoryEntry | null {
    for (let i = this.rec.networkHistory.length - 1; i >= 0; i--) {
      const e = this.rec.networkHistory[i] as HistoryEntry;
      if (e.cycle === c) return e;
    }
    return null;
  }

  /** Source network of a continue / widen run. */
  private sourceNetworkId(): string | null {
    const n = this.config.network;
    return n.mode === "new" ? null : n.networkId;
  }

  /**
   * The newest accepted network before cycle `c`: the last network of the latest earlier cycle
   * that passed gating (or was not gated), else the source network (continue / widen), else null.
   */
  private previousAccepted(c: number): string | null {
    for (let k = c - 1; k >= 0; k--) {
      const e = this.cycleNetwork(k);
      if (e && (e.gating == null || e.gating.accepted)) return e.networkId;
    }
    return this.sourceNetworkId();
  }

  private trainingStarted(c: number): boolean {
    return this.rec.resume?.cycle === c || this.cycleNetwork(c) !== null;
  }

  private async needsSelfPlay(c: number): Promise<boolean> {
    const sp = this.config.data.selfPlay;
    if (!sp || this.trainingStarted(c)) return false;
    const id = this.generatedIds()[c];
    if (!id) return true;
    const ds = await this.deps.datasets.get(id);
    return !ds || ds.games < sp.games;
  }

  private needsTraining(c: number): boolean {
    return this.cycleNetwork(c) === null || this.rec.resume?.cycle === c;
  }

  private needsGating(c: number): boolean {
    const e = this.cycleNetwork(c);
    return !!this.config.loop.gating && e !== null && e.gating === undefined;
  }

  /** Datasets of cycle `c`'s training: the configured ones + the newest keepCycles generated ones. */
  private trainingDatasets(c: number): string[] {
    const loop = this.config.loop;
    const generated = this.generatedIds().slice(0, c + 1);
    const keep = loop.enabled && loop.keepCycles !== null && loop.keepCycles > 0 ? loop.keepCycles : null;
    const own = keep === null ? generated : generated.slice(Math.max(0, generated.length - keep));
    return [...new Set([...this.config.data.datasetIds, ...own])];
  }

  // --- self-play -----------------------------------------------------------------------------------

  private async selfPlayEngine(c: number): Promise<SelfPlayEngineSpec> {
    const sp = this.config.data.selfPlay;
    if (!sp) throw new Error("This run has no self-play settings.");
    const loop = this.config.loop;
    const useNetwork = sp.engineId === NETWORK_ENGINE_ID || (c > 0 && loop.enabled && loop.selfPlayWithLatest);
    if (useNetwork) {
      const networkId = this.previousAccepted(c);
      if (!networkId) throw new Error("There is no network to play the self-play games with yet. Choose an engine for self-play in the first cycle.");
      return resolveSelfPlayEngine(this.deps, NETWORK_ENGINE_ID, networkId);
    }
    return resolveSelfPlayEngine(this.deps, sp.engineId, null);
  }

  private async selfPlayPhase(c: number): Promise<void> {
    const deps = this.deps;
    const sp = this.config.data.selfPlay;
    if (!sp) return;
    this.setStatus("selfplay", "selfplay");
    this.live.selfPlay = emptySelfPlayProgress(sp.games);
    this.publishLive();
    const engine = await this.selfPlayEngine(c);
    if (this.stopMode) return;

    let id = this.generatedIds()[c];
    let ds = id ? await deps.datasets.get(id) : undefined;
    if (!ds) {
      const now = Date.now();
      id = id ?? deps.newId();
      ds = {
        id,
        name: `${this.name} - cycle ${c + 1}`,
        description: `Self-play games of cycle ${c + 1} of the training run "${this.name}", played by ${engine.name}.`,
        createdAt: now,
        updatedAt: now,
        positions: 0,
        games: 0,
        chunks: 0,
        source: {
          kind: "selfplay",
          engineId: engine.engineId,
          engineName: engine.name,
          networkId: engine.networkId,
          limits: { ...sp.limits },
          randomPlies: sp.randomPlies,
          trainingRunId: this.runId,
        },
      };
      await deps.datasets.put(ds);
      if (!this.rec.datasetIds.includes(id)) this.rec.datasetIds = [...this.rec.datasetIds, id];
      await this.flushNow();
    }
    const remaining = sp.games - ds.games;
    if (remaining <= 0) return;

    const datasetId = ds.id;
    const workers = Math.max(1, Math.min(sp.concurrency, await deps.maxWorkers()));
    const dsLock = await deps.locks.acquire(datasetLockKey(datasetId));
    if (!dsLock) throw new Error(`The dataset "${ds.name}" is being written by another tab, so this run cannot add its games now.`);
    let writer: DatasetWriter;
    try {
      writer = await DatasetWriter.open(deps.datasets, datasetId, deps.timing.datasetWriter);
    } catch (err) {
      dsLock.release();
      throw err;
    }
    this.log("info", `Cycle ${c + 1}: self-play with ${engine.name}, ${remaining} game${remaining === 1 ? "" : "s"} on ${workers} worker${workers === 1 ? "" : "s"}.`);
    this.ctx.registry.add(datasetId, { stop: () => this.requestStop("pause"), persist: () => writer.persistNow() });
    let progress: SelfPlayProgress = emptySelfPlayProgress(sp.games);
    try {
      const summary = await runSelfPlayJob({
        source: deps.selfPlay,
        writer,
        engine,
        config: sp,
        games: remaining,
        concurrency: workers,
        seed: mixSeeds(this.config.hyper.seed, c, 0x5e1f),
        firstGameIndex: ds.games,
        offset: { games: ds.games, positions: ds.positions, total: sp.games },
        signal: this.abort.signal,
        onProgress: (p) => {
          progress = p;
          this.live.selfPlay = p;
          this.rec.progress = { phase: "selfplay", done: p.gamesDone, total: sp.games };
          setDatasetJob({ datasetId, status: "running", progress: p, error: null });
          this.liveThrottle.schedule();
          this.markDirty();
        },
        onLog: (level, message) => this.log(level, message),
      });
      await writer.close();
      setDatasetJob({ datasetId, status: summary.stopped ? "stopped" : "finished", progress: { ...progress, workers: 0, boards: [] }, error: null });
    } catch (err) {
      await writer.close().catch(() => writer.dispose());
      setDatasetJob({ datasetId, status: "error", progress: { ...progress, workers: 0, boards: [] }, error: messageOf(err) });
      throw err;
    } finally {
      this.ctx.registry.delete(datasetId);
      dsLock.release();
    }
  }

  // --- training ------------------------------------------------------------------------------------

  /** Weights a cycle starts from (when there is no checkpoint of it), and the parent network. */
  private async cycleStart(c: number): Promise<{ float: FloatNetworkData; optimizer: OptimizerStateData | null; parent: NetworkRecord | null }> {
    const deps = this.deps;
    const n = this.config.network;
    if (c === 0 && n.mode === "new") return { float: createNetwork(n.hidden, n.activation, this.config.hyper.seed), optimizer: null, parent: null };
    const fromId = c === 0 ? (this.sourceNetworkId() as string) : this.cycleNetwork(c - 1)?.networkId;
    if (!fromId) throw new Error(`The network of cycle ${c} is missing from the run's history.`);
    const [parent, data] = await Promise.all([deps.networks.get(fromId), deps.networks.getData(fromId)]);
    if (!parent || !data || !data.quantized) {
      throw new Error(
        c === 0 ? "The network this run starts from no longer exists." : `The network of cycle ${c} ("${parent?.name ?? "deleted"}") no longer exists, so training cannot continue from it.`,
      );
    }
    let float = data.float;
    if (float) {
      try {
        validateFloatNetwork(float);
      } catch {
        float = null;
      }
    }
    float ??= dequantizeNetwork(parseNetworkFile(data.quantized));
    if (c === 0 && n.mode === "widen") return { float: widenNetwork(float, n.newHidden, this.config.hyper.seed), optimizer: null, parent };
    let optimizer = data.optimizer;
    if (optimizer) {
      try {
        validateOptimizerState(optimizer, float);
      } catch {
        optimizer = null;
      }
    }
    return { float, optimizer, parent };
  }

  private async makePlan(c: number, hidden: number): Promise<CyclePlan> {
    const requested = Math.max(1, Math.floor(this.config.hyper.threads || 1));
    const threads = Math.max(1, Math.min(requested, await this.deps.maxWorkers(), clampThreads(requested), maxThreadsForHidden(hidden)));
    return {
      cycle: c,
      datasetIds: this.trainingDatasets(c),
      seed: (Math.floor(this.config.hyper.seed) + c) | 0,
      threads,
      checkpointEverySteps: this.deps.timing.checkpointEverySteps,
    };
  }

  private async loadCheckpoint(c: number): Promise<RunCheckpointData | null> {
    const raw = (await this.deps.networks.getData(checkpointDataId(this.runId))) as Partial<RunCheckpointData> | undefined;
    if (!raw || raw.kind !== "run-checkpoint" || !raw.cursor || !raw.plan || !raw.float || !raw.optimizer) return null;
    if (raw.cursor.cycle !== c || raw.plan.cycle !== c) return null;
    try {
      validateFloatNetwork(raw.float);
      validateOptimizerState(raw.optimizer, raw.float);
    } catch {
      this.log("warn", "The saved training checkpoint is damaged; the cycle's training starts again.");
      return null;
    }
    return raw as RunCheckpointData;
  }

  private async loadBest(c: number): Promise<RunBestData | null> {
    const raw = (await this.deps.networks.getData(bestDataId(this.runId))) as Partial<RunBestData> | undefined;
    if (!raw || raw.kind !== "run-best" || !raw.meta || raw.meta.cycle !== c || !raw.float) return null;
    return raw as RunBestData;
  }

  private async deleteCheckpoints(): Promise<void> {
    await this.deps.networks.remove(checkpointDataId(this.runId));
    await this.deps.networks.remove(bestDataId(this.runId));
  }

  /** Runs (or resumes) the cycle's training. True when it completed and the network was saved. */
  private async trainingPhase(c: number): Promise<boolean> {
    const deps = this.deps;
    const hyper = this.config.hyper;
    this.setStatus("training", "training");
    this.live.selfPlay = null;
    this.publishLive();

    const ckpt = await this.loadCheckpoint(c);
    let network: FloatNetworkData;
    let optimizer: OptimizerStateData | null;
    let plan: CyclePlan;
    let resume: { epoch: number; step: number } | null = null;
    let parent: NetworkRecord | null;
    if (ckpt) {
      network = ckpt.float as FloatNetworkData;
      optimizer = ckpt.optimizer;
      plan = ckpt.plan;
      resume = { epoch: ckpt.cursor.epoch, step: ckpt.cursor.step };
      parent = await this.parentOf(c);
      this.log("info", `Continuing ${this.cycleLabel(c)}training from the checkpoint at epoch ${Math.min(resume.epoch + 1, hyper.epochs)}, step ${resume.step}.`);
    } else {
      const start = await this.cycleStart(c);
      network = start.float;
      optimizer = start.optimizer;
      parent = start.parent;
      plan = await this.makePlan(c, network.hidden);
    }
    let best = await this.loadBest(c);
    if (this.stopMode) return false;
    this.rec.resume = { cycle: c, epoch: resume?.epoch ?? 0, step: resume?.step ?? 0 };
    await this.flushNow();

    const job: TrainJob = {
      network,
      optimizer,
      datasetIds: plan.datasetIds,
      hyper: { ...hyper, threads: plan.threads, seed: plan.seed },
      resume,
      checkpointEverySteps: plan.checkpointEverySteps,
    };
    const startCursor = resume ?? { epoch: 0, step: 0 };
    let pendingEpoch: number | null = null;
    let lastPersist = Date.now();
    let writes: Promise<void> = Promise.resolve();
    let writeError: unknown = null;
    let lastWritten: TrainCheckpoint | null = null;
    const enqueue = (op: () => Promise<void>) => {
      writes = writes.then(op).catch((e) => {
        writeError ??= e;
      });
      return writes;
    };
    const writeCheckpoint = (cp: TrainCheckpoint) => {
      lastWritten = cp;
      return enqueue(async () => {
        const record: RunCheckpointData = {
          id: checkpointDataId(this.runId),
          kind: "run-checkpoint",
          runId: this.runId,
          quantized: safeQuantize(cp.network),
          float: cp.network,
          optimizer: cp.optimizer,
          cursor: { cycle: c, epoch: cp.epoch, step: cp.step, positionsSeen: cp.positionsSeen },
          plan,
        };
        await deps.networks.putData(record);
        this.rec.resume = { cycle: c, epoch: cp.epoch, step: cp.step };
        this.markDirty();
      });
    };

    const handlers: TrainHandlers = {
      onProgress: (p) => this.onTrainProgress(c, p),
      onLog: (m) => this.log("info", m),
      onEpoch: (e) => {
        // A stop during the epoch-end validation leaves a stale validation loss: ignore those.
        pendingEpoch = this.stopMode ? null : e.epoch;
      },
      onCheckpoint: (cp) => {
        const epochEnd = pendingEpoch !== null && cp.step === 0 && cp.epoch === pendingEpoch;
        if (epochEnd) pendingEpoch = null;
        if (epochEnd && cp.valLoss !== null && Number.isFinite(cp.valLoss) && (best === null || cp.valLoss < best.meta.valLoss)) {
          const candidate: RunBestData = {
            id: bestDataId(this.runId),
            kind: "run-best",
            runId: this.runId,
            quantized: safeQuantize(cp.network),
            float: cp.network,
            optimizer: cp.optimizer,
            meta: { cycle: c, epoch: cp.epoch, step: cp.step, valLoss: cp.valLoss, trainLoss: finiteOrNull(cp.trainLoss), positionsSeen: cp.positionsSeen },
          };
          best = candidate;
          // The final checkpoint is saved as the cycle's network right away; no need to store it twice.
          if (!cp.finished) void enqueue(() => deps.networks.putData(candidate));
        }
        if (cp.finished) return;
        if (epochEnd || Date.now() - lastPersist >= deps.timing.checkpointPersistMs) {
          lastPersist = Date.now();
          this.unsavedCheckpoint = null;
          void writeCheckpoint(cp);
        } else {
          this.unsavedCheckpoint = () => {
            lastPersist = Date.now();
            return writeCheckpoint(cp);
          };
        }
      },
    };

    const trainer = deps.createTrainer();
    this.trainer = trainer;
    let final: TrainCheckpoint;
    try {
      const promise = trainer.start(job, handlers);
      this.trainerStarted = true;
      if (this.stopMode) trainer.stop();
      final = await promise;
    } finally {
      this.trainer = null;
      this.trainerStarted = false;
      this.unsavedCheckpoint = null;
    }
    await writes;
    if (writeError) throw writeError;

    if (!final.finished) {
      // Paused or stopped: the trainer's final checkpoint is where the next start continues.
      if (lastWritten !== final) await writeCheckpoint(final);
      await writes;
      if (writeError) throw writeError;
      const progressed = final.epoch !== startCursor.epoch || final.step !== startCursor.step;
      if (this.stopMode === "stop" && progressed) await this.saveCycleNetwork(c, plan, this.resultOf(final, best), parent, { snapshot: true });
      else if (this.stopMode === "stop") this.log("info", "Stopped before training made progress in this cycle; no new network was saved.");
      return false;
    }

    // Lowest validation loss among the epoch ends (the last epoch end included), else the final weights.
    await this.saveCycleNetwork(c, plan, this.resultOf(final, best), parent, { snapshot: false });
    this.rec.resume = null;
    await this.flushNow();
    await this.deleteCheckpoints();
    return true;
  }

  private resultOf(final: TrainCheckpoint, best: RunBestData | null): CycleResult {
    if (best && best.float && (final.valLoss === null || !Number.isFinite(final.valLoss) || best.meta.valLoss <= final.valLoss || !final.finished)) {
      return {
        float: best.float,
        optimizer: best.optimizer,
        quantized: best.quantized && best.quantized.byteLength > 0 ? best.quantized : null,
        epoch: best.meta.epoch,
        step: best.meta.step,
        positionsSeen: best.meta.positionsSeen,
        trainLoss: best.meta.trainLoss,
        valLoss: best.meta.valLoss,
      };
    }
    return {
      float: final.network,
      optimizer: final.optimizer,
      quantized: null,
      epoch: final.epoch,
      step: final.step,
      positionsSeen: final.positionsSeen,
      trainLoss: finiteOrNull(final.trainLoss),
      valLoss: finiteOrNull(final.valLoss),
    };
  }

  /** Parent of cycle `c`'s network: the previous cycle's network, or the source network. */
  private async parentOf(c: number): Promise<NetworkRecord | null> {
    const id = c === 0 ? this.sourceNetworkId() : (this.cycleNetwork(c - 1)?.networkId ?? null);
    return id ? ((await this.deps.networks.get(id)) ?? null) : null;
  }

  private cycleLabel(c: number): string {
    return this.config.loop.enabled ? `cycle ${c + 1} ` : "";
  }

  /**
   * True when the newest network of cycle `c` already holds exactly this result (a run stopped
   * twice without better weights in between). Within an unfinished cycle that network can only
   * be an earlier stop snapshot; positionsSeen grows with every step, so equal counts mean the
   * same training state.
   */
  private async sameAsLastSnapshot(c: number, result: CycleResult, parent: NetworkRecord | null): Promise<boolean> {
    const last = this.cycleNetwork(c);
    if (!last) return false;
    const rec = await this.deps.networks.get(last.networkId);
    return (
      !!rec &&
      rec.stats.positionsSeen === (parent?.stats.positionsSeen ?? 0) + result.positionsSeen &&
      rec.stats.epochs === (parent?.stats.epochs ?? 0) + result.epoch
    );
  }

  private async saveCycleNetwork(c: number, plan: CyclePlan, result: CycleResult, parent: NetworkRecord | null, opts: { snapshot: boolean }): Promise<void> {
    const deps = this.deps;
    if (opts.snapshot && (await this.sameAsLastSnapshot(c, result, parent))) {
      this.log("info", "The best network of this cycle so far is already saved; no second copy was made.");
      await this.flushNow();
      return;
    }
    const epochs = this.config.hyper.epochs;
    const quantized = result.quantized ?? quantizeNetwork(result.float);
    const id = deps.newId();
    const now = Date.now();
    const epochText = result.step > 0 ? `${result.epoch} full epoch${result.epoch === 1 ? "" : "s"} + ${result.step} steps` : `${result.epoch} epoch${result.epoch === 1 ? "" : "s"}`;
    const name = opts.snapshot ? `${this.name} - c${c + 1} (stopped, epoch ${result.epoch}/${epochs})` : `${this.name} - c${c + 1}`;
    const record: NetworkRecord = {
      id,
      name,
      description:
        `Trained by the run "${this.name}"${this.config.loop.enabled ? `, cycle ${c + 1}` : ""}: ${epochText} (${formatCount(result.positionsSeen)} positions seen)` +
        `${result.valLoss !== null ? `, validation loss ${result.valLoss.toFixed(5)}` : ""}.${opts.snapshot ? " Saved when the run was stopped." : ""}`,
      createdAt: now,
      updatedAt: now,
      hidden: result.float.hidden,
      activation: result.float.activation,
      parentId: parent?.id ?? null,
      stats: {
        positionsSeen: (parent?.stats.positionsSeen ?? 0) + result.positionsSeen,
        epochs: (parent?.stats.epochs ?? 0) + result.epoch,
        trainLoss: result.trainLoss,
        valLoss: result.valLoss,
        trainingRunId: this.runId,
        datasetIds: [...plan.datasetIds],
      },
      sizeBytes: quantized.byteLength,
    };
    await deps.networks.putData({ id, quantized, float: result.float, optimizer: result.optimizer });
    await deps.networks.put(record);
    const willGate = !opts.snapshot && !!this.config.loop.gating && this.previousAccepted(c) !== null;
    const entry: HistoryEntry = { networkId: id, cycle: c, createdAt: now, valLoss: result.valLoss };
    if (!willGate) entry.gating = null;
    this.rec.networkHistory = [...this.rec.networkHistory, entry];
    this.rec.networkId = id;
    this.log(
      "info",
      `Saved the network "${name}"${result.valLoss !== null ? ` (validation loss ${result.valLoss.toFixed(5)}, epoch ${result.epoch})` : ""}.`,
    );
    await this.flushNow();
  }

  private onTrainProgress(c: number, p: TrainProgress): void {
    this.live.train = p;
    const total = p.epochs * p.stepsPerEpoch;
    const done = Math.min(total, p.epoch * p.stepsPerEpoch + p.step);
    this.rec.progress = { phase: "training", done, total };
    const t = Date.now();
    const last = this.lastPoint;
    const valChanged = last !== null && last.valLoss !== p.valLoss;
    const fresh = last === null || last.cycle !== c;
    if (Number.isFinite(p.trainLoss) && (fresh || ((done !== last.step || valChanged) && (t - last.t >= this.deps.timing.pointIntervalMs || valChanged || p.epoch !== last.epoch)))) {
      const point: TrainingPoint = {
        t,
        cycle: c,
        epoch: p.epoch,
        step: done,
        positions: p.positionsSeen,
        trainLoss: p.trainLoss,
        valLoss: finiteOrNull(p.valLoss),
        lr: p.lr,
        posPerSec: p.posPerSec,
      };
      this.rec.points = thinPoints([...this.rec.points, point]);
      this.lastPoint = { t, cycle: c, step: done, epoch: p.epoch, valLoss: p.valLoss };
    }
    this.liveThrottle.schedule();
    this.markDirty();
  }

  // --- gating --------------------------------------------------------------------------------------

  private async gatingPhase(c: number): Promise<void> {
    const deps = this.deps;
    const gating = this.config.loop.gating;
    const entry = this.cycleNetwork(c);
    const prevId = this.previousAccepted(c);
    if (!gating || !entry) return;
    const setGating = async (g: HistoryEntry["gating"]) => {
      this.rec.networkHistory = this.rec.networkHistory.map((e) => (e === entry ? { ...e, gating: g } : e));
      await this.flushNow();
    };
    if (!prevId) {
      await setGating(null);
      return;
    }
    const [newRec, newData, oldRec, oldData] = await Promise.all([
      deps.networks.get(entry.networkId),
      deps.networks.getData(entry.networkId),
      deps.networks.get(prevId),
      deps.networks.getData(prevId),
    ]);
    if (!newRec || !newData?.quantized?.byteLength) throw new Error(`The network of cycle ${c + 1} was deleted, so it cannot be evaluated.`);
    if (!oldRec || !oldData?.quantized?.byteLength) {
      this.log("warn", "The previous network was deleted; the new network is accepted without a gating match.");
      await setGating(null);
      return;
    }
    this.setStatus("evaluating", "evaluating");
    const total = gating.games;
    const tally: GatingProgress = { played: 0, total, wins: 0, draws: 0, losses: 0, score: 0.5, boards: [] };
    this.live.gating = { ...tally };
    this.publishLive();
    const wasm = await deps.stockNnueWasm();
    if (this.stopMode) return;
    const workers = Math.max(1, Math.min(total, await deps.maxWorkers()));
    const sp = this.config.data.selfPlay;
    this.log("info", `Gating: "${newRec.name}" plays ${total} games against "${oldRec.name}" on ${workers} worker${workers === 1 ? "" : "s"}.`);
    const update = () => {
      tally.score = tally.played > 0 ? (tally.wins + tally.draws / 2) / tally.played : 0.5;
      this.live.gating = { ...tally, boards: [...tally.boards] };
      this.rec.progress = { phase: "evaluating", done: tally.played, total };
      this.liveThrottle.schedule();
      this.markDirty();
    };
    const summary = await deps.selfPlay.gating(
      {
        wasm,
        newNetwork: newData.quantized,
        oldNetwork: oldData.quantized,
        hashMb: Math.min(await deps.defaultHashMb(), 64),
        names: { new: newRec.name, old: oldRec.name },
        settings: gameSettingsFor({ limits: gating.limits, randomPlies: sp?.randomPlies ?? 8, maxPlies: sp?.maxPlies ?? 400, skipPlies: 0 }),
        games: total,
        concurrency: workers,
        seed: mixSeeds(this.config.hyper.seed, c, 0x9a7e),
      },
      {
        onGame: (g) => {
          const o = gatingOutcome(g);
          tally.played++;
          if (o === "win") tally.wins++;
          else if (o === "draw") tally.draws++;
          else tally.losses++;
          update();
        },
        onBoards: (b) => {
          tally.boards = b;
          update();
        },
        onLog: (level, message) => this.log(level, message),
      },
      this.abort.signal,
    );
    if (summary.stopped || this.stopMode) return;
    const played = summary.played;
    const score = played > 0 ? (summary.wins + summary.draws / 2) / played : 0;
    const accepted = played > 0 && score >= gating.minScore;
    this.log(
      accepted ? "info" : "warn",
      `Gating: the new network scored ${formatPercent(score)} (+${summary.wins} =${summary.draws} −${summary.losses}) against "${oldRec.name}" — ` +
        (accepted ? "accepted." : `rejected (needs ${formatPercent(gating.minScore)}); the next cycle plays with "${oldRec.name}".`),
    );
    await setGating({ score, games: played, accepted });
  }

  // --- publish ---------------------------------------------------------------------------------------

  private async publish(): Promise<void> {
    const deps = this.deps;
    const target = this.previousAccepted(this.rec.cycle + 1);
    if (!target) return;
    if (!this.rec.engineId) {
      const net = await deps.networks.get(target);
      const engineId = await this.ctx.networks.createEngine(target, { name: this.name });
      this.rec.engineId = engineId;
      this.log("info", `Published the engine "${this.name}" with the network "${net?.name ?? "?"}". Find it in the engine library.`);
      await this.flushNow();
      return;
    }
    const engine = await deps.engines.get(this.rec.engineId);
    if (!engine) {
      this.log("warn", "The engine published by this run was deleted; it is not re-created.");
      return;
    }
    if (engine.networkId !== target) {
      await deps.engines.update(engine.id, { networkId: target });
      const net = await deps.networks.get(target);
      this.log("info", `The engine "${engine.name}" now uses the network "${net?.name ?? "?"}".`);
      await this.flushNow();
    }
  }

  // --- endings ---------------------------------------------------------------------------------------

  private async finish(): Promise<void> {
    this.setStatus("finished", "idle");
    this.rec.progress = { phase: "finished", done: 1, total: 1 };
    this.log("info", "Run finished.");
    await this.flushNow();
    await this.deleteCheckpoints().catch((e) => console.warn("[training] could not delete checkpoints", e));
    const net = this.rec.networkId ? await this.deps.networks.get(this.rec.networkId).catch(() => undefined) : undefined;
    this.deps.notify.toast(`Training run "${this.name}" finished`, {
      kind: "success",
      detail: net ? `Newest network: "${net.name}"${net.stats.valLoss !== null ? ` (validation loss ${net.stats.valLoss.toFixed(5)})` : ""}.` : undefined,
    });
  }

  private async interrupted(): Promise<void> {
    const status: TrainingRunStatus = this.stopMode === "stop" ? "stopped" : "paused";
    this.setStatus(status, "idle");
    this.rec.progress = { ...this.rec.progress, phase: status };
    this.log("info", status === "stopped" ? "Stopped." : "Paused.");
    await this.flushNow();
  }

  private async fail(err: unknown): Promise<void> {
    const message = messageOf(err);
    console.error(`[training] run "${this.name}" failed`, err);
    this.setStatus("error", "idle");
    this.rec.error = message;
    this.rec.progress = { ...this.rec.progress, phase: "error" };
    this.log("error", message);
    try {
      await this.flushNow();
    } catch (e) {
      console.error("[training] could not save the failed run", e);
    }
    this.deps.notify.toast(`Training run "${this.name}" stopped with an error`, { kind: "error", detail: message });
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.liveThrottle.cancel();
    clearLiveRun(this.runId);
    this.deps.notify.clearActivity(`training:${this.runId}`);
    this.trainer?.terminate();
    this.ctx.onExit();
    this.resolveFinished();
  }

  // --- record, log, live state ---------------------------------------------------------------------

  private setStatus(status: TrainingRunStatus, phase: LivePhase): void {
    this.rec.status = status;
    this.live.status = status;
    this.live.phase = phase;
    if (phase !== "evaluating") this.live.gating = null;
    if (phase !== "selfplay") this.live.selfPlay = null;
    // The last training progress stays visible while the network is saved / published.
    if (phase === "selfplay" || phase === "evaluating") this.live.train = null;
    // Status changes are rare: store them at once so other tabs and the run list see them.
    if (!this.exited) this.flushNow().catch((e) => console.warn("[training] could not save the run's status", e));
    this.publishLive();
  }

  private log(level: TrainingLogEntry["level"], message: string): void {
    const entry: TrainingLogEntry = { t: Date.now(), level, message };
    const log = [...this.rec.log, entry];
    this.rec.log = log.length > MAX_RUN_LOG ? log.slice(log.length - MAX_RUN_LOG) : log;
    this.live.lastLog = message;
    this.liveThrottle.schedule();
    this.markDirty();
  }

  /** The fields this controller owns (config, autoResume and createdAt are never written). */
  private patch(): Partial<TrainingRunRecord> {
    const r = this.rec;
    return {
      status: r.status,
      cycle: r.cycle,
      progress: r.progress,
      networkId: r.networkId,
      engineId: r.engineId,
      networkHistory: r.networkHistory,
      datasetIds: r.datasetIds,
      points: r.points,
      log: r.log,
      error: r.error ?? null,
      resume: r.resume ?? null,
    };
  }

  private markDirty(): void {
    if (this.flushTimer || this.exited) return;
    const wait = Math.max(0, this.lastFlush + this.deps.timing.runFlushMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow().catch((e) => console.warn("[training] could not save the run's progress", e));
    }, wait);
  }

  /** Writes the owned fields now (serialized with other writes). */
  private flushNow(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const patch = this.patch();
    this.lastFlush = Date.now();
    const write = this.writeChain.then(() => this.deps.runs.update(this.runId, patch).then(() => undefined));
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private publishLive(): void {
    if (this.exited || this.idle) return;
    const state: LiveRunState = { ...this.live, cycle: this.rec.cycle };
    setLiveRun(state);
    this.deps.notify.setActivity({
      id: `training:${this.runId}`,
      kind: "training",
      label: this.name,
      detail: this.activityDetail(state),
      progress: this.activityProgress(state),
      href: `/lab/runs/${this.runId}`,
    });
  }

  private activityDetail(s: LiveRunState): string {
    const prefix = this.config.loop.enabled ? `Cycle ${s.cycle + 1} – ` : "";
    if (s.phase === "selfplay" && s.selfPlay?.workers === 0 && s.selfPlay.boards.length === 0) return `${prefix}self-play: preparing the engine`;
    if (s.phase === "selfplay" && s.selfPlay) return `${prefix}self-play ${s.selfPlay.gamesDone}/${s.selfPlay.gamesTotal ?? "∞"} games`;
    if (s.phase === "training" && s.train) return `${prefix}training epoch ${Math.min(s.train.epoch + 1, s.train.epochs)}/${s.train.epochs}`;
    if (s.phase === "training") return `${prefix}loading training data`;
    if (s.phase === "evaluating" && s.gating) return `${prefix}gating ${s.gating.played}/${s.gating.total} games`;
    return `${prefix}${s.status === "queued" ? "starting" : s.status}`;
  }

  private activityProgress(s: LiveRunState): number | null {
    if (s.phase === "selfplay" && s.selfPlay?.gamesTotal) return Math.min(1, s.selfPlay.gamesDone / s.selfPlay.gamesTotal);
    if (s.phase === "training" && s.train && s.train.stepsPerEpoch > 0) {
      return Math.min(1, (s.train.epoch * s.train.stepsPerEpoch + s.train.step) / (s.train.epochs * s.train.stepsPerEpoch));
    }
    if (s.phase === "evaluating" && s.gating && s.gating.total > 0) return Math.min(1, s.gating.played / s.gating.total);
    return null;
  }
}
