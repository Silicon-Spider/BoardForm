// Shared engine-related types. Owned by the architecture contract (docs/ARCHITECTURE.md).
// Additive changes only; keep field names stable — records are persisted in IndexedDB.

/**
 * How an engine is authored.
 * - blocks:  Blockly HCE workspace → generated eval.ts + stock template
 * - eval:    user-written eval.ts + stock template
 * - full:    every source file is user-editable (snapshot of the template, or anything)
 * - scratch: user-written from a near-empty skeleton (all files editable)
 * - nnue:    stock template + NNUE eval (eval.ts editable) + attached network
 * - wasm:    uploaded pre-compiled module implementing docs/ENGINE_ABI.md
 */
export type EngineKind = "blocks" | "eval" | "full" | "scratch" | "nnue" | "wasm";

export interface EngineOptions {
  /** Transposition table size in MiB (passed as `Hash=N` via cb_set_option). */
  hashMb: number;
}

export interface EngineBuildInfo {
  /** Hash of assembled sources + compiler version + flags. */
  sourceHash: string;
  wasm: ArrayBuffer;
  builtAt: number;
  /** e.g. "assemblyscript 0.28.20" */
  compiler: string;
  sizeBytes: number;
  compileMs: number;
  warnings: number;
}

export interface EngineRecord {
  id: string;
  name: string;
  description: string;
  kind: EngineKind;
  createdAt: number;
  updatedAt: number;
  /** Accent colour (CSS hex) used for cards, charts, arena standings. */
  color: string;
  /** Blockly workspace serialization (kind "blocks"). */
  blocks?: unknown;
  /**
   * Source files keyed by path relative to the engine root (e.g. "eval.ts").
   * - eval / nnue: overrides on top of the stock template (normally just "eval.ts")
   * - full / scratch: the complete source tree
   */
  files?: Record<string, string>;
  /** Entry file for compilation (default "main.ts"). */
  entry?: string;
  /** Template version used to assemble blocks/eval/nnue kinds. */
  templateVersion?: number;
  /**
   * Blocks engines: the @/blocks GENERATOR_VERSION that produced files["eval.ts"]. When it is
   * missing or older than the current one, regenerate eval.ts from `blocks` before building.
   */
  generatorVersion?: number;
  /** NNUE network loaded at engine start (any kind whose wasm exports cb_nnue_load). */
  networkId?: string | null;
  options: EngineOptions;
  /** Last successful build (not for kind "wasm"). */
  build?: EngineBuildInfo | null;
  /** Module bytes for kind "wasm". */
  wasm?: ArrayBuffer;
  /** Engine this one was duplicated/converted from. */
  parentId?: string | null;
  tags?: string[];
  /** Built-in starter engines seeded on first run. */
  builtin?: boolean;
}

/** Remaining clock time (ms) passed to cb_go. */
export interface ClockState {
  wtime: number;
  btime: number;
  winc: number;
  binc: number;
  movestogo?: number;
}

/** Limits for one search (maps 1:1 onto cb_go). Any combination; first reached wins. */
export interface SearchLimits {
  depth?: number;
  nodes?: number;
  movetimeMs?: number;
  clock?: ClockState;
  /** Search until stop() — requires the stop flag (SharedArrayBuffer) or worker termination. */
  infinite?: boolean;
}

export interface SearchInfo {
  depth: number;
  seldepth: number;
  /** Centipawns from the side to move's POV; null when `mate` is set. */
  scoreCp: number | null;
  /** Mate in N moves from the side to move's POV (negative = getting mated). */
  mate: number | null;
  nodes: number;
  timeMs: number;
  nps: number;
  /** Principal variation, UCI moves. */
  pv: string[];
}

export type StopReason = "done" | "stopped" | "timeout" | "error";

export interface SearchResult {
  /** UCI best move, or null if the side to move has no legal move (or the engine failed). */
  bestMove: string | null;
  /** Last info reported during the search. */
  info: SearchInfo | null;
  elapsedMs: number;
  stopReason: StopReason;
  error?: string;
}

export interface TraceEntry {
  label: string;
  /** Contribution for White, cp, positive = good for White. */
  white: number;
  /** Contribution for Black, cp, positive = good for Black. */
  black: number;
}

export interface EngineCapabilities {
  abiVersion: number;
  eval: boolean;
  trace: boolean;
  perft: boolean;
  nnue: boolean;
  setOption: boolean;
  /** From cb_name, if exported. */
  name: string | null;
  /** True when stop() can interrupt a search cooperatively (SharedArrayBuffer available). */
  stopFlag: boolean;
}

/** Per-side caps applied on top of (or instead of) a clock. Unset/0 = no cap. */
export interface EngineLimits {
  depth?: number;
  nodes?: number;
  movetimeMs?: number;
}

/** A side's time control. */
export interface TimeControl {
  baseMs: number;
  incMs: number;
  /** Moves per control period (classical); undefined/0 = sudden death + increment. */
  movesPerControl?: number;
}
