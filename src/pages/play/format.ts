// Display helpers for the Play page: PVs with move numbers, move labels, scores from either
// point of view, one-line limit summaries and download file names.
import { fenTurn, uciLineToSan } from "@/chess";
import type { EngineLimits, GameRecord, SearchInfo } from "@/types";
import { formatCount, formatScore } from "@/utils/format";
import { slugify } from "@/utils/misc";
import type { Score, Side } from "./types";

/** Full-move number of a FEN. */
export function fenMoveNumber(fen: string): number {
  return Math.max(1, parseInt(fen.trim().split(/\s+/)[5] ?? "1", 10) || 1);
}

export interface PvToken {
  /** Move number prefix shown before this move ("12." or "12…"), if any. */
  prefix: string | null;
  san: string;
  /** Index in the PV (0 = first move). */
  index: number;
}

/** A PV in SAN with move numbers, e.g. 12… Nf6 13. Bg5 Be7. Stops at the first illegal move. */
export function pvTokens(fen: string, pv: readonly string[], max = 24): PvToken[] {
  const san = uciLineToSan(fen, pv.slice(0, max));
  let moveNo = fenMoveNumber(fen);
  let white = fenTurn(fen) === "w";
  return san.map((m, i) => {
    const prefix = white ? `${moveNo}.` : i === 0 ? `${moveNo}…` : null;
    if (!white) moveNo++;
    white = !white;
    return { prefix, san: m, index: i };
  });
}

export function pvText(fen: string, pv: readonly string[], max = 24): string {
  return pvTokens(fen, pv, max)
    .map((t) => (t.prefix ? `${t.prefix} ${t.san}` : t.san))
    .join(" ");
}

/** The score of an info from the side to move's POV in `fen`, turned into White's view. */
export function infoWhiteScore(info: SearchInfo | null, fen: string | null): Score | null {
  if (!info || !fen) return null;
  const sign = fenTurn(fen) === "w" ? 1 : -1;
  if (info.mate !== null && info.mate !== 0) return { cp: null, mate: info.mate * sign };
  if (info.scoreCp === null || !Number.isFinite(info.scoreCp)) return null;
  return { cp: info.scoreCp * sign, mate: null };
}

export function scoreText(score: Score | null): string {
  return score ? formatScore(score.cp, score.mate) : "—";
}

/** Converts a White-POV score to `side`'s view. */
export function scoreForSide(score: Score | null, side: Side): Score | null {
  if (!score || side === "w") return score;
  return { cp: score.cp === null ? null : -score.cp, mate: score.mate === null ? null : -score.mate };
}

/** "12." for White's 12th move, "12…" for Black's, from an absolute ply number (1-based). */
export function plyLabel(ply: number, startPly = 0): string {
  const abs = startPly + ply - 1; // 0 = White's first move
  const moveNo = Math.floor(abs / 2) + 1;
  return abs % 2 === 0 ? `${moveNo}.` : `${moveNo}…`;
}

/** Engine caps as a short line ("1 s per move", "depth 12 · 50k nodes"). */
export function capsText(limits: EngineLimits): string {
  const parts: string[] = [];
  if (limits.movetimeMs) parts.push(`${Number((limits.movetimeMs / 1000).toFixed(3))} s per move`);
  if (limits.depth) parts.push(`depth ${limits.depth}`);
  if (limits.nodes) parts.push(`${formatCount(limits.nodes)} nodes`);
  return parts.join(" · ");
}

/** "You vs Classic" */
export function gameTitle(g: Pick<GameRecord, "white" | "black">): string {
  return `${g.white.name} vs ${g.black.name}`;
}

export function pgnFileName(g: Pick<GameRecord, "white" | "black" | "createdAt">): string {
  const d = new Date(g.createdAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${slugify(`${g.white.name} vs ${g.black.name}`)}-${date}.pgn`;
}

/** Number of full moves for a list ("34 moves"). */
export function fullMoves(plies: number): number {
  return Math.ceil(plies / 2);
}
