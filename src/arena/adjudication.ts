// Adjudication: ending clearly decided (or clearly dead) games early, from the engines' own scores.
//
// Fed with the score of every engine move (White's point of view, mate scores as ±10000):
// * Resign: both engines agree that the same side is ahead by at least `resignScoreCp` for their
//   last `resignMoves` moves each → that side wins ("resign").
// * Draw: both engines' scores stay within ±`drawScoreCp` for their last `drawMoves` moves each,
//   counting only moves played after ply `drawMinPly` → draw ("adjudication").
// * A move without a score (the engine reported nothing) breaks every streak.
import type { AdjudicationConfig, GameResult, Termination } from "@/types";

export interface AdjudicationOutcome {
  result: GameResult;
  termination: Termination;
  detail: string;
}

type Side = "w" | "b";

/** Score used for mate scores (White POV ±). Larger than any centipawn threshold. */
export const MATE_SCORE = 10_000;

export const DEFAULT_ADJUDICATION: AdjudicationConfig = {
  resignScoreCp: 900,
  resignMoves: 4,
  drawScoreCp: 10,
  drawMoves: 8,
  drawMinPly: 80,
  maxPlies: 400,
};

const enabled = (threshold: number | null | undefined, moves: number) =>
  typeof threshold === "number" && Number.isFinite(threshold) && Number.isFinite(moves) && moves >= 1;

export class Adjudicator {
  /** Consecutive moves (per engine) with White ahead by ≥ resignScoreCp. */
  private whiteAhead = { w: 0, b: 0 };
  /** Consecutive moves (per engine) with Black ahead by ≥ resignScoreCp. */
  private blackAhead = { w: 0, b: 0 };
  /** Consecutive moves (per engine) after drawMinPly with |score| ≤ drawScoreCp. */
  private drawish = { w: 0, b: 0 };

  constructor(private readonly config: AdjudicationConfig) {}

  /**
   * Records the score of the move `side`'s engine just played.
   * @param scoreWhite White-POV cp (mate = ±MATE_SCORE), null when the engine reported no score.
   * @param plyAfter plies on the board after this move (the move's own 1-based ply number).
   */
  record(side: Side, scoreWhite: number | null, plyAfter: number): AdjudicationOutcome | null {
    const c = this.config;
    // NaN compares false with everything, so an unknown score breaks every streak below.
    const score = scoreWhite !== null && Number.isFinite(scoreWhite) ? scoreWhite : NaN;

    if (enabled(c.resignScoreCp, c.resignMoves)) {
      const r = Math.abs(c.resignScoreCp as number);
      this.whiteAhead[side] = score >= r ? this.whiteAhead[side] + 1 : 0;
      this.blackAhead[side] = score <= -r ? this.blackAhead[side] + 1 : 0;
      const n = Math.floor(c.resignMoves);
      if (this.whiteAhead.w >= n && this.whiteAhead.b >= n) {
        return { result: "1-0", termination: "resign", detail: `Both engines saw White ahead by at least ${formatPawns(r)} for ${n} moves` };
      }
      if (this.blackAhead.w >= n && this.blackAhead.b >= n) {
        return { result: "0-1", termination: "resign", detail: `Both engines saw Black ahead by at least ${formatPawns(r)} for ${n} moves` };
      }
    }

    if (enabled(c.drawScoreCp, c.drawMoves)) {
      const d = Math.abs(c.drawScoreCp as number);
      const counts = plyAfter > Math.max(0, c.drawMinPly || 0);
      this.drawish[side] = counts && Math.abs(score) <= d ? this.drawish[side] + 1 : 0;
      const n = Math.floor(c.drawMoves);
      if (this.drawish.w >= n && this.drawish.b >= n) {
        return { result: "1/2-1/2", termination: "adjudication", detail: `Both engines scored the position within ±${formatPawns(d)} for ${n} moves` };
      }
    }
    return null;
  }
}

function formatPawns(cp: number): string {
  return `${Number((cp / 100).toFixed(2))} ${Math.abs(cp) === 100 ? "pawn" : "pawns"}`;
}
