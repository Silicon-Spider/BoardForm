// Evaluate: cb_eval (White's point of view) and the breakdown from cb_eval_trace.
import { useEffect, useRef, useState } from "react";
import type { EngineCapabilities, TraceEntry } from "@/types";
import { formatScore } from "@/utils/format";
import { signedInt } from "../format";
import { engineErrorText, type JobRunner } from "./runner";

interface EvalResult {
  fen: string;
  /** Engine generation that produced it (a rebuilt engine makes it outdated). */
  generation: number;
  score: number | null;
  trace: TraceEntry[] | null;
  rejected: boolean;
}

const FALLBACK_LABEL = /^fallback \(no network\)$/i;

export function EvalTool({
  fen,
  runner,
  caps,
  ready,
  generation,
  sideToMove,
}: {
  fen: string;
  runner: JobRunner;
  caps: EngineCapabilities | null;
  ready: boolean;
  generation: number;
  sideToMove: "w" | "b";
}) {
  const [result, setResult] = useState<EvalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const generationRef = useRef(generation);
  generationRef.current = generation;

  const evaluate = async (position: string) => {
    setError(null);
    try {
      const out = await runnerRef.current.run("eval", "Evaluating…", async (client) => {
        const ok = await client.position(position, []);
        const gen = generationRef.current;
        if (!ok) return { fen: position, generation: gen, score: null, trace: null, rejected: true };
        const c = client.capabilities;
        const score = c.eval ? await client.eval() : null;
        const trace = c.trace ? await client.evalTrace() : null;
        return { fen: position, generation: gen, score, trace, rejected: false };
      });
      if (out) setResult(out);
    } catch (err) {
      setError(engineErrorText(err));
    }
  };

  // Re-evaluate when the position changes or a new engine (e.g. a new build) is running, once the
  // engine is ready and idle.
  const lastAuto = useRef<string | null>(null);
  useEffect(() => {
    if (!auto || !ready || !result) return;
    if (result.fen === fen && result.generation === generation) return;
    const key = `${generation}|${fen}`;
    if (lastAuto.current === key || runnerRef.current.busy) return;
    const t = setTimeout(() => {
      lastAuto.current = key;
      void evaluate(fen);
    }, 120);
    return () => clearTimeout(t);
  }, [fen, auto, ready, result, generation]);

  const unsupported = caps && !caps.eval && !caps.trace;
  const busy = runner.job?.tool === "eval";
  const positionChanged = result !== null && result.fen !== fen;
  const rebuilt = result !== null && result.generation !== generation;
  const stale = positionChanged || rebuilt;
  const terms = (result?.trace ?? []).filter((t) => t.label.toLowerCase() !== "total");
  const totalLine = result?.trace?.find((t) => t.label.toLowerCase() === "total");
  const termSum = terms.reduce((s, t) => s + t.white - t.black, 0);
  const total = result?.score ?? totalLine?.white ?? (terms.length ? termSum : null);
  const fallback = terms.some((t) => FALLBACK_LABEL.test(t.label));

  return (
    <div className="workshop-tool">
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" onClick={() => void evaluate(fen)} disabled={runner.busy || !!unsupported}>
          {busy ? <span className="spinner workshop-btn-spinner" /> : null}
          Evaluate
        </button>
        <label className="checkbox small" title="Evaluate again whenever the position changes">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Re-evaluate when the position changes
        </label>
      </div>
      {unsupported && <div className="callout warn small">This engine exports neither cb_eval nor cb_eval_trace, so it cannot evaluate positions here. Searching still works.</div>}
      {error && <div className="callout danger small">{error}</div>}
      {!result && !error && !unsupported && <p className="small muted">Shows the static evaluation of the board position and how each term contributes.</p>}
      {result?.rejected && <div className="callout danger small">The engine rejected this position (cb_position returned 0).</div>}
      {result && !result.rejected && (
        <div className={"workshop-eval-result" + (stale ? " stale" : "")}>
          <div className="workshop-eval-score">
            <span className="workshop-eval-big num">{result.score !== null ? formatScore(result.score) : total !== null ? formatScore(total) : "—"}</span>
            <span className="small muted">
              White's point of view · {sideToMove === "w" ? "White" : "Black"} to move
              {positionChanged ? " · position changed" : rebuilt ? " · from the previous engine" : ""}
            </span>
          </div>
          {caps && !caps.eval && <p className="small muted">No cb_eval export: the score is the breakdown's total.</p>}
          {fallback && (
            <div className="callout warn small">
              <strong>No network loaded.</strong> The NNUE evaluation is using its fallback (material + piece-square tables). Choose a network for this engine to
              evaluate with it.
            </div>
          )}
          {result.trace === null ? (
            caps && !caps.trace && <p className="small muted">This engine has no cb_eval_trace export, so there is no breakdown.</p>
          ) : terms.length === 0 ? (
            <p className="small muted">The evaluation reported no terms (call traceTerm in evaluate() to see a breakdown).</p>
          ) : (
            <div className="workshop-table-wrap">
              <table className="table workshop-trace">
                <thead>
                  <tr>
                    <th>Term</th>
                    <th className="num">White</th>
                    <th className="num">Black</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {terms.map((t, i) => {
                    const net = t.white - t.black;
                    return (
                      <tr key={`${t.label}-${i}`}>
                        <td className="workshop-trace-label">{t.label}</td>
                        <td className="num">{t.white}</td>
                        <td className="num">{t.black}</td>
                        <td className={"num " + (net > 0 ? "workshop-pos" : net < 0 ? "workshop-neg" : "faint")}>{signedInt(net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <td />
                    <td />
                    <td className="num">
                      <strong>{total !== null ? signedInt(total) : "—"}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {total !== null && terms.length > 0 && termSum !== total && (
            <p className="small faint">
              The terms add up to {signedInt(termSum)} cp; the remaining {signedInt(total - termSum)} cp come from code that is not traced.
            </p>
          )}
          <p className="small faint">Values in centipawns (100 = one pawn); positive is good for that side.</p>
        </div>
      )}
    </div>
  );
}
