// Tunables of the NNUE Lab service. Values follow docs/NNUE_FORMAT.md ("Training data" and
// "Training-run guidance") and the measurements quoted there. Worker-safe (no imports).

/** Self-play search limit when the configuration sets none (nodes per move). */
export const DEFAULT_SELFPLAY_NODES = 5000;

/** Adjudication: a game is won by the side ahead once |score| ≥ this (cp, mate scores count)… */
export const ADJUDICATE_CP = 2500;
/** …for this many consecutive searched plies (both sides' searches count). */
export const ADJUDICATE_PLIES = 8;

/** Positions whose search score is this large (cp, either sign) are not recorded. */
export const RECORD_SCORE_LIMIT = 3000;

/** Score used for "mate in N" (side-to-move POV): ±(MATE_SCORE − N). Far beyond every threshold above. */
export const MATE_SCORE = 30000;

/** Rough positions recorded per self-play game (template engine, 5000 nodes, default filters). */
export const POSITIONS_PER_GAME_ESTIMATE = 95;

/** Below this many optimizer steps per cycle a network barely learns (wizard warning). */
export const MIN_USEFUL_STEPS = 1000;
/** Below this many training positions a network rarely beats the material + PST fallback. */
export const MIN_USEFUL_POSITIONS = 200_000;

/** Self-play engines never get more transposition table than this (many run at once). */
export const SELFPLAY_MAX_HASH_MB = 64;
/** Live board updates per worker are posted at most this often. */
export const BOARD_UPDATE_MS = 250;
/** Live state (zustand) is published at most this often. */
export const LIVE_THROTTLE_MS = 250;

/** Run records keep at most this many training points (older ones are thinned out). */
export const MAX_RUN_POINTS = 4000;
/** A training point is stored at most this often (progress arrives ~4× per second). */
export const POINT_INTERVAL_MS = 1500;
/** Run records keep the newest this-many log entries. */
export const MAX_RUN_LOG = 500;

/** Training checkpoints are written to IndexedDB at most this often (plus at every epoch end). */
export const CHECKPOINT_PERSIST_MS = 20_000;
/** The trainer posts a checkpoint every N optimizer steps (persisting is throttled separately). */
export const CHECKPOINT_EVERY_STEPS = 25;
/** The run record (points, log, progress) is written at most this often while a run executes. */
export const RUN_FLUSH_MS = 3000;

/** Dataset records are updated at most this often while positions are being added. */
export const DATASET_UPDATE_MS = 2000;
/** The chunk being filled is written to IndexedDB at least this often (limits loss on tab close: a
 * reload or a closed browser loses at most this much self-play; a rewrite is at most 512 KB). */
export const DATASET_PARTIAL_FLUSH_MS = 10_000;

/** A self-play job fails after this many games in a row ended in an engine error. */
export const MAX_CONSECUTIVE_GAME_ERRORS = 3;
/** Time the workers get to acknowledge a stop before they are terminated. */
export const STOP_GRACE_MS = 3000;

/** IndexedDB ids (store "networkData") of a run's training checkpoints. */
export const checkpointDataId = (runId: string): string => `checkpoint:${runId}`;
export const bestDataId = (runId: string): string => `best:${runId}`;
/** Key for RunLocks of a dataset being written (one writer per dataset across tabs). */
export const datasetLockKey = (datasetId: string): string => `dataset:${datasetId}`;
/**
 * Web Lock names: "boardform:run:<id>" makes sure only one tab executes a run;
 * "boardform:dataset:<id>" that only one tab appends to a dataset.
 */
export const runLockName = (key: string): string => (key.startsWith("dataset:") ? `boardform:${key}` : `boardform:run:${key}`);
