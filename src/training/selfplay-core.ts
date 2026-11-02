// Self-play and gating games, independent of the worker global so they can run (and be tested)
// in Node. selfplay.worker.ts wires createSelfPlayWorkerHandler() to `self`.
//
// Self-play: ONE engine instance plays both sides (newGame() per game). Every game starts with a
// random opening of `randomPlies` legal plies (deterministic for the game's seed); then the engine
// searches every move with the job's limits until a rules ending, `maxPlies` (draw) or score
// adjudication. Positions are recorded per searched ply with the docs/NNUE_FORMAT.md filters:
// not when the side to move is in check, not when the chosen move is a capture or a promotion,
// not when |score| ≥ 3000, and not before `skipPlies`. The score is the search score converted to
// White's point of view; the game result is filled in once the game is over.
//
// Gating: two instances of the same module (the stock NNUE engine) with different networks play
// each other; nothing is recorded.
import type { SearchInfo, SearchLimits, Termination } from "@/types";
import { ChessGame, randomPlies } from "@/chess";
import { PACKED_SIZE, packPosition, setPackedResult } from "@/nnue/pack";
import { BOARD_UPDATE_MS } from "./constants";
import { Adjudicator, resultCode, scoreFromInfo, toWhiteScore } from "./scores";
import type {
  GameSettings,
  GatingGameRecord,
  SelfPlayGameRecord,
  SelfPlayWorkerEvent,
  SelfPlayWorkerInit,
  SelfPlayWorkerRequest,
  SkipCounts,
} from "./selfplay-protocol";

/** The part of EngineInstance (@/engine-host/instance) a game needs. */
export interface PlayingEngine {
  newGame(): void;
  position(startFen: string, moves: string[]): boolean;
  go(limits: SearchLimits): { bestMove: string | null; info: SearchInfo | null };
  /** True after a trap (the instance must be re-created). */
  readonly broken?: boolean;
}

/** The engine misbehaved (illegal move, no move, rejected position): the game is abandoned. */
export class EngineGameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineGameError";
  }
}

export interface GameContext {
  /** Polled after every search: true = abandon the game now. */
  shouldStop(): boolean;
  /** Position after every move (throttle in the caller). */
  onBoard?(fen: string, lastMove: string, ply: number): void;
  /** Called after every move so stop messages can be handled between plies. */
  yieldNow?(): Promise<void>;
}

/** Plays the deterministic random opening for `seed`. */
function openingGame(settings: GameSettings, seed: number): ChessGame {
  const game = new ChessGame("startpos");
  for (const uci of randomPlies(settings.randomPlies, seed)) {
    if (!game.play(uci)) break; // cannot happen (randomPlies only returns legal moves)
  }
  return game;
}

function rulesEnding(game: ChessGame): { result: 0 | 1 | 2; termination: Termination } | null {
  const out = game.outcome();
  return out ? { result: resultCode(out.result), termination: out.termination } : null;
}

/**
 * Sends the game so far to the engine and searches it. Returns the engine's move (not played yet)
 * or null when it returned none. Throws EngineGameError when the engine rejects the position.
 */
function search(engine: PlayingEngine, game: ChessGame, limits: SearchLimits): { uci: string; info: SearchInfo | null } | null {
  if (!engine.position("startpos", game.history().uci)) {
    throw new EngineGameError(`The engine rejected the position after ${game.ply()} plies (FEN ${game.fen()}).`);
  }
  const r = engine.go(limits);
  return r.bestMove === null || r.bestMove === "" ? null : { uci: r.bestMove, info: r.info };
}

/** Growable buffer of packed positions. */
class PackedBuffer {
  private buf = new Uint8Array(256 * PACKED_SIZE);
  count = 0;

  add(fen: string, scoreWhite: number): void {
    if ((this.count + 1) * PACKED_SIZE > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    packPosition(fen, scoreWhite, 1, this.buf, this.count * PACKED_SIZE);
    this.count++;
  }

  /** Sets every result byte and returns a standalone buffer of exactly count × 32 bytes. */
  finish(result: 0 | 1 | 2): ArrayBuffer {
    for (let i = 0; i < this.count; i++) setPackedResult(this.buf, i * PACKED_SIZE, result);
    return this.buf.slice(0, this.count * PACKED_SIZE).buffer;
  }
}

/**
 * Plays one self-play game. Resolves with the record, or null when `ctx.shouldStop()` became true
 * (the unfinished game is discarded). Throws EngineGameError / engine crash errors.
 */
export async function playSelfPlayGame(engine: PlayingEngine, settings: GameSettings, seed: number, gameIndex: number, ctx: GameContext): Promise<SelfPlayGameRecord | null> {
  const game = openingGame(settings, seed);
  engine.newGame();
  const packed = new PackedBuffer();
  const skipped: SkipCounts = { check: 0, capture: 0, promotion: 0, score: 0, noScore: 0, early: 0 };
  const adjudicator = new Adjudicator(settings.adjudicateCp, settings.adjudicatePlies);
  let searched = 0;
  let nodes = 0;
  let ending: { result: 0 | 1 | 2; termination: Termination } | null = null;

  for (;;) {
    ending = rulesEnding(game);
    if (ending) break;
    if (game.ply() >= settings.maxPlies) {
      ending = { result: 1, termination: "max-moves" };
      break;
    }
    const fen = game.fen();
    const ply = game.ply();
    const sideToMove = game.turn();
    const inCheck = game.inCheck();
    const r = search(engine, game, settings.limits);
    // A raised stop flag cut the search short: its move and score are not trustworthy.
    if (ctx.shouldStop()) return null;
    if (r === null) throw new EngineGameError(`The engine produced no move although legal moves exist (FEN ${fen}).`);
    searched++;
    nodes += r.info?.nodes ?? 0;
    const played = game.play(r.uci);
    if (!played) throw new EngineGameError(`The engine played an illegal move "${r.uci}" (FEN ${fen}).`);

    const scoreWhite = toWhiteScore(scoreFromInfo(r.info), sideToMove);
    if (ply < settings.skipPlies) skipped.early++;
    else if (inCheck) skipped.check++;
    else if (played.san.includes("x")) skipped.capture++;
    else if (played.uci.length > 4) skipped.promotion++;
    else if (scoreWhite === null) skipped.noScore++;
    else if (Math.abs(scoreWhite) >= settings.recordScoreLimit) skipped.score++;
    else packed.add(fen, scoreWhite);

    const adjudicated = adjudicator.push(scoreWhite);
    ctx.onBoard?.(game.fen(), played.uci, game.ply());
    if (adjudicated !== null) {
      ending = { result: adjudicated, termination: "adjudication" };
      break;
    }
    if (ctx.yieldNow) await ctx.yieldNow();
    if (ctx.shouldStop()) return null;
  }

  return {
    gameIndex,
    result: ending.result,
    termination: ending.termination,
    plies: game.ply(),
    searched,
    nodes,
    positions: packed.count,
    data: packed.finish(ending.result),
    skipped,
  };
}

/**
 * Plays one gating game: `newEngine` (White when `newIsWhite`) against `oldEngine`. Resolves with
 * the record (result from White's POV) or null when stopped.
 */
export async function playGatingGame(
  newEngine: PlayingEngine,
  oldEngine: PlayingEngine,
  settings: GameSettings,
  seed: number,
  gameIndex: number,
  newIsWhite: boolean,
  ctx: GameContext,
): Promise<GatingGameRecord | null> {
  const game = openingGame(settings, seed);
  newEngine.newGame();
  oldEngine.newGame();
  const adjudicator = new Adjudicator(settings.adjudicateCp, settings.adjudicatePlies);
  let ending: { result: 0 | 1 | 2; termination: Termination } | null = null;
  for (;;) {
    ending = rulesEnding(game);
    if (ending) break;
    if (game.ply() >= settings.maxPlies) {
      ending = { result: 1, termination: "max-moves" };
      break;
    }
    const sideToMove = game.turn();
    const engine = (sideToMove === "w") === newIsWhite ? newEngine : oldEngine;
    const fen = game.fen();
    const r = search(engine, game, settings.limits);
    if (ctx.shouldStop()) return null;
    if (r === null) throw new EngineGameError(`The engine produced no move although legal moves exist (FEN ${fen}).`);
    const played = game.play(r.uci);
    if (!played) throw new EngineGameError(`The engine played an illegal move "${r.uci}" (FEN ${fen}).`);
    const adjudicated = adjudicator.push(toWhiteScore(scoreFromInfo(r.info), sideToMove));
    ctx.onBoard?.(game.fen(), played.uci, game.ply());
    if (adjudicated !== null) {
      ending = { result: adjudicated, termination: "adjudication" };
      break;
    }
    if (ctx.yieldNow) await ctx.yieldNow();
    if (ctx.shouldStop()) return null;
  }
  return { gameIndex, newIsWhite, result: ending.result, termination: ending.termination, plies: game.ply() };
}

// --- worker message handling -------------------------------------------------------------------

export interface SelfPlayWorkerPort {
  post(event: SelfPlayWorkerEvent, transfer?: Transferable[]): void;
}

export interface CreateEngineOptions {
  stopFlag: Int32Array | null;
  hashMb: number;
  network: ArrayBuffer | null;
  onLog(text: string): void;
}

export interface SelfPlayWorkerDeps {
  /** Creates an engine instance (default: EngineInstance.create, loaded lazily). */
  createEngine?(module: WebAssembly.Module | ArrayBuffer, moduleInfo: SelfPlayWorkerInit["moduleInfo"], opts: CreateEngineOptions): Promise<PlayingEngine & { capabilities?: { name: string | null } }>;
  /** Event-loop yield between plies (default: a MessageChannel round trip). */
  yieldFn?(): Promise<void>;
  now?(): number;
}

/**
 * Engine output lines forwarded before the rest is suppressed (some engines log every move). Only
 * the first worker forwards: every worker runs the same engine(s), so the others would repeat the
 * same lines once per worker in the run log.
 */
const MAX_FORWARDED_LOGS = 3;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves after pending messages had a chance to run (much cheaper than setTimeout(0)). */
function messageChannelYield(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

async function defaultCreateEngine(
  module: WebAssembly.Module | ArrayBuffer,
  moduleInfo: SelfPlayWorkerInit["moduleInfo"],
  opts: CreateEngineOptions,
): Promise<PlayingEngine & { capabilities: { name: string | null } }> {
  const [{ EngineInstance }, { rememberModuleInfo }] = await Promise.all([import("@/engine-host/instance"), import("@/engine-host/module-info")]);
  if (module instanceof WebAssembly.Module) rememberModuleInfo(module, moduleInfo);
  return EngineInstance.create(module instanceof WebAssembly.Module ? module : new Uint8Array(module), {
    stopFlag: opts.stopFlag,
    hashMb: opts.hashMb,
    network: opts.network,
    onLog: opts.onLog,
  });
}

/** Returns the handler for SelfPlayWorkerRequest messages (one pool job per worker). */
export function createSelfPlayWorkerHandler(port: SelfPlayWorkerPort, deps: SelfPlayWorkerDeps = {}): (msg: SelfPlayWorkerRequest) => void {
  const createEngine = deps.createEngine ?? defaultCreateEngine;
  const yieldFn = deps.yieldFn ?? messageChannelYield;
  const now = deps.now ?? (() => Date.now());

  let init: SelfPlayWorkerInit | null = null;
  let engines: PlayingEngine[] = [];
  let ready: Promise<boolean> = Promise.resolve(false);
  let stopFlag: Int32Array | null = null;
  let stopRequested = false;
  let playing = false;
  let stoppedSent = false;
  let lastBoardAt = -Infinity;
  let forwardedLogs = 0;
  let suppressedLogs = 0;
  /** Games run one after another. */
  let chain: Promise<void> = Promise.resolve();

  const shouldStop = () => stopRequested || (stopFlag !== null && Atomics.load(stopFlag, 0) !== 0);

  const onEngineLog = (text: string) => {
    if ((init?.slot ?? 0) !== 0) return;
    if (forwardedLogs < MAX_FORWARDED_LOGS) {
      forwardedLogs++;
      port.post({ type: "log", level: "info", message: `Engine: ${text}` });
    } else {
      suppressedLogs++;
      if (suppressedLogs === 1) port.post({ type: "log", level: "info", message: "Further engine output is not shown." });
    }
  };

  const createAll = async (msg: SelfPlayWorkerInit): Promise<PlayingEngine[]> => {
    const out: PlayingEngine[] = [];
    for (const network of msg.networks) {
      out.push(await createEngine(msg.module, msg.moduleInfo, { stopFlag, hashMb: msg.hashMb, network, onLog: onEngineLog }));
    }
    return out;
  };

  const sendStopped = () => {
    if (stoppedSent) return;
    stoppedSent = true;
    port.post({ type: "stopped" });
  };

  async function play(msg: Extract<SelfPlayWorkerRequest, { type: "play" }>): Promise<void> {
    if (!(await ready) || !init) return;
    if (shouldStop()) {
      port.post({ type: "aborted", gameIndex: msg.gameIndex });
      return;
    }
    playing = true;
    const settings = init.settings;
    const ctx: GameContext = {
      shouldStop,
      onBoard: (fen, lastMove, ply) => {
        const t = now();
        if (t - lastBoardAt < BOARD_UPDATE_MS) return;
        lastBoardAt = t;
        port.post({ type: "board", gameIndex: msg.gameIndex, fen, lastMove, ply });
      },
      yieldNow: yieldFn,
    };
    try {
      if (init.mode === "selfplay") {
        const rec = await playSelfPlayGame(engines[0] as PlayingEngine, settings, msg.seed, msg.gameIndex, ctx);
        if (rec) port.post({ type: "game", game: rec }, [rec.data]);
        else port.post({ type: "aborted", gameIndex: msg.gameIndex });
      } else {
        const rec = await playGatingGame(engines[0] as PlayingEngine, engines[1] as PlayingEngine, settings, msg.seed, msg.gameIndex, msg.newIsWhite ?? true, ctx);
        if (rec) port.post({ type: "gating-game", game: rec });
        else port.post({ type: "aborted", gameIndex: msg.gameIndex });
      }
    } catch (err) {
      if (shouldStop()) {
        port.post({ type: "aborted", gameIndex: msg.gameIndex });
      } else {
        const crashed = engines.some((e) => e.broken);
        let message = messageOf(err);
        if (crashed) {
          // A trapped instance is unusable: start fresh ones from the same module.
          try {
            engines = await createAll(init);
          } catch (e) {
            message += ` (restarting the engine failed: ${messageOf(e)})`;
            ready = Promise.resolve(false);
          }
        }
        port.post({ type: "game-error", gameIndex: msg.gameIndex, message, crashed });
      }
    } finally {
      playing = false;
      if (stopRequested) sendStopped();
    }
  }

  return (msg: SelfPlayWorkerRequest) => {
    switch (msg.type) {
      case "init": {
        if (init) {
          port.post({ type: "init-error", message: "This self-play worker was already initialised." });
          return;
        }
        init = msg;
        stopFlag = msg.stopBuffer ? new Int32Array(msg.stopBuffer) : null;
        ready = (async () => {
          try {
            engines = await createAll(msg);
            const named = engines[0] as { capabilities?: { name: string | null } } | undefined;
            port.post({ type: "ready", engineName: named?.capabilities?.name ?? null, stopFlag: stopFlag !== null });
            return true;
          } catch (err) {
            port.post({ type: "init-error", message: messageOf(err) });
            return false;
          }
        })();
        return;
      }
      case "play":
        chain = chain.then(() => play(msg));
        return;
      case "stop":
        stopRequested = true;
        if (!playing) {
          // Wait for anything still queued (it answers "aborted" at once), then confirm.
          void chain.then(sendStopped);
        }
        return;
    }
  };
}
