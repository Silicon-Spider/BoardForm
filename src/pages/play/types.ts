// Types shared by the Play page modules: the game setup form, the players of a running game,
// game endings and the shape of the in-progress game persisted in settings ("play.current").
import type { EngineKind, EngineLimits, GameResult, Termination, TimeControl } from "@/types";

export type Side = "w" | "b";

export const SIDES: readonly Side[] = ["w", "b"];
export const SIDE_NAMES: Record<Side, string> = { w: "White", b: "Black" };

export function otherSide(side: Side): Side {
  return side === "w" ? "b" : "w";
}

/** One side of the game setup form. */
export interface SideSetup {
  player: "human" | "engine";
  /** Selected engine. Kept while the side is human, so switching back restores the choice. */
  engineId: string | null;
  /** Per-move caps of an engine side (unset = no cap). */
  limits: EngineLimits;
  /** This side's clock; null = no clock. */
  timeControl: TimeControl | null;
  /** Transposition table size in MiB; null = the engine's own default. */
  hashMb: number | null;
}

/** Where a game starts. */
export type StartPosition =
  | { kind: "standard" }
  | { kind: "fen"; fen: string }
  | { kind: "opening"; name: string; eco: string; moves: string[] }
  | { kind: "random"; plies: number };

export interface GameSetup {
  white: SideSetup;
  black: SideSetup;
  start: StartPosition;
  /** Changing one side's clock applies the same clock to the other side. */
  sameClock: boolean;
}

/** A start position turned into concrete moves (book / random plies are played before the game). */
export interface ResolvedStart {
  /** Full FEN of the position before the book moves. */
  startFen: string;
  /** Book or random plies played automatically (UCI). */
  moves: string[];
  /** Opening name for the game record, if one from the book was used. */
  opening: string | null;
}

/** Who plays a side; fixed when the game starts. */
export interface PlayerMeta {
  kind: "human" | "engine";
  name: string;
  engineId: string | null;
  engineKind: EngineKind | null;
  /** Engine accent colour (CSS). */
  color: string | null;
  /** Hash size the engine is started with. */
  hashMb: number | null;
  /** Engine caps (empty for humans). */
  limits: EngineLimits;
  timeControl: TimeControl | null;
}

/** An engine score from the engine's own point of view (the side it plays). */
export interface Score {
  cp: number | null;
  mate: number | null;
}

export interface GameEnd {
  result: GameResult;
  termination: Termination;
  winner: Side | null;
  /** Headline, e.g. "White wins" or "Draw". */
  title: string;
  /** One sentence, e.g. "Checkmate." or "Classic ran out of time." */
  reason: string;
}

/** The in-progress (or just finished) game, stored in settings under "play.current". */
export interface PersistedGame {
  v: 1;
  id: string;
  createdAt: number;
  setup: GameSetup;
  players: Record<Side, PlayerMeta>;
  startFen: string;
  /** Leading plies that came from the opening book / random opening. */
  bookPlies: number;
  opening: string | null;
  moves: string[];
  evals: Array<number | null>;
  /** White-POV score after each ply (with real mate distances); optional for older snapshots. */
  whiteScores?: Array<Score | null>;
  times: number[];
  /** Remaining clock time when the game was stored (the running clock is charged up to then). */
  clock: Record<Side, number | null>;
  /** Last score each engine reported (draw offers are judged on it). */
  scores: Record<Side, Score | null>;
  end: GameEnd | null;
  /** Set once the finished game was written to the games store. */
  savedGameId: string | null;
  /** The game ended without being worth saving (aborted before any move). */
  saveSkipped: boolean;
  /** Wall-clock time of this snapshot. */
  updatedAt: number;
}
