// Bench: a fixed-depth search over six positions (each from a fresh game) → nodes, time and
// speed. Handy to compare versions of an engine.
import { useState } from "react";
import { uciToSan } from "@/chess";
import { ProgressBar } from "@/components";
import { useSetting } from "@/storage";
import { formatCount, formatDuration } from "@/utils/format";
import { BENCH_DEPTHS, BENCH_POSITIONS } from "../positions";
import { engineErrorText, type JobRunner } from "./runner";

interface BenchRow {
  name: string;
  nodes: number;
  ms: number;
  best: string | null;
  note: string | null;
}

interface BenchState {
  depth: number;
  rows: BenchRow[];
  finished: boolean;
  cancelled: boolean;
  error: string | null;
}

/**
 * Default bench depth: the stock template searches very selectively (depth 10 takes a moment),
 * while a minimal from-scratch engine needs seconds for depth 6. Remembered per family.
 */
export function benchDefaults(family: "template" | "custom"): { key: string; depth: number } {
  return family === "template" ? { key: "workshop.benchDepth.template", depth: 10 } : { key: "workshop.benchDepth.custom", depth: 5 };
}

export function BenchTool({ runner, family }: { runner: JobRunner; family: "template" | "custom" }) {
  const defaults = benchDefaults(family);
  const [depth, setDepth] = useSetting<number>(defaults.key, defaults.depth);
  const [bench, setBench] = useState<BenchState | null>(null);
  const running = runner.job?.tool === "bench";

  const run = async () => {
    let state: BenchState = { depth, rows: [], finished: false, cancelled: false, error: null };
    setBench(state);
    const update = (fn: (s: BenchState) => BenchState) => {
      state = fn(state);
      setBench(state);
    };
    try {
      await runner.run("bench", `Bench at depth ${depth}…`, async (client, ctl) => {
        for (const p of BENCH_POSITIONS) {
          if (ctl.cancelled) return;
          await client.newGame();
          if (!(await client.position(p.fen, []))) {
            update((s) => ({ ...s, rows: [...s.rows, { name: p.name, nodes: 0, ms: 0, best: null, note: "position rejected" }] }));
            continue;
          }
          const r = await client.go({ depth });
          const note = r.stopReason === "timeout" ? "cut off at the time limit" : r.stopReason === "error" ? `crashed: ${r.error ?? "error"}` : r.stopReason === "stopped" ? "stopped" : r.bestMove ? null : "no move";
          update((s) => ({
            ...s,
            rows: [...s.rows, { name: p.name, nodes: r.info?.nodes ?? 0, ms: r.elapsedMs, best: r.bestMove ? (uciToSan(p.fen, r.bestMove) ?? r.bestMove) : null, note }],
          }));
          if (r.stopReason === "stopped") return;
        }
      });
      update((s) => ({ ...s, finished: true, cancelled: s.rows.length < BENCH_POSITIONS.length || s.rows.some((r) => r.note === "stopped") }));
    } catch (err) {
      update((s) => ({ ...s, finished: true, error: engineErrorText(err) }));
    }
  };

  const rows = bench?.rows ?? [];
  const nodes = rows.reduce((s, r) => s + r.nodes, 0);
  const ms = rows.reduce((s, r) => s + r.ms, 0);

  return (
    <div className="workshop-tool">
      <p className="small muted">Searches {BENCH_POSITIONS.length} positions to a fixed depth, each from a fresh game (empty hash table).</p>
      <div className="row-wrap">
        <label className="row small">
          Depth
          <select className="select select-sm" value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={running}>
            {BENCH_DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void run()} disabled={runner.busy}>
          {running ? <span className="spinner workshop-btn-spinner" /> : null}
          Run bench
        </button>
        {running && (
          <button type="button" className="btn btn-sm" onClick={() => runner.stop()}>
            Stop
          </button>
        )}
      </div>
      {bench && !bench.finished && <ProgressBar value={rows.length} max={BENCH_POSITIONS.length} label={`Position ${Math.min(rows.length + 1, BENCH_POSITIONS.length)} of ${BENCH_POSITIONS.length}`} showValue="fraction" />}
      {bench?.error && <div className="callout danger small">{bench.error}</div>}
      {bench && rows.length > 0 && (
        <>
          <div className="workshop-stats">
            <div>
              <span className="workshop-stat-label">Nodes</span>
              <span className="workshop-stat-value num">{formatCount(nodes)}</span>
            </div>
            <div>
              <span className="workshop-stat-label">Time</span>
              <span className="workshop-stat-value num">{formatDuration(ms)}</span>
            </div>
            <div>
              <span className="workshop-stat-label">Speed</span>
              <span className="workshop-stat-value num">{ms > 0 ? `${formatCount((nodes * 1000) / ms)} nps` : "—"}</span>
            </div>
          </div>
          {bench.finished && bench.cancelled && <p className="small text-warn">Stopped early: the totals cover {rows.length} of {BENCH_POSITIONS.length} positions.</p>}
          <div className="workshop-table-wrap">
            <table className="table workshop-benchtable">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Best</th>
                  <th className="num">Nodes</th>
                  <th className="num">Time</th>
                  <th className="num">NPS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.name}
                      {r.note && <span className="small text-warn"> · {r.note}</span>}
                    </td>
                    <td>{r.best ?? "—"}</td>
                    <td className="num">{formatCount(r.nodes)}</td>
                    <td className="num">{formatDuration(r.ms)}</td>
                    <td className="num">{r.ms > 0 ? formatCount((r.nodes * 1000) / r.ms) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
