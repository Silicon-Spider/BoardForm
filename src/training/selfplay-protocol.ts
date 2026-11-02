// Messages between the self-play pool (main thread, selfplay-pool.ts) and selfplay.worker.ts.
//
//   pool → worker: init (once), then play (one game at a time), stop
//   worker → pool: ready | init-error, board (≤ 4/s), game | gating-game | game-error | aborted,
//                  stopped (answer to stop once no game is running), log
import type { SearchLimits, Termination } from "@/types";
import type { WasmModuleInfo } from "@/engine-host/module-info";

/** How every game of a job is played and what is recorded. */
export interface GameSettings {
  limits: SearchLimits;
  /** Random legal plies at the start of every game (never searched, never recorded). */
  randomPlies: number;
  /** A game reaching this many plies (random opening included) is a draw ("max-moves"). */
  maxPlies: number;
  /** Positions whose ply index (plies played before them) is below this are not recorded. */
  skipPlies: number;
  adjudicateCp: number;
  adjudicatePlies: number;
  /** Positions with |score| ≥ this are not recorded. */
  recordScoreLimit: number;
}

export interface SelfPlayWorkerInit {
  type: "init";
  /** "selfplay": one engine plays both sides; "gating": networks[0] (new) vs networks[1] (previous). */
  mode: "selfplay" | "gating";
  module: WebAssembly.Module | ArrayBuffer;
  /** Import/export signatures (a Module cannot be re-parsed in the worker). */
  moduleInfo: WasmModuleInfo | null;
  /** One entry per engine instance (null = no network). */
  networks: Array<ArrayBuffer | null>;
  hashMb: number;
  /** 4-byte SharedArrayBuffer behind the stop flag (shared by the whole pool), when cross-origin isolated. */
  stopBuffer: SharedArrayBuffer | null;
  settings: GameSettings;
  /** Worker index in its pool (for log messages). */
  slot: number;
}

export interface SelfPlayWorkerPlay {
  type: "play";
  gameIndex: number;
  seed: number;
  /** Gating only: the new network plays White. */
  newIsWhite?: boolean;
}

export type SelfPlayWorkerRequest = SelfPlayWorkerInit | SelfPlayWorkerPlay | { type: "stop" };

/** Why positions of a game were not recorded (diagnostics for the log). */
export interface SkipCounts {
  check: number;
  capture: number;
  promotion: number;
  score: number;
  noScore: number;
  early: number;
}

export interface SelfPlayGameRecord {
  gameIndex: number;
  /** White's point of view: 0 Black won, 1 draw, 2 White won. */
  result: 0 | 1 | 2;
  termination: Termination;
  plies: number;
  /** Searched plies (the random opening is not searched). */
  searched: number;
  nodes: number;
  /** Recorded positions; `data` holds positions × 32 bytes of PackedPosition (results set). */
  positions: number;
  data: ArrayBuffer;
  skipped: SkipCounts;
}

export interface GatingGameRecord {
  gameIndex: number;
  newIsWhite: boolean;
  /** White's point of view: 0 Black won, 1 draw, 2 White won. */
  result: 0 | 1 | 2;
  termination: Termination;
  plies: number;
}

export type SelfPlayWorkerEvent =
  | { type: "ready"; engineName: string | null; stopFlag: boolean }
  | { type: "init-error"; message: string }
  | { type: "board"; gameIndex: number; fen: string; lastMove: string | null; ply: number }
  | { type: "game"; game: SelfPlayGameRecord }
  | { type: "gating-game"; game: GatingGameRecord }
  /** The game was abandoned because the engine failed (crashed: the instance was re-created). */
  | { type: "game-error"; gameIndex: number; message: string; crashed: boolean }
  /** The game was abandoned because of a stop request. */
  | { type: "aborted"; gameIndex: number }
  | { type: "stopped" }
  | { type: "log"; level: "info" | "warn"; message: string };
