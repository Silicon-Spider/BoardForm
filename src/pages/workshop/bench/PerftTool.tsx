// Perft: count the leaf nodes of the legal move tree from the board position, and "Check move
// generation" — perft 1..N on six reference positions with known results.
import { useState } from "react";
import { normalizeFen } from "@/chess";
import { ProgressBar } from "@/components";
import { useSetting } from "@/storage";
import type { EngineCapabilities } from "@/types";
import { formatCount, formatDuration } from "@/utils/format";
import { groupDigits } from "../format";
import { CHECK_DEPTHS, PERFT_DEPTHS, PERFT_SUITE, expectedPerft, perftSuiteNodes } from "../positions";
import { engineErrorText, type JobControl, type JobRunner } from "./runner";

interface PerftResult {
  fen: string;
  depth: number;
  nodes: number;
  ms: number;
  expected: number | null;
}

type CellState = { state: "pending" } | { state: "running" } | { state: "pass"; nodes: number; ms: number } | { state: "fail"; nodes: number | null; expected: number } | { state: "skipped" };

interface CheckState {
  maxDepth: number;
  cells: Record<string, CellState[]>;
  doneNodes: number;
  totalNodes: number;
  finished: boolean;
  cancelled: boolean;
  error: string | null;
  ms: number;
}

const sameFen = (a: string, b: string) => normalizeFen(a).split(" ").slice(0, 4).join(" ") === normalizeFen(b).split(" ").slice(0, 4).join(" ");

export function PerftTool({ fen, runner, caps }: { fen: string; runner: JobRunner; caps: EngineCapabilities | null }) {
  const [depth, setDepth] = useSetting<number>("workshop.perftDepth", 4);
  const [checkDepth, setCheckDepth] = useSetting<number>("workshop.checkDepth", 4);
  const [result, setResult] = useState<PerftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState | null>(null);
  const unsupported = caps !== null && !caps.perft;
  const running = runner.job?.tool === "perft";

  const runPerft = async () => {
    setError(null);
    setResult(null);
    const reference = PERFT_SUITE.find((c) => sameFen(c.fen, fen));
    try {
      const out = await runner.run("perft", `perft ${depth}…`, async (client, ctl) => {
        if (!client.capabilities.perft) throw new Error("This engine has no cb_perft export.");
        if (!(await client.position(fen, []))) throw new Error("The engine rejected this position (cb_position returned 0).");
        const t0 = performance.now();
        const nodes = await client.perft(depth);
        if (ctl.cancelled) return null;
        return { fen, depth, nodes: nodes ?? 0, ms: performance.now() - t0, expected: reference ? expectedPerft(reference, depth) : null };
      });
      if (out) setResult(out);
    } catch (err) {
      setError(/stopped/i.test(String(err)) ? "Stopped." : engineErrorText(err));
    }
  };

  const runCheck = async () => {
    const maxDepth = checkDepth;
    const cells: Record<string, CellState[]> = {};
    for (const c of PERFT_SUITE) cells[c.id] = Array.from({ length: maxDepth }, (_, i): CellState => (i < c.counts.length ? { state: "pending" } : { state: "skipped" }));
    let state: CheckState = { maxDepth, cells, doneNodes: 0, totalNodes: perftSuiteNodes(maxDepth), finished: false, cancelled: false, error: null, ms: 0 };
    const update = (fn: (s: CheckState) => CheckState) => {
      state = fn(state);
      setCheck(state);
    };
    setCheck(state);
    const setCell = (id: string, d: number, cell: CellState) =>
      update((s) => ({ ...s, cells: { ...s.cells, [id]: s.cells[id].map((c, i) => (i === d - 1 ? cell : c)) } }));
    const t0 = performance.now();
    try {
      await runner.run("perft", "Checking move generation…", async (client, ctl: JobControl) => {
        if (!client.capabilities.perft) throw new Error("This engine has no cb_perft export.");
        for (const c of PERFT_SUITE) {
          if (!(await client.position(c.fen, []))) {
            for (let d = 1; d <= Math.min(maxDepth, c.counts.length); d++) setCell(c.id, d, { state: "fail", nodes: null, expected: c.counts[d - 1] });
            continue;
          }
          for (let d = 1; d <= Math.min(maxDepth, c.counts.length); d++) {
            if (ctl.cancelled) return;
            setCell(c.id, d, { state: "running" });
            const t = performance.now();
            const nodes = await client.perft(d);
            const expected = c.counts[d - 1];
            setCell(c.id, d, nodes === expected ? { state: "pass", nodes, ms: performance.now() - t } : { state: "fail", nodes, expected });
            update((s) => ({ ...s, doneNodes: s.doneNodes + expected }));
            // A wrong count at one depth makes the deeper ones wrong too: skip them.
            if (nodes !== expected) {
              for (let k = d + 1; k <= Math.min(maxDepth, c.counts.length); k++) setCell(c.id, k, { state: "skipped" });
              update((s) => ({ ...s, doneNodes: s.doneNodes + c.counts.slice(d, maxDepth).reduce((a, b) => a + b, 0) }));
              break;
            }
          }
        }
      });
      update((s) => ({ ...s, finished: true, ms: performance.now() - t0 }));
    } catch (err) {
      const stopped = /stopped/i.test(String(err));
      update((s) => ({ ...s, finished: true, cancelled: stopped, error: stopped ? null : engineErrorText(err), ms: performance.now() - t0 }));
    }
    if (state.finished && !state.error) {
      // Cancelled between calls (no exception): mark what never ran.
      const anyPending = Object.values(state.cells).some((row) => row.some((c) => c.state === "pending" || c.state === "running"));
      if (anyPending) update((s) => ({ ...s, cancelled: true }));
    }
  };

  const allCells = check ? Object.values(check.cells).flat() : [];
  const failures = allCells.filter((c) => c.state === "fail").length;
  const passes = allCells.filter((c) => c.state === "pass").length;
  const checking = running && runner.job?.label.startsWith("Checking");

  return (
    <div className="workshop-tool">
      {unsupported && <div className="callout warn small">This engine has no cb_perft export, so perft is not available.</div>}
      <section className="workshop-subsection">
        <div className="section-title">Perft from the board position</div>
        <div className="row-wrap">
          <label className="row small">
            Depth
            <select className="select select-sm" value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={running}>
              {PERFT_DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void runPerft()} disabled={runner.busy || unsupported}>
            {running && !checking ? <span className="spinner workshop-btn-spinner" /> : null}
            Run perft
          </button>
          {running && !checking && (
            <button type="button" className="btn btn-sm" onClick={() => runner.stop()}>
              Stop
            </button>
          )}
        </div>
        {error && <div className={"callout small " + (error === "Stopped." ? "" : "danger")}>{error}</div>}
        {result && (
          <div className="workshop-stats">
            <div>
              <span className="workshop-stat-label">Nodes</span>
              <span className="workshop-stat-value num">{groupDigits(result.nodes)}</span>
            </div>
            <div>
              <span className="workshop-stat-label">Time</span>
              <span className="workshop-stat-value num">{formatDuration(result.ms)}</span>
            </div>
            <div>
              <span className="workshop-stat-label">Speed</span>
              <span className="workshop-stat-value num">{result.ms > 0 ? `${formatCount((result.nodes * 1000) / result.ms)} nodes/s` : "—"}</span>
            </div>
            {result.expected !== null && (
              <div className={result.expected === result.nodes ? "text-ok" : "text-danger"}>
                <span className="workshop-stat-label">Reference</span>
                <span className="workshop-stat-value num">{result.expected === result.nodes ? "✓ matches" : `✗ expected ${groupDigits(result.expected)}`}</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="workshop-subsection">
        <div className="section-title">Check move generation</div>
        <p className="small muted">Runs perft 1…N on six reference positions with known results. Every number must match exactly.</p>
        <div className="row-wrap">
          <label className="row small">
            Up to depth
            <select className="select select-sm" value={checkDepth} onChange={(e) => setCheckDepth(Number(e.target.value))} disabled={running}>
              {CHECK_DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d} ({formatCount(perftSuiteNodes(d))} nodes)
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void runCheck()} disabled={runner.busy || unsupported}>
            {checking ? <span className="spinner workshop-btn-spinner" /> : null}
            Check move generation
          </button>
          {checking && (
            <button type="button" className="btn btn-sm" onClick={() => runner.stop()}>
              Stop
            </button>
          )}
        </div>
        {check && (
          <>
            {!check.finished && <ProgressBar value={check.doneNodes} max={check.totalNodes} label="Checking…" />}
            {check.finished && !check.error && (
              <div className={"callout small " + (failures > 0 ? "danger" : check.cancelled ? "warn" : "ok")}>
                {failures > 0
                  ? `${failures} count${failures === 1 ? "" : "s"} wrong — the move generator has a bug (look at the first failing depth).`
                  : check.cancelled
                    ? `Stopped after ${passes} matching count${passes === 1 ? "" : "s"}.`
                    : `All ${passes} counts match (${formatDuration(check.ms)}). Move generation looks correct.`}
              </div>
            )}
            {check.error && <div className="callout danger small">{check.error}</div>}
            <div className="workshop-table-wrap">
              <table className="table workshop-check">
                <thead>
                  <tr>
                    <th>Position</th>
                    {Array.from({ length: check.maxDepth }, (_, i) => (
                      <th key={i} className="num">
                        d{i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERFT_SUITE.map((c) => (
                    <tr key={c.id}>
                      <td title={c.fen}>{c.name}</td>
                      {check.cells[c.id].map((cell, i) => (
                        <td key={i} className={`num workshop-cell workshop-cell--${cell.state}`} title={cellTitle(cell, c.counts[i])}>
                          {cellText(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {failures > 0 && (
              <ul className="workshop-plain-list small">
                {PERFT_SUITE.flatMap((c) =>
                  check.cells[c.id].flatMap((cell, i) =>
                    cell.state === "fail" ? [<li key={`${c.id}-${i}`}>{`${c.name}, depth ${i + 1}: got ${cell.nodes === null ? "no answer (position rejected)" : groupDigits(cell.nodes)}, expected ${groupDigits(cell.expected)}`}</li>] : [],
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function cellText(cell: CellState): string {
  switch (cell.state) {
    case "pass":
      return "✓";
    case "fail":
      return "✗";
    case "running":
      return "…";
    case "skipped":
      return "–";
    default:
      return "·";
  }
}

function cellTitle(cell: CellState, expected: number | undefined): string {
  switch (cell.state) {
    case "pass":
      return `${groupDigits(cell.nodes)} nodes ✓ (${formatDuration(cell.ms)})`;
    case "fail":
      return `got ${cell.nodes === null ? "nothing" : groupDigits(cell.nodes)}, expected ${groupDigits(cell.expected)}`;
    case "skipped":
      return expected === undefined ? "No reference value" : "Skipped";
    default:
      return expected === undefined ? "" : `expected ${groupDigits(expected)}`;
  }
}
