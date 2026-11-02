// Developer playground: every shared component with sample data (route #/dev, or #/dev/<section>
// to show one section). Used for visual checks and e2e tests.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageProps } from "@/app/router";
import { Link } from "@/app/router";
import { ChessGame, OPENINGS, START_FEN, parseFenBoard, type MoveInput } from "@/chess";
import {
  BoardEditor,
  CHART_COLORS,
  Chessboard,
  Clock,
  ConfirmDialog,
  EmptyState,
  EnginePicker,
  EvalBar,
  Icon,
  KindBadge,
  LimitsEditor,
  LineChart,
  MiniBoard,
  Modal,
  MoveList,
  ProgressBar,
  Spinner,
  Tabs,
  Toolbar,
  Tooltip,
  describeLimits,
  useConfirm,
  type ChartSeries,
  type LimitsValue,
} from "@/components";
import type { EngineKind, EngineRecord } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { CodeComponentsDemo } from "@/components/code/demo";
import "./dev.css";

const SECTIONS = [
  { id: "board", label: "Chessboard" },
  { id: "editor", label: "Board editor" },
  { id: "boards", label: "Mini boards" },
  { id: "game", label: "Clock · eval · moves" },
  { id: "charts", label: "Charts" },
  { id: "limits", label: "Limits & engines" },
  { id: "basics", label: "Basics" },
  { id: "code", label: "Code editor" },
] as const;

function Section({ id, title, description, children, only }: { id: string; title: string; description?: ReactNode; children: ReactNode; only?: string }) {
  if (only && only !== id) return null;
  return (
    <section className="dev-section" id={`dev-${id}`} data-testid={`dev-section-${id}`}>
      <header className="dev-section-head">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function Demo({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={"dev-demo card" + (className ? " " + className : "")}>
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

const PIECE_VALUES: Record<string, number> = { P: 100, N: 300, B: 320, R: 500, Q: 900, K: 0 };

/** Material balance (White POV) — a stand-in "evaluation" for the demo eval bar. */
function material(fen: string): number {
  let s = 0;
  for (const p of parseFenBoard(fen)) if (p) s += (p[0] === "w" ? 1 : -1) * PIECE_VALUES[p[1]];
  return s;
}

// ------------------------------------------------------------------------------------------
// Chessboard: playable game with random replies, history browsing, flip, arrows.

function BoardDemo() {
  const game = useRef(new ChessGame());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [coords, setCoords] = useState(true);
  const [autoReply, setAutoReply] = useState(true);
  const [showArrows, setShowArrows] = useState(false);
  const rand = useRef(mulberry32(7));
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (replyTimer.current) clearTimeout(replyTimer.current);
  }, []);

  const g = game.current;
  const history = g.history();
  const live = viewPly === null || viewPly === history.uci.length;
  const ply = live ? history.uci.length : viewPly!;
  const fen = g.fenAt(ply);
  const last = ply > 0 ? history.uci[ply - 1] : null;
  const outcome = live ? g.outcome() : null;

  const onMove = (m: MoveInput) => {
    if (!g.play(m)) return;
    setViewPly(null);
    bump();
    if (autoReply && !g.isGameOver()) {
      replyTimer.current = setTimeout(() => {
        const moves = g.legalMoves();
        if (moves.length === 0) return;
        g.play(moves[Math.floor(rand.current() * moves.length)]);
        bump();
      }, 350);
    }
  };

  const arrows = showArrows
    ? [
        { from: "g1", to: "f3" },
        { from: "e2", to: "e4", color: "var(--cb-chart-2)" },
        { from: "d7", to: "d5", color: "#15781b" },
        { from: "c4", to: "c4", color: "#882020" },
      ]
    : undefined;

  return (
    <div className="dev-board-layout">
      <div className="dev-board-main" data-testid="dev-board-main">
        <EvalBar cp={material(fen)} orientation={orientation} />
        <div className="dev-board-wrap">
          <Chessboard
            fen={fen}
            orientation={orientation}
            interactive={live && !outcome ? "both" : "none"}
            onMove={onMove}
            lastMove={last}
            arrows={arrows}
            showCoordinates={coords}
          />
        </div>
      </div>
      <div className="dev-board-side">
        <Toolbar aria-label="Board options">
          <button className="btn btn-sm" onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}>
            <Icon name="flip" size={14} /> Flip
          </button>
          <button
            className="btn btn-sm"
            disabled={history.uci.length === 0}
            onClick={() => {
              if (replyTimer.current) clearTimeout(replyTimer.current);
              g.undo();
              setViewPly(null);
              bump();
            }}
          >
            Undo
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              if (replyTimer.current) clearTimeout(replyTimer.current);
              game.current = new ChessGame();
              setViewPly(null);
              bump();
            }}
          >
            <Icon name="reset" size={14} /> Reset
          </button>
          <Toolbar.Spacer />
        </Toolbar>
        <div className="dev-checks">
          <label className="checkbox">
            <input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} /> Random replies
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={coords} onChange={(e) => setCoords(e.target.checked)} /> Coordinates
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={showArrows} onChange={(e) => setShowArrows(e.target.checked)} /> Arrows
          </label>
        </div>
        <MoveList
          san={history.san}
          currentPly={ply}
          onSelectPly={(p) => setViewPly(p === history.uci.length ? null : p)}
          result={outcome?.result}
          controls
          className="dev-movelist"
          emptyText="Make a move on the board"
        />
        <div className="small muted" data-testid="dev-board-status">
          {outcome ? `Game over: ${outcome.result} (${outcome.termination})` : live ? `${g.turn() === "w" ? "White" : "Black"} to move` : `Viewing ply ${ply} — click the last move to return`}
        </div>
      </div>
    </div>
  );
}

const PROMO_FEN = "8/1P4k1/8/8/8/8/5K2/8 w - - 0 1";

function PromotionDemo() {
  const [fen, setFen] = useState(PROMO_FEN);
  const [last, setLast] = useState<string | null>(null);
  const [played, setPlayed] = useState<string>("");
  return (
    <Demo title="Promotion (drag b7 to b8)">
      <div className="dev-small-board" data-testid="dev-board-promo">
        <Chessboard
          fen={fen}
          lastMove={last}
          onMove={(m) => {
            const g = new ChessGame(fen);
            const r = g.play(m);
            if (!r) return;
            setFen(g.fen());
            setLast(r.uci);
            setPlayed(`${r.san} (${r.uci})`);
          }}
        />
      </div>
      <div className="row-between small">
        <span className="muted" data-testid="dev-promo-result">
          {played ? `Played ${played}` : "Pick a piece in the picker"}
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setFen(PROMO_FEN);
            setLast(null);
            setPlayed("");
          }}
        >
          Reset
        </button>
      </div>
    </Demo>
  );
}

function DecorationsDemo() {
  return (
    <Demo title="Check, highlights and arrows (view only, black at the bottom)">
      <div className="dev-small-board">
        <Chessboard
          fen="r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4"
          orientation="black"
          lastMove="h5f7"
          interactive="none"
          squareHighlights={{ e8: "rgba(239, 99, 99, 0.35)", c4: "rgba(91, 156, 245, 0.35)" }}
          arrows={[
            { from: "c4", to: "f7" },
            { from: "f7", to: "e8", color: "#882020" },
          ]}
        />
      </div>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------

function EditorDemo() {
  const [fen, setFen] = useState("r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 4 8");
  return (
    <div className="stack">
      <BoardEditor fen={fen} onChange={setFen} />
      <div className="dev-output">
        <span className="section-title">onChange (valid FENs only)</span>
        <code data-testid="dev-editor-output">{fen}</code>
      </div>
    </div>
  );
}

function MiniBoardsDemo() {
  const items = useMemo(
    () =>
      OPENINGS.slice(0, 10).map((o) => {
        const g = ChessGame.fromMoves(START_FEN, o.moves)!;
        return { o, fen: g.fen(), last: g.lastMove() };
      }),
    [],
  );
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="dev-minis">
        {items.map(({ o, fen, last }) => (
          <figure key={o.name} className="dev-mini">
            <MiniBoard fen={fen} lastMove={last} onClick={() => setPicked(o.name)} title={o.name} />
            <figcaption>
              <span className="badge">{o.eco}</span> <span className="truncate">{o.name}</span>
            </figcaption>
          </figure>
        ))}
        <figure className="dev-mini">
          <MiniBoard fen={START_FEN} orientation="black" size={96} />
          <figcaption className="faint">Black POV, 96px</figcaption>
        </figure>
      </div>
      <div className="small muted">{picked ? `Clicked: ${picked}` : "MiniBoards are static and cheap; click one."}</div>
    </div>
  );
}

function ClockEvalMovesDemo() {
  const [running, setRunning] = useState<"w" | "b" | null>("w");
  const [times, setTimes] = useState({ w: 183_000, b: 14_500 });
  const since = useRef(performance.now());
  const toggle = () => {
    const now = performance.now();
    const elapsed = now - since.current;
    since.current = now;
    setTimes((t) => (running ? { ...t, [running]: Math.max(0, t[running] - elapsed) } : t));
    setRunning((r) => (r === "w" ? "b" : r === "b" ? "w" : "w"));
  };
  const sample = ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "Be3", "e5", "Nb3", "Be6", "f3", "Be7", "Qd2", "O-O", "O-O-O", "Nbd7", "g4", "b5"];
  const [ply, setPly] = useState(sample.length);
  return (
    <div className="dev-grid-3">
      <Demo title="Clocks">
        <div className="stack-sm">
          <Clock ms={times.b} side="b" label="Stockfish-ish" running={running === "b"} />
          <Clock ms={times.w} side="w" label="You" running={running === "w"} />
          <Clock ms={0} side="w" label="Flagged" running={false} compact />
          <button className="btn btn-sm" onClick={toggle} data-testid="dev-clock-toggle">
            Press clock
          </button>
        </div>
      </Demo>
      <Demo title="Eval bars (White POV)">
        <div className="dev-evals">
          {[
            { cp: 0, label: "0.00" },
            { cp: 85, label: "+0.85" },
            { cp: -240, label: "−2.40" },
            { cp: 1250, label: "+12.5" },
            { mate: 3, label: "M3" },
            { mate: -5, label: "−M5" },
            { cp: null, label: "none" },
          ].map((e, i) => (
            <div key={i} className="dev-eval">
              <EvalBar cp={e.cp ?? null} mate={e.mate ?? null} />
              <span className="small faint">{e.label}</span>
            </div>
          ))}
        </div>
      </Demo>
      <Demo title="Move list (from a FEN with Black to move)">
        <MoveList san={sample.slice(1)} startPly={1} currentPly={Math.max(0, ply - 1)} onSelectPly={(p) => setPly(p + 1)} result="*" controls className="dev-movelist-small" />
      </Demo>
    </div>
  );
}

function ChartsDemo() {
  const loss = useMemo<ChartSeries[]>(() => {
    const r = mulberry32(3);
    const train = [];
    const val = [];
    for (let s = 0; s <= 4000; s++) {
      const base = 0.045 + 0.42 * Math.exp(-s / 520) + 0.02 * Math.exp(-s / 3000);
      train.push({ x: s, y: base * (1 + (r() - 0.5) * 0.28) });
      if (s % 200 === 0) val.push({ x: s, y: base * 1.08 + 0.004 });
    }
    return [
      { name: "Train loss", color: CHART_COLORS[0], points: train, width: 1.5 },
      { name: "Validation loss", color: CHART_COLORS[1], points: val },
    ];
  }, []);
  const elo = useMemo<ChartSeries[]>(() => {
    const r = mulberry32(11);
    let v = 0;
    const pts = [];
    for (let i = 1; i <= 160; i++) {
      v += (r() - 0.42) * 18;
      pts.push({ x: i, y: v });
    }
    return [{ name: "Elo difference", color: CHART_COLORS[2], points: pts }];
  }, []);
  const [log, setLog] = useState(true);
  return (
    <div className="dev-grid-2">
      <Demo title={`Training loss — 4,001 points, downsampled${log ? ", log scale" : ""}`}>
        <label className="checkbox small">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> Log Y
        </label>
        <LineChart series={loss} logY={log} xLabel="Step" yLabel="Loss" height={240} />
      </Demo>
      <Demo title="Elo over games (single series)">
        <LineChart series={elo} xLabel="Games" yLabel="Elo" height={240} formatY={(v) => (v > 0 ? "+" : "") + Math.round(v)} />
      </Demo>
      <Demo title="Empty chart">
        <LineChart series={[{ name: "Positions/s", color: CHART_COLORS[0], points: [] }]} height={160} emptyText="Start a training run to see the loss curve" />
      </Demo>
      <Demo title="Progress">
        <div className="stack">
          <ProgressBar label="Self-play games" value={37} max={120} showValue="fraction" detail="≈ 14 games/min · 6 min left" />
          <ProgressBar label="Epoch 3 / 10" value={0.64} />
          <ProgressBar label="Compiling engine" value={null} />
          <ProgressBar label="Gating match" value={0.9} variant="ok" size="lg" />
          <ProgressBar label="Disk quota" value={0.93} variant="danger" size="sm" />
        </div>
      </Demo>
    </div>
  );
}

const SAMPLE_ENGINES: EngineRecord[] = (
  [
    ["Pawn Storm", "blocks", "#f59e0b"],
    ["Material Only", "eval", "#38bdf8"],
    ["Full Monty", "full", "#a78bfa"],
    ["Tabula Rasa", "scratch", "#f472b6"],
    ["Net 256 SCReLU", "nnue", "#34d399"],
    ["Uploaded Rust engine", "wasm", "#94a3b8"],
    ["Aggressive Kings", "blocks", "#ef6363"],
    ["Endgame Expert", "eval", "#4cc38a"],
  ] as Array<[string, EngineKind, string]>
).map(([name, kind, color], i) => ({
  id: `sample-${i}`,
  name,
  kind,
  color,
  description: `Sample ${kind} engine`,
  createdAt: 0,
  updatedAt: 0,
  options: { hashMb: 16 },
}));

function LimitsDemo() {
  const [value, setValue] = useState<LimitsValue>({ limits: { depth: 12 }, timeControl: { baseMs: 300_000, incMs: 0 } });
  const [compact, setCompact] = useState<LimitsValue>({ limits: { movetimeMs: 500 }, timeControl: null });
  const [engine, setEngine] = useState<string | null>("sample-4");
  const [engine2, setEngine2] = useState<string | null>(null);
  return (
    <div className="dev-grid-2">
      <Demo title="LimitsEditor">
        <LimitsEditor value={value} onChange={setValue} />
        <code className="dev-json" data-testid="dev-limits-output">
          {JSON.stringify(value)}
        </code>
      </Demo>
      <div className="stack">
        <Demo title="LimitsEditor (compact)">
          <LimitsEditor value={compact} onChange={setCompact} compact />
          <div className="small muted">{describeLimits(compact)}</div>
        </Demo>
        <Demo title="EnginePicker">
          <div className="stack-sm">
            <div className="field">
              <label>Sample engines (search appears with more than 7 options)</label>
              <EnginePicker value={engine} onChange={(id) => setEngine(id)} engines={SAMPLE_ENGINES} allowNone />
            </div>
            <div className="field">
              <label>NNUE engines only, with an extra option</label>
              <EnginePicker
                value={engine2}
                onChange={(id) => setEngine2(id)}
                engines={SAMPLE_ENGINES}
                filter={(e) => e.kind === "nnue"}
                extraOptions={[{ value: "$network", label: "Current network (stock NNUE)", color: "var(--kind-nnue)" }]}
                placeholder="Self-play engine…"
              />
            </div>
            <div className="field">
              <label>From storage (useEngines)</label>
              <EnginePicker value={null} onChange={() => {}} />
            </div>
          </div>
        </Demo>
      </div>
    </div>
  );
}

function BasicsDemo() {
  const [tab, setTab] = useState("blocks");
  const [modal, setModal] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [answer, setAnswer] = useState<string>("—");
  const confirm = useConfirm();
  return (
    <div className="dev-grid-2">
      <Demo title="Tabs">
        <Tabs
          tabs={[
            { id: "blocks", label: "Blocks" },
            { id: "code", label: "Code", badge: 3 },
            { id: "nnue", label: "NNUE" },
            { id: "test", label: "Test", disabled: true },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div className="small muted" style={{ paddingTop: 8 }}>
          Active tab: {tab} (arrow keys move between tabs)
        </div>
        <Tabs tabs={["Overview", "Games", "Log"]} active="Games" onChange={() => {}} size="sm" />
      </Demo>
      <Demo title="Kind badges, spinner, tooltip">
        <div className="row-wrap">
          {(["blocks", "eval", "full", "scratch", "nnue", "wasm"] as EngineKind[]).map((k) => (
            <KindBadge key={k} kind={k} />
          ))}
        </div>
        <div className="row-wrap" style={{ marginTop: 12 }}>
          <Spinner />
          <Spinner size={24} />
          <Spinner label="Compiling…" />
          <Tooltip content="Tooltips appear on hover and keyboard focus, and flip to stay on screen.">
            <button className="btn btn-sm">Hover me</button>
          </Tooltip>
          <Tooltip content="Below the anchor" placement="bottom">
            <button className="btn btn-sm btn-ghost">
              <Icon name="info" size={14} /> Bottom
            </button>
          </Tooltip>
        </div>
      </Demo>
      <Demo title="Modal & confirmation">
        <div className="row-wrap">
          <button className="btn" onClick={() => setModal(true)}>
            Open modal
          </button>
          <button className="btn" onClick={() => setConfirmOpen(true)}>
            ConfirmDialog
          </button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              const ok = await confirm({
                title: "Delete “Pawn Storm”?",
                message: "The engine, its blocks and its build are removed. Games played with it stay in the history.",
                confirmLabel: "Delete engine",
                danger: true,
              });
              setAnswer(ok ? "confirmed" : "cancelled");
            }}
          >
            useConfirm()
          </button>
          <span className="small muted">Answer: {answer}</span>
        </div>
        <Modal
          open={modal}
          title="Rename engine"
          onClose={() => setModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => setModal(false)}>
                Save
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="dev-rename">Name</label>
            <input id="dev-rename" className="input" defaultValue="Pawn Storm" />
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Esc or a click on the backdrop closes the dialog; Tab stays inside it.
          </p>
        </Modal>
        <ConfirmDialog
          open={confirmOpen}
          title="Stop the training run?"
          message="The current epoch is checkpointed; you can resume later."
          confirmLabel="Stop run"
          onConfirm={() => {
            setConfirmOpen(false);
            setAnswer("stopped");
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      </Demo>
      <Demo title="Toolbar & empty state">
        <Toolbar aria-label="Workshop">
          <Toolbar.Group label="Build">
            <button className="btn btn-sm btn-primary">
              <Icon name="play" size={14} /> Compile
            </button>
            <button className="btn btn-sm">Test</button>
          </Toolbar.Group>
          <Toolbar.Separator />
          <Toolbar.Group label="View">
            <button className="btn btn-sm btn-ghost btn-icon" aria-label="Flip">
              <Icon name="flip" size={14} />
            </button>
          </Toolbar.Group>
          <Toolbar.Spacer />
          <span className="badge badge-ok">Saved</span>
        </Toolbar>
        <EmptyState
          compact
          icon={<img src="/pieces/chessnut/wN.svg" alt="" />}
          title="No matches yet"
          description="Pick two or more engines and a time control to start a match."
          action={
            <button className="btn btn-primary btn-sm">
              <Icon name="plus" size={14} /> New match
            </button>
          }
        />
      </Demo>
    </div>
  );
}

export default function DevPage({ params }: PageProps) {
  const only = SECTIONS.some((s) => s.id === params.section) ? params.section : undefined;
  const [theme, setTheme] = useState<"dark" | "light">(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="page dev-page">
      <div className="page-header">
        <div>
          <h1>Component gallery</h1>
          <div className="page-subtitle">Shared UI kit (@/components) with sample data — for visual checks and tests.</div>
        </div>
        <div className="spacer" />
        <div className="btn-group" role="radiogroup" aria-label="Theme">
          {(["dark", "light"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={"btn btn-sm" + (theme === t ? " active" : "")} onClick={() => setTheme(t)}>
              {t === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </div>
      <nav className="dev-nav" aria-label="Sections">
        <Link to="/dev" className={!only ? "active" : undefined}>
          All
        </Link>
        {SECTIONS.map((s) => (
          <Link key={s.id} to={`/dev/${s.id}`} className={only === s.id ? "active" : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>

      <Section id="board" title="Chessboard" description="Click or drag to move (touch works too). Right-drag draws arrows, right-click circles a square. Legal moves, last move, check, promotion picker and move animation." only={only}>
        <BoardDemo />
        <div className="dev-grid-2" style={{ marginTop: 16 }}>
          <PromotionDemo />
          <DecorationsDemo />
        </div>
      </Section>
      <Section id="editor" title="Board editor" description="Set up any position; only valid FENs are reported." only={only}>
        <EditorDemo />
      </Section>
      <Section id="boards" title="Mini boards" description="Static thumbnails (CSS grid + background images) — the first ten book openings." only={only}>
        <MiniBoardsDemo />
      </Section>
      <Section id="game" title="Clock, eval bar, move list" only={only}>
        <ClockEvalMovesDemo />
      </Section>
      <Section id="charts" title="Charts & progress" description="Hover or focus a chart (arrow keys) for the crosshair readout." only={only}>
        <ChartsDemo />
      </Section>
      <Section id="limits" title="Limits & engine picker" only={only}>
        <LimitsDemo />
      </Section>
      <Section id="basics" title="Basics" only={only}>
        <BasicsDemo />
      </Section>
      <Section
        id="code"
        title="Code editor, API reference, file tree"
        description="@/components/code: CodeMirror 6 with AssemblyScript highlighting, engine-API completion (try pos. or Ctrl+Space), diagnostics with hover text, search (Ctrl+F) and Ctrl+S. main.ts is the 1171-line scratch engine."
        only={only}
      >
        <CodeComponentsDemo />
      </Section>
    </div>
  );
}
