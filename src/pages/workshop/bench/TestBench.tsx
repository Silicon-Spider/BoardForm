// The test bench (side-panel "Test" tab, the same for every engine kind): a position to test on
// and the tools Evaluate, Search, Perft, Bench and the engine console. The engine starts on the
// first test action (building first if needed) and is shared by all tools.
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBoardProps } from "@/app/preferences";
import { toast } from "@/app/toast";
import { ChessGame, START_FEN, mirrorFen, normalizeFen, validateFen, type MoveInput } from "@/chess";
import { BoardEditor, Chessboard, Icon, Modal, Tabs, type ChessboardArrow } from "@/components";
import { fenShapeProblem, sideOf } from "../format";
import { PRESET_POSITIONS } from "../positions";
import type { EngineSession } from "../session";
import { MenuButton } from "../ui";
import { BenchTool } from "./BenchTool";
import { ConsoleTool, useConsoleLines } from "./ConsoleTool";
import { EvalTool } from "./EvalTool";
import { PerftTool } from "./PerftTool";
import { SearchTool } from "./SearchTool";
import { useJobRunner, type ToolId } from "./runner";

export interface TestBenchProps {
  session: EngineSession;
  /** Engines built on the stock template search far more selectively (bench defaults). */
  family: "template" | "custom";
  /** Whether the Test tab is on screen (keeps the console scrolled, etc.). */
  visible: boolean;
  onShowBuildLog(): void;
}

function capsSummary(c: NonNullable<ReturnType<EngineSession["getState"]>["caps"]>): string {
  const on = (b: boolean, label: string) => (b ? label : null);
  return [on(c.eval, "eval"), on(c.trace, "breakdown"), on(c.perft, "perft"), on(c.nnue, "NNUE"), on(c.setOption, "options")].filter(Boolean).join(" · ") || "search only";
}

function EngineStatus({ session, onShowBuildLog }: { session: EngineSession; onShowBuildLog(): void }) {
  const s = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  if (s.phase === "starting") {
    return (
      <div className="workshop-engine-status starting" role="status">
        <span className="spinner workshop-btn-spinner" aria-hidden="true" />
        <span className="grow truncate">{s.statusText ?? "Starting the engine…"}</span>
      </div>
    );
  }
  if (s.phase === "ready" && s.caps) {
    return (
      <div className="workshop-engine-status ready" role="status">
        <span className="workshop-status-dot ok" aria-hidden="true" />
        <span className="grow truncate" title={`ABI v${s.caps.abiVersion}${s.caps.stopFlag ? " · instant stop" : " · stop restarts the engine"}`}>
          <strong>{s.caps.name ?? "Engine"}</strong> <span className="muted">running · {capsSummary(s.caps)}</span>
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => session.restart("restarted by you")} title="Start a fresh engine instance">
          <Icon name="reset" size={14} /> Restart
        </button>
      </div>
    );
  }
  if (s.phase === "error") {
    return (
      <div className="workshop-engine-status error" role="alert">
        <span className="workshop-status-dot danger" aria-hidden="true" />
        <span className="grow workshop-engine-error">
          <strong>{s.buildFailed ? "The engine does not compile." : "The engine could not start."}</strong> <span className="muted">{s.error}</span>
        </span>
        {s.buildFailed && (
          <button type="button" className="btn btn-sm" onClick={onShowBuildLog}>
            Show errors
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void session.getClient().catch(() => {})}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="workshop-engine-status idle">
      <span className="workshop-status-dot" aria-hidden="true" />
      <span className="grow muted">The engine starts with your first test.</span>
      <button type="button" className="btn btn-sm" onClick={() => void session.getClient().catch(() => {})}>
        Start engine
      </button>
    </div>
  );
}

/** FEN field: shows the board's FEN; typed FENs apply on Enter / Apply after validation. */
function FenField({ fen, onApply }: { fen: string; onApply(fen: string): void }) {
  const [text, setText] = useState(fen);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setText(fen);
      setError(null);
    }
  }, [fen]);
  const apply = () => {
    const problem = fenShapeProblem(text);
    const check = problem ? { ok: false, error: problem } : validateFen(text);
    if (!check.ok) {
      setError(check.error ?? "Invalid FEN");
      return;
    }
    editing.current = false;
    setError(null);
    onApply(normalizeFen(text));
  };
  const dirty = text.trim() !== fen;
  return (
    <div className="field workshop-fen">
      <div className="workshop-fen-row">
        <input
          className={"input input-sm mono grow" + (error ? " workshop-input-error" : "")}
          value={text}
          aria-label="Position (FEN)"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          onFocus={() => (editing.current = true)}
          onBlur={() => {
            editing.current = false;
            if (!dirty) setError(null);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") {
              setText(fen);
              setError(null);
            }
          }}
        />
        {dirty && (
          <button type="button" className="btn btn-sm" onClick={apply}>
            Apply
          </button>
        )}
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export const TestBench = memo(function TestBench({ session, family, visible, onShowBuildLog }: TestBenchProps) {
  const boardProps = useBoardProps();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const runner = useJobRunner(session);
  const [fen, setFen] = useState(START_FEN);
  const [lastMove, setLastMove] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [best, setBest] = useState<{ fen: string; uci: string } | null>(null);
  const [tool, setTool] = useState<ToolId>("eval");
  const [setup, setSetup] = useState<string | null>(null);
  const lines = useConsoleLines(session);
  const seenLines = useRef(0);
  if (tool === "console") seenLines.current = lines.length;
  const unseen = Math.max(0, lines.length - seenLines.current);

  const setPosition = (next: string, move: string | null = null) => {
    setFen(next);
    setLastMove(move);
  };

  const onMove = (m: MoveInput) => {
    let game: ChessGame;
    try {
      game = new ChessGame(fen);
    } catch {
      return;
    }
    const played = game.play(m);
    if (played) setPosition(game.fen(), played.uci);
  };

  const arrows = useMemo((): ChessboardArrow[] => {
    if (!best || best.fen !== fen || best.uci.length < 4) return [];
    return [{ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), color: "#2f9e5a" }];
  }, [best, fen]);

  const ready = state.phase === "ready";
  const caps = state.caps;
  const side = sideOf(fen);

  const tools = [
    { id: "eval", label: "Evaluate" },
    { id: "search", label: "Search" },
    { id: "perft", label: "Perft" },
    { id: "bench", label: "Bench" },
    { id: "console", label: "Console", badge: unseen > 0 ? (unseen > 99 ? "99+" : String(unseen)) : undefined },
  ];

  return (
    <div className="workshop-bench">
      <EngineStatus session={session} onShowBuildLog={onShowBuildLog} />

      <div className="workshop-position">
        <div className="workshop-board-wrap">
          <Chessboard
            {...boardProps}
            fen={fen}
            orientation={orientation}
            onMove={onMove}
            lastMove={lastMove}
            arrows={arrows}
            aria-label="Test position"
          />
        </div>
        <div className="workshop-position-side">
          <span className="workshop-turn small">
            <span className={"workshop-turn-dot " + (side === "w" ? "white" : "black")} aria-hidden="true" />
            {side === "w" ? "White" : "Black"} to move
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setPosition(START_FEN)} title="Back to the initial position">
            <Icon name="first" size={14} /> Start
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))} title="Flip the board">
            <Icon name="flip" size={14} /> Flip
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSetup(fen)} title="Edit the position piece by piece">
            <Icon name="hand" size={14} /> Set up…
          </button>
          <MenuButton
            label={
              <>
                Presets <Icon name="chevronDown" size={14} />
              </>
            }
            align="left"
            items={[
              ...PRESET_POSITIONS.map((p) => ({ id: p.id, label: p.name, hint: p.hint, onSelect: () => setPosition(p.fen) })),
              "separator" as const,
              // Checks symmetry in one click: the breakdown of the mirrored position should be the
              // same with White and Black swapped (blocks evaluations are symmetric by construction).
              { id: "mirror", label: "Swap colours", hint: "This position with White and Black swapped: a symmetric evaluation gives the opposite score", onSelect: () => setPosition(mirrorFen(fen)) },
            ]}
          />
          <button
            type="button"
            className="btn btn-sm"
            title="Copy the FEN to the clipboard"
            onClick={() =>
              void navigator.clipboard.writeText(fen).then(
                () => toast("FEN copied", { kind: "success" }),
                () => toast("Could not copy to the clipboard", { kind: "error" }),
              )
            }
          >
            <Icon name="copy" size={14} /> Copy FEN
          </button>
          {runner.job && (
            <span className="workshop-job small" role="status">
              <span className="spinner workshop-btn-spinner" aria-hidden="true" />
              <span className="truncate">{runner.job.label}</span>
            </span>
          )}
        </div>
        <FenField fen={fen} onApply={(f) => setPosition(f)} />
      </div>

      <Tabs tabs={tools} active={tool} onChange={(id) => setTool(id as ToolId)} size="sm" aria-label="Test tools" className="workshop-tool-tabs" />
      <div className="workshop-tool-body">
        <div hidden={tool !== "eval"}>
          <EvalTool fen={fen} runner={runner} caps={caps} ready={ready} generation={state.generation} sideToMove={side} />
        </div>
        <div hidden={tool !== "search"}>
          <SearchTool fen={fen} runner={runner} onBestMove={(uci, forFen) => setBest(uci ? { fen: forFen, uci } : null)} />
        </div>
        <div hidden={tool !== "perft"}>
          <PerftTool fen={fen} runner={runner} caps={caps} />
        </div>
        <div hidden={tool !== "bench"}>
          <BenchTool runner={runner} family={family} />
        </div>
        <div hidden={tool !== "console"}>
          <ConsoleTool session={session} visible={visible && tool === "console"} />
        </div>
      </div>

      <Modal
        open={setup !== null}
        title="Set up a position"
        width={720}
        onClose={() => setSetup(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSetup(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (setup) setPosition(setup);
                setSetup(null);
              }}
            >
              Use this position
            </button>
          </>
        }
      >
        {setup !== null && <BoardEditor fen={setup} onChange={setSetup} orientation={orientation} />}
      </Modal>
    </div>
  );
});
