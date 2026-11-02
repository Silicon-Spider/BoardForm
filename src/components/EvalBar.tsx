// Vertical evaluation bar (White's point of view). The white share follows a logistic
// "winning chances" curve so ±1 pawn moves the bar visibly while ±10 pawns nearly fills it.
// Given the position (`fen`), a checkmate or stalemate on the board shows the result instead of
// the last engine score (which would still say "M1" after the mating move).
import { memo, useMemo } from "react";
import { ChessGame } from "@/chess";
import { clamp, formatScore } from "@/utils/format";
import "./EvalBar.css";

export interface EvalBarProps {
  /** Centipawns, White POV. null/undefined = unknown. */
  cp: number | null | undefined;
  /** Mate in N moves, White POV (positive = White mates). Takes precedence over cp. */
  mate?: number | null;
  /** Board orientation: the side at the bottom of the board is at the bottom of the bar. */
  orientation?: "white" | "black";
  /**
   * The position on the board. When it is checkmate or stalemate the bar shows the result
   * ("1-0", "0-1", "½-½") rather than the score.
   */
  fen?: string | null;
  /** Show the numeric label. Default true. */
  showLabel?: boolean;
  /** Explicit height (px or CSS length). Default: stretch to the parent flex row, min 120px. */
  height?: number | string;
  className?: string;
}

/** Share of the bar that is White, 0..1. */
export function evalToWhiteShare(cp: number | null | undefined, mate?: number | null): number {
  if (mate !== null && mate !== undefined && mate !== 0) return mate > 0 ? 1 : 0;
  if (cp === null || cp === undefined || !Number.isFinite(cp)) return 0.5;
  const chances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1; // −1..1 (lichess' curve)
  return clamp((chances + 1) / 2, 0.025, 0.975);
}

/** Short label that fits a narrow bar: "0.4", "+3.2", "12", "M3". */
function shortLabel(cp: number | null | undefined, mate?: number | null): string {
  if (mate !== null && mate !== undefined && mate !== 0) return `M${Math.abs(mate)}`;
  if (cp === null || cp === undefined || !Number.isFinite(cp)) return "–";
  const v = Math.abs(cp) / 100;
  return v >= 9.95 ? String(Math.round(v)) : v.toFixed(1);
}

export interface FinalPosition {
  /** "1-0", "0-1" or "½-½". */
  label: string;
  /** Spelled out, e.g. "Checkmate — White wins". */
  text: string;
  /** Share of the bar that is White: 1, 0 or 0.5. */
  whiteShare: number;
}

/** Result shown for a position with no legal moves (checkmate or stalemate); null otherwise or for an invalid FEN. */
export function finalPosition(fen: string | null | undefined): FinalPosition | null {
  if (!fen) return null;
  let game: ChessGame;
  try {
    game = new ChessGame(fen);
  } catch {
    return null;
  }
  if (game.legalMoves().length > 0) return null;
  if (!game.inCheck()) return { label: "½-½", text: "Stalemate — draw", whiteShare: 0.5 };
  // The side to move has been checkmated.
  return game.turn() === "b"
    ? { label: "1-0", text: "Checkmate — White wins", whiteShare: 1 }
    : { label: "0-1", text: "Checkmate — Black wins", whiteShare: 0 };
}

function EvalBarImpl({ cp, mate, orientation = "white", fen, showLabel = true, height, className }: EvalBarProps) {
  const final = useMemo(() => finalPosition(fen), [fen]);
  const share = final ? final.whiteShare : evalToWhiteShare(cp, mate);
  const whiteAhead = final ? final.whiteShare >= 0.5 : mate !== null && mate !== undefined && mate !== 0 ? mate > 0 : (cp ?? 0) >= 0;
  const flipped = orientation === "black";
  const known = !!final || (mate !== null && mate !== undefined && mate !== 0) || (cp !== null && cp !== undefined && Number.isFinite(cp));
  // The label sits at the leading side's end of the bar (for a draw: in the white half).
  const labelAtBottom = whiteAhead !== flipped;
  const description = final ? final.text : `Evaluation ${formatScore(cp, mate)}`;
  return (
    <div
      className={["cb-evalbar", flipped && "cb-evalbar--flipped", final && "cb-evalbar--final", className].filter(Boolean).join(" ")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-label={description}
      title={final ? final.text : known ? `${description} (White's view)` : "No evaluation"}
      style={height !== undefined ? { height, minHeight: 0 } : undefined}
    >
      <div className="cb-evalbar-white" style={{ height: `${share * 100}%` }} />
      <div className="cb-evalbar-mid" aria-hidden="true" />
      {showLabel && known && (
        <span
          className={[
            "cb-evalbar-label",
            labelAtBottom ? "cb-evalbar-label--bottom" : "cb-evalbar-label--top",
            whiteAhead ? "on-white" : "on-black",
          ].join(" ")}
        >
          {final ? final.label : shortLabel(cp, mate)}
        </span>
      )}
    </div>
  );
}

export const EvalBar = memo(EvalBarImpl);
