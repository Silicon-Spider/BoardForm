// Game rules that are not chess rules: how games end (and how that is worded), when an engine
// accepts a draw offer, score conversions, material balance and building the saved GameRecord.
// Pure functions, unit-tested in rules.test.ts.
import { ChessGame, START_FEN, parseFenBoard, type GameOutcome, type PieceCode } from "@/chess";
import type { GameRecord, GameResult, PlayerRef, SearchInfo, Termination, TimeControl } from "@/types";
import { formatScore } from "@/utils/format";
import { cannotMate } from "./clock";
import { SIDE_NAMES, otherSide, type GameEnd, type PlayerMeta, type Score, type Side } from "./types";

// --- results ---------------------------------------------------------------------------------

export function resultFor(winner: Side | null): GameResult {
  return winner === "w" ? "1-0" : winner === "b" ? "0-1" : "1/2-1/2";
}

function winTitle(winner: Side | null): string {
  return winner ? `${SIDE_NAMES[winner]} wins` : "Draw";
}

const RULE_REASONS: Partial<Record<Termination, string>> = {
  checkmate: "Checkmate.",
  stalemate: "Stalemate.",
  threefold: "Threefold repetition.",
  "fifty-move": "Fifty-move rule.",
  "insufficient-material": "Insufficient material.",
};

/** A game ended by the rules of chess (ChessGame.outcome()). */
export function endByRules(outcome: GameOutcome): GameEnd {
  const winner: Side | null = outcome.result === "1-0" ? "w" : outcome.result === "0-1" ? "b" : null;
  return {
    result: outcome.result,
    termination: outcome.termination,
    winner,
    title: winTitle(winner),
    reason: RULE_REASONS[outcome.termination] ?? "Game over.",
  };
}

export function endByResign(loser: Side, names: Record<Side, string>): GameEnd {
  const winner = otherSide(loser);
  return { result: resultFor(winner), termination: "resign", winner, title: winTitle(winner), reason: `${names[loser]} resigned.` };
}

/** A flag fell. Drawn when the opponent has no mating material left. */
export function endByTimeout(flagged: Side, fen: string, names: Record<Side, string>): GameEnd {
  const opponent = otherSide(flagged);
  if (cannotMate(fen, opponent)) {
    return {
      result: "1/2-1/2",
      termination: "timeout",
      winner: null,
      title: "Draw",
      reason: `${names[flagged]} ran out of time, but ${names[opponent]} cannot checkmate.`,
    };
  }
  return { result: resultFor(opponent), termination: "timeout", winner: opponent, title: winTitle(opponent), reason: `${names[flagged]} ran out of time.` };
}

export function endByAgreement(reason = "Draw agreed."): GameEnd {
  return { result: "1/2-1/2", termination: "draw-agreed", winner: null, title: "Draw", reason };
}

export function endByIllegalMove(side: Side, move: string, names: Record<Side, string>): GameEnd {
  const winner = otherSide(side);
  return {
    result: resultFor(winner),
    termination: "illegal-move",
    winner,
    title: winTitle(winner),
    reason: `${names[side]} played an illegal move (${move}).`,
  };
}

/** The engine failed: crashed, produced no move, rejected the position... `what` completes "<name> …". */
export function endByEngineError(side: Side, what: string, names: Record<Side, string>): GameEnd {
  const winner = otherSide(side);
  return { result: resultFor(winner), termination: "engine-error", winner, title: winTitle(winner), reason: `${names[side]} ${what}.` };
}

export function endByAbort(): GameEnd {
  return { result: "*", termination: "aborted", winner: null, title: "Game aborted", reason: "The game was stopped before it finished." };
}

// --- draw offers -----------------------------------------------------------------------------

/** Engines consider draw offers only once this many plies were played... */
export const DRAW_OFFER_MIN_PLY = 40;
/** ...and only when their own score is within ± this many centipawns. */
export const DRAW_OFFER_MAX_CP = 30;

/** Whether an engine accepts a draw offer, judged on the last score it reported (its own view). */
export function engineDrawDecision(score: Score | null, ply: number): { accept: boolean; reason: string } {
  if (ply < DRAW_OFFER_MIN_PLY) {
    return { accept: false, reason: `it is too early — engines accept draws only after ${DRAW_OFFER_MIN_PLY / 2} moves each` };
  }
  if (!score || (score.cp === null && !score.mate)) return { accept: false, reason: "it has not evaluated the position yet" };
  if (score.mate) return { accept: false, reason: score.mate > 0 ? "it sees a forced mate" : "it plays on even though it sees a forced mate against it" };
  const cp = score.cp ?? 0;
  if (Math.abs(cp) <= DRAW_OFFER_MAX_CP) return { accept: true, reason: `its evaluation is ${formatScore(cp)}` };
  return {
    accept: false,
    reason: cp > 0 ? `it thinks it is better (${formatScore(cp)})` : `its evaluation is ${formatScore(cp)}, but it plays on`,
  };
}

// --- scores ----------------------------------------------------------------------------------

export function scoreOf(info: SearchInfo | null | undefined): Score | null {
  if (!info) return null;
  if (info.mate !== null && info.mate !== 0) return { cp: null, mate: info.mate };
  if (info.scoreCp === null || !Number.isFinite(info.scoreCp)) return null;
  return { cp: info.scoreCp, mate: null };
}

/** A score from `pov`'s point of view turned into White's point of view. */
export function toWhiteScore(score: Score | null, pov: Side): Score | null {
  if (!score) return null;
  const sign = pov === "w" ? 1 : -1;
  return { cp: score.cp === null ? null : score.cp * sign, mate: score.mate === null ? null : score.mate * sign };
}

/** Mate scores are stored as ±10000 cp in game records. */
export const MATE_CP = 10_000;

/** The White-POV centipawn value stored per ply in GameRecord.evals. */
export function evalForRecord(score: Score | null, mover: Side): number | null {
  const white = toWhiteScore(score, mover);
  if (!white) return null;
  if (white.mate) return white.mate > 0 ? MATE_CP : -MATE_CP;
  if (white.cp === null) return null;
  const cp = Math.round(white.cp);
  return cp === 0 ? 0 : cp; // no -0 in stored records
}

// --- material --------------------------------------------------------------------------------

const PIECE_POINTS: Record<string, number> = { Q: 9, R: 5, B: 3, N: 3, P: 1 };
const PIECE_ORDER = ["Q", "R", "B", "N", "P"] as const;

export interface MaterialSide {
  /** Opponent pieces this side is up by (net), most valuable first, e.g. ["bN", "bP"]. */
  pieces: PieceCode[];
  /** Material lead in pawns (0 when not ahead). */
  lead: number;
}

/** Net material difference per side (works for any start position, including promotions). */
export function materialBalance(fen: string): Record<Side, MaterialSide> {
  const counts: Record<Side, Record<string, number>> = { w: {}, b: {} };
  for (const p of parseFenBoard(fen)) {
    if (!p || p[1] === "K") continue;
    const c = counts[p[0] as Side];
    c[p[1]] = (c[p[1]] ?? 0) + 1;
  }
  const out: Record<Side, MaterialSide> = { w: { pieces: [], lead: 0 }, b: { pieces: [], lead: 0 } };
  let points = 0;
  for (const type of PIECE_ORDER) {
    const d = (counts.w[type] ?? 0) - (counts.b[type] ?? 0);
    points += d * PIECE_POINTS[type];
    for (let i = 0; i < Math.abs(d); i++) {
      if (d > 0) out.w.pieces.push(`b${type}` as PieceCode);
      else out.b.pieces.push(`w${type}` as PieceCode);
    }
  }
  if (points > 0) out.w.lead = points;
  else if (points < 0) out.b.lead = -points;
  return out;
}

// --- records & PGN ---------------------------------------------------------------------------

/** PGN TimeControl tag value: "-", "300+3", "40/5400+30". */
export function pgnTimeControl(tc: TimeControl | null): string {
  if (!tc) return "-";
  const base = Math.round(tc.baseMs / 1000);
  const inc = Math.round(tc.incMs / 1000);
  const main = tc.movesPerControl ? `${tc.movesPerControl}/${base}` : `${base}`;
  return inc > 0 || !tc.movesPerControl ? `${main}+${inc}` : main;
}

const PGN_TERMINATION: Record<Termination, string> = {
  checkmate: "normal",
  stalemate: "normal",
  threefold: "normal",
  "fifty-move": "normal",
  "insufficient-material": "normal",
  resign: "normal",
  "draw-agreed": "normal",
  timeout: "time forfeit",
  adjudication: "adjudication",
  "max-moves": "adjudication",
  "illegal-move": "rules infraction",
  "engine-error": "abandoned",
  aborted: "abandoned",
  unterminated: "unterminated",
};

function pgnDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function sameTimeControl(a: TimeControl | null, b: TimeControl | null): boolean {
  if (!a || !b) return a === b;
  return a.baseMs === b.baseMs && a.incMs === b.incMs && (a.movesPerControl ?? 0) === (b.movesPerControl ?? 0);
}

export function pgnHeaders(args: {
  players: Record<Side, PlayerMeta>;
  createdAt: number;
  opening: string | null;
  end: GameEnd | null;
}): Record<string, string> {
  const { players, createdAt, opening, end } = args;
  const headers: Record<string, string> = {
    Event: "Casual game",
    Site: "BoardForm",
    Date: pgnDate(createdAt),
    Round: "-",
    White: players.w.name,
    Black: players.b.name,
    WhiteType: players.w.kind === "human" ? "human" : "program",
    BlackType: players.b.kind === "human" ? "human" : "program",
  };
  const wtc = players.w.timeControl;
  const btc = players.b.timeControl;
  if (sameTimeControl(wtc, btc)) headers.TimeControl = pgnTimeControl(wtc);
  else {
    headers.WhiteTimeControl = pgnTimeControl(wtc);
    headers.BlackTimeControl = pgnTimeControl(btc);
  }
  if (opening) headers.Opening = opening;
  if (end) headers.Termination = PGN_TERMINATION[end.termination] ?? "normal";
  return headers;
}

export function playerRef(p: PlayerMeta): PlayerRef {
  return p.kind === "engine" && p.engineId ? { type: "engine", engineId: p.engineId, name: p.name } : { type: "human", name: p.name };
}

/** PGN of a game in any state (result "*" while it is running). */
export function gamePgn(args: {
  players: Record<Side, PlayerMeta>;
  createdAt: number;
  opening: string | null;
  startFen: string;
  moves: readonly string[];
  end: GameEnd | null;
}): string {
  const game = ChessGame.fromMoves(args.startFen, args.moves) ?? new ChessGame(args.startFen);
  return game.pgn(pgnHeaders(args), args.end?.result ?? "*");
}

/** The GameRecord saved when a game ends. */
export function buildGameRecord(args: {
  id: string;
  createdAt: number;
  players: Record<Side, PlayerMeta>;
  startFen: string;
  moves: readonly string[];
  opening: string | null;
  evals: ReadonlyArray<number | null>;
  times: readonly number[];
  end: GameEnd;
}): GameRecord {
  const game = ChessGame.fromMoves(args.startFen, args.moves);
  const san = game ? game.history().san : [];
  const plies = args.moves.length;
  const fit = <T,>(list: readonly T[], fill: T): T[] => Array.from({ length: plies }, (_, i) => (i < list.length ? list[i] : fill));
  return {
    id: args.id,
    createdAt: args.createdAt,
    white: playerRef(args.players.w),
    black: playerRef(args.players.b),
    startFen: game?.startFen ?? args.startFen,
    moves: [...args.moves],
    san,
    result: args.end.result,
    termination: args.end.termination,
    pgn: gamePgn(args),
    matchId: null,
    opening: args.opening,
    timeControl: { white: args.players.w.timeControl, black: args.players.b.timeControl },
    evals: fit(args.evals, null),
    times: fit(args.times, 0).map((t) => Math.max(0, Math.round(t))),
  };
}

// --- labels ----------------------------------------------------------------------------------

const TERMINATION_LABELS: Record<Termination, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  threefold: "Threefold repetition",
  "fifty-move": "Fifty-move rule",
  "insufficient-material": "Insufficient material",
  timeout: "Time forfeit",
  resign: "Resignation",
  "draw-agreed": "Draw agreed",
  adjudication: "Adjudication",
  "illegal-move": "Illegal move",
  "engine-error": "Engine error",
  "max-moves": "Move limit",
  aborted: "Aborted",
  unterminated: "Unfinished",
};

export function terminationLabel(t: Termination): string {
  return TERMINATION_LABELS[t] ?? t;
}

/** "1-0" → "White won" etc., for screen readers and tooltips. */
export function resultLabel(r: GameResult): string {
  return r === "1-0" ? "White won" : r === "0-1" ? "Black won" : r === "1/2-1/2" ? "Draw" : "Unfinished";
}

export function isStandardStart(fen: string): boolean {
  return fen === START_FEN || fen === "startpos";
}
