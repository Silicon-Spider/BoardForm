// Evaluations of the standard sample positions by one or two networks (networks.evaluate).
import { useEffect, useState } from "react";
import { MiniBoard } from "@/components";
import { networks } from "@/training";
import { formatCp, errorMessage } from "../model/format";
import { SAMPLE_FENS, SAMPLE_POSITIONS, evalAgrees } from "../model/samples";

export type EvalState = { status: "idle" } | { status: "loading" } | { status: "ready"; values: Array<number | null> } | { status: "error"; error: string };

/** Evaluates the sample positions with a network; re-runs when the id (or `refreshKey`) changes. */
export function useSampleEvals(networkId: string | null | undefined, refreshKey = ""): EvalState {
  const [state, setState] = useState<EvalState>({ status: "idle" });
  useEffect(() => {
    if (!networkId) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    networks
      .evaluate(networkId, [...SAMPLE_FENS])
      .then((values) => {
        if (!cancelled) setState({ status: "ready", values });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [networkId, refreshKey]);
  return state;
}

function valueAt(s: EvalState, i: number): number | null | undefined {
  return s.status === "ready" ? (s.values[i] ?? null) : undefined;
}

function EvalCell({ state, index, expect }: { state: EvalState; index: number; expect: (typeof SAMPLE_POSITIONS)[number]["expect"] }) {
  if (state.status === "loading") return <span className="lab-skeleton" aria-label="Evaluating" />;
  if (state.status !== "ready") return <span className="faint">—</span>;
  const v = valueAt(state, index) ?? null;
  const agrees = evalAgrees(expect, v);
  return (
    <span className="lab-eval">
      <span className="num">{formatCp(v)}</span>
      {agrees !== null && (
        <span className={agrees ? "lab-eval-ok" : "lab-eval-off"} title={agrees ? "Points the expected way" : "Unexpected for this position"}>
          {agrees ? "✓" : "✗"}
        </span>
      )}
    </span>
  );
}

/** Table: position | newest | previous (optional). Scores are White's point of view. */
export function SampleEvalTable({
  current,
  previous,
  currentLabel = "Newest",
  previousLabel = "Previous",
}: {
  current: EvalState;
  previous?: EvalState | null;
  currentLabel?: string;
  previousLabel?: string;
}) {
  const error = current.status === "error" ? current.error : previous && previous.status === "error" ? previous.error : null;
  return (
    <div className="stack-sm">
      {error && <div className="callout warn small">Could not evaluate: {error}</div>}
      <div className="lab-table-wrap">
        <table className="table lab-evals">
          <thead>
            <tr>
              <th>Position</th>
              <th className="num">{currentLabel}</th>
              {previous && <th className="num">{previousLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {SAMPLE_POSITIONS.map((p, i) => (
              <tr key={p.id}>
                <td>
                  <span className="lab-eval-pos">
                    <MiniBoard fen={p.fen} size={40} title={p.name} />
                    <span className="lab-eval-name">{p.name}</span>
                  </span>
                </td>
                <td className="num">
                  <EvalCell state={current} index={i} expect={p.expect} />
                </td>
                {previous && (
                  <td className="num">
                    <EvalCell state={previous} index={i} expect={p.expect} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small faint">Pawns from White's point of view. ✓ marks scores that point the expected way.</div>
    </div>
  );
}

/** Grid of the sample positions with one network's evaluation (network page). */
export function SampleEvalGrid({ state }: { state: EvalState }) {
  return (
    <div className="stack-sm">
      {state.status === "error" && <div className="callout warn small">Could not evaluate: {state.error}</div>}
      <div className="lab-sample-grid lab-sample-grid--six">
        {SAMPLE_POSITIONS.map((p, i) => (
          <figure key={p.id} className="lab-sample">
            <MiniBoard fen={p.fen} title={p.name} />
            <figcaption>
              <span className="lab-sample-name">{p.name}</span>
              <EvalCell state={state} index={i} expect={p.expect} />
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="small faint">Pawns from White's point of view. ✓ marks scores that point the expected way.</div>
    </div>
  );
}
