// MatchRunner: executes one match in this tab.
//
//   prepare  — mark the record "running", build every participant engine once (a build error
//              pauses the match with a clear lastError);
//   play     — up to `concurrency` slots; each slot takes the next unplayed game of the schedule,
//              gets two engines from its pool (an engine is reused across games when it is the
//              same, with newGame() in between), plays it with runEngineGame and records it;
//   stop     — pause / abort / delete: abort the running games (they are replayed on resume),
//              terminate every engine, write the final status.
//
// After every game the result is appended to MatchRecord.results (and the GameRecord saved when
// config.saveGames), so a match interrupted at any point resumes where it was.
//
// Engines come from injected dependencies (the service passes loadEngine-based ones), which keeps
// this module free of workers so it can be tested in Node with fake engines.
import { clearActivity, setActivity } from "@/app/activity";
import { INFO_RATE_NOTE_PREFIX } from "@/engine-host/info-throttle";
import { ALL_RECORDS, subscribe } from "@/storage/events";
import { newId } from "@/storage/id";
import { enginesRepo, gamesRepo, matchesRepo } from "@/storage/repos";
import type { EngineRecord, GameRecord, MatchConfig, MatchRecord, ParticipantConfig } from "@/types";
import { runEngineGame } from "./game";
import { appendLiveLog, matchExtras, patchLiveMatch } from "./live";
import { buildSlots, withOpening, type ScheduledSlot } from "./schedule";
import { participantLabels } from "./standings";
import type { ArenaGameSummary, ArenaLogEntry, ArenaMatchExtras, GameEngine, LiveGameView, PlayedGame } from "./types";

/** An engine instance the runner owns (EngineClient fits). */
export interface PoolEngine extends GameEngine {
  terminate(): void;
  readonly alive: boolean;
}

export interface RunnerDeps {
  /** Builds the engine if needed. Throws an Error with a user-facing message (e.g. a BuildError). */
  prepare(engineId: string, onStatus: (status: string) => void): Promise<void>;
  /** Starts one engine instance. */
  load(engineId: string, opts: { hashMb?: number; label: string; onLog: (line: string) => void }): Promise<PoolEngine>;
}

export interface RunnerHooks {
  onFinished?(record: MatchRecord, labels: string[]): void;
  /** The match stopped because of an error (it is paused with lastError). */
  onError?(record: MatchRecord | null, message: string): void;
}

export type StopKind = "paused" | "aborted" | "deleted";

/** Live UI updates are batched to at most one store write per this many ms. */
const LIVE_FLUSH_MS = 100;
/** How long stop() waits for games to wind down before terminating the engines regardless. */
const STOP_GRACE_MS = 3_000;
/**
 * While running, the record is touched this often. initArenaService() adds (updatedAt −
 * runningSince) to the running time of a match whose tab closed, so long games are not lost.
 */
const HEARTBEAT_MS = 10_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The engine worker's note that an engine reports search info far too often
 * (src/engine-host/info-throttle.ts). Each new engine worker can give it again.
 */
const isInfoRateNote = (line: string): boolean => line.startsWith(INFO_RATE_NOTE_PREFIX);

/** An engine failed to build or start; remembers which one, so the UI can link to it. */
class EngineFailure extends Error {
  constructor(
    message: string,
    readonly engineId: string,
  ) {
    super(message);
    this.name = "EngineFailure";
  }
}

class StopSignal extends Error {
  constructor() {
    super("stopped");
    this.name = "StopSignal";
  }
}

interface PoolItem {
  engineId: string;
  hashMb: number | undefined;
  engine: PoolEngine;
}

/** The engines of one board slot, reused between games when possible. */
class SlotPool {
  private items: PoolItem[] = [];
  constructor(
    private readonly deps: RunnerDeps,
    private readonly signal: AbortSignal,
    private readonly nameOf: (engineId: string) => string,
    private readonly onLog: (name: string, line: string) => void,
  ) {}

  async acquire(sides: readonly ParticipantConfig[]): Promise<PoolEngine[]> {
    const free = this.items.slice();
    const chosen: Array<PoolItem | null> = sides.map((s) => {
      const i = free.findIndex((it) => it.engineId === s.engineId && it.hashMb === s.hashMb && it.engine.alive);
      return i >= 0 ? free.splice(i, 1)[0] : null;
    });
    for (const it of free) it.engine.terminate(); // not needed for this game
    this.items = chosen.filter((c): c is PoolItem => c !== null);
    for (let k = 0; k < sides.length; k++) {
      if (chosen[k]) continue;
      if (this.signal.aborted) throw new StopSignal();
      const { engineId, hashMb } = sides[k];
      const name = this.nameOf(engineId);
      let engine: PoolEngine;
      try {
        engine = await this.deps.load(engineId, { hashMb, label: name, onLog: (line) => this.onLog(name, line) });
      } catch (err) {
        throw new EngineFailure(messageOf(err), engineId);
      }
      const item = { engineId, hashMb, engine };
      this.items.push(item); // from now on terminateAll() covers it
      chosen[k] = item;
      if (this.signal.aborted) throw new StopSignal();
    }
    return chosen.map((c) => c!.engine);
  }

  terminateAll(): void {
    for (const it of this.items) {
      try {
        it.engine.terminate();
      } catch (err) {
        console.error("Could not terminate an engine", err);
      }
    }
    this.items = [];
  }
}

export class MatchRunner {
  /** Resolves once the match is marked "running" (rejects when it could not start at all). */
  readonly started: Promise<void>;
  /** Resolves when the runner has finished or stopped and cleaned up. */
  readonly done: Promise<void>;

  private resolveStarted!: () => void;
  private rejectStarted!: (err: Error) => void;
  private resolveDone!: () => void;
  private hasStarted = false;
  private runCalled = false;

  private readonly controller = new AbortController();
  private stopKind: StopKind | null = null;
  private lastError: string | null = null;
  private lastErrorEngineId: string | null = null;

  private record: MatchRecord | null = null;
  private config!: MatchConfig;
  private labels: string[] = [];
  private engineNames = new Map<string, string>();
  private slots: ScheduledSlot[] = [];
  private results: ArenaGameSummary[] = [];
  private queue: ScheduledSlot[] = [];
  private sessionStart = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private pools: SlotPool[] = [];

  // Live state batching.
  private views: Array<LiveGameView | null> = [];
  private pendingLog: ArenaLogEntry[] = [];
  /** Engines whose report-rate note (isInfoRateNote) was logged already. */
  private notedEngines = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly matchId: string,
    private readonly deps: RunnerDeps,
    private readonly hooks: RunnerHooks = {},
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // Callers that only await `done` must not see an unhandled rejection.
    this.started.catch(() => undefined);
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  get stopping(): boolean {
    return this.stopKind !== null;
  }

  /** Requests a stop; resolves when the runner is done. The first request wins. */
  stop(kind: StopKind): Promise<void> {
    if (!this.stopKind) {
      this.stopKind = kind;
      this.controller.abort();
      patchLiveMatch(this.matchId, { phase: "stopping", status: kind === "aborted" ? "Aborting…" : kind === "deleted" ? "Deleting…" : "Pausing…" });
      // Engines that do not answer the stop request in time are terminated (their games end).
      setTimeout(() => this.terminatePools(), STOP_GRACE_MS);
    }
    if (!this.runCalled) this.resolveDone();
    return this.done;
  }

  /** Runs the match until it finishes or stop() is called. Call once. */
  async run(): Promise<void> {
    if (this.runCalled) return this.done;
    this.runCalled = true;
    try {
      await this.prepare();
      if (!this.stopKind) await this.play();
    } catch (err) {
      if (!(err instanceof StopSignal)) this.fail(messageOf(err), err instanceof EngineFailure ? err.engineId : null);
    } finally {
      await this.finish();
    }
  }

  // --- phases ----------------------------------------------------------------------------------

  private async prepare(): Promise<void> {
    const record = await matchesRepo.get(this.matchId);
    if (!record) throw this.startError("This match no longer exists.");
    if (record.status === "finished") throw this.startError("This match is already finished.");
    this.record = record;
    this.config = record.config;
    this.slots = buildSlots(this.config);
    // One result per schedule index (defensive against duplicates in old records).
    const seen = new Set<number>();
    this.results = (record.results as ArenaGameSummary[]).filter((r) => r.index < this.slots.length && !seen.has(r.index) && seen.add(r.index));

    const ids = [...new Set(this.config.participants.map((p) => p.engineId))];
    const engines = new Map<string, EngineRecord | undefined>();
    for (const id of ids) engines.set(id, await enginesRepo.get(id));
    for (const [id, e] of engines) this.engineNames.set(id, e?.name ?? "Deleted engine");
    this.labels = participantLabels(this.config, (id) => engines.get(id)?.name);

    this.sessionStart = Date.now();
    const extras: ArenaMatchExtras = { lastError: null, lastErrorEngineId: null, interrupted: false, runningSince: this.sessionStart };
    await this.writeRecord({ status: "running", totalGames: this.slots.length, ...extras });
    this.hasStarted = true;
    this.resolveStarted();

    this.heartbeat = setInterval(() => {
      if (this.stopKind) return;
      this.writeChain = this.writeChain.then(() => this.writeRecord({}).then(() => undefined)).catch(() => undefined);
    }, HEARTBEAT_MS);
    this.unsubscribe = subscribe("matches", (e) => {
      if (e.op === "delete" && (e.id === this.matchId || e.id === ALL_RECORDS)) void this.checkDeleted();
    });
    patchLiveMatch(this.matchId, {
      running: true,
      games: [],
      lastError: null,
      phase: "preparing",
      status: "Preparing the engines…",
      startedAt: this.sessionStart,
    });
    this.updateActivity();
    this.log("info", `Match started (${this.results.length} of ${this.slots.length} games already played).`);

    for (const id of ids) {
      if (this.stopKind) throw new StopSignal();
      const engine = engines.get(id);
      if (!engine) {
        const n = this.config.participants.findIndex((p) => p.engineId === id) + 1;
        throw new Error(`An engine in this match (participant ${n}) has been deleted. Start a new match without it.`);
      }
      patchLiveMatch(this.matchId, { status: `Preparing ${engine.name}…` });
      try {
        await this.deps.prepare(id, (s) => patchLiveMatch(this.matchId, { status: `${engine.name}: ${s}` }));
      } catch (err) {
        throw new EngineFailure(messageOf(err), id);
      }
    }
  }

  private async play(): Promise<void> {
    const done = new Set(this.results.map((r) => r.index));
    this.queue = this.slots.filter((s) => !done.has(s.index));
    if (this.queue.length === 0) return;
    const concurrency = Math.max(1, Math.min(Math.floor(this.config.concurrency) || 1, this.queue.length));
    this.views = new Array(concurrency).fill(null);
    patchLiveMatch(this.matchId, { phase: "playing", status: "Playing" });
    const loops: Promise<void>[] = [];
    for (let s = 0; s < concurrency; s++) loops.push(this.slotLoop(s));
    await Promise.all(loops);
  }

  private async slotLoop(slot: number): Promise<void> {
    const pool = new SlotPool(
      this.deps,
      this.controller.signal,
      (id) => this.engineNames.get(id) ?? "engine",
      (name, line) => this.engineLog(name, line),
    );
    this.pools.push(pool);
    try {
      while (!this.stopKind) {
        const next = this.queue.shift();
        if (!next) break;
        const white = this.config.participants[next.white];
        const black = this.config.participants[next.black];
        let engines: PoolEngine[];
        try {
          engines = await pool.acquire([white, black]);
        } catch (err) {
          if (err instanceof StopSignal || this.stopKind) break;
          const message = `Could not start the engines for game ${next.index + 1} (${this.labels[next.white]} vs ${this.labels[next.black]}): ${messageOf(err)}`;
          throw err instanceof EngineFailure ? new EngineFailure(message, err.engineId) : new Error(message);
        }
        if (this.stopKind) break;
        const game = withOpening(this.config, next);
        const played = await runEngineGame(
          {
            white: { engineId: white.engineId, name: this.labels[next.white], config: white },
            black: { engineId: black.engineId, name: this.labels[next.black], config: black },
            startFen: game.startFen,
            openingMoves: game.openingMoves,
            opening: game.opening,
            eco: game.eco,
            adjudication: this.config.adjudication,
            signal: this.controller.signal,
            event: this.config.name,
            round: String(next.index + 1),
            onUpdate: (view) => this.setView(slot, { ...view, slot, index: next.index }),
            onLog: (level, text) => this.log(level, `Game ${next.index + 1}: ${text}`),
          },
          { white: engines[0], black: engines[1] },
        );
        if (played.termination === "aborted") break; // stopping: the game is replayed on resume
        // Keep the final position (with its result) on the board until the slot's next game starts.
        const last = this.views[slot];
        if (last && last.index === next.index) this.setView(slot, { ...last, result: played.result, thinking: null });
        await this.recordGame(next, played);
      }
    } catch (err) {
      if (!(err instanceof StopSignal) && !this.stopKind) this.fail(messageOf(err), err instanceof EngineFailure ? err.engineId : null);
    } finally {
      pool.terminateAll();
      this.setView(slot, null);
    }
  }

  private async finish(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.terminatePools();
    try {
      await this.writeChain;
    } catch {
      /* reported by fail() already */
    }
    const id = this.matchId;
    if (!this.hasStarted) {
      // Never got going (missing record, finished, or the first write failed).
      this.rejectStarted(new Error(this.lastError ?? "The match could not be started."));
      patchLiveMatch(id, { running: false, phase: "stopped", status: null, games: [], lastError: this.lastError });
      this.resolveDone();
      return;
    }
    clearActivity(`arena:${id}`);
    const kind = this.stopKind;
    const complete = this.results.length >= this.slots.length;
    let record: MatchRecord | null = null;
    if (kind !== "deleted") {
      const session = Math.max(0, Date.now() - this.sessionStart);
      const previous = this.record ? (matchExtras(this.record).elapsedMs ?? 0) : 0;
      const status = kind === "aborted" ? "aborted" : !kind && complete ? "finished" : "paused";
      const extras: ArenaMatchExtras = {
        runningSince: null,
        elapsedMs: previous + session,
        lastError: this.lastError,
        lastErrorEngineId: this.lastError ? this.lastErrorEngineId : null,
        interrupted: false,
        ...(status === "finished" ? { finishedAt: Date.now() } : {}),
      };
      try {
        record = await this.writeRecord({ status, ...extras });
      } catch (err) {
        console.error("Could not save the match status", err);
      }
      if (status === "finished" && record) this.safeHook(() => this.hooks.onFinished?.(record!, this.labels));
      this.log(status === "finished" ? "info" : this.lastError ? "error" : "info", status === "finished" ? "Match finished." : status === "aborted" ? "Match aborted." : this.lastError ? `Match paused: ${this.lastError}` : "Match paused.");
    }
    this.flushLive();
    patchLiveMatch(id, { running: false, phase: "stopped", status: null, games: [], lastError: this.lastError });
    if (this.lastError) this.safeHook(() => this.hooks.onError?.(record ?? this.record, this.lastError!));
    this.resolveDone();
  }

  // --- results & persistence -------------------------------------------------------------------

  private recordGame(slot: ScheduledSlot, played: PlayedGame): Promise<void> {
    const white = this.config.participants[slot.white];
    const black = this.config.participants[slot.black];
    const summary: ArenaGameSummary = {
      index: slot.index,
      whiteId: white.engineId,
      blackId: black.engineId,
      result: played.result,
      termination: played.termination,
      plies: played.moves.length,
      gameId: null,
      opening: played.opening,
      detail: played.detail ?? null,
      finishedAt: Date.now(),
    };
    const write = async () => {
      if (this.stopKind === "deleted") return;
      if (this.config.saveGames) {
        const game: GameRecord = {
          id: newId(),
          createdAt: Date.now(),
          white: { type: "engine", engineId: white.engineId, name: this.labels[slot.white] },
          black: { type: "engine", engineId: black.engineId, name: this.labels[slot.black] },
          startFen: played.startFen,
          moves: played.moves,
          san: played.san,
          result: played.result,
          termination: played.termination,
          pgn: played.pgn,
          matchId: this.matchId,
          opening: played.opening,
          timeControl: { white: white.timeControl, black: black.timeControl },
          evals: played.evals,
          times: played.times,
        };
        await gamesRepo.put(game);
        summary.gameId = game.id;
      }
      this.results.push(summary);
      await this.writeRecord({ results: this.results.slice() });
      this.updateActivity();
    };
    const next = this.writeChain.then(write);
    this.writeChain = next.catch((err: unknown) => {
      if (this.stopKind === "deleted") return;
      this.fail(`Could not save game ${slot.index + 1}: ${messageOf(err)}`);
    });
    return this.writeChain;
  }

  private async writeRecord(patch: Partial<MatchRecord> & ArenaMatchExtras): Promise<MatchRecord> {
    const updated = await matchesRepo.update(this.matchId, patch as Partial<MatchRecord>);
    this.record = updated;
    return updated;
  }

  private async checkDeleted(): Promise<void> {
    try {
      if (!(await matchesRepo.get(this.matchId))) void this.stop("deleted");
    } catch {
      /* ignore: the next write reports storage problems */
    }
  }

  private fail(message: string, engineId: string | null = null): void {
    if (this.stopKind === "deleted") return;
    if (!this.lastError) {
      this.lastError = message;
      this.lastErrorEngineId = engineId;
    }
    this.log("error", message);
    if (!this.hasStarted) {
      this.stopKind ??= "paused";
      return;
    }
    void this.stop("paused");
  }

  private startError(message: string): Error {
    this.lastError = message;
    return new Error(message);
  }

  private terminatePools(): void {
    for (const p of this.pools) p.terminateAll();
  }

  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error("Arena hook failed", err);
    }
  }

  // --- live state ------------------------------------------------------------------------------

  private updateActivity(): void {
    if (!this.record || this.stopKind) return;
    const total = this.slots.length;
    const done = this.results.length;
    setActivity({
      id: `arena:${this.matchId}`,
      kind: "arena",
      label: this.config.name,
      detail: `${done} / ${total} games`,
      progress: total > 0 ? done / total : null,
      href: `/arena/${this.matchId}`,
    });
  }

  private setView(slot: number, view: LiveGameView | null): void {
    if (slot < this.views.length) this.views[slot] = view;
    this.scheduleFlush();
  }

  /**
   * A log line from an engine's worker. The host's note that an engine reports search info far
   * too often comes once per engine worker, and a match starts many of them (a new pair whenever
   * the engines of a board change), so it is shown once per engine and session.
   */
  private engineLog(name: string, line: string): void {
    if (isInfoRateNote(line)) {
      if (this.notedEngines.has(name)) return;
      this.notedEngines.add(name);
      this.log("warn", `${name}: ${line} (shown once)`);
      return;
    }
    this.log(line.startsWith("[host]") ? "warn" : "info", `${name}: ${line}`);
  }

  private log(level: ArenaLogEntry["level"], text: string): void {
    this.pendingLog.push({ at: Date.now(), level, text });
    if (this.pendingLog.length > 500) this.pendingLog.splice(0, this.pendingLog.length - 500);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushLive(), LIVE_FLUSH_MS);
  }

  private flushLive(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingLog.length > 0) {
      appendLiveLog(this.matchId, this.pendingLog);
      this.pendingLog = [];
    }
    if (!this.stopKind || this.views.some(Boolean)) {
      patchLiveMatch(this.matchId, { games: this.views.filter((v): v is LiveGameView => v !== null) });
    }
  }
}
