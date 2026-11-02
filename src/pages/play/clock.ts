// Chess clock accounting (pure functions, unit-tested in clock.test.ts).
//
// The game keeps an authoritative "remaining ms" per side. A side's turn starts its clock; when it
// moves, the wall time of the turn is charged, then the increment is added, and with a
// "moves per control" time control the base time is added again each time the side completes a
// control period (e.g. 40/90+30: +90 min after the 40th, 80th... move).
import { parseFenBoard } from "@/chess";
import type { TimeControl } from "@/types";
import type { Side } from "./types";

export interface ChargedClock {
  /** Remaining time after the move (0 when flagged). */
  ms: number;
  /** The time ran out before the move was made. */
  flagged: boolean;
}

/**
 * Charges one completed move to the mover's clock.
 * @param msBefore remaining time when the turn started
 * @param elapsedMs time the move took
 * @param movesCompleted moves this side has completed under the clock, including this one
 */
export function chargeMove(tc: TimeControl, msBefore: number, elapsedMs: number, movesCompleted: number): ChargedClock {
  const left = msBefore - Math.max(0, elapsedMs);
  if (!(left > 0)) return { ms: 0, flagged: true };
  let ms = left + Math.max(0, tc.incMs || 0);
  const period = tc.movesPerControl ? Math.round(tc.movesPerControl) : 0;
  if (period > 0 && movesCompleted > 0 && movesCompleted % period === 0) ms += Math.max(0, tc.baseMs);
  return { ms, flagged: false };
}

/** Remaining time of a clock that has been running since `since` (null = not running). */
export function remainingAt(ms: number, since: number | null, now: number): number {
  if (since === null) return ms;
  return Math.max(0, ms - Math.max(0, now - since));
}

/** Moves made by `side` within `plies` plies that started with `firstToMove` to move. */
export function movesBySide(firstToMove: Side, plies: number, side: Side): number {
  const n = Math.max(0, Math.floor(plies));
  return side === firstToMove ? Math.ceil(n / 2) : Math.floor(n / 2);
}

/**
 * True when `side` cannot possibly checkmate with its material: a lone king, king and one minor
 * piece, or king and bishops that all stand on squares of one colour. (The usual rule for "flag
 * falls, but the opponent cannot win": the game is then drawn.)
 */
export function cannotMate(fen: string, side: Side): boolean {
  const board = parseFenBoard(fen);
  let knights = 0;
  const bishopColours: number[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece || piece[0] !== side) continue;
    switch (piece[1]) {
      case "P":
      case "R":
      case "Q":
        return false;
      case "N":
        knights++;
        break;
      case "B":
        bishopColours.push(((i >> 3) + (i & 7)) % 2);
        break;
    }
  }
  const minors = knights + bishopColours.length;
  if (minors <= 1) return true;
  return knights === 0 && bishopColours.every((c) => c === bishopColours[0]);
}

/** Clock values a game starts with. */
export function initialClocks(white: TimeControl | null, black: TimeControl | null): Record<Side, number | null> {
  return { w: white ? white.baseMs : null, b: black ? black.baseMs : null };
}
