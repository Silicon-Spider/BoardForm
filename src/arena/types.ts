// Public types of the arena service (docs/ARCHITECTURE.md §5 "@/arena").
// WP-ARENA owns this file; keep these names and shapes (additive changes only).
import type {
  AdjudicationConfig,
  GameResult,
  MatchConfig,
  MatchGameSummary,
  MatchRecord,
  ParticipantConfig,
  SearchInfo,
  SearchLimits,
  SearchResult,
  Termination,
} from "@/types";

export interface ArenaService {
  createMatch(config: MatchConfig, opts?: { start?: boolean }): Promise<string>;
  /** Start or resume; games that were interrupted are replayed from the start. */
  start(matchId: string): Promise<void>;
  pause(matchId: string): Promise<void>;
  abort(matchId: string): Promise<void>;
  deleteMatch(matchId: string, opts?: { deleteGames?: boolean }): Promise<void>;
  isRunning(matchId: string): boolean;
}

export interface LiveGameView {
  /** Board slot (0 .. concurrency-1). */
  slot: number;
  /** Game index in the match schedule. */
  index: number;
  white: { id: string; name: string };
  black: { id: string; name: string };
  startFen: string;
  fen: string;
  moves: string[];
  lastMove: string | null;
  sideToMove: "w" | "b";
  whiteMs: number | null;
  blackMs: number | null;
  /** Last info of White's engine (its own searches, so the scores are White's point of view). */
  whiteInfo: SearchInfo | null;
  /** Last info of Black's engine (side-to-move point of view = Black's; negate for White's view). */
  blackInfo: SearchInfo | null;
  opening: string | null;
  /** SAN of `moves` (additive). */
  san?: string[];
  /** Plies that came from the opening book / random opening (additive). */
  openingPlies?: number;
  /** Who is thinking right now; null between moves (additive). */
  thinking?: "w" | "b" | null;
  /** Set once the game is over, while its final position is still shown (additive). */
  result?: GameResult | null;
}

/** One line of the match log (engine output, host notes, errors). */
export interface ArenaLogEntry {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface LiveMatchState {
  matchId: string;
  running: boolean;
  games: LiveGameView[];
  lastError: string | null;
  /** What the runner is doing ("Building Blocky…", "Playing", "Pausing…"); additive. */
  status?: string | null;
  phase?: "preparing" | "playing" | "stopping" | "stopped";
  /** Date.now() when this session started (additive). */
  startedAt?: number | null;
  /** Recent engine output and notes of this session, oldest first (additive). */
  log?: ArenaLogEntry[];
}

/** One side of a single engine-vs-engine game. */
export interface GameSide {
  engineId: string;
  name: string;
  config: ParticipantConfig;
}

/**
 * What playEngineGame needs from an engine. EngineClient implements it; unit tests use fakes.
 * `go` must resolve (not reject) for engine problems and report them through `stopReason`.
 */
export interface GameEngine {
  newGame(): Promise<void>;
  position(startFen: string, moves: string[]): Promise<boolean>;
  go(limits: SearchLimits, onInfo?: (info: SearchInfo) => void): Promise<SearchResult>;
  stop(): void;
}

export interface PlayEngineGameOptions {
  white: GameSide;
  black: GameSide;
  /** "startpos" or a FEN. */
  startFen: string;
  /** Book / random opening moves (UCI) played before the engines take over. */
  openingMoves?: string[];
  opening?: string | null;
  adjudication: AdjudicationConfig;
  signal?: AbortSignal;
  onUpdate?(view: Omit<LiveGameView, "slot" | "index">): void;
  /**
   * Engines to play with (additive). When omitted, playEngineGame starts both with loadEngine()
   * and terminates them afterwards; when given, the caller owns them (they are not terminated).
   */
  engines?: { white: GameEngine; black: GameEngine };
  /** PGN "Event" and "Round" tags, and the opening's ECO code (additive). */
  event?: string;
  round?: string;
  eco?: string | null;
  /** Minimum gap between onUpdate calls in ms (additive, default 100; the final update always comes). */
  updateIntervalMs?: number;
  /** Notes about the game ("Black's engine crashed: ..."), e.g. for a match log (additive). */
  onLog?(level: ArenaLogEntry["level"], text: string): void;
}

export interface PlayedGame {
  startFen: string;
  moves: string[];
  san: string[];
  result: GameResult;
  termination: Termination;
  /** White-POV cp per ply (mate mapped to ±10000; null = unknown). */
  evals: Array<number | null>;
  /** Time used per ply (ms). */
  times: number[];
  pgn: string;
  opening: string | null;
  /** Human-readable reason, e.g. "Black played an illegal move (e2e5)" (additive). */
  detail?: string | null;
  /** Plies that came from the opening (additive). */
  openingPlies?: number;
}

// ------------------------------------------------------------------------------------------
// Fields the arena stores on its records in addition to the shared types (IndexedDB keeps any
// extra fields; backups keep them too). Read them with the helpers in ./records.

/** Extra fields on a MatchRecord written by the arena. */
export interface ArenaMatchExtras {
  /** The error that stopped the match last (build failure, engine did not start, ...). */
  lastError?: string | null;
  /** The engine that caused lastError, when known (e.g. the one that failed to compile). */
  lastErrorEngineId?: string | null;
  /** True when the match stopped because its tab was closed or reloaded while it was running. */
  interrupted?: boolean;
  /** Running time of finished sessions, ms. */
  elapsedMs?: number;
  /** Date.now() when the current session started (only while running). */
  runningSince?: number | null;
  finishedAt?: number | null;
}

export type ArenaMatchRecord = MatchRecord & ArenaMatchExtras;

/** Extra fields on a MatchGameSummary written by the arena. */
export interface ArenaGameSummary extends MatchGameSummary {
  /** Human-readable reason for engine errors, illegal moves, time forfeits... */
  detail?: string | null;
  /** Date.now() when the game finished. */
  finishedAt?: number;
}
