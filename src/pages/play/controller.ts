// GameController: one game on the Play page — engines, clocks, moves, endings, persistence.
//
// Framework-agnostic: React reads it through subscribe()/getState() (useSyncExternalStore), and
// everything it needs from the outside world (starting engines, saving games, persisting the
// in-progress game, the time) is injected, so the game loop is unit-tested with fake engines.
//
// The game loop: beginTurn() looks at the side to move. A human turn starts that side's clock and
// arms a flag timer; humanMove() ends it. An engine turn sends position() + go(), and the result
// is validated: an illegal move, no move or a crash loses the game; "timeout" with a clock is a
// flag fall. Every async step carries the turn's generation number, so results that arrive after
// a takeback, pause, abort or dispose are ignored.
import { ChessGame, type MoveInput } from "@/chess";
import { toSearchLimits } from "@/engine-host/limits";
import type { CompileDiagnostic, EngineCapabilities, GameRecord, SearchInfo, SearchLimits, SearchResult } from "@/types";
import { formatDuration } from "@/utils/format";
import { chargeMove, movesBySide, remainingAt } from "./clock";
import {
  buildGameRecord,
  endByAbort,
  endByAgreement,
  endByEngineError,
  endByIllegalMove,
  endByResign,
  endByRules,
  endByTimeout,
  engineDrawDecision,
  evalForRecord,
  MATE_CP,
  scoreOf,
  toWhiteScore,
} from "./rules";
import { SIDES, otherSide, type GameEnd, type GameSetup, type PersistedGame, type PlayerMeta, type ResolvedStart, type Score, type Side } from "./types";

// --- dependencies ----------------------------------------------------------------------------

/** What the controller needs from an engine (EngineClient implements it). */
export interface EngineHandle {
  readonly capabilities: EngineCapabilities;
  newGame(): Promise<void>;
  position(startFen: string, moves: string[]): Promise<boolean>;
  go(limits: SearchLimits, onInfo?: (info: SearchInfo) => void): Promise<SearchResult>;
  stop(): void;
  terminate(): void;
}

export interface LoadEngineOptions {
  hashMb?: number;
  label: string;
  onLog: (line: string) => void;
  onStatus: (status: string) => void;
}

export interface ControllerDeps {
  /** Builds (if needed) and starts an engine; rejects with BuildError or a user-facing Error. */
  loadEngine(engineId: string, opts: LoadEngineOptions): Promise<EngineHandle>;
  saveGame(record: GameRecord): Promise<void>;
  /** Stores the in-progress game (null clears it). */
  persist(game: PersistedGame): void;
  /** Monotonic milliseconds (performance.now). */
  now(): number;
  /** Wall-clock milliseconds (Date.now). */
  wallNow(): number;
  newId(): string;
}

// --- state -----------------------------------------------------------------------------------

export type GamePhase =
  /** Building / starting the engines. */
  | "loading"
  /** Restored after a reload or after leaving the page; waiting for resume(). */
  | "interrupted"
  | "playing"
  /** Engine vs engine, paused by the user. */
  | "paused"
  | "finished"
  /** The engines could not be started. */
  | "failed";

export type EngineStatus = "loading" | "waiting" | "thinking" | "stopped" | "error";

export interface EngineView {
  status: EngineStatus;
  /** Build / start progress ("Compiling…"). */
  statusText: string | null;
  /** Latest info of the current or last search. */
  info: SearchInfo | null;
  /** FEN of the position `info` belongs to (for the PV in SAN and arrows). */
  infoFen: string | null;
  /** Last score the engine reported, from its own point of view. */
  score: Score | null;
  /** Engine console (cb_log output and host / play notes). */
  logs: readonly string[];
  capabilities: EngineCapabilities | null;
}

export interface LoadFailure {
  side: Side;
  engineId: string | null;
  name: string;
  message: string;
  /** Compiler diagnostics when the engine failed to build. */
  diagnostics: CompileDiagnostic[] | null;
}

export interface SaveState {
  status: "idle" | "saving" | "saved" | "error" | "skipped";
  error?: string;
}

export interface Notice {
  kind: "info" | "warn";
  text: string;
  /** Changes with every notice, so the UI can re-show identical texts. */
  id: number;
}

export interface GameState {
  readonly id: string;
  readonly createdAt: number;
  readonly setup: GameSetup;
  readonly players: Readonly<Record<Side, PlayerMeta>>;
  readonly startFen: string;
  readonly bookPlies: number;
  readonly opening: string | null;
  readonly moves: readonly string[];
  readonly san: readonly string[];
  readonly fen: string;
  readonly turn: Side;
  readonly phase: GamePhase;
  /** Remaining ms per side as of `clockAt`; null = no clock. */
  readonly clock: Readonly<Record<Side, number | null>>;
  /** The clock currently counting down (from clock[running] since clockAt). */
  readonly running: Side | null;
  readonly clockAt: number;
  readonly engines: Readonly<Record<Side, EngineView | null>>;
  readonly evals: ReadonlyArray<number | null>;
  /** Engine score after each ply, White's point of view (null = human / book move). */
  readonly whiteScores: ReadonlyArray<Score | null>;
  readonly times: readonly number[];
  /** Latest engine score, White's point of view. */
  readonly liveEval: Score | null;
  readonly end: GameEnd | null;
  readonly save: SaveState;
  readonly loadError: LoadFailure | null;
  /** The failed load was a resume (offer "try again" rather than "back to setup"). */
  readonly resuming: boolean;
  readonly notice: Notice | null;
  readonly moveDelayMs: number;
  /** Plies a takeback would remove now (0 = not possible). */
  readonly takebackPlies: number;
}

interface Model {
  id: string;
  createdAt: number;
  setup: GameSetup;
  players: Record<Side, PlayerMeta>;
  startFen: string;
  bookPlies: number;
  opening: string | null;
  moves: string[];
  san: string[];
  phase: GamePhase;
  clock: Record<Side, number | null>;
  running: Side | null;
  clockAt: number;
  engines: Record<Side, EngineView | null>;
  evals: Array<number | null>;
  whiteScores: Array<Score | null>;
  times: number[];
  liveEval: Score | null;
  end: GameEnd | null;
  save: SaveState;
  savedGameId: string | null;
  loadError: LoadFailure | null;
  resuming: boolean;
  notice: Notice | null;
  moveDelayMs: number;
}

const LOG_LIMIT = 400;
/** Engine infos and logs are coalesced into one update per this many ms. */
const INFO_EMIT_MS = 100;
/** While a clock runs, the game is persisted this often (so a reload loses little time). */
export const PERSIST_INTERVAL_MS = 5000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function diagnosticsOf(err: unknown): CompileDiagnostic[] | null {
  const result = (err as { result?: { diagnostics?: unknown } } | null)?.result;
  return result && Array.isArray(result.diagnostics) ? (result.diagnostics as CompileDiagnostic[]) : null;
}

/** A stored White-POV eval (mate = ±10000) as a score; the mate distance is unknown then. */
function scoreFromEval(v: number | null): Score | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.abs(v) >= MATE_CP ? { cp: v > 0 ? MATE_CP : -MATE_CP, mate: null } : { cp: v, mate: null };
}

/** The most recent non-null score of a per-ply list. */
function lastScore(scores: ReadonlyArray<Score | null>): Score | null {
  for (let i = scores.length - 1; i >= 0; i--) if (scores[i]) return scores[i];
  return null;
}

function emptyEngineView(): EngineView {
  return { status: "loading", statusText: null, info: null, infoFen: null, score: null, logs: [], capabilities: null };
}

export interface StartOptions {
  setup: GameSetup;
  players: Record<Side, PlayerMeta>;
  start: ResolvedStart;
  moveDelayMs: number;
}

export class GameController {
  private m: Model;
  private game: ChessGame;
  private snapshot: GameState;
  private readonly listeners = new Set<() => void>();
  private readonly clients: Record<Side, EngineHandle | null> = { w: null, b: null };

  /** Bumped whenever the current turn is abandoned (move made, takeback, pause, end, dispose). */
  private turnGen = 0;
  /** Bumped whenever an engine load is abandoned. */
  private loadGen = 0;
  /** When the side to move started its turn (monotonic); null between turns. */
  private turnStartedAt: number | null = null;
  private flagTimer: ReturnType<typeof setTimeout> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private noticeId = 0;
  private disposed = false;

  private constructor(
    private readonly deps: ControllerDeps,
    model: Model,
    game: ChessGame,
  ) {
    this.m = model;
    this.game = game;
    this.snapshot = this.buildSnapshot();
  }

  /** A new game: starts the engines, then play begins. */
  static start(opts: StartOptions, deps: ControllerDeps): GameController {
    const game = ChessGame.fromMoves(opts.start.startFen, opts.start.moves);
    if (!game) throw new Error("The start position or its opening moves are not legal.");
    const now = deps.now();
    const model: Model = {
      id: deps.newId(),
      createdAt: deps.wallNow(),
      setup: opts.setup,
      players: opts.players,
      startFen: game.startFen,
      bookPlies: opts.start.moves.length,
      opening: opts.start.opening,
      moves: game.history().uci,
      san: game.history().san,
      phase: "loading",
      clock: { w: opts.players.w.timeControl?.baseMs ?? null, b: opts.players.b.timeControl?.baseMs ?? null },
      running: null,
      clockAt: now,
      engines: { w: opts.players.w.kind === "engine" ? emptyEngineView() : null, b: opts.players.b.kind === "engine" ? emptyEngineView() : null },
      evals: opts.start.moves.map(() => null),
      whiteScores: opts.start.moves.map(() => null),
      times: opts.start.moves.map(() => 0),
      liveEval: null,
      end: null,
      save: { status: "idle" },
      savedGameId: null,
      loadError: null,
      resuming: false,
      notice: null,
      moveDelayMs: opts.moveDelayMs,
    };
    const c = new GameController(deps, model, game);
    void c.loadAndPlay(false);
    return c;
  }

  /** A game stored by an earlier visit: shown as it was, and resumed with resume(). Null if unusable. */
  static restore(p: PersistedGame, deps: ControllerDeps, moveDelayMs: number): GameController | null {
    const game = ChessGame.fromMoves(p.startFen, p.moves);
    if (!game) return null;
    const engineView = (side: Side): EngineView | null =>
      p.players[side].kind === "engine" ? { ...emptyEngineView(), status: p.end ? "stopped" : "waiting", score: p.scores[side] } : null;
    const model: Model = {
      id: p.id,
      createdAt: p.createdAt,
      setup: p.setup,
      players: p.players,
      startFen: game.startFen,
      bookPlies: Math.min(p.bookPlies, p.moves.length),
      opening: p.opening,
      moves: game.history().uci,
      san: game.history().san,
      phase: p.end ? "finished" : "interrupted",
      clock: { ...p.clock },
      running: null,
      clockAt: deps.now(),
      engines: { w: engineView("w"), b: engineView("b") },
      evals: [...p.evals],
      whiteScores: p.whiteScores && p.whiteScores.length === p.evals.length ? [...p.whiteScores] : p.evals.map(scoreFromEval),
      times: [...p.times],
      liveEval: null,
      end: p.end,
      save: p.savedGameId ? { status: "saved" } : p.saveSkipped ? { status: "skipped" } : { status: "idle" },
      savedGameId: p.savedGameId,
      loadError: null,
      resuming: false,
      notice: null,
      moveDelayMs,
    };
    // The last stored evaluation, so the eval bar is not empty after a reload.
    model.liveEval = lastScore(model.whiteScores);
    const c = new GameController(deps, model, game);
    // A game that ended while its save was still in flight: save it now (same id, idempotent).
    if (p.end && !p.savedGameId && !p.saveSkipped) void c.saveRecord();
    return c;
  }

  // --- React binding ---------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): GameState => this.snapshot;

  // --- commands --------------------------------------------------------------------------------

  /** A move by a human player. Returns false when it is not that player's turn or illegal. */
  humanMove(move: MoveInput | string): boolean {
    if (this.m.phase !== "playing" || this.delayTimer) return false;
    const side = this.game.turn();
    if (this.m.players[side].kind !== "human" || this.turnStartedAt === null) return false;
    if (!this.game.isLegal(move)) return false;
    const elapsed = this.deps.now() - this.turnStartedAt;
    const before = this.m.clock[side];
    if (before !== null && before - elapsed <= 0) {
      this.flag(side);
      return false;
    }
    const played = this.game.play(move);
    if (!played) return false;
    this.recordMove(side, played, elapsed, null);
    this.afterMove();
    return true;
  }

  /** The human (or, with two humans, the side to move) resigns. */
  resign(side?: Side): void {
    if (this.m.phase !== "playing" && this.m.phase !== "paused") return;
    const humans = this.humanSides();
    const loser = side ?? (humans.length === 1 ? humans[0] : this.game.turn());
    this.finish(endByResign(loser, this.names()));
  }

  /** A draw offer: two humans agree at once; an engine judges it on its last score. */
  offerDraw(): { accepted: boolean; message: string } {
    if (this.m.phase !== "playing") return { accepted: false, message: "The game is not running." };
    const humans = this.humanSides();
    if (humans.length === 2) {
      this.finish(endByAgreement());
      return { accepted: true, message: "Draw agreed." };
    }
    const engineSide = SIDES.find((s) => this.m.players[s].kind === "engine");
    if (humans.length !== 1 || !engineSide) return { accepted: false, message: "Draw offers need a human player." };
    const name = this.m.players[engineSide].name;
    const decision = engineDrawDecision(this.m.engines[engineSide]?.score ?? null, this.m.moves.length);
    if (decision.accept) {
      this.finish(endByAgreement(`${name} accepted your draw offer.`));
      return { accepted: true, message: `${name} accepts the draw.` };
    }
    const message = `${name} declines the draw: ${decision.reason}.`;
    this.setNotice("info", message);
    return { accepted: false, message };
  }

  /** Takes back the human's last move (and the engine's reply to it). */
  takeback(): boolean {
    const count = this.takebackCount();
    if (count === 0) return false;
    this.interruptTurn();
    for (let i = 0; i < count; i++) this.game.undo();
    const keep = this.m.moves.length - count;
    this.m.moves = this.game.history().uci;
    this.m.san = this.game.history().san;
    this.m.evals = this.m.evals.slice(0, keep);
    this.m.whiteScores = this.m.whiteScores.slice(0, keep);
    this.m.times = this.m.times.slice(0, keep);
    for (const s of SIDES) {
      const ev = this.m.engines[s];
      if (ev) this.m.engines[s] = { ...ev, status: "waiting", info: null, infoFen: null };
    }
    // The eval bar falls back to the last evaluation that is still part of the game.
    this.m.liveEval = lastScore(this.m.whiteScores);
    this.setNotice("info", count === 1 ? "Took back one move." : `Took back ${count} moves.`);
    this.persist();
    this.beginTurn();
    return true;
  }

  /** Engine vs engine: pause between / during moves (the thinking engine is stopped and its clock frozen). */
  pause(): void {
    if (this.m.phase !== "playing") return;
    this.interruptTurn();
    this.m.phase = "paused";
    this.stopPersistTimer();
    this.persist();
    this.emit();
  }

  /** Continues a paused game, reloads the engines of an interrupted (restored) game, or retries a failed start. */
  resume(): void {
    if (this.disposed) return;
    if (this.m.phase === "paused") {
      this.m.phase = "playing";
      this.emit();
      this.beginTurn();
      return;
    }
    if (this.m.phase === "interrupted") void this.loadAndPlay(true);
    else if (this.m.phase === "failed") void this.loadAndPlay(this.m.resuming);
  }

  /** Ends the game without a result (saved as "aborted" when moves were played). */
  abort(): void {
    if (this.m.phase === "finished") return;
    if (this.m.phase === "loading" || (this.m.phase === "failed" && !this.m.resuming)) {
      // Nothing was played yet: just stop loading.
      this.loadGen++;
      this.terminateEngines();
      this.m.phase = "finished";
      this.m.end = endByAbort();
      this.m.save = { status: "skipped" };
      this.emit();
      return;
    }
    this.finish(endByAbort());
  }

  setMoveDelay(ms: number): void {
    this.m.moveDelayMs = Math.max(0, Math.min(5000, Math.round(ms)));
    this.emit();
  }

  dismissNotice(): void {
    if (!this.m.notice) return;
    this.m.notice = null;
    this.emit();
  }

  /** Retries a failed save of the finished game. */
  retrySave(): void {
    if (this.m.end && this.m.save.status === "error") void this.saveRecord();
  }

  /** Writes the current state now (e.g. when the page is hidden), charging the running clock. */
  persistNow(): void {
    this.persist();
  }

  /** The persisted form now, or null while there is nothing worth storing (loading, failed, disposed). */
  snapshotNow(): PersistedGame | null {
    if (this.disposed || this.m.phase === "loading" || this.m.phase === "failed") return null;
    return this.toPersisted();
  }

  /** The game as a record (for PGN export while it is still running, use gamePgn). */
  currentRecord(): GameRecord | null {
    if (!this.m.end) return null;
    return this.record(this.m.end);
  }

  /** The finished game's id in the games store, once saved. */
  get savedGameId(): string | null {
    return this.m.savedGameId;
  }

  /** Stops everything. An unfinished game is persisted first, so it can be resumed later. */
  dispose(): void {
    if (this.disposed) return;
    if (this.m.phase === "playing" || this.m.phase === "paused" || this.m.phase === "interrupted") this.persist();
    this.disposed = true;
    this.turnGen++;
    this.loadGen++;
    this.clearTimers();
    this.stopPersistTimer();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.terminateEngines();
    this.listeners.clear();
  }

  // --- engines ---------------------------------------------------------------------------------

  private async loadAndPlay(resuming: boolean): Promise<void> {
    const gen = ++this.loadGen;
    this.m.phase = "loading";
    this.m.loadError = null;
    this.m.resuming = resuming;
    const sides = SIDES.filter((s) => this.m.players[s].kind === "engine" && !this.clients[s]);
    for (const s of sides) this.m.engines[s] = { ...(this.m.engines[s] ?? emptyEngineView()), status: "loading", statusText: "Preparing…" };
    this.emit();

    const results = await Promise.allSettled(sides.map((s) => this.loadSide(s, gen)));
    if (gen !== this.loadGen || this.disposed) return;
    const failedIndex = results.findIndex((r) => r.status === "rejected");
    if (failedIndex >= 0) {
      const side = sides[failedIndex];
      const err = (results[failedIndex] as PromiseRejectedResult).reason;
      this.terminateEngines();
      const p = this.m.players[side];
      this.m.loadError = { side, engineId: p.engineId, name: p.name, message: messageOf(err), diagnostics: diagnosticsOf(err) };
      for (const s of sides) {
        const ev = this.m.engines[s];
        if (ev) this.m.engines[s] = { ...ev, status: s === side ? "error" : "stopped", statusText: s === side ? "Could not start" : null };
      }
      this.m.phase = "failed";
      this.emit();
      return;
    }
    this.m.phase = "playing";
    this.emit();
    this.persist();
    this.beginTurn();
  }

  private async loadSide(side: Side, gen: number): Promise<void> {
    const p = this.m.players[side];
    if (!p.engineId) throw new Error(`No engine was chosen for ${side === "w" ? "White" : "Black"}.`);
    const client = await this.deps.loadEngine(p.engineId, {
      hashMb: p.hashMb ?? undefined,
      label: p.name,
      onLog: (line) => this.log(side, line),
      onStatus: (text) => {
        if (gen !== this.loadGen) return;
        this.patchEngine(side, { statusText: text });
        this.emitSoon();
      },
    });
    if (gen !== this.loadGen || this.disposed) {
      client.terminate();
      return;
    }
    this.clients[side] = client;
    this.patchEngine(side, { statusText: "Starting a new game…", capabilities: client.capabilities });
    await client.newGame();
    if (gen !== this.loadGen || this.disposed) return;
    this.patchEngine(side, { status: "waiting", statusText: null });
  }

  private terminateEngines(): void {
    for (const s of SIDES) {
      const c = this.clients[s];
      this.clients[s] = null;
      if (!c) continue;
      try {
        c.stop();
        c.terminate();
      } catch (err) {
        console.warn("[play] could not stop an engine", err);
      }
    }
  }

  // --- the game loop ---------------------------------------------------------------------------

  private beginTurn(): void {
    if (this.disposed || this.m.phase !== "playing") return;
    this.clearTimers();
    const outcome = this.game.outcome();
    if (outcome) {
      this.finish(endByRules(outcome));
      return;
    }
    const side = this.game.turn();
    const gen = ++this.turnGen;
    this.startPersistTimer();
    if (this.m.players[side].kind === "human") {
      this.startClock(side);
      this.armFlagTimer(side, gen);
      this.emit();
      return;
    }
    void this.engineTurn(side, gen);
  }

  private stale(gen: number): boolean {
    return gen !== this.turnGen || this.disposed || this.m.phase !== "playing";
  }

  private async engineTurn(side: Side, gen: number): Promise<void> {
    const client = this.clients[side];
    if (!client) {
      this.finish(endByEngineError(side, "is not running", this.names()));
      return;
    }
    const fen = this.game.fen();
    this.patchEngine(side, { status: "thinking", info: null, infoFen: fen });
    this.emit();
    let ok: boolean;
    try {
      ok = await client.position(this.m.startFen, [...this.m.moves]);
    } catch (err) {
      if (this.stale(gen)) return;
      this.finish(endByEngineError(side, `could not set up the position (${messageOf(err)})`, this.names()));
      return;
    }
    if (this.stale(gen)) return;
    if (!ok) {
      this.finish(endByEngineError(side, "rejected the position", this.names()));
      return;
    }
    this.startClock(side);
    const limits = this.searchLimits(side);
    this.emit();
    let result: SearchResult;
    try {
      result = await client.go(limits, (info) => this.onInfo(side, gen, info));
    } catch (err) {
      if (this.stale(gen)) return;
      this.finish(endByEngineError(side, `stopped working (${messageOf(err)})`, this.names()));
      return;
    }
    if (this.stale(gen)) return;
    this.onEngineResult(side, result);
  }

  private searchLimits(side: Side): SearchLimits {
    const p = this.m.players;
    return toSearchLimits({
      limits: p[side].limits,
      whiteTc: p.w.timeControl,
      blackTc: p.b.timeControl,
      whiteMs: this.m.clock.w,
      blackMs: this.m.clock.b,
      sideToMove: side,
      // Plies under the clock (book moves are not), so movestogo counts this side's own moves.
      movesPlayed: this.m.moves.length - this.m.bookPlies,
    });
  }

  private onInfo(side: Side, gen: number, info: SearchInfo): void {
    if (this.stale(gen)) return;
    const score = scoreOf(info);
    this.patchEngine(side, { info, score: score ?? this.m.engines[side]?.score ?? null });
    if (score) this.m.liveEval = toWhiteScore(score, side);
    this.emitSoon();
  }

  private onEngineResult(side: Side, result: SearchResult): void {
    const name = this.m.players[side].name;
    const used = this.deps.now() - (this.turnStartedAt ?? this.deps.now());
    const info = result.info ?? this.m.engines[side]?.info ?? null;
    const score = scoreOf(info) ?? this.m.engines[side]?.score ?? null;
    this.patchEngine(side, { status: "waiting", info, score });
    if (score) this.m.liveEval = toWhiteScore(score, side);

    if (result.stopReason === "error") {
      this.finish(endByEngineError(side, result.error ? `crashed: ${result.error}` : "crashed", this.names()));
      return;
    }
    // With a clock, the clock decides whether the move came in time. ("timeout" alone is not a flag
    // fall: the host also reports it when the engine overran its per-move cap with time left.)
    const before = this.m.clock[side];
    let charged = used;
    if (before !== null && before - charged <= 0) {
      if (result.stopReason !== "timeout" && result.elapsedMs < before) {
        // The engine answered in time and the page was slow to handle it: charge the engine's own
        // search time instead of the page's delay.
        charged = result.elapsedMs;
        this.log(side, `[play] The page was busy; charged ${name}'s own search time (${formatDuration(charged)}).`);
      } else {
        this.log(side, `[play] ${name} did not move within its remaining time.`);
        this.flag(side);
        return;
      }
    }
    if (!result.bestMove) {
      // The turn only starts when the game is not over, so legal moves exist.
      this.finish(endByEngineError(side, "produced no move", this.names()));
      return;
    }
    const played = this.game.play(result.bestMove);
    if (!played) {
      this.finish(endByIllegalMove(side, result.bestMove, this.names()));
      return;
    }
    if (result.stopReason === "timeout") {
      this.log(
        side,
        before === null
          ? `[play] ${name} overran its time limit (${formatDuration(used)}); the move was played anyway because this side has no clock.`
          : `[play] ${name} overran its per-move limit (${formatDuration(used)}); the move counts because its clock still had time.`,
      );
    }
    this.recordMove(side, played, charged, score);
    this.afterMove();
  }

  /** Clock, move lists, evals and times after a legal move by `side`. */
  private recordMove(side: Side, played: { uci: string; san: string }, elapsedMs: number, score: Score | null): void {
    const tc = this.m.players[side].timeControl;
    const before = this.m.clock[side];
    if (tc && before !== null) {
      const plies = this.m.moves.length + 1 - this.m.bookPlies;
      const completed = movesBySide(this.firstClockedSide(), plies, side);
      this.m.clock = { ...this.m.clock, [side]: chargeMove(tc, before, elapsedMs, completed).ms };
    }
    this.m.running = null;
    this.m.clockAt = this.deps.now();
    this.turnStartedAt = null;
    this.m.moves = [...this.m.moves, played.uci];
    this.m.san = [...this.m.san, played.san];
    this.m.evals = [...this.m.evals, evalForRecord(score, side)];
    this.m.whiteScores = [...this.m.whiteScores, toWhiteScore(score, side)];
    this.m.times = [...this.m.times, Math.max(0, Math.round(elapsedMs))];
    this.m.notice = null;
  }

  private afterMove(): void {
    this.clearTimers();
    this.turnGen++;
    this.persist();
    if (this.game.outcome()) {
      this.beginTurn(); // ends the game
      return;
    }
    const delay = this.humanSides().length === 0 ? this.m.moveDelayMs : 0;
    if (delay > 0) {
      this.emit();
      this.delayTimer = setTimeout(() => {
        this.delayTimer = null;
        this.beginTurn();
      }, delay);
      return;
    }
    this.beginTurn();
  }

  private startClock(side: Side): void {
    const now = this.deps.now();
    this.turnStartedAt = now;
    this.m.running = this.m.clock[side] !== null ? side : null;
    this.m.clockAt = now;
  }

  private armFlagTimer(side: Side, gen: number): void {
    const ms = this.m.clock[side];
    if (ms === null) return;
    const check = () => {
      this.flagTimer = null;
      if (this.stale(gen) || this.turnStartedAt === null) return;
      const left = ms - (this.deps.now() - this.turnStartedAt);
      if (left <= 0) this.flag(side);
      else this.flagTimer = setTimeout(check, left + 5);
    };
    this.flagTimer = setTimeout(check, Math.max(0, ms) + 5);
  }

  private flag(side: Side): void {
    this.m.clock = { ...this.m.clock, [side]: 0 };
    this.m.running = null;
    this.turnStartedAt = null;
    this.finish(endByTimeout(side, this.game.fen(), this.names()));
  }

  /** Abandons the current turn: stops the thinking engine and freezes the running clock. */
  private interruptTurn(): void {
    this.turnGen++;
    this.clearTimers();
    const running = this.m.running;
    const now = this.deps.now();
    if (running && this.turnStartedAt !== null) {
      const ms = this.m.clock[running];
      if (ms !== null) this.m.clock = { ...this.m.clock, [running]: remainingAt(ms, this.turnStartedAt, now) };
    }
    this.m.running = null;
    this.m.clockAt = now;
    this.turnStartedAt = null;
    for (const s of SIDES) {
      if (this.m.engines[s]?.status === "thinking") {
        this.clients[s]?.stop();
        this.patchEngine(s, { status: "waiting" });
      }
    }
  }

  private finish(end: GameEnd): void {
    if (this.m.phase === "finished" || this.disposed) return;
    this.interruptTurn();
    this.stopPersistTimer();
    this.m.phase = "finished";
    this.m.end = end;
    this.m.notice = null;
    this.terminateEngines();
    for (const s of SIDES) {
      const ev = this.m.engines[s];
      if (ev) this.m.engines[s] = { ...ev, status: ev.status === "error" ? "error" : "stopped", statusText: null };
    }
    this.emit();
    this.persist();
    void this.saveRecord();
  }

  private record(end: GameEnd): GameRecord {
    return buildGameRecord({
      id: this.m.id,
      createdAt: this.m.createdAt,
      players: this.m.players,
      startFen: this.m.startFen,
      moves: this.m.moves,
      opening: this.m.opening,
      evals: this.m.evals,
      times: this.m.times,
      end,
    });
  }

  private async saveRecord(): Promise<void> {
    const end = this.m.end;
    if (!end) return;
    if (end.termination === "aborted" && this.m.moves.length <= this.m.bookPlies) {
      this.m.save = { status: "skipped" };
      this.emit();
      this.persist();
      return;
    }
    this.m.save = { status: "saving" };
    this.emit();
    try {
      await this.deps.saveGame(this.record(end));
      this.m.savedGameId = this.m.id;
      this.m.save = { status: "saved" };
    } catch (err) {
      this.m.save = { status: "error", error: messageOf(err) };
    }
    if (this.disposed) return;
    this.emit();
    this.persist();
  }

  // --- helpers ---------------------------------------------------------------------------------

  private humanSides(): Side[] {
    return SIDES.filter((s) => this.m.players[s].kind === "human");
  }

  private names(): Record<Side, string> {
    return { w: this.m.players.w.name, b: this.m.players.b.name };
  }

  /** Side to move when the clocked part of the game began (after the book moves). */
  private firstClockedSide(): Side {
    const startTurn: Side = this.m.startFen.split(" ")[1] === "b" ? "b" : "w";
    return this.m.bookPlies % 2 === 0 ? startTurn : otherSide(startTurn);
  }

  private takebackCount(): number {
    if (this.m.phase !== "playing" || this.delayTimer) return 0;
    const humans = this.humanSides();
    if (humans.length === 0) return 0;
    const played = this.m.moves.length - this.m.bookPlies;
    if (played <= 0) return 0;
    if (humans.length === 2) return 1;
    // Human to move: undo the engine's reply and the human's move before it.
    if (this.game.turn() === humans[0]) return played >= 2 ? 2 : 0;
    // Engine to move (thinking): undo the human's last move.
    return 1;
  }

  private patchEngine(side: Side, patch: Partial<EngineView>): void {
    const ev = this.m.engines[side];
    if (ev) this.m.engines[side] = { ...ev, ...patch };
  }

  private log(side: Side, line: string): void {
    const ev = this.m.engines[side];
    if (!ev || this.disposed) return;
    const logs = ev.logs.length >= LOG_LIMIT ? [...ev.logs.slice(ev.logs.length - LOG_LIMIT + 1), line] : [...ev.logs, line];
    this.m.engines[side] = { ...ev, logs };
    this.emitSoon();
  }

  private setNotice(kind: Notice["kind"], text: string): void {
    this.m.notice = { kind, text, id: ++this.noticeId };
    this.emit();
  }

  private clearTimers(): void {
    if (this.flagTimer) clearTimeout(this.flagTimer);
    if (this.delayTimer) clearTimeout(this.delayTimer);
    this.flagTimer = null;
    this.delayTimer = null;
  }

  private startPersistTimer(): void {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => {
      if (this.m.running) this.persist();
    }, PERSIST_INTERVAL_MS);
  }

  private stopPersistTimer(): void {
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persistTimer = null;
  }

  /** The persisted form; the running clock is charged up to now. */
  toPersisted(): PersistedGame {
    const clock = { ...this.m.clock };
    if (this.m.running && this.turnStartedAt !== null) {
      const ms = clock[this.m.running];
      if (ms !== null) clock[this.m.running] = remainingAt(ms, this.turnStartedAt, this.deps.now());
    }
    return {
      v: 1,
      id: this.m.id,
      createdAt: this.m.createdAt,
      setup: this.m.setup,
      players: this.m.players,
      startFen: this.m.startFen,
      bookPlies: this.m.bookPlies,
      opening: this.m.opening,
      moves: [...this.m.moves],
      evals: [...this.m.evals],
      whiteScores: [...this.m.whiteScores],
      times: [...this.m.times],
      clock,
      scores: { w: this.m.engines.w?.score ?? null, b: this.m.engines.b?.score ?? null },
      end: this.m.end,
      savedGameId: this.m.savedGameId,
      saveSkipped: this.m.save.status === "skipped",
      updatedAt: this.deps.wallNow(),
    };
  }

  private persist(): void {
    if (this.disposed || this.m.phase === "loading" || this.m.phase === "failed") return;
    try {
      this.deps.persist(this.toPersisted());
    } catch (err) {
      console.error("[play] could not store the game", err);
    }
  }

  private buildSnapshot(): GameState {
    const m = this.m;
    return {
      id: m.id,
      createdAt: m.createdAt,
      setup: m.setup,
      players: m.players,
      startFen: m.startFen,
      bookPlies: m.bookPlies,
      opening: m.opening,
      moves: m.moves,
      san: m.san,
      fen: this.game.fen(),
      turn: this.game.turn(),
      phase: m.phase,
      clock: m.clock,
      running: m.running,
      clockAt: m.clockAt,
      engines: { w: m.engines.w, b: m.engines.b },
      evals: m.evals,
      whiteScores: m.whiteScores,
      times: m.times,
      liveEval: m.liveEval,
      end: m.end,
      save: m.save,
      loadError: m.loadError,
      resuming: m.resuming,
      notice: m.notice,
      moveDelayMs: m.moveDelayMs,
      takebackPlies: this.takebackCount(),
    };
  }

  private emit(): void {
    if (this.disposed) return;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.snapshot = this.buildSnapshot();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("[play] listener failed", err);
      }
    }
  }

  private emitSoon(): void {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, INFO_EMIT_MS);
  }
}
