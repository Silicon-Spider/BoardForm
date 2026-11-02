// Loss and learning-rate charts of a run (train + validation loss on a log axis, LR below), with
// cycle boundaries, the best validation loss, and a table view of the same numbers.
import { useMemo, useState } from "react";
import { CHART_COLORS, EmptyState, LineChart } from "@/components";
import type { TrainingRunRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { bestPoint, buildRunChartData, withLivePoints, type ChartInputPoint } from "../model/chart";
import { formatLoss, formatLr } from "../model/format";
import { LabIcon } from "../ui/icons";

const TABLE_ROWS = 300;

export function RunCharts({ run, livePoints }: { run: TrainingRunRecord; livePoints: readonly ChartInputPoint[] }) {
  const [table, setTable] = useState(false);
  const data = useMemo(() => buildRunChartData(withLivePoints(run.points, livePoints)), [run.points, livePoints]);
  const best = bestPoint(data.val);
  const hasData = data.train.length > 0 || data.val.length > 0;
  // Both charts share the x range so their cycle markers line up.
  const xMin = data.rows.length ? data.rows[0].x : undefined;
  const xMax = data.rows.length ? data.rows[data.rows.length - 1].x : undefined;
  const plainMarkers = useMemo(() => data.markers.map((m) => ({ x: m.x })), [data.markers]);

  if (!hasData) {
    const waiting = run.config.data.selfPlay !== null && run.points.length === 0;
    return (
      <EmptyState
        compact
        icon={<LabIcon name="chart" size={22} />}
        title="No training data yet"
        description={
          waiting
            ? "The loss curves appear as soon as training starts — in the first cycle that is right after the self-play games are done."
            : "The loss curves appear as soon as the first training steps finish."
        }
      />
    );
  }

  return (
    <div className="stack lab-charts">
      <div className="row-between lab-chart-head">
        <div className="small muted">
          {best ? (
            <>
              Best validation loss <strong className="lab-strong">{formatLoss(best.y)}</strong> after {formatCount(best.x)} positions
            </>
          ) : (
            "Validation loss appears after the first epoch."
          )}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          <LabIcon name={table ? "chart" : "list"} />
          {table ? "Show charts" : "Show as table"}
        </button>
      </div>
      {table ? (
        <div className="lab-table-wrap lab-chart-table" tabIndex={0} aria-label="Training points">
          <table className="table">
            <thead>
              <tr>
                <th className="num">Cycle</th>
                <th className="num">Epoch</th>
                <th className="num">Positions</th>
                <th className="num">Training loss</th>
                <th className="num">Validation loss</th>
                <th className="num">Learning rate</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(-TABLE_ROWS).reverse().map((r, i) => (
                <tr key={`${r.x}-${i}`}>
                  <td className="num">{r.cycle + 1}</td>
                  <td className="num">{r.epoch + 1}</td>
                  <td className="num">{formatCount(r.x)}</td>
                  <td className="num">{formatLoss(r.trainLoss)}</td>
                  <td className="num">{formatLoss(r.valLoss)}</td>
                  <td className="num">{formatLr(r.lr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length > TABLE_ROWS && <div className="small faint lab-table-note">Showing the newest {TABLE_ROWS} of {formatCount(data.rows.length)} points.</div>}
        </div>
      ) : (
        <>
          <LineChart
            series={[
              { name: "Training loss", color: CHART_COLORS[0], points: data.train },
              { name: "Validation loss", color: CHART_COLORS[1], points: data.val },
            ]}
            logY
            height={240}
            xLabel="Positions trained on"
            yLabel="Loss (log scale)"
            formatX={formatCount}
            formatY={formatLoss}
            xMin={xMin}
            xMax={xMax}
            xMarkers={data.markers}
          />
          <LineChart
            series={[{ name: "Learning rate", color: CHART_COLORS[2], points: data.lr }]}
            height={130}
            xLabel="Positions trained on"
            yLabel="Learning rate"
            formatX={formatCount}
            formatY={formatLr}
            yMin={0}
            xMin={xMin}
            xMax={xMax}
            xMarkers={plainMarkers}
          />
        </>
      )}
    </div>
  );
}
