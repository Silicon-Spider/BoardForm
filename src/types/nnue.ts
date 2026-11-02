// NNUE networks, datasets and training-run types. See docs/NNUE_FORMAT.md.
import type { EngineLimits } from "./engine";

export type Activation = 0 | 1; // 0 = CReLU, 1 = SCReLU

/** Float weights (training precision). Layouts match docs/NNUE_FORMAT.md. */
export interface FloatNetworkData {
  hidden: number;
  activation: Activation;
  w1: Float32Array; // 768*HL feature-major
  b1: Float32Array; // HL
  w2: Float32Array; // 2*HL (stm half first)
  b2: Float32Array; // 1
}

/** AdamW state, same shapes as the network. */
export interface OptimizerStateData {
  step: number;
  m: FloatNetworkData;
  v: FloatNetworkData;
}

/** Network metadata (store "networks"). Heavy data lives in NetworkDataRecord. */
export interface NetworkRecord {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  hidden: number;
  activation: Activation;
  /** Network this one was continued/widened/forked from. */
  parentId: string | null;
  stats: {
    positionsSeen: number;
    epochs: number;
    trainLoss: number | null;
    valLoss: number | null;
    trainingRunId?: string | null;
    datasetIds?: string[];
  };
  /** Byte size of the quantized CBNN file. */
  sizeBytes: number;
  builtin?: boolean;
}

/** Heavy network payload (store "networkData", same id as NetworkRecord). */
export interface NetworkDataRecord {
  id: string;
  /** CBNN v1 file bytes (what engines load). */
  quantized: ArrayBuffer;
  /** Float weights for continued training (may be absent for imported files). */
  float: FloatNetworkData | null;
  optimizer: OptimizerStateData | null;
}

export interface DatasetRecord {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  positions: number;
  games: number;
  chunks: number;
  source: {
    kind: "selfplay" | "import" | "merge";
    engineId?: string | null;
    engineName?: string | null;
    networkId?: string | null;
    limits?: EngineLimits;
    randomPlies?: number;
    trainingRunId?: string | null;
  };
}

/** Store "datasetChunks"; id = `${datasetId}:${index}` (index zero-padded to 6 digits). */
export interface DatasetChunkRecord {
  id: string;
  datasetId: string;
  index: number;
  count: number;
  /** count × 32 bytes of PackedPosition. */
  data: ArrayBuffer;
}

export type LrSchedule = "constant" | "step" | "cosine";

export interface TrainingHyperParams {
  epochs: number;
  batchSize: number;
  learningRate: number;
  lrSchedule: LrSchedule;
  /** Step schedule: multiply by `lrGamma` every `lrStepEpochs` epochs. */
  lrGamma?: number;
  lrStepEpochs?: number;
  /** Cosine schedule floor. */
  finalLearningRate?: number;
  /** λ in docs/NNUE_FORMAT.md (eval vs. game result blend). */
  evalWeight: number;
  weightDecay: number;
  /** Fraction of positions held out for validation loss (0..0.5). */
  validationSplit: number;
  /** Gradient worker threads (1 = single worker). */
  threads: number;
  seed: number;
}

export interface SelfPlayConfig {
  /** Engine that plays the games. "$network" = the run's current network inside the stock NNUE engine. */
  engineId: string;
  limits: EngineLimits;
  /** Random plies at the start of every game for diversity. */
  randomPlies: number;
  /** Games to generate (per cycle when looping). */
  games: number;
  /** Parallel self-play workers. */
  concurrency: number;
  /** Stop a game after this many plies (adjudicated as draw). */
  maxPlies: number;
  /** Positions skipped at the start of each game before recording. */
  skipPlies: number;
}

export interface TrainingRunConfig {
  name: string;
  network:
    | { mode: "new"; hidden: number; activation: Activation }
    | { mode: "continue"; networkId: string }
    | { mode: "widen"; networkId: string; newHidden: number };
  data: {
    /** Existing datasets to train on (in addition to freshly generated ones). */
    datasetIds: string[];
    /** Generate new self-play data before (each cycle of) training; null = use existing only. */
    selfPlay: SelfPlayConfig | null;
  };
  hyper: TrainingHyperParams;
  loop: {
    /** Repeat self-play → train cycles (reinforcement loop). */
    enabled: boolean;
    /** null = run until stopped. */
    cycles: number | null;
    /** After the first cycle, self-play with the newest network. */
    selfPlayWithLatest: boolean;
    /** Only keep the newest K cycles of generated data in the training set (null = all). */
    keepCycles: number | null;
    /** Optional gating match of new vs. previous network. */
    gating: { games: number; limits: EngineLimits; minScore: number } | null;
  };
  /** Create (or keep updated) an NNUE engine that uses the newest network. */
  publishEngine: boolean;
}

export interface TrainingPoint {
  t: number;
  cycle: number;
  epoch: number;
  step: number;
  positions: number;
  trainLoss: number;
  valLoss: number | null;
  lr: number;
  posPerSec?: number;
}

export type TrainingRunStatus =
  | "queued"
  | "selfplay"
  | "training"
  | "evaluating"
  | "paused"
  | "finished"
  | "stopped"
  | "error";

export interface TrainingLogEntry {
  t: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface TrainingRunRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  config: TrainingRunConfig;
  status: TrainingRunStatus;
  /** Resume automatically when the app is (re)opened. */
  autoResume: boolean;
  cycle: number;
  progress: { phase: string; done: number; total: number };
  /** Newest network produced by this run. */
  networkId: string | null;
  /** Engine published for this run (config.publishEngine). */
  engineId: string | null;
  networkHistory: Array<{
    networkId: string;
    cycle: number;
    createdAt: number;
    valLoss: number | null;
    gating?: { score: number; games: number; accepted: boolean } | null;
  }>;
  /** Datasets generated by this run (per cycle) plus configured ones. */
  datasetIds: string[];
  points: TrainingPoint[];
  log: TrainingLogEntry[];
  error?: string | null;
  /** Mid-training resume info (epoch/step within the current cycle). */
  resume?: { cycle: number; epoch: number; step: number } | null;
}
