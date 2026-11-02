// Public types of the NNUE Lab service (docs/ARCHITECTURE.md §5 "@/training").
// WP-LAB-SERVICE owns this file; keep these names and shapes (additive changes only).
//
// What the service stores in a TrainingRunRecord (src/types/nnue.ts):
//  * status / progress: progress.phase is "queued" | "selfplay" | "training" | "evaluating" |
//    "paused" | "stopped" | "finished" | "error"; done / total count games (self-play, gating) or
//    optimizer steps of the current cycle (training). Status changes are written at once, the
//    rest at most every ~3 s while a run executes (live values: useLiveRun).
//  * points (≤ ~4000, older ones thinned out): `epoch` = completed epochs of the cycle (like
//    TrainProgress.epoch), `step` = optimizer steps since the start of the cycle (epoch ·
//    stepsPerEpoch + step, monotonic within a cycle), `positions` = positions trained on in the
//    cycle, valLoss = latest validation loss (null without validation).
//  * networkHistory: one entry per completed cycle ("<run> - cN"), plus an extra entry when a run
//    is stopped mid-training ("<run> - cN (stopped, epoch e/E)"). gating: null = not gated
//    (no earlier network or no gating configured), missing = gating still to do.
//  * datasetIds: the configured datasets first, then one generated dataset per cycle
//    ("<run> - cycle N").
//  * resume: { cycle, epoch, step } while a cycle's training is in progress (null otherwise).
//  * log (≤ 500 entries): trainer messages, self-play summaries, gating results, errors.
// Checkpoints live in the networkData store under "checkpoint:<runId>" and "best:<runId>" and are
// deleted when the cycle completes (or with the run).
//
// getLiveRun(id) / getDatasetJob(id) (exported from @/training) read the live state outside React.
import type { Activation, SelfPlayConfig, TrainingRunConfig, TrainingRunStatus } from "@/types";
import type { TrainProgress } from "@/nnue/protocol";

export interface RunEstimate {
  /** Positions available for training (existing datasets + planned self-play, estimated). */
  positions: number;
  stepsPerEpoch: number;
  /** Optimizer steps per cycle. */
  totalSteps: number;
  /** Trainable parameters of the network. */
  parameters: number;
  /** User-facing advice, e.g. "only 140 optimizer steps — use a smaller batch or more epochs". */
  warnings: string[];
}

/** One game being played right now (self-play or gating). */
export interface LiveBoard {
  slot: number;
  fen: string;
  lastMove: string | null;
  ply: number;
  white: string;
  black: string;
}

export interface SelfPlayProgress {
  gamesDone: number;
  /** null = until stopped. */
  gamesTotal: number | null;
  positions: number;
  posPerSec: number;
  workers: number;
  boards: LiveBoard[];
  results: { white: number; draw: number; black: number };
  avgPlies: number;
}

export interface GatingProgress {
  played: number;
  total: number;
  /** From the new network's point of view. */
  wins: number;
  draws: number;
  losses: number;
  /** (wins + draws / 2) / played; 0.5 before the first game. */
  score: number;
  boards: LiveBoard[];
}

export interface LiveRunState {
  runId: string;
  status: TrainingRunStatus;
  cycle: number;
  phase: "idle" | "selfplay" | "training" | "evaluating";
  selfPlay: SelfPlayProgress | null;
  train: TrainProgress | null;
  gating: GatingProgress | null;
  lastLog: string | null;
  startedAt: number | null;
}

export interface DatasetJobState {
  datasetId: string;
  status: "running" | "finished" | "stopped" | "error";
  progress: SelfPlayProgress;
  error?: string | null;
}

export interface GenerateDatasetOptions {
  name: string;
  description?: string;
  /** engineId "$network" = the stock NNUE engine running `networkId`. */
  selfPlay: SelfPlayConfig;
  networkId?: string | null;
  /** Add the new games to this existing dataset instead of creating a new one. */
  appendTo?: string | null;
}

export interface DatasetSample {
  fen: string;
  /** Search score, White's point of view (cp). */
  scoreWhite: number;
  /** 0 Black won, 1 draw, 2 White won. */
  result: 0 | 1 | 2;
}

export interface TrainingService {
  createRun(config: TrainingRunConfig, opts?: { autoResume?: boolean; start?: boolean }): Promise<string>;
  start(runId: string): Promise<void>;
  pause(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  deleteRun(runId: string, opts?: { deleteNetworks?: boolean; deleteDatasets?: boolean }): Promise<void>;
  setAutoResume(runId: string, on: boolean): Promise<void>;
  isActive(runId: string): boolean;
  activeRunIds(): string[];
  validateConfig(config: TrainingRunConfig): Promise<string[]>;
  estimate(config: TrainingRunConfig): Promise<RunEstimate>;
}

export interface DatasetService {
  generate(opts: GenerateDatasetOptions): Promise<string>;
  stop(datasetId: string): Promise<void>;
  isGenerating(datasetId: string): boolean;
  importFile(file: Blob, opts?: { name?: string }): Promise<string>;
  exportFile(datasetId: string): Promise<Blob>;
  merge(ids: string[], name: string): Promise<string>;
  samplePositions(datasetId: string, count: number): Promise<DatasetSample[]>;
  remove(datasetId: string): Promise<void>;
}

export interface NetworkService {
  importFile(file: Blob, opts?: { name?: string }): Promise<string>;
  exportFile(networkId: string): Promise<Blob>;
  createRandom(opts: { name: string; hidden: number; activation: Activation; seed?: number }): Promise<string>;
  createEngine(networkId: string, opts?: { name?: string }): Promise<string>;
  rename(networkId: string, name: string, description?: string): Promise<void>;
  remove(networkId: string): Promise<void>;
  evaluate(networkId: string, fens: string[]): Promise<Array<number | null>>;
}
