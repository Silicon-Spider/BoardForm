// Chess clock accounting for engine games.
//
// * Each side starts with its time control's base time (no clock = null: limits only).
// * After a move, the time it took is subtracted. Below zero the side has flagged (lost on time,
//   decided by the caller). Otherwise the increment is added, and with `movesPerControl` the base
//   time is added again after every completed period (e.g. 40 moves in 90 minutes).
// * Opening book moves are not on the clock: `movesMade` counts the side's engine moves only.
import type { TimeControl } from "@/types";

export interface ClockCharge {
  /** Remaining time after the move (negative when flagged; null = no clock). */
  remaining: number | null;
  flagged: boolean;
}

export function initialClockMs(tc: TimeControl | null | undefined): number | null {
  return tc ? Math.max(0, tc.baseMs) : null;
}

/**
 * Charges one move.
 * @param remaining the side's time before the move (null = no clock)
 * @param elapsedMs how long the move took
 * @param movesMade the side's moves on the clock before this one
 */
export function chargeMove(tc: TimeControl | null | undefined, remaining: number | null, elapsedMs: number, movesMade: number): ClockCharge {
  if (!tc || remaining === null) return { remaining, flagged: false };
  const spent = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const left = remaining - spent;
  if (left < 0) return { remaining: left, flagged: true };
  let next = left + Math.max(0, tc.incMs || 0);
  const period = tc.movesPerControl && tc.movesPerControl > 0 ? Math.round(tc.movesPerControl) : 0;
  if (period > 0 && (movesMade + 1) % period === 0) next += Math.max(0, tc.baseMs);
  return { remaining: next, flagged: false };
}

/**
 * True when the side has enough material to deliver mate at all (used to turn a time forfeit into
 * a draw). Lone king, or king with a single bishop or knight and nothing else = cannot mate.
 * @param placement the first FEN field (piece placement)
 */
export function hasMatingMaterial(placement: string, side: "w" | "b"): boolean {
  const board = placement.split(" ")[0];
  let minors = 0;
  for (const ch of board) {
    const isWhite = ch >= "A" && ch <= "Z";
    if ((side === "w") !== isWhite || !/[pnbrqPNBRQ]/.test(ch)) continue;
    const p = ch.toLowerCase();
    if (p === "p" || p === "r" || p === "q") return true;
    minors++;
  }
  return minors >= 2;
}
