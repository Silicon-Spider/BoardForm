// Play page (#/play): play against engines or watch engines play each other, analyse positions,
// and review saved games. Route parameters: docs/ARCHITECTURE.md §6.
//
// The page owns one GameController (the current game, persisted under "play.current" so a reload
// shows a "Resume game" banner) and, in Analysis mode, one AnalysisSession. Both are disposed —
// engines stopped and terminated — when replaced or when the page unmounts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChessGame, type MoveInput } from "@/chess";
import { Icon, Tabs, useConfirm } from "@/components";
import { useBoardPreferences, useDefaultHashMb } from "@/app/preferences";
import { setQuery, type PageProps } from "@/app/router";
import { toast } from "@/app/toast";
import { EngineClient, getEngineArtifacts, loadEngine } from "@/engine-host";
import { enginesRepo, gamesRepo, newId, settingsRepo, useEngines, useSetting } from "@/storage";
import type { EngineRecord, GameRecord } from "@/types";
import { downloadText } from "@/utils/misc";
import type { AnalysisDeps } from "./analysis-session";
import { ANALYSIS_KEY, AnalysisView, EMPTY_LINE, lineForGame, parseLine, type AnalysisLine } from "./AnalysisView";
import { BoardArea, PlayerBar } from "./BoardArea";
import { GameController, type ControllerDeps, type GameState } from "./controller";
import { capsText, pgnFileName } from "./format";
import { GamePanel } from "./GamePanel";
import { copyText, useAnalysisSession, useBoardKeys, useGameState, usePersistentState } from "./hooks";
import { PlayIcon } from "./icons";
import { CURRENT_GAME_KEY, clearSnapshot, newestGame, parsePersistedGame, takeSnapshot, writeSnapshot } from "./persisted";
import { gamePgn, materialBalance } from "./rules";
import { PgnImportModal, SavedGames } from "./SavedGames";
import { DEFAULT_SETUP, QUERY_KEYS, hasPlayQuery, intentFromQuery, normalizeSetup, playersFor, previewFen, resolveStart, swapSides, validateSetup, withDefaultEngines } from "./setup";
import { SetupPanel } from "./SetupPanel";
import { SIDES, type GameSetup, type PersistedGame, type ResolvedStart, type Side } from "./types";
import "./play.css";

type Mode = "play" | "analysis";
type SideTab = "main" | "games";

const UNFINISHED = new Set<GameState["phase"]>(["loading", "interrupted", "playing", "paused"]);

const LINK_ENGINE_KEYS = ["engine", "white", "black", "analysis"] as const;

/**
 * The engine list plus engines named in a link that the live list does not show yet — a link
 * opened right after creating an engine can arrive before the list refreshes.
 */
async function withLinkedEngines(params: URLSearchParams, engines: readonly EngineRecord[]): Promise<readonly EngineRecord[]> {
  const ids = LINK_ENGINE_KEYS.map((k) => params.get(k)).filter((v): v is string => !!v && v !== "human");
  const missing = ids.filter((id) => !engines.some((e) => e.id === id));
  if (missing.length === 0) return engines;
  const found = await Promise.all(missing.map((id) => enginesRepo.get(id).catch(() => undefined)));
  return [...engines, ...found.filter((e): e is EngineRecord => !!e)];
}

function Layout({ board, tab, onTab, mainLabel, gamesCount, viewKey, children }: { board: ReactNode; tab: SideTab; onTab(t: SideTab): void; mainLabel: string; gamesCount?: ReactNode; viewKey: string; children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // A different view (setup → game, another tab, another game) starts at the top of the panel.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [viewKey, tab]);
  return (
    <div className="play-layout">
      {board}
      <div className="play-side-wrap">
        <aside className="play-side panel" aria-label={tab === "main" ? mainLabel : "Saved games"}>
          <Tabs
            size="sm"
            className="play-side-tabs"
            active={tab}
            onChange={(id) => onTab(id as SideTab)}
            tabs={[
              { id: "main", label: mainLabel },
              { id: "games", label: "Saved games", badge: gamesCount },
            ]}
          />
          <div className="play-side-body" ref={bodyRef}>
            {children}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function PlayPage({ query }: PageProps) {
  const engines = useEngines();
  const confirm = useConfirm();
  const [prefs] = useBoardPreferences();
  const [defaultHashMb] = useDefaultHashMb();
  const [mode, setMode] = useSetting<Mode>("play.mode", "play");
  const [storedSetup, setStoredSetup] = useSetting<unknown>("play.lastSetup", DEFAULT_SETUP);
  const setup = useMemo(() => withDefaultEngines(normalizeSetup(storedSetup), engines), [storedSetup, engines]);
  const [moveDelay, setMoveDelay] = useSetting<number>("play.moveDelayMs", 400);
  const [showEval, setShowEval] = useSetting<boolean>("play.showEvalBar", true);
  const [, persistCurrent] = useSetting<PersistedGame | null>(CURRENT_GAME_KEY, null);

  // --- the game ------------------------------------------------------------------------------
  const [controller, setController] = useState<GameController | null>(null);
  const [restoreDone, setRestoreDone] = useState(false);
  const game = useGameState(controller);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [flip, setFlip] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("main");
  const [linkProblems, setLinkProblems] = useState<string[]>([]);
  const [pendingStart, setPendingStart] = useState<{ setup: GameSetup; autostart: boolean } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const persistRef = useRef(persistCurrent);
  persistRef.current = persistCurrent;
  const moveDelayRef = useRef(moveDelay);
  moveDelayRef.current = moveDelay;

  const deps = useMemo<ControllerDeps>(
    () => ({
      loadEngine: (engineId, opts) => loadEngine(engineId, { hashMb: opts.hashMb, label: opts.label, onLog: opts.onLog, onStatus: opts.onStatus }),
      saveGame: (record) => gamesRepo.put(record),
      persist: (g) => persistRef.current(g),
      now: () => performance.now(),
      wallNow: () => Date.now(),
      newId,
    }),
    [],
  );

  // Restore the game of an earlier visit (shown with a "Resume game" banner).
  useEffect(() => {
    let cancelled = false;
    settingsRepo
      .get<unknown>(CURRENT_GAME_KEY, null)
      .then((raw) => {
        if (cancelled) return;
        const stored = newestGame(parsePersistedGame(raw), parsePersistedGame(takeSnapshot()));
        const c = stored ? GameController.restore(stored, deps, moveDelayRef.current) : null;
        if (c) setController(c);
      })
      .catch((err: unknown) => console.error("[play] could not read the stored game", err))
      .finally(() => {
        if (!cancelled) setRestoreDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deps]);

  // Stop and terminate the engines of a replaced game, and on unmount.
  useEffect(() => () => controller?.dispose(), [controller]);

  // Store the running clock when the page is hidden or closed.
  useEffect(() => {
    if (!controller) return;
    const save = () => {
      const snapshot = controller.snapshotNow();
      if (snapshot) writeSnapshot(snapshot);
      controller.persistNow();
    };
    const onVisibility = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [controller]);

  const unfinished = !!game && UNFINISHED.has(game.phase);

  const startGame = useCallback(
    (s: GameSetup, override?: ResolvedStart, engineList?: readonly EngineRecord[]) => {
      const list = engineList ?? engines;
      if (!list) return;
      const problems = validateSetup(s, list);
      if (problems.length) {
        toast(problems[0], { kind: "warn" });
        return;
      }
      let c: GameController;
      try {
        const start = override ?? resolveStart(s.start, (Math.random() * 2 ** 32) >>> 0);
        c = GameController.start({ setup: s, players: playersFor(s, list, defaultHashMb), start, moveDelayMs: moveDelayRef.current }, deps);
      } catch (err) {
        toast("Could not start the game", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      controller?.dispose();
      persistCurrent(null);
      clearSnapshot();
      setController(c);
      setViewPly(null);
      setFlip(false);
      setMode("play");
      setSideTab("main");
      setPendingStart(null);
      setLinkProblems([]);
    },
    [engines, defaultHashMb, deps, controller, persistCurrent, setMode],
  );

  /** Leaves the current game for the setup form (aborting it after confirmation). */
  const toSetup = useCallback(
    async (opts: { confirmAbort: boolean } = { confirmAbort: true }) => {
      if (controller && game && UNFINISHED.has(game.phase) && game.phase !== "loading") {
        if (opts.confirmAbort) {
          const played = game.moves.length > game.bookPlies;
          const ok = await confirm({
            title: "Abort the current game?",
            message: played ? "It is saved as unfinished, and you go back to the new-game form." : "No moves were played yet, so nothing is saved.",
            confirmLabel: "Abort game",
            danger: true,
          });
          if (!ok) return false;
        }
        controller.abort();
      }
      controller?.dispose();
      setController(null);
      persistCurrent(null);
      clearSnapshot();
      setViewPly(null);
      setFlip(false);
      return true;
    },
    [controller, game, confirm, persistCurrent],
  );

  // --- analysis ------------------------------------------------------------------------------
  const [line, setLine, lineLoaded] = usePersistentState<AnalysisLine>(ANALYSIS_KEY, EMPTY_LINE, parseLine);
  const [analysisEngine, setAnalysisEngine] = useSetting<string | null>("play.analysisEngine", null);
  const [analysisPov, setAnalysisPov] = useSetting<"white" | "stm">("play.analysisPov", "white");
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const analysisDeps = useMemo<AnalysisDeps>(
    () => ({
      async createEngine(engineId, { onLog, onStatus }) {
        const { engine, wasm, network } = await getEngineArtifacts(engineId, { onStatus });
        onStatus("Starting the engine…");
        const client = await EngineClient.create(wasm, { maxWaitMs: Infinity, hashMb: engine.options?.hashMb ?? defaultHashMb, network, onLog, label: engine.name });
        return { client, name: engine.name };
      },
    }),
    [defaultHashMb],
  );
  const [analysis, session] = useAnalysisSession(analysisDeps);
  const analysisActive = mode === "analysis";
  const validAnalysisEngine = analysisEngine && engines?.some((e) => e.id === analysisEngine) ? analysisEngine : null;

  useEffect(() => {
    session?.setEngine(analysisActive ? validAnalysisEngine : null);
  }, [session, analysisActive, validAnalysisEngine]);
  useEffect(() => {
    if (lineLoaded) session?.setPosition(line.startFen, line.moves.slice(0, Math.min(line.ply, line.moves.length)));
  }, [session, lineLoaded, line.startFen, line.moves, line.ply]);
  useEffect(() => {
    session?.setRunning(analysisActive && analysisRunning && !!validAnalysisEngine);
  }, [session, analysisActive, analysisRunning, validAnalysisEngine]);
  useEffect(() => {
    if (analysis?.status === "error" && analysisRunning) setAnalysisRunning(false);
  }, [analysis?.status, analysisRunning]);
  useEffect(() => {
    if (!analysisActive) setAnalysisRunning(false);
  }, [analysisActive]);

  const openReview = useCallback(
    (g: GameRecord, ply?: number) => {
      setLine(lineForGame(g, ply));
      setMode("analysis");
      setSideTab("main");
    },
    [setLine, setMode],
  );

  // --- query parameters (prefill / start / open), consumed once and removed from the URL --------
  const queryKey = query.toString();
  const handledQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!restoreDone || !engines || !hasPlayQuery(query) || handledQuery.current === queryKey) return;
    handledQuery.current = queryKey;
    const params = new URLSearchParams(queryKey);
    void (async () => {
      const list = await withLinkedEngines(params, engines);
      setQuery(Object.fromEntries(QUERY_KEYS.map((k) => [k, null])));
      handleLink(params, list);
    })();
    // Only when the query changes (or once the data it needs has loaded).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreDone, engines === undefined, queryKey]);

  function handleLink(query: URLSearchParams, list: readonly EngineRecord[]) {
    const intent = intentFromQuery(query, setup, list);
    setLinkProblems(intent.problems);
    if (intent.gameId) {
      const id = intent.gameId;
      gamesRepo
        .get(id)
        .then((g) => {
          if (g) openReview(g);
          else setLinkProblems(["The game in the link no longer exists."]);
        })
        .catch(() => setLinkProblems(["Could not open the game from the link."]));
      return;
    }
    if (query.has("analysis")) {
      setMode("analysis");
      setSideTab("main");
      if (intent.analysisEngineId) setAnalysisEngine(intent.analysisEngineId);
      if (intent.analysisFen) setLine({ ...EMPTY_LINE, startFen: new ChessGame(intent.analysisFen).startFen });
      setAnalysisRunning(!!intent.analysisEngineId);
      return;
    }
    if (!intent.setup) return;
    setStoredSetup(intent.setup);
    setMode("play");
    setSideTab("main");
    if (unfinished) setPendingStart({ setup: intent.setup, autostart: intent.autostart });
    else if (intent.autostart) startGame(intent.setup, undefined, list);
    else if (controller) void toSetup({ confirmAbort: false });
  }

  // --- board state for the Play mode ---------------------------------------------------------
  const gameChess = useMemo(() => (game ? ChessGame.fromMoves(game.startFen, game.moves) : null), [game?.startFen, game?.moves]);
  const plies = game?.san.length ?? 0;
  const shownPly = game ? (viewPly === null ? plies : Math.min(viewPly, plies)) : 0;
  const browsing = !!game && shownPly < plies;

  useEffect(() => {
    // A takeback can make the browsed ply disappear.
    if (viewPly !== null && viewPly >= plies) setViewPly(null);
  }, [viewPly, plies]);

  const humanSides = game ? SIDES.filter((s) => game.players[s].kind === "human") : SIDES.filter((s) => (s === "w" ? setup.white : setup.black).player === "human");
  const baseOrientation = humanSides.length === 1 ? (humanSides[0] === "w" ? "white" : "black") : "white";
  const orientation = flip ? (baseOrientation === "white" ? "black" : "white") : baseOrientation;

  const keys = {
    step: (d: number) => {
      if (mode === "analysis") setLine((l) => ({ ...l, ply: Math.max(0, Math.min(l.moves.length, l.ply + d)) }));
      else if (game) {
        const next = Math.max(0, Math.min(plies, shownPly + d));
        setViewPly(next >= plies ? null : next);
      }
    },
    first: () => (mode === "analysis" ? setLine((l) => ({ ...l, ply: 0 })) : game && setViewPly(plies > 0 ? 0 : null)),
    last: () => (mode === "analysis" ? setLine((l) => ({ ...l, ply: l.moves.length })) : setViewPly(null)),
    flip: () => (mode === "analysis" ? setLine((l) => ({ ...l, orientation: l.orientation === "white" ? "black" : "white" })) : setFlip((f) => !f)),
  };
  useBoardKeys(keys);

  const copyPgn = () => game && copyText(controller?.currentRecord()?.pgn ?? gamePgn({ ...game, end: game.end }), "PGN");
  const downloadPgn = () => {
    if (!game) return;
    const pgn = controller?.currentRecord()?.pgn ?? gamePgn({ ...game, end: game.end });
    const ref = (s: Side) => ({ type: "human" as const, name: game.players[s].name });
    downloadText(pgn, pgnFileName({ white: ref("w"), black: ref("b"), createdAt: game.createdAt }), "application/x-chess-pgn");
  };
  const analyseGame = () => {
    if (!game) return;
    const record = controller?.currentRecord();
    if (record && controller?.savedGameId) openReview(record);
    else {
      setLine({ ...EMPTY_LINE, startFen: game.startFen, moves: [...game.moves], ply: game.moves.length, names: { w: game.players.w.name, b: game.players.b.name }, orientation: baseOrientation });
      setMode("analysis");
      setSideTab("main");
    }
  };
  const rematch = () => {
    if (!game) return;
    startGame(swapSides(game.setup), { startFen: game.startFen, moves: game.moves.slice(0, game.bookPlies), opening: game.opening });
  };

  // --- render: Play mode ---------------------------------------------------------------------
  const linkCallouts = (
    <>
      {linkProblems.length > 0 && (
        <div className="callout warn play-callout" role="alert">
          <div className="grow">
            {linkProblems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" onClick={() => setLinkProblems([])}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {pendingStart && game && (
        <div className="callout play-callout" role="alert">
          <div className="grow">
            <strong>Start the game from the link?</strong>
            <div className="small muted">
              Your game {game.players.w.name} vs {game.players.b.name} is not finished. Starting a new one aborts it (it is saved as unfinished).
            </div>
          </div>
          <div className="row-wrap">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                const next = pendingStart;
                controller?.abort();
                if (next.autostart) startGame(next.setup);
                else void toSetup({ confirmAbort: false }).then(() => setPendingStart(null));
              }}
            >
              {pendingStart.autostart ? "Start new game" : "Abort and set up"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPendingStart(null)}>
              Keep playing
            </button>
          </div>
        </div>
      )}
    </>
  );

  let playBoard: ReactNode;
  let playPanel: ReactNode;
  if (game && controller) {
    const fen = browsing && gameChess ? gameChess.fenAt(shownPly) : game.fen;
    const live = !browsing;
    const now = performance.now();
    const material = materialBalance(fen);
    const thinkingSide = SIDES.find((s) => game.engines[s]?.status === "thinking") ?? null;
    const humanToMove = game.phase === "playing" && game.players[game.turn].kind === "human";
    const interactive = live && humanToMove ? (humanSides.length === 2 ? "both" : game.turn === "w" ? "white" : "black") : "none";
    let arrows: Array<{ from: string; to: string }> | undefined;
    if (live && prefs.showEngineArrows && thinkingSide) {
      const ev = game.engines[thinkingSide]!;
      const best = ev.info?.pv[0];
      if (best && ev.infoFen === game.fen && best.length >= 4) arrows = [{ from: best.slice(0, 2), to: best.slice(2, 4) }];
    }
    let evalScore = game.liveEval;
    if (browsing) {
      evalScore = null;
      for (let i = shownPly - 1; i >= 0; i--) {
        if (game.whiteScores[i]) {
          evalScore = game.whiteScores[i];
          break;
        }
      }
    }
    const bar = (side: Side) => {
      const p = game.players[side];
      const ev = game.engines[side];
      const ms = game.clock[side];
      const running = game.running === side;
      const clockMs = ms === null ? null : running ? Math.max(0, ms - (now - game.clockAt)) : ms;
      let status: ReactNode = null;
      if (ev?.status === "thinking") status = <span className="play-thinking">Thinking</span>;
      else if (game.phase === "playing" && game.turn === side && p.kind === "human") status = <span className="text-ok">{humanSides.length === 2 ? "To move" : "Your move"}</span>;
      else if (p.kind === "engine") status = capsText(p.limits) || null;
      const end = game.end;
      const result = end && end.termination !== "aborted" ? (end.winner === null ? "draw" : end.winner === side ? "win" : "loss") : null;
      return (
        <PlayerBar
          side={side}
          name={p.name}
          engineKind={p.engineKind}
          clockMs={clockMs}
          clockRunning={running && game.phase === "playing"}
          material={material[side]}
          status={status}
          active={game.phase === "playing" && game.turn === side}
          result={result}
        />
      );
    };
    const bottomSide: Side = orientation === "white" ? "w" : "b";
    const topSide: Side = bottomSide === "w" ? "b" : "w";
    playBoard = (
      <BoardArea
        top={bar(topSide)}
        bottom={bar(bottomSide)}
        fen={fen}
        orientation={orientation}
        interactive={interactive}
        onMove={(m: MoveInput) => controller.humanMove(m)}
        lastMove={shownPly > 0 ? game.moves[shownPly - 1] : null}
        arrows={arrows}
        evalScore={evalScore}
        showEval={showEval}
        aria-label="Game board"
        note={
          browsing ? (
            <div className="play-board-note">
              <Icon name="info" size={14} /> Viewing an earlier position.
              <button type="button" className="play-linkbtn" onClick={() => setViewPly(null)}>
                Back to the game
              </button>
            </div>
          ) : null
        }
        tools={
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFlip((f) => !f)} title="Flip the board (F)">
              <Icon name="flip" /> Flip
            </button>
            <button type="button" className={"btn btn-ghost btn-sm" + (showEval ? " play-tool-on" : "")} aria-pressed={showEval} onClick={() => setShowEval(!showEval)} title="Show or hide the evaluation bar">
              <PlayIcon name="eye" /> Eval bar
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(fen, "FEN")}>
              <Icon name="copy" /> FEN
            </button>
          </>
        }
      />
    );
    playPanel = (
      <>
        {linkCallouts}
        <GamePanel
          state={game}
          controller={controller}
          viewPly={browsing ? shownPly : null}
          onViewPly={setViewPly}
          onNewGame={() => void toSetup()}
          onBackToSetup={() => void toSetup({ confirmAbort: false })}
          onRematch={rematch}
          onAnalyse={analyseGame}
          onCopyPgn={copyPgn}
          onDownloadPgn={downloadPgn}
          onMoveDelay={(ms) => {
            setMoveDelay(ms);
            controller.setMoveDelay(ms);
          }}
          confirm={confirm}
        />
      </>
    );
  } else {
    // Setup: preview of the start position and the players.
    const fen = previewFen(setup.start);
    const material = materialBalance(fen);
    const sideSetup = (s: Side) => (s === "w" ? setup.white : setup.black);
    const names = engines ? playersFor(setup, engines, defaultHashMb) : null;
    const bar = (side: Side) => {
      const s = sideSetup(side);
      const e = s.player === "engine" ? engines?.find((x) => x.id === s.engineId) : undefined;
      return (
        <PlayerBar
          side={side}
          name={names?.[side].name ?? (s.player === "human" ? "You" : "Engine")}
          engineKind={e?.kind ?? null}
          clockMs={s.timeControl ? s.timeControl.baseMs : null}
          material={material[side]}
          status={s.player === "engine" ? capsText(s.limits) || null : null}
        />
      );
    };
    const bottomSide: Side = orientation === "white" ? "w" : "b";
    const topSide: Side = bottomSide === "w" ? "b" : "w";
    const problems = validateSetup(setup, engines);
    playBoard = (
      <BoardArea
        top={bar(topSide)}
        bottom={bar(bottomSide)}
        fen={fen}
        orientation={orientation}
        interactive="none"
        showEval={false}
        aria-label="Start position preview"
        note={
          setup.start.kind === "random" ? (
            <div className="play-board-note">
              <Icon name="info" size={14} /> A random opening is chosen when the game starts.
            </div>
          ) : null
        }
        tools={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFlip((f) => !f)} title="Flip the board (F)">
            <Icon name="flip" /> Flip
          </button>
        }
      />
    );
    playPanel = (
      <SetupPanel
        setup={setup}
        engines={engines}
        onChange={(next) => setStoredSetup(next)}
        onStart={() => startGame(setup)}
        problems={restoreDone ? problems : ["Loading…"]}
        defaultHashMb={defaultHashMb}
        moveDelayMs={moveDelay}
        onMoveDelay={setMoveDelay}
        notices={linkCallouts}
      />
    );
  }

  const savedGames = (
    <SavedGames
      activeGameId={mode === "analysis" ? line.gameId : null}
      onOpen={(g) => openReview(g)}
      onImport={() => setImportOpen(true)}
      onDeleted={(id) => {
        if (line.gameId === id) setLine((l) => ({ ...l, gameId: null }));
      }}
      confirm={confirm}
    />
  );

  const gameBadge = game && unfinished ? (game.phase === "paused" ? "paused" : game.phase === "interrupted" ? "waiting" : "live") : null;

  return (
    <div className="page play-page">
      <header className="play-header">
        <h1>Play</h1>
        <div className="btn-group play-seg play-modes" role="radiogroup" aria-label="Mode">
          <button type="button" role="radio" aria-checked={mode === "play"} className={"btn btn-sm" + (mode === "play" ? " active" : "")} onClick={() => setMode("play")}>
            Play
            {gameBadge && mode !== "play" && <span className={`play-live-dot play-live-dot--${gameBadge}`} aria-label={`Game ${gameBadge}`} />}
          </button>
          <button type="button" role="radio" aria-checked={mode === "analysis"} className={"btn btn-sm" + (mode === "analysis" ? " active" : "")} onClick={() => setMode("analysis")}>
            Analysis
          </button>
        </div>
        <span className="spacer" />
        {mode === "analysis" && game && unfinished && (
          <button type="button" className="btn btn-sm play-backtogame" onClick={() => setMode("play")}>
            <span className={`play-live-dot play-live-dot--${gameBadge}`} aria-hidden="true" />
            {game.players.w.name} vs {game.players.b.name} — back to the game
          </button>
        )}
      </header>

      {mode === "play" ? (
        <Layout board={playBoard} tab={sideTab} onTab={setSideTab} mainLabel={game ? "Game" : "New game"} viewKey={game ? `game:${game.id}` : "setup"}>
          {sideTab === "main" ? playPanel : savedGames}
        </Layout>
      ) : (
        <AnalysisView
          line={line}
          setLine={setLine}
          analysis={analysis}
          engineId={validAnalysisEngine}
          onEngine={(id) => setAnalysisEngine(id)}
          running={analysisRunning}
          onRunning={setAnalysisRunning}
          pov={analysisPov}
          onPov={setAnalysisPov}
          showEval={showEval}
          onShowEval={setShowEval}
          onImport={() => setImportOpen(true)}
          onPlayFrom={(fen) => {
            setStoredSetup({ ...setup, start: { kind: "fen", fen } });
            setMode("play");
            setSideTab("main");
            if (game && !unfinished) void toSetup({ confirmAbort: false });
            else if (unfinished) toast("Finish or abort your current game first — the position was put into the new-game form.", { kind: "info" });
          }}
          confirm={confirm}
          layout={(board, panel) => (
            <Layout board={board} tab={sideTab} onTab={setSideTab} mainLabel="Analysis" viewKey={`analysis:${line.gameId ?? ""}`}>
              {sideTab === "main" ? (
                <>
                  {linkCallouts}
                  {panel}
                </>
              ) : (
                savedGames
              )}
            </Layout>
          )}
        />
      )}

      <PgnImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onLoad={(pgn) => {
          setImportOpen(false);
          const names = pgn.headers.White || pgn.headers.Black ? { w: pgn.headers.White || "White", b: pgn.headers.Black || "Black" } : null;
          setLine({ ...EMPTY_LINE, startFen: pgn.startFen, moves: pgn.moves, ply: pgn.moves.length, names });
          setMode("analysis");
          setSideTab("main");
          toast(`Loaded ${pgn.moves.length} ${pgn.moves.length === 1 ? "ply" : "plies"} into the analysis board`, { kind: "success" });
        }}
      />
    </div>
  );
}
