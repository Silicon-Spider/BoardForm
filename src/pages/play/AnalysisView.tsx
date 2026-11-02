// Analysis mode: a free board (both colours move; a move at an earlier ply replaces the rest of
// the line), an engine analysing the position without a time limit, and the review of a saved
// game (players, result, evaluation graph).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChessGame, START_FEN, validateFen, type MoveInput } from "@/chess";
import { formatDiagnostic } from "@/compiler";
import { EnginePicker, Icon, Modal, MoveList, Spinner, Tooltip, formatTimeControl, startPlyFromFen, type ConfirmFn } from "@/components";
import { useBoardPreferences } from "@/app/preferences";
import { Link } from "@/app/router";
import { gamesRepo, subscribe, useEngines } from "@/storage";
import type { EngineRecord, GameRecord } from "@/types";
import { formatDateTime } from "@/utils/format";
import type { AnalysisState, AnalysisStatus } from "./analysis-session";
import { positionKey } from "./analysis-session";
import { BoardArea, PlayerBar } from "./BoardArea";
import { EngineCard, type EngineCardStatus } from "./EngineCard";
import { EvalGraph } from "./EvalGraph";
import { gameTitle, infoWhiteScore } from "./format";
import { copyText } from "./hooks";
import { PlayIcon } from "./icons";
import { MATE_CP, materialBalance, resultLabel, terminationLabel } from "./rules";
import { downloadGamePgn } from "./SavedGames";
import { defaultEngineId } from "./setup";
import { PositionEditorModal } from "./StartPositionField";
import type { Score, Side } from "./types";

// --- the analysed line -----------------------------------------------------------------------

export interface AnalysisLine {
  /** Full FEN of the start position. */
  startFen: string;
  moves: string[];
  /** Plies shown on the board (0 = start). */
  ply: number;
  /** The saved game being reviewed (its moves are the line until the user changes it). */
  gameId: string | null;
  /** Player names of an imported PGN. */
  names: { w: string; b: string } | null;
  orientation: "white" | "black";
}

export const ANALYSIS_KEY = "play.analysis";
export const EMPTY_LINE: AnalysisLine = { startFen: START_FEN, moves: [], ply: 0, gameId: null, names: null, orientation: "white" };

export function parseLine(raw: unknown): AnalysisLine {
  if (typeof raw !== "object" || raw === null) return EMPTY_LINE;
  const r = raw as Record<string, unknown>;
  if (typeof r.startFen !== "string" || !Array.isArray(r.moves) || !r.moves.every((m) => typeof m === "string")) return EMPTY_LINE;
  const game = ChessGame.fromMoves(r.startFen, r.moves as string[]);
  if (!game) return EMPTY_LINE;
  const ply = typeof r.ply === "number" && Number.isFinite(r.ply) ? Math.max(0, Math.min(game.ply(), Math.round(r.ply))) : game.ply();
  const names = typeof r.names === "object" && r.names !== null && typeof (r.names as { w?: unknown }).w === "string" && typeof (r.names as { b?: unknown }).b === "string" ? (r.names as { w: string; b: string }) : null;
  return {
    startFen: game.startFen,
    moves: game.history().uci,
    ply,
    gameId: typeof r.gameId === "string" ? r.gameId : null,
    names,
    orientation: r.orientation === "black" ? "black" : "white",
  };
}

/** A line for a saved game (normalised start FEN, orientation from the human's side). */
export function lineForGame(g: GameRecord, ply?: number): AnalysisLine {
  let startFen = START_FEN;
  try {
    startFen = new ChessGame(g.startFen).startFen;
  } catch {
    /* keep the standard start */
  }
  const orientation = g.black.type === "human" && g.white.type !== "human" ? "black" : "white";
  return { startFen, moves: [...g.moves], ply: ply ?? g.moves.length, gameId: g.id, names: null, orientation };
}

const sameMoves = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((m, i) => m === b[i]);

/** The saved game with this id (undefined while loading, null when it does not exist). */
function useSavedGame(id: string | null): GameRecord | null | undefined {
  const [state, setState] = useState<{ id: string | null; game: GameRecord | null | undefined }>({ id, game: id ? undefined : null });
  useEffect(() => {
    if (!id) {
      setState({ id, game: null });
      return;
    }
    let cancelled = false;
    const load = () =>
      gamesRepo
        .get(id)
        .then((g) => !cancelled && setState({ id, game: g ?? null }))
        .catch(() => !cancelled && setState({ id, game: null }));
    setState({ id, game: undefined });
    void load();
    const off = subscribe("games", (e) => {
      if (e.id === id || e.id === "*") void load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [id]);
  return state.id === id ? state.game : undefined;
}

const CARD_STATUS: Record<AnalysisStatus, EngineCardStatus> = {
  off: "off",
  loading: "loading",
  analysing: "analysing",
  stopped: "stopped",
  finished: "finished",
  error: "error",
};

// --- dialogs ---------------------------------------------------------------------------------

function FenModal({ open, onClose, onLoad }: { open: boolean; onClose(): void; onLoad(fen: string): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);
  const load = () => {
    const v = validateFen(text);
    if (!v.ok) {
      setError(v.error ?? "Invalid FEN");
      return;
    }
    onLoad(new ChessGame(text).startFen);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Load a position (FEN)"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={load}>
            Load position
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="play-fen-load">FEN</label>
        <textarea
          id="play-fen-load"
          className={"textarea mono" + (error ? " play-input-error" : "")}
          rows={2}
          spellCheck={false}
          value={text}
          placeholder="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              load();
            }
          }}
        />
        {error ? <span className="field-error">{error}</span> : <span className="field-hint">The six fields of a FEN; missing trailing fields are filled in.</span>}
      </div>
    </Modal>
  );
}

// --- view ------------------------------------------------------------------------------------

export interface AnalysisViewProps {
  line: AnalysisLine;
  setLine(next: AnalysisLine | ((prev: AnalysisLine) => AnalysisLine)): void;
  analysis: AnalysisState | null;
  engineId: string | null;
  onEngine(id: string | null): void;
  running: boolean;
  onRunning(on: boolean): void;
  pov: "white" | "stm";
  onPov(pov: "white" | "stm"): void;
  showEval: boolean;
  onShowEval(on: boolean): void;
  onImport(): void;
  onPlayFrom(fen: string): void;
  /** Rendered with the layout: (board column, side-panel content for the analysis tab). */
  layout(board: ReactNode, panel: ReactNode): ReactNode;
  confirm: ConfirmFn;
}

export function AnalysisView(props: AnalysisViewProps) {
  const { line, setLine, analysis, engineId, onEngine, running, onRunning, pov, onPov, showEval, onShowEval, onImport, onPlayFrom, layout, confirm } = props;
  const engines = useEngines();
  const [prefs] = useBoardPreferences();
  const review = useSavedGame(line.gameId);
  const [fenOpen, setFenOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const lineGame = useMemo(() => ChessGame.fromMoves(line.startFen, line.moves) ?? new ChessGame(START_FEN), [line.startFen, line.moves]);
  const san = useMemo(() => lineGame.history().san, [lineGame]);
  const ply = Math.min(line.ply, line.moves.length);
  const fen = lineGame.fenAt(ply);
  const key = positionKey(line.startFen, line.moves.slice(0, ply));
  const turn: Side = fen.split(" ")[1] === "b" ? "b" : "w";
  const startPly = startPlyFromFen(line.startFen);
  const inSync = !!review && review.startFen !== undefined && sameMoves(review.moves, line.moves);
  const info = analysis && analysis.infoKey === key ? analysis.info : null;

  // A deleted review game: keep the moves, drop the link to the record.
  useEffect(() => {
    if (line.gameId && review === null) setLine((l) => ({ ...l, gameId: null }));
  }, [review, line.gameId, setLine]);

  const setPly = useCallback((p: number) => setLine((l) => ({ ...l, ply: Math.max(0, Math.min(l.moves.length, p)) })), [setLine]);

  const play = (m: MoveInput) => {
    const g = ChessGame.fromMoves(line.startFen, line.moves.slice(0, ply));
    const played = g?.play(m);
    if (!played) return;
    setLine((l) => {
      const p = Math.min(l.ply, l.moves.length);
      if (l.moves[p] === played.uci) return { ...l, ply: p + 1 };
      return { ...l, moves: [...l.moves.slice(0, p), played.uci], ply: p + 1 };
    });
  };

  const playPv = (index: number) => {
    if (!info) return;
    const g = ChessGame.fromMoves(line.startFen, line.moves.slice(0, ply));
    if (!g) return;
    for (const m of info.pv.slice(0, index + 1)) if (!g.play(m)) break;
    const next = g.history().uci;
    setLine((l) => ({ ...l, moves: next.every((m, i) => l.moves[i] === m) ? l.moves : next, ply: next.length }));
  };

  const startAnalysis = () => {
    if (!engineId && engines) {
      const played = review ? [review.white, review.black].find((p) => p.type === "engine" && engines.some((e) => e.id === p.engineId)) : undefined;
      const id = played && played.type === "engine" ? played.engineId : defaultEngineId(engines);
      if (!id) return;
      onEngine(id);
    }
    onRunning(true);
  };

  const reset = async (next: AnalysisLine) => {
    if (line.moves.length > 0 && !line.gameId) {
      const ok = await confirm({ title: "Replace the analysis board?", message: "The moves on the board are not saved anywhere else.", confirmLabel: "Replace", danger: true });
      if (!ok) return;
    }
    setLine(next);
  };

  const pgnOfLine = () => {
    const names = review ? { w: review.white.name, b: review.black.name } : line.names;
    return lineGame.pgn({ Event: "Analysis", White: names?.w ?? "?", Black: names?.b ?? "?" }, inSync && review ? review.result : "*");
  };

  // --- eval bar & arrows
  let evalScore: Score | null = info ? infoWhiteScore(info, analysis?.infoFen ?? null) : null;
  if (!evalScore && inSync && review?.evals && ply > 0) {
    for (let i = ply - 1; i >= 0; i--) {
      const v = review.evals[i];
      if (v === null || v === undefined) continue;
      if (Math.abs(v) >= MATE_CP) {
        // Records store mates as ±10000. In a game that ended in that mate, the distance is the
        // moves left until the end; otherwise only the sign is known.
        const winner = review.result === "1-0" ? 1 : review.result === "0-1" ? -1 : 0;
        const sign = v > 0 ? 1 : -1;
        evalScore =
          review.termination === "checkmate" && winner === sign
            ? { cp: null, mate: sign * Math.max(1, Math.ceil((review.moves.length - ply) / 2)) }
            : { cp: v, mate: null };
      } else evalScore = { cp: v, mate: null };
      break;
    }
  }
  const best = info?.pv[0];
  const arrows = prefs.showEngineArrows && best && best.length >= 4 ? [{ from: best.slice(0, 2), to: best.slice(2, 4) }] : undefined;

  // --- players
  const engineOf = (id: string): EngineRecord | undefined => engines?.find((e) => e.id === id);
  const playerFor = (side: Side) => {
    if (review) {
      const ref = side === "w" ? review.white : review.black;
      const winner = review.result === "1-0" ? "w" : review.result === "0-1" ? "b" : null;
      return {
        name: ref.name,
        kind: ref.type === "engine" ? (engineOf(ref.engineId)?.kind ?? null) : null,
        result: (review.result === "*" ? null : winner === null ? "draw" : winner === side ? "win" : "loss") as "win" | "loss" | "draw" | null,
      };
    }
    return { name: line.names?.[side] ?? (side === "w" ? "White" : "Black"), kind: null, result: null };
  };
  const material = materialBalance(fen);
  const bottomSide: Side = line.orientation === "white" ? "w" : "b";
  const topSide: Side = bottomSide === "w" ? "b" : "w";
  const bar = (side: Side) => {
    const p = playerFor(side);
    return <PlayerBar side={side} name={p.name} engineKind={p.kind} material={material[side]} status={turn === side ? "To move" : undefined} active={turn === side} result={inSync && ply === line.moves.length ? p.result : null} />;
  };

  const browsing = ply < line.moves.length;
  const board = (
    <BoardArea
      top={bar(topSide)}
      bottom={bar(bottomSide)}
      fen={fen}
      orientation={line.orientation}
      interactive="both"
      onMove={play}
      lastMove={ply > 0 ? line.moves[ply - 1] : null}
      arrows={arrows}
      evalScore={evalScore}
      showEval={showEval}
      aria-label="Analysis board"
      tools={
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLine((l) => ({ ...l, orientation: l.orientation === "white" ? "black" : "white" }))} title="Flip the board (F)">
            <Icon name="flip" /> Flip
          </button>
          <button type="button" className={"btn btn-ghost btn-sm" + (showEval ? " play-tool-on" : "")} aria-pressed={showEval} onClick={() => onShowEval(!showEval)} title="Show or hide the evaluation bar">
            <PlayIcon name="eye" /> Eval bar
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(fen, "FEN")}>
            <Icon name="copy" /> FEN
          </button>
        </>
      }
    />
  );

  // --- side panel
  const errors = (analysis?.diagnostics ?? []).filter((d) => d.severity === "error");
  const engineRecord = engineId ? engineOf(engineId) : undefined;
  const panel = (
    <div className="play-analysis">
      {line.gameId && review === undefined && (
        <div className="card">
          <Spinner label="Loading the game…" />
        </div>
      )}
      {review && (
        <section className="play-review card" aria-label="Game review">
          <div className="play-review-head">
            <div className="grow">
              <div className="play-review-title truncate" title={gameTitle(review)}>
                {gameTitle(review)}
              </div>
              <div className="small muted">
                <span className="badge" title={resultLabel(review.result)}>
                  {review.result === "1/2-1/2" ? "½–½" : review.result}
                </span>{" "}
                {terminationLabel(review.termination)} · {formatDateTime(review.createdAt)}
                {review.timeControl?.white ? ` · ${formatTimeControl(review.timeControl.white)}` : ""}
                {review.opening ? ` · ${review.opening}` : ""}
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close the review" title="Close the review (keeps the moves)" onClick={() => setLine((l) => ({ ...l, gameId: null, names: { w: review.white.name, b: review.black.name } }))}>
              <Icon name="close" />
            </button>
          </div>
          {!inSync && (
            <div className="play-review-diverged small">
              You are exploring your own moves.{" "}
              <button type="button" className="play-linkbtn" onClick={() => setLine((l) => ({ ...l, moves: [...review.moves], ply: Math.min(l.ply, review.moves.length) }))}>
                Back to the game moves
              </button>
            </div>
          )}
          <EvalGraph
            evals={review.evals ?? []}
            startPly={startPlyFromFen(lineForGame(review).startFen)}
            currentPly={inSync ? ply : null}
            onSelectPly={(p) => setLine((l) => (inSync ? { ...l, ply: p } : { ...l, moves: [...review.moves], ply: p }))}
          />
          <div className="row-wrap">
            {!running && (
              <button type="button" className="btn btn-sm btn-primary" onClick={startAnalysis}>
                <Icon name="play" /> Analyse from here
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => downloadGamePgn(review)}>
              <PlayIcon name="download" /> PGN
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => copyText(review.pgn, "PGN")}>
              <Icon name="copy" /> Copy PGN
            </button>
          </div>
        </section>
      )}

      <section className="play-analysis-engine" aria-label="Engine analysis">
        <div className="play-analysis-picker">
          <EnginePicker value={engineId} onChange={(id) => onEngine(id)} size="sm" placeholder="Choose an engine to analyse with…" aria-label="Analysis engine" />
          {running ? (
            <button type="button" className="btn btn-sm" onClick={() => onRunning(false)}>
              <PlayIcon name="stop" /> Stop
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={startAnalysis} disabled={!engines || engines.length === 0}>
              <Icon name="play" /> Analyse
            </button>
          )}
        </div>
        {engineId && analysis && analysis.engineId === engineId && (analysis.status !== "off" || analysis.info || analysis.logs.length > 0) ? (
          <EngineCard
            name={analysis.engineName ?? engineRecord?.name ?? "Engine"}
            color={engineRecord?.color}
            kind={engineRecord?.kind}
            status={CARD_STATUS[analysis.status]}
            statusText={analysis.statusText}
            info={info}
            infoFen={analysis.infoKey === key ? analysis.infoFen : null}
            logs={analysis.logs}
            pov={pov}
            onPvMove={playPv}
            actions={
              <div className="btn-group play-pov" role="radiogroup" aria-label="Score point of view">
                <button type="button" role="radio" aria-checked={pov === "white"} className={"btn btn-sm" + (pov === "white" ? " active" : "")} onClick={() => onPov("white")} title="Scores from White's point of view">
                  White
                </button>
                <button type="button" role="radio" aria-checked={pov === "stm"} className={"btn btn-sm" + (pov === "stm" ? " active" : "")} onClick={() => onPov("stm")} title="Scores from the side to move's point of view">
                  To move
                </button>
              </div>
            }
          >
            {analysis.status === "finished" && analysis.statusText && <p className="small muted play-analysis-note">{analysis.statusText}</p>}
            {analysis.status === "error" && (
              <div className="callout danger small play-analysis-error" role="alert">
                {errors.length ? (
                  <>
                    <strong>{analysis.engineName ?? engineRecord?.name ?? "The engine"} does not compile.</strong>
                    <ul className="play-diagnostics">
                      {errors.slice(0, 4).map((d, i) => (
                        <li key={i} className="mono">
                          {formatDiagnostic(d)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <span>{analysis.error}</span>
                )}
                {engineId && (
                  <div>
                    <Link to={`/engines/${engineId}`}>Open it in the Workshop</Link>
                  </div>
                )}
              </div>
            )}
          </EngineCard>
        ) : (
          <p className="field-hint play-analysis-hint">
            The engine searches the position on the board without a time limit and starts again whenever the position changes. Click a move of its line to play it.
          </p>
        )}
      </section>

      <section className="play-moves">
        <div className="play-moves-head">
          <h3 className="section-title">Moves</h3>
          <span className="spacer" />
          {browsing && (
            <Tooltip content="You are looking at an earlier position of the line. Playing a different move here removes the moves after it; step with ← / → or click a move to look around.">
              <span className="play-moves-hint" tabIndex={0}>
                <Icon name="info" size={13} /> A move here replaces {line.moves.length - ply === 1 ? "the last move" : `the ${line.moves.length - ply} moves after it`}
              </span>
            </Tooltip>
          )}
        </div>
        <MoveList
          san={san}
          currentPly={ply}
          onSelectPly={setPly}
          startPly={startPly}
          result={inSync && review && review.result !== "*" ? review.result : null}
          controls
          emptyText="Make a move on the board, or load a game or position."
          className="play-movelist"
        />
      </section>

      <section className="play-analysis-tools" aria-label="Position">
        <h3 className="section-title">Position</h3>
        <div className="play-tools-grid">
          <button type="button" className="btn btn-sm" onClick={() => reset({ ...EMPTY_LINE, orientation: line.orientation })}>
            <Icon name="reset" /> New board
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setEditorOpen(true)}>
            <PlayIcon name="board" /> Set up…
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setFenOpen(true)}>
            <PlayIcon name="edit" /> Load FEN…
          </button>
          <button type="button" className="btn btn-sm" onClick={onImport}>
            <PlayIcon name="upload" /> Import PGN…
          </button>
          <button type="button" className="btn btn-sm" onClick={() => copyText(pgnOfLine(), "PGN")} disabled={line.moves.length === 0}>
            <Icon name="copy" /> Copy PGN
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onPlayFrom(fen)} disabled={!!lineGame && ChessGame.fromMoves(line.startFen, line.moves.slice(0, ply))?.isGameOver()} title="Start a game from this position">
            <PlayIcon name="flag" /> Play from here
          </button>
        </div>
      </section>

      <FenModal
        open={fenOpen}
        onClose={() => setFenOpen(false)}
        onLoad={(f) => {
          setFenOpen(false);
          void reset({ ...EMPTY_LINE, startFen: f, orientation: line.orientation });
        }}
      />
      <PositionEditorModal
        open={editorOpen}
        fen={fen}
        title="Set up a position to analyse"
        confirmLabel="Analyse this position"
        onClose={() => setEditorOpen(false)}
        onUse={(f) => {
          setEditorOpen(false);
          void reset({ ...EMPTY_LINE, startFen: new ChessGame(f).startFen, orientation: line.orientation });
        }}
      />
    </div>
  );

  return <>{layout(board, panel)}</>;
}
