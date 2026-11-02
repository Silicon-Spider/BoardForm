// Game settings → per-move SearchLimits (docs/ARCHITECTURE.md §5).
import type { EngineLimits, SearchLimits, TimeControl } from "@/types";

/** Used when neither caps nor a clock limit the search, so a move always ends. */
export const DEFAULT_MOVETIME_MS = 1000;

const positive = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegative = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/**
 * Limits for the engine about to move.
 *
 * - The caps in `limits` (depth / nodes / movetime; unset or 0 = no cap) always apply.
 * - A clock is passed when the side to move plays with a time control and its remaining time
 *   (`whiteMs` / `blackMs`) is known. If the opponent has no clock, its fields mirror the mover's.
 * - `movestogo` = moves left in the current period of the mover's `movesPerControl`
 *   (absent for sudden death / increment-only controls).
 * - `movesPlayed` = plies already played in this game by both sides (i.e. `moves.length`).
 * - If nothing limits the search at all, `movetimeMs` defaults to 1000 ms.
 */
export function toSearchLimits(args: {
  limits: EngineLimits;
  whiteTc: TimeControl | null;
  blackTc: TimeControl | null;
  whiteMs: number | null;
  blackMs: number | null;
  sideToMove: "w" | "b";
  movesPlayed: number;
}): SearchLimits {
  const { limits, whiteTc, blackTc, whiteMs, blackMs, sideToMove, movesPlayed } = args;
  const out: SearchLimits = {};
  if (positive(limits.depth)) out.depth = Math.max(1, Math.round(limits.depth));
  if (positive(limits.nodes)) out.nodes = Math.max(1, Math.round(limits.nodes));
  if (positive(limits.movetimeMs)) out.movetimeMs = Math.max(1, Math.round(limits.movetimeMs));

  const white = sideToMove === "w";
  const ownTc = white ? whiteTc : blackTc;
  const ownMs = white ? whiteMs : blackMs;
  if (ownTc && typeof ownMs === "number" && Number.isFinite(ownMs)) {
    const oppTc = white ? blackTc : whiteTc;
    const oppMs = white ? blackMs : whiteMs;
    const own = { ms: nonNegative(ownMs), inc: nonNegative(ownTc.incMs) };
    const opp = oppTc && typeof oppMs === "number" && Number.isFinite(oppMs) ? { ms: nonNegative(oppMs), inc: nonNegative(oppTc.incMs) } : own;
    const w = white ? own : opp;
    const b = white ? opp : own;
    out.clock = { wtime: w.ms, btime: b.ms, winc: w.inc, binc: b.inc };

    const perPeriod = ownTc.movesPerControl;
    if (positive(perPeriod)) {
      const period = Math.round(perPeriod);
      const ownMovesMade = Math.floor(Math.max(0, movesPlayed) / 2);
      out.clock.movestogo = period - (ownMovesMade % period);
    }
  }

  if (out.depth === undefined && out.nodes === undefined && out.movetimeMs === undefined && !out.clock) {
    out.movetimeMs = DEFAULT_MOVETIME_MS;
  }
  return out;
}

/** Grace period between raising the stop flag and terminating an unresponsive engine. */
export const STOP_GRACE_MS = 1000;
/** Safety limit for searches limited only by depth / nodes (or not at all). */
export const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * When the host should intervene in a search, in ms after it started: at this point the stop flag
 * is raised (or, without SharedArrayBuffer, the worker is terminated), and STOP_GRACE_MS later an
 * engine that still has not answered is terminated. Null = never (infinite analysis, use stop();
 * or a depth / nodes search with `maxWaitMs = Infinity`).
 *
 * - movetime m      → m + 100 ms + 10 %
 * - clock           → the mover's remaining time + 100 ms
 * - depth/nodes only → maxWaitMs
 */
export function searchDeadlineMs(limits: SearchLimits, sideToMove: "w" | "b" | null, maxWaitMs: number = DEFAULT_MAX_WAIT_MS): number | null {
  if (limits.infinite) return null;
  const candidates: number[] = [];
  if (positive(limits.movetimeMs)) candidates.push(limits.movetimeMs + 100 + 0.1 * limits.movetimeMs);
  const c = limits.clock;
  if (c) {
    const remaining = sideToMove === "w" ? c.wtime : sideToMove === "b" ? c.btime : Math.max(c.wtime, c.btime);
    candidates.push(Math.max(0, Number.isFinite(remaining) ? remaining : 0) + 100);
  }
  const deadline = candidates.length ? Math.min(...candidates) : maxWaitMs;
  return Number.isFinite(deadline) ? deadline : null;
}

/** Side to move after `moves` from "startpos" or a FEN (null if the FEN has no valid colour field). */
export function sideToMoveOf(startFen: string, moves: readonly string[]): "w" | "b" | null {
  const fen = startFen.trim().replace(/^fen\s+/, "");
  let side: "w" | "b";
  if (fen === "" || fen === "startpos") side = "w";
  else {
    const field = fen.split(/\s+/)[1];
    if (field !== "w" && field !== "b") return null;
    side = field;
  }
  return moves.length % 2 === 0 ? side : side === "w" ? "b" : "w";
}
