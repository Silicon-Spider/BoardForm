// Vertical evaluation bar (White's point of view). The white share follows a logistic
// "winning chances" curve so ±1 pawn moves the bar visibly while ±10 pawns nearly fills it.
import { memo } from "react";
import { clamp, formatScore } from "@/utils/format";
import "./EvalBar.css";

export interface EvalBarProps {
  /** Centipawns, White POV. null/undefined = unknown. */
  cp: number | null | undefined;
  /** Mate in N moves, White POV (positive = White mates). Takes precedence over cp. */
  mate?: number | null;
  /** Board orientation: the side at the bottom of the board is at the bottom of the bar. */
  orientation?: "white" | "black";
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

function EvalBarImpl({ cp, mate, orientation = "white", showLabel = true, height, className }: EvalBarProps) {
  const share = evalToWhiteShare(cp, mate);
  const whiteAhead =
    mate !== null && mate !== undefined && mate !== 0 ? mate > 0 : (cp ?? 0) >= 0;
  const flipped = orientation === "black";
  const known = (mate !== null && mate !== undefined && mate !== 0) || (cp !== null && cp !== undefined && Number.isFinite(cp));
  // The label sits at the leading side's end of the bar.
  const labelAtBottom = whiteAhead !== flipped;
  return (
    <div
      className={["cb-evalbar", flipped && "cb-evalbar--flipped", className].filter(Boolean).join(" ")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-label={`Evaluation ${formatScore(cp, mate)}`}
      title={known ? `Evaluation ${formatScore(cp, mate)} (White's view)` : "No evaluation"}
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
          {shortLabel(cp, mate)}
        </span>
      )}
    </div>
  );
}

export const EvalBar = memo(EvalBarImpl);
