// Small pure helpers shared by the self-play worker and the main thread: search scores, game
// adjudication, search limits and seeds. Worker-safe (no DOM, no storage).
import type { EngineLimits, SearchInfo, SearchLimits } from "@/types";
import { ADJUDICATE_CP, ADJUDICATE_PLIES, DEFAULT_SELFPLAY_NODES, MATE_SCORE } from "./constants";

/**
 * The search score of a finished search in centipawns from the side to move's point of view.
 * "Mate in N" becomes ±(MATE_SCORE − N), so mates always count as huge scores. Null when the
 * engine reported nothing (no cb_info) — such positions cannot be labelled.
 */
export function scoreFromInfo(info: SearchInfo | null | undefined): number | null {
  if (!info) return null;
  if (info.mate !== null && info.mate !== 0) {
    const n = Math.min(Math.abs(info.mate), 1000);
    return info.mate > 0 ? MATE_SCORE - n : -(MATE_SCORE - n);
  }
  return typeof info.scoreCp === "number" && Number.isFinite(info.scoreCp) ? info.scoreCp : null;
}

/** Side-to-move score → White's point of view. */
export function toWhiteScore(scoreStm: number | null, sideToMove: "w" | "b"): number | null {
  if (scoreStm === null) return null;
  return sideToMove === "w" ? scoreStm : -scoreStm;
}

/**
 * Score adjudication: once |score| ≥ `cp` for `plies` consecutive searched plies with the same
 * side ahead, that side is declared the winner. Scores are White POV; a ply without a score
 * breaks the streak.
 */
export class Adjudicator {
  private sign = 0;
  private streak = 0;

  constructor(
    private readonly cp: number = ADJUDICATE_CP,
    private readonly plies: number = ADJUDICATE_PLIES,
  ) {}

  /** Feeds one search score; returns the adjudicated result (2 White won, 0 Black won) or null. */
  push(scoreWhite: number | null): 0 | 2 | null {
    const s = scoreWhite === null ? 0 : scoreWhite >= this.cp ? 1 : scoreWhite <= -this.cp ? -1 : 0;
    this.streak = s !== 0 && s === this.sign ? this.streak + 1 : s !== 0 ? 1 : 0;
    this.sign = s;
    if (this.plies > 0 && this.streak >= this.plies) return s > 0 ? 2 : 0;
    return null;
  }
}

const positive = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** True when `limits` caps the search at all (depth, nodes or movetime). */
export function hasLimit(limits: EngineLimits | null | undefined): boolean {
  return !!limits && (positive(limits.depth) || positive(limits.nodes) || positive(limits.movetimeMs));
}

/** Per-move search limits for self-play / gating: the configured caps, or DEFAULT_SELFPLAY_NODES. */
export function selfPlaySearchLimits(limits: EngineLimits | null | undefined): SearchLimits {
  const out: SearchLimits = {};
  if (limits && positive(limits.depth)) out.depth = Math.max(1, Math.round(limits.depth));
  if (limits && positive(limits.nodes)) out.nodes = Math.max(1, Math.round(limits.nodes));
  if (limits && positive(limits.movetimeMs)) out.movetimeMs = Math.max(1, Math.round(limits.movetimeMs));
  if (out.depth === undefined && out.nodes === undefined && out.movetimeMs === undefined) out.nodes = DEFAULT_SELFPLAY_NODES;
  return out;
}

/** One-line description of engine limits ("5,000 nodes", "depth 8 · 100 ms"). */
export function describeEngineLimits(limits: EngineLimits | null | undefined): string {
  const l = selfPlaySearchLimits(limits);
  const parts: string[] = [];
  if (l.depth !== undefined) parts.push(`depth ${l.depth}`);
  if (l.nodes !== undefined) parts.push(`${l.nodes.toLocaleString("en-US")} nodes`);
  if (l.movetimeMs !== undefined) parts.push(`${l.movetimeMs} ms`);
  return parts.join(" · ");
}

/** Deterministic 32-bit mix of several integers (murmur3-style), for per-game seeds. */
export function mixSeeds(...parts: number[]): number {
  let h = 0x2545f491;
  for (const p of parts) {
    let k = Math.imul(Math.floor(p) | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Seed of self-play game `index` of a job (independent of which worker plays it). */
export function selfPlayGameSeed(jobSeed: number, index: number): number {
  return mixSeeds(jobSeed, 0x5e1f, index);
}

/**
 * Gating games come in pairs with the same random opening and swapped colours (game 2k: the new
 * network plays White, game 2k + 1: Black), which cancels most of the opening's bias.
 */
export function gatingGameSetup(jobSeed: number, index: number): { seed: number; newIsWhite: boolean } {
  return { seed: mixSeeds(jobSeed, 0x6a7e, Math.floor(index / 2)), newIsWhite: index % 2 === 0 };
}

/** Game result from White's point of view ("1-0" → 2, "0-1" → 0, otherwise a draw → 1). */
export function resultCode(result: string): 0 | 1 | 2 {
  return result === "1-0" ? 2 : result === "0-1" ? 0 : 1;
}
