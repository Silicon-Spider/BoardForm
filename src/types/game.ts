// Games, matches and arena types.
import type { EngineLimits, TimeControl } from "./engine";

export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";

export type Termination =
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "fifty-move"
  | "insufficient-material"
  | "timeout"
  | "resign"
  | "draw-agreed"
  | "adjudication"
  | "illegal-move"
  | "engine-error"
  | "max-moves"
  | "aborted"
  | "unterminated";

export type PlayerRef =
  | { type: "human"; name: string }
  | { type: "engine"; engineId: string; name: string };

export interface GameRecord {
  id: string;
  createdAt: number;
  white: PlayerRef;
  black: PlayerRef;
  /** "startpos" or a FEN. */
  startFen: string;
  /** UCI moves. */
  moves: string[];
  san: string[];
  result: GameResult;
  termination: Termination;
  pgn: string;
  /** Arena match id, if played in a match. */
  matchId?: string | null;
  /** Opening name, if one from the book was used. */
  opening?: string | null;
  timeControl?: { white: TimeControl | null; black: TimeControl | null };
  /** Engine-reported eval after each ply, White POV centipawns (null = unknown / mate scores mapped to ±10000). */
  evals?: Array<number | null>;
  /** Time spent per ply (ms). */
  times?: number[];
}

export interface ParticipantConfig {
  engineId: string;
  limits: EngineLimits;
  /** null = no clock (limits only). */
  timeControl: TimeControl | null;
  hashMb?: number;
}

export interface AdjudicationConfig {
  /** Resign when |score| ≥ this (cp) for `resignMoves` consecutive moves by both engines; null = off. */
  resignScoreCp: number | null;
  resignMoves: number;
  /** Draw when |score| ≤ this (cp) for `drawMoves` consecutive moves after `drawMinPly`; null = off. */
  drawScoreCp: number | null;
  drawMoves: number;
  drawMinPly: number;
  /** Declare a draw ("max-moves") after this many plies; null = unlimited. */
  maxPlies: number | null;
}

export interface MatchConfig {
  name: string;
  participants: ParticipantConfig[];
  /** round-robin: every pair; gauntlet: participants[0] vs each other. */
  format: "round-robin" | "gauntlet";
  /** Games per pairing (colors alternate; even numbers recommended). */
  gamesPerPairing: number;
  openings: { mode: "book" | "none" | "random-plies"; randomPlies?: number; seed?: number };
  /** Games played simultaneously. */
  concurrency: number;
  adjudication: AdjudicationConfig;
  saveGames: boolean;
}

export interface MatchGameSummary {
  index: number;
  whiteId: string;
  blackId: string;
  result: GameResult;
  termination: Termination;
  plies: number;
  gameId?: string | null;
  opening?: string | null;
}

export type MatchStatus = "pending" | "running" | "paused" | "finished" | "aborted";

export interface MatchRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: MatchStatus;
  config: MatchConfig;
  totalGames: number;
  results: MatchGameSummary[];
}
