// Turns a run's training points (persisted + live) into chart series: train / validation loss and
// learning rate against "positions trained on", with one marker per cycle boundary.
//
// The x axis must keep growing across cycles. The service stores TrainingPoint.positions per
// cycle (the training job's positionsSeen, which restarts at zero every cycle); run-wide counts
// are handled too: when a new cycle starts lower than where the previous one ended, the previous
// cycle's total is added as an offset. A cycle whose training restarted (positions going backwards
// inside one cycle) replaces the abandoned tail. Cycles are 0-based; marker labels are 1-based.
import type { TrainingPoint } from "@/types";

export interface XY {
  x: number;
  y: number;
}

export interface CycleMarker {
  x: number;
  label: string;
}

export interface RunChartData {
  train: XY[];
  val: XY[];
  lr: XY[];
  /** One per cycle after the first, at the x where it starts. */
  markers: CycleMarker[];
  /** Rows for the table view, in x order. */
  rows: Array<{ x: number; cycle: number; epoch: number; trainLoss: number; valLoss: number | null; lr: number }>;
}

/** The part of a point the charts need (live points have no timestamp or step). */
export type ChartInputPoint = Pick<TrainingPoint, "cycle" | "epoch" | "positions" | "trainLoss" | "valLoss" | "lr">;

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function buildRunChartData(points: readonly ChartInputPoint[]): RunChartData {
  type Row = RunChartData["rows"][number] & { raw: number };
  const rows: Row[] = [];
  const markers: CycleMarker[] = [];
  let offset = 0;
  let prevCycle: number | null = null;
  let prevRaw = 0;

  for (const p of points) {
    if (!finite(p.positions)) continue;
    const raw = Math.max(0, p.positions);
    if (prevCycle !== null && p.cycle !== prevCycle) {
      // New cycle: counting restarted → continue after the previous cycle's last x.
      if (raw < prevRaw) offset += prevRaw;
      markers.push({ x: offset + raw, label: `Cycle ${p.cycle + 1}` });
    } else if (prevCycle !== null && raw < prevRaw) {
      // Same cycle went backwards: training of this cycle restarted. Drop the abandoned tail.
      while (rows.length > 0 && rows[rows.length - 1].cycle === p.cycle && rows[rows.length - 1].raw >= raw) rows.pop();
    }
    rows.push({
      x: offset + raw,
      raw,
      cycle: p.cycle,
      epoch: p.epoch,
      trainLoss: p.trainLoss,
      valLoss: finite(p.valLoss) ? p.valLoss : null,
      lr: p.lr,
    });
    prevCycle = p.cycle;
    prevRaw = raw;
  }

  // A cycle marker stays where the cycle first started, even if that cycle's training restarted.
  const train: XY[] = [];
  const val: XY[] = [];
  const lr: XY[] = [];
  for (const r of rows) {
    if (finite(r.trainLoss) && r.trainLoss > 0) train.push({ x: r.x, y: r.trainLoss });
    if (r.valLoss !== null && r.valLoss > 0) val.push({ x: r.x, y: r.valLoss });
    if (finite(r.lr) && r.lr > 0) lr.push({ x: r.x, y: r.lr });
  }
  return {
    train,
    val,
    lr,
    markers: dedupeMarkers(markers),
    rows: rows.map(({ raw: _raw, ...rest }) => rest),
  };
}

/** Keeps the last marker for each label (a cycle restarted) and sorts by x. */
function dedupeMarkers(markers: CycleMarker[]): CycleMarker[] {
  const byLabel = new Map<string, CycleMarker>();
  for (const m of markers) byLabel.set(m.label, m);
  return [...byLabel.values()].sort((a, b) => a.x - b.x);
}

/**
 * Appends live points (newer than the newest persisted one) to the persisted list. A live point is
 * newer when it belongs to a later cycle, or to the same cycle with more positions.
 */
export function withLivePoints<P extends ChartInputPoint>(persisted: readonly P[], live: readonly ChartInputPoint[]): ChartInputPoint[] {
  if (live.length === 0) return persisted as readonly ChartInputPoint[] as ChartInputPoint[];
  const last = persisted.length ? persisted[persisted.length - 1] : null;
  const fresh = last
    ? live.filter((p) => p.cycle > last.cycle || (p.cycle === last.cycle && p.positions > last.positions))
    : live;
  return fresh.length ? [...persisted, ...fresh] : (persisted as readonly ChartInputPoint[] as ChartInputPoint[]);
}

/** Most recent validation-loss minimum: { x, y } of the best point, or null. */
export function bestPoint(series: readonly XY[]): XY | null {
  let best: XY | null = null;
  for (const p of series) if (!best || p.y < best.y) best = p;
  return best;
}
