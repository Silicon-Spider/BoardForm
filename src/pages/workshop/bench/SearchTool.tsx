// Search: Go / Stop with depth / nodes / movetime limits or an infinite analysis, the stream of
// search info lines (PV in SAN) and the best move (also drawn as an arrow on the board).
import { useEffect, useRef, useState } from "react";
import { ChessGame, uciLineToSan, uciToSan } from "@/chess";
import { LimitsEditor } from "@/components";
import { useSetting } from "@/storage";
import type { EngineLimits, SearchInfo, SearchLimits, SearchResult } from "@/types";
import { formatCount, formatDuration } from "@/utils/format";
import { formatInfoScore, numberedLine, sideOf } from "../format";
import { engineErrorText, runtimeErrorHint, type JobRunner } from "./runner";

const MAX_ROWS = 300;
const DEFAULT_LIMITS: EngineLimits = { movetimeMs: 2000 };

interface InfoRow extends SearchInfo {
  key: number;
  san: string;
}

interface Outcome {
  fen: string;
  result: SearchResult;
  legalMoves: number;
  noMoveReason: string | null;
}

function hasLimit(l: EngineLimits): boolean {
  return !!(l.depth || l.nodes || l.movetimeMs);
}

export function SearchTool({
  fen,
  runner,
  onBestMove,
}: {
  fen: string;
  runner: JobRunner;
  /** Live best move for a position (from the PV while searching, the result afterwards); null clears the arrow. */
  onBestMove(uci: string | null, forFen: string): void;
}) {
  const [limits, setLimits] = useSetting<EngineLimits>("workshop.searchLimits", DEFAULT_LIMITS);
  const [infinite, setInfinite] = useSetting<boolean>("workshop.searchInfinite", false);
  const [rows, setRows] = useState<InfoRow[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchFen, setSearchFen] = useState<string | null>(null);
  const keyRef = useRef(0);
  const searching = runner.job?.tool === "search";
  const restartOn = useRef<string | null>(null);
  const onBestRef = useRef(onBestMove);
  onBestRef.current = onBestMove;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  const go = async (position: string, mode: { infinite: boolean; limits: EngineLimits }) => {
    setError(null);
    setOutcome(null);
    setRows([]);
    setSearchFen(position);
    onBestRef.current(null, position);
    const game = new ChessGame(position);
    const legal = game.legalMoves().length;
    const searchLimits: SearchLimits = mode.infinite ? { infinite: true } : { ...mode.limits };
    try {
      const result = await runnerRef.current.run("search", mode.infinite ? "Analysing…" : "Searching…", async (client) => {
        await client.newGame();
        if (!(await client.position(position, []))) throw new Error("The engine rejected this position (cb_position returned 0).");
        return client.go(searchLimits, (info) => {
          const row: InfoRow = { ...info, key: ++keyRef.current, san: numberedLine(position, uciLineToSan(position, info.pv)) };
          setRows((r) => (r.length >= MAX_ROWS ? [row, ...r.slice(0, MAX_ROWS - 1)] : [row, ...r]));
          if (info.pv[0]) onBestRef.current(info.pv[0], position);
        });
      });
      if (!result) return;
      const outcome = game.outcome();
      setOutcome({
        fen: position,
        result,
        legalMoves: legal,
        noMoveReason: legal === 0 ? (outcome?.termination === "checkmate" ? "checkmate" : "stalemate") : null,
      });
      onBestRef.current(result.bestMove && game.isLegal(result.bestMove) ? result.bestMove : null, position);
    } catch (err) {
      setError(engineErrorText(err));
      onBestRef.current(null, position);
    }
    // An infinite analysis interrupted by a position change continues on the new position.
    const next = restartOn.current;
    restartOn.current = null;
    if (next) void go(next, { infinite: true, limits: mode.limits });
  };

  // The board position changed during a search: stop it (an infinite analysis restarts on the new position).
  useEffect(() => {
    if (!searching || searchFen === null || searchFen === fen) return;
    if (infinite) restartOn.current = fen;
    runnerRef.current.stop();
  }, [fen, searching, searchFen, infinite]);

  const canGo = infinite || hasLimit(limits);
  // Scores are shown from White's point of view, so they depend on who moves in the searched position.
  const sideToMove = sideOf(searchFen ?? fen);
  const stale = outcome !== null && outcome.fen !== fen;
  const r = outcome?.result;
  const best = r?.bestMove ?? null;
  const bestSan = best && outcome ? uciToSan(outcome.fen, best) : null;
  const last = r?.info ?? rows[0] ?? null;

  return (
    <div className="workshop-tool">
      <div className={"workshop-search-limits" + (infinite ? " disabled" : "")}>
        <LimitsEditor
          compact
          allowClock={false}
          value={{ limits, timeControl: null }}
          onChange={(v) => setLimits(v.limits)}
          disabled={infinite || searching}
        />
      </div>
      <label className="checkbox small">
        <input type="checkbox" checked={infinite} disabled={searching} onChange={(e) => setInfinite(e.target.checked)} /> Infinite analysis (until you press Stop)
      </label>
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" disabled={runner.busy || !canGo} onClick={() => void go(fen, { infinite, limits })}>
          {searching ? <span className="spinner workshop-btn-spinner" /> : null}
          Go
        </button>
        <button type="button" className="btn" disabled={!searching} onClick={() => runner.stop()}>
          Stop
        </button>
        {!canGo && <span className="small text-warn">Set a depth, node or time limit — or choose infinite analysis.</span>}
      </div>

      {error && <div className="callout danger small">{error}</div>}
      {searching && (
        <div className="workshop-search-status small">
          <span className="spinner workshop-btn-spinner" aria-hidden="true" />
          {last ? (
            <span className="num">
              depth {last.depth} · {formatInfoScore(last, sideToMove)} · {formatCount(last.nodes)} nodes · {formatDuration(last.timeMs)}
            </span>
          ) : (
            <span>{infinite ? "Analysing…" : "Searching…"}</span>
          )}
        </div>
      )}
      {r && outcome && (
        <div className={"workshop-search-result" + (stale ? " stale" : "")}>
          {stale && <p className="small faint">Result for the previous position.</p>}
          {best ? (
            <div className="workshop-bestmove">
              <span className="small muted">Best move</span>
              <strong className="workshop-bestmove-san">{bestSan ?? best}</strong>
              <span className="mono small faint">{best}</span>
              {r.info && (
                <span className="small muted num">
                  {formatInfoScore(r.info, sideToMove)} · depth {r.info.depth} · {formatCount(r.info.nodes)} nodes · {formatDuration(r.elapsedMs)}
                </span>
              )}
            </div>
          ) : outcome.noMoveReason ? (
            <div className="callout small">No legal moves: this position is {outcome.noMoveReason}.</div>
          ) : r.stopReason !== "error" ? (
            <div className="callout warn small">
              <strong>The engine produced no move</strong> although there {outcome.legalMoves === 1 ? "is 1 legal move" : `are ${outcome.legalMoves} legal moves`}. cb_go
              must write a move to the output buffer and return its length.
            </div>
          ) : null}
          {best && outcome.legalMoves > 0 && bestSan === null && <div className="callout danger small">{best} is not a legal move in this position.</div>}
          {r.stopReason === "error" && (
            <div className="callout danger small">
              The engine crashed during the search: {r.error ?? "unknown error"}. It was restarted. {runtimeErrorHint(r.error ?? "")}
            </div>
          )}
          {r.stopReason === "timeout" && <div className="callout warn small">The search ran past its time limit and the host had to stop it.</div>}
          {r.stopReason === "stopped" && <p className="small muted">Stopped — showing the best move found so far.</p>}
        </div>
      )}
      {rows.length > 0 && (
        <div className="workshop-table-wrap workshop-info-wrap">
          <table className="table workshop-info">
            <thead>
              <tr>
                <th className="num">Depth</th>
                <th className="num">Score</th>
                <th className="num">Nodes</th>
                <th className="num">NPS</th>
                <th className="num">Time</th>
                <th>Principal variation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="num">
                    {row.depth}
                    <span className="faint">/{row.seldepth}</span>
                  </td>
                  <td className="num">{formatInfoScore(row, sideToMove)}</td>
                  <td className="num">{formatCount(row.nodes)}</td>
                  <td className="num">{formatCount(row.nps)}</td>
                  <td className="num">{formatDuration(row.timeMs)}</td>
                  <td className="workshop-pv">{row.san || row.pv.join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!searching && !r && !error && rows.length === 0 && <p className="small muted">Scores are shown from White's point of view.</p>}
    </div>
  );
}
