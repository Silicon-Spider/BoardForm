// Evaluation graph of a saved game: White-POV evaluation (pawns, clamped to ±10, mates at the
// edge) per ply. Click a point (or focus the chart, pick a point with ←/→ and press Enter) to
// jump to that position.
import { memo, useMemo } from "react";
import { CHART_COLORS, LineChart, type ChartSeries } from "@/components";
import { MATE_CP } from "./rules";
import { plyLabel } from "./format";

const CLAMP_PAWNS = 10;

function pawns(cp: number): number {
  if (Math.abs(cp) >= MATE_CP) return cp > 0 ? CLAMP_PAWNS : -CLAMP_PAWNS;
  return Math.max(-CLAMP_PAWNS, Math.min(CLAMP_PAWNS, cp / 100));
}

function formatPawns(v: number): string {
  if (v === 0) return "0.0";
  const a = Math.abs(v);
  return `${v > 0 ? "+" : "−"}${a >= CLAMP_PAWNS ? "10+" : a.toFixed(1)}`;
}

export interface EvalGraphProps {
  evals: ReadonlyArray<number | null>;
  /** startPlyFromFen of the game's start position (for move labels). */
  startPly: number;
  /** Ply shown on the board (0 = start), marked on the graph. */
  currentPly: number | null;
  onSelectPly(ply: number): void;
}

function EvalGraphImpl({ evals, startPly, currentPly, onSelectPly }: EvalGraphProps) {
  const { series, bound } = useMemo(() => {
    const points = evals.flatMap((v, i) => (v === null || v === undefined || !Number.isFinite(v) ? [] : [{ x: i + 1, y: pawns(v) }]));
    const max = points.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
    const s: ChartSeries[] = [{ name: "Evaluation", color: CHART_COLORS[0], points }];
    return { series: s, bound: Math.min(CLAMP_PAWNS, Math.max(1, Math.ceil(max))) };
  }, [evals]);
  const hasPoints = series[0].points.length > 0;
  if (!hasPoints) {
    return <p className="play-evalgraph-empty small muted">No engine evaluations were recorded for this game.</p>;
  }
  return (
    <div className="play-evalgraph">
      <LineChart
        series={series}
        height={132}
        legend={false}
        endLabels={false}
        xMin={0}
        xMax={Math.max(1, evals.length)}
        yMin={-bound}
        yMax={bound}
        xLabel="Move"
        formatX={(x) => (Number.isInteger(x) && x > 0 ? plyLabel(x, startPly) : "Start")}
        formatY={formatPawns}
        xMarkers={currentPly !== null && currentPly > 0 ? [{ x: currentPly }] : undefined}
        onPointClick={(x) => onSelectPly(Math.round(x))}
      />
    </div>
  );
}

export const EvalGraph = memo(EvalGraphImpl);
