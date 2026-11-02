// Test doubles for the Lab service tests (never imported by app code). Import "fake-indexeddb/auto"
// in the test file first; the real repositories then run against the in-memory database.
import type { EngineRecord, FloatNetworkData, OptimizerStateData, TrainingRunConfig } from "@/types";
import { datasetsRepo, enginesRepo, networksRepo, runsRepo } from "@/storage/repos";
import { newId } from "@/storage/id";
import { cloneNetwork, createOptimizerState } from "@/nnue/init";
import { PACKED_SIZE, setPackedResult } from "@/nnue/pack";
import type { TrainCheckpoint, TrainHandlers, TrainJob, TrainerRequest } from "@/nnue/protocol";
import { makeMaterialDataset } from "@/nnue/synthetic";
import { TrainerClient, type TrainerWorkerLike } from "@/nnue/trainerClient";
import { createTrainerWorkerHandler } from "@/nnue/workerCore";
import type { LockHandle, Notifier, RunLocks, ServiceDeps, TrainerLike } from "./deps";
import type { GatingPoolJob, PoolHandlers, SelfPlayPoolJob, SelfPlaySource } from "./selfplay-pool";
import type { GatingGameRecord, SelfPlayGameRecord } from "./selfplay-protocol";

// --- notifier ------------------------------------------------------------------------------------

export interface RecordingNotifier extends Notifier {
  toasts: Array<{ message: string; kind?: string; detail?: string }>;
  activities: Map<string, { label: string; detail?: string; progress?: number | null; href?: string }>;
  activityIds: Set<string>;
}

export function recordingNotifier(): RecordingNotifier {
  const n: RecordingNotifier = {
    toasts: [],
    activities: new Map(),
    activityIds: new Set(),
    toast(message, opts) {
      n.toasts.push({ message, kind: opts?.kind, detail: opts?.detail });
    },
    setActivity(a) {
      n.activities.set(a.id, a);
      n.activityIds.add(a.id);
    },
    clearActivity(id) {
      n.activities.delete(id);
    },
  };
  return n;
}

// --- locks ---------------------------------------------------------------------------------------

/** In-memory locks shared by several "tabs" (service instances) of one test. */
export class FakeLocks implements RunLocks {
  readonly held = new Set<string>();

  async acquire(runId: string): Promise<LockHandle | null> {
    if (this.held.has(runId)) return null;
    this.held.add(runId);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(runId);
      },
    };
  }

  async isHeld(runId: string): Promise<boolean | null> {
    return this.held.has(runId);
  }
}

// --- self-play -------------------------------------------------------------------------------------

export interface FakeSelfPlayOptions {
  /** Positions recorded per game (default 40). */
  positionsPerGame?: number;
  /** Delay per game (ms, default 1). */
  gameDelayMs?: number;
  /** Gating result (White POV) of game `index` with the new network playing White when `newIsWhite`. */
  gatingResult?(index: number, newIsWhite: boolean, job: GatingPoolJob): 0 | 1 | 2;
  /** Throw this error after this many self-play games (once). */
  failAfterGames?: { games: number; message: string } | null;
}

/** Synthetic games: material-labelled random positions (learnable), one game at a time per "worker". */
export class FakeSelfPlaySource implements SelfPlaySource {
  readonly selfPlayJobs: SelfPlayPoolJob[] = [];
  readonly gatingJobs: GatingPoolJob[] = [];
  private gamesPlayed = 0;

  constructor(private readonly opts: FakeSelfPlayOptions = {}) {}

  async selfPlay(job: SelfPlayPoolJob, handlers: PoolHandlers<SelfPlayGameRecord>, signal: AbortSignal) {
    this.selfPlayJobs.push(job);
    handlers.onReady?.(job.concurrency);
    let games = 0;
    let positions = 0;
    const n = this.opts.positionsPerGame ?? 40;
    for (let i = 0; job.games === null || i < job.games; i++) {
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, this.opts.gameDelayMs ?? 1));
      if (signal.aborted) break;
      const fail = this.opts.failAfterGames;
      if (fail && this.gamesPlayed >= fail.games) {
        this.opts.failAfterGames = null;
        throw new Error(fail.message);
      }
      const index = job.firstGameIndex + i;
      const data = makeMaterialDataset(n, (job.seed ^ (index * 7919)) >>> 0);
      const result = (index % 3) as 0 | 1 | 2;
      for (let k = 0; k < n; k++) setPackedResult(data, k * PACKED_SIZE, result);
      const rec: SelfPlayGameRecord = {
        gameIndex: index,
        result,
        termination: "checkmate",
        plies: 80,
        searched: 72,
        nodes: 72 * 1000,
        positions: n,
        data: data.buffer,
        skipped: { check: 1, capture: 2, promotion: 0, score: 0, noScore: 0, early: 4 },
      };
      handlers.onBoards?.([{ slot: 0, fen: "startpos", lastMove: null, ply: 0, white: job.engineName, black: job.engineName }]);
      await handlers.onGame(rec);
      games++;
      positions += n;
      this.gamesPlayed++;
    }
    return { games, positions, stopped: signal.aborted };
  }

  async gating(job: GatingPoolJob, handlers: PoolHandlers<GatingGameRecord>, signal: AbortSignal) {
    this.gatingJobs.push(job);
    const tally = { wins: 0, draws: 0, losses: 0 };
    for (let i = 0; i < job.games; i++) {
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, this.opts.gameDelayMs ?? 1));
      if (signal.aborted) break;
      const newIsWhite = i % 2 === 0;
      const result = this.opts.gatingResult ? this.opts.gatingResult(i, newIsWhite, job) : 1;
      const rec: GatingGameRecord = { gameIndex: i, newIsWhite, result, termination: "adjudication", plies: 60 };
      if (result === 1) tally.draws++;
      else if ((result === 2) === newIsWhite) tally.wins++;
      else tally.losses++;
      await handlers.onGame(rec);
    }
    return { played: tally.wins + tally.draws + tally.losses, ...tally, stopped: signal.aborted };
  }
}

// --- trainers ------------------------------------------------------------------------------------

/** In-process stand-in for the trainer worker (real training core, structured-cloned messages). */
class InProcessTrainerWorker implements TrainerWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  private terminated = false;
  private readonly handle: (msg: TrainerRequest) => void;

  constructor() {
    this.handle = createTrainerWorkerHandler(
      {
        post: (event, transfer) => {
          if (this.terminated) return;
          const copy = structuredClone(event, { transfer });
          setTimeout(() => {
            if (!this.terminated) this.onmessage?.({ data: copy } as MessageEvent);
          }, 0);
        },
      },
      { sessionOptions: { sliceMs: 2, progressIntervalMs: 5 } },
    );
  }

  postMessage(message: TrainerRequest): void {
    const copy = structuredClone(message);
    setTimeout(() => {
      if (!this.terminated) this.handle(copy);
    }, 0);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.handle({ type: "stop" });
  }
}

/** A real TrainerClient whose "worker" runs in this process (reads datasets from fake-indexeddb). */
export function inProcessTrainer(): TrainerLike {
  return new TrainerClient(() => new InProcessTrainerWorker());
}

export interface ScriptedTrainerOptions {
  /** Validation loss after epoch e (1-based); null = no validation. */
  valLoss?(epoch: number, job: TrainJob): number | null;
  stepsPerEpoch?: number;
  /** Delay per step (ms). */
  stepMs?: number;
  /** Throw after this many steps (once). */
  failAtStep?: { step: number; message: string } | null;
}

/**
 * Deterministic fake trainer: weights change by +1e-3 per step in b1[0], every step is
 * reported, checkpoints follow checkpointEverySteps / epoch ends like the real session.
 */
export class ScriptedTrainer implements TrainerLike {
  static jobs: TrainJob[] = [];
  private stopRequested = false;

  constructor(private readonly opts: ScriptedTrainerOptions = {}) {}

  stop(): void {
    this.stopRequested = true;
  }

  terminate(): void {
    this.stopRequested = true;
  }

  async start(job: TrainJob, h: TrainHandlers = {}): Promise<TrainCheckpoint> {
    ScriptedTrainer.jobs.push(job);
    const spe = this.opts.stepsPerEpoch ?? 5;
    const epochs = job.hyper.epochs;
    const net: FloatNetworkData = cloneNetwork(job.network);
    const opt: OptimizerStateData = job.optimizer ? structuredClone(job.optimizer) : createOptimizerState(job.network);
    let epoch = job.resume?.epoch ?? 0;
    let step = job.resume?.step ?? 0;
    let valLoss: number | null = epoch > 0 ? (this.opts.valLoss?.(epoch, job) ?? null) : 0.5;
    const cp = (finished: boolean): TrainCheckpoint => ({
      network: cloneNetwork(net),
      optimizer: structuredClone(opt),
      epoch,
      step,
      positionsSeen: (epoch * spe + step) * 100,
      trainLoss: 0.1,
      valLoss,
      finished,
    });
    const progress = () =>
      h.onProgress?.({ epoch, epochs, step, stepsPerEpoch: spe, positionsSeen: (epoch * spe + step) * 100, trainLoss: 0.1, valLoss, lr: 0.001, posPerSec: 1000 });
    progress();
    while (epoch < epochs && !this.stopRequested) {
      while (step < spe && !this.stopRequested) {
        await new Promise((r) => setTimeout(r, this.opts.stepMs ?? 0));
        if (this.stopRequested) break;
        const f = this.opts.failAtStep;
        if (f && epoch * spe + step >= f.step) {
          this.opts.failAtStep = null;
          const err = `Training diverged: ${f.message}`;
          h.onError?.(err);
          throw new Error(err);
        }
        net.b1[0] = (net.b1[0] as number) + 1e-3;
        opt.step++;
        step++;
        progress();
        const every = job.checkpointEverySteps ?? 0;
        if (every > 0 && (epoch * spe + step) % every === 0 && step < spe) h.onCheckpoint?.(cp(false));
      }
      if (step < spe) break;
      epoch++;
      step = 0;
      valLoss = this.opts.valLoss ? this.opts.valLoss(epoch, job) : null;
      h.onEpoch?.({ epoch, trainLoss: 0.1, valLoss });
      h.onLog?.(`Epoch ${epoch}/${epochs}`);
      if (epoch < epochs) h.onCheckpoint?.(cp(false));
      progress();
    }
    const final = cp(epoch >= epochs);
    h.onCheckpoint?.(final);
    return final;
  }
}

// --- deps ----------------------------------------------------------------------------------------

export function testDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps & { notify: RecordingNotifier; locks: RunLocks } {
  const notify = recordingNotifier();
  return {
    runs: runsRepo,
    networks: networksRepo,
    datasets: datasetsRepo,
    engines: enginesRepo,
    selfPlay: new FakeSelfPlaySource(),
    createTrainer: () => new ScriptedTrainer(),
    stockNnueWasm: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
    engineArtifacts: async (engineId) => {
      const engine = await enginesRepo.get(engineId);
      if (!engine) throw new Error("Engine not found (it may have been deleted).");
      return { engine, wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer, network: null };
    },
    maxWorkers: async () => 4,
    defaultHashMb: async () => 16,
    nnueEngineFiles: () => ({ files: { "eval.ts": "// nnue eval" }, templateVersion: 1 }),
    locks: new FakeLocks(),
    whenReady: async () => undefined,
    newId,
    timing: {
      checkpointPersistMs: 0,
      checkpointEverySteps: 2,
      runFlushMs: 0,
      pointIntervalMs: 0,
      liveThrottleMs: 0,
      datasetWriter: { chunkPositions: 100, partialFlushMs: 0, recordUpdateMs: 0 },
    },
    ...overrides,
    notify: (overrides.notify as RecordingNotifier | undefined) ?? notify,
  };
}

export function testEngine(id: string, overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    id,
    name: `Engine ${id}`,
    description: "",
    kind: "eval",
    createdAt: 1,
    updatedAt: 1,
    color: "#123456",
    options: { hashMb: 16 },
    files: { "eval.ts": "// eval" },
    templateVersion: 1,
    networkId: null,
    ...overrides,
  };
}

export function runConfig(overrides: Partial<TrainingRunConfig> = {}): TrainingRunConfig {
  return {
    name: "Test run",
    network: { mode: "new", hidden: 16, activation: 1 },
    data: { datasetIds: [], selfPlay: null },
    hyper: {
      epochs: 3,
      batchSize: 64,
      learningRate: 0.003,
      lrSchedule: "constant",
      evalWeight: 0.75,
      weightDecay: 0.01,
      validationSplit: 0.1,
      threads: 1,
      seed: 7,
    },
    loop: { enabled: false, cycles: 1, selfPlayWithLatest: true, keepCycles: null, gating: null },
    publishEngine: false,
    ...overrides,
  };
}

/** Polls until `cond()` (async) is true. */
export async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
