// Main-thread side of self-play and gating: a pool of selfplay.worker.ts workers that share one
// compiled module and one stop flag. The pool hands out games one at a time (so fast workers never
// sit idle while a slow one finishes its share), collects the finished games and live boards, and
// shuts the workers down when the job is complete or stopped.
//
// Stopping: the shared stop flag (SharedArrayBuffer, when cross-origin isolated) makes every
// running search return at once; workers abandon the unfinished game and confirm with "stopped".
// Without SharedArrayBuffer the workers notice the stop message between two plies. Workers that do
// not confirm within STOP_GRACE_MS are terminated. Games completed before the stop are kept.
import type { LiveBoard } from "./types";
import { compileModule, moduleInfoOf, type WasmModuleInfo } from "@/engine-host/module-info";
import { MAX_CONSECUTIVE_GAME_ERRORS, STOP_GRACE_MS } from "./constants";
import { gatingGameSetup, selfPlayGameSeed } from "./scores";
import type {
  GameSettings,
  GatingGameRecord,
  SelfPlayGameRecord,
  SelfPlayWorkerEvent,
  SelfPlayWorkerInit,
  SelfPlayWorkerRequest,
} from "./selfplay-protocol";

/** The subset of the Worker API the pool needs (tests inject in-process fakes). */
export interface SelfPlayWorkerLike {
  postMessage(message: SelfPlayWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export function createSelfPlayWorker(index: number): SelfPlayWorkerLike {
  return new Worker(new URL("./selfplay.worker.ts", import.meta.url), { type: "module", name: `selfplay-${index + 1}` });
}

export interface SelfPlayPoolJob {
  /** Engine module (bytes are compiled once on the main thread). */
  wasm: ArrayBuffer | WebAssembly.Module;
  network: ArrayBuffer | null;
  hashMb: number;
  engineName: string;
  settings: GameSettings;
  /** Games to complete; null = until stopped. */
  games: number | null;
  concurrency: number;
  seed: number;
  /** Index of the first game. Continuing a job with the next index never repeats an opening. */
  firstGameIndex: number;
}

export interface GatingPoolJob {
  /** The stock NNUE engine. */
  wasm: ArrayBuffer | WebAssembly.Module;
  newNetwork: ArrayBuffer;
  oldNetwork: ArrayBuffer;
  hashMb: number;
  names: { new: string; old: string };
  settings: GameSettings;
  games: number;
  concurrency: number;
  seed: number;
}

export interface PoolHandlers<G> {
  /** Every completed game, in completion order (awaited one at a time). */
  onGame(game: G): void | Promise<void>;
  /** One board per worker; called whenever one changes (throttle in the caller). */
  onBoards?(boards: LiveBoard[]): void;
  onLog?(level: "info" | "warn", message: string): void;
  /** All workers started (engines instantiated). */
  onReady?(workers: number): void;
}

export interface SelfPlayPoolSummary {
  games: number;
  positions: number;
  stopped: boolean;
}

export interface GatingPoolSummary {
  played: number;
  /** From the new network's point of view. */
  wins: number;
  draws: number;
  losses: number;
  stopped: boolean;
}

/** Where self-play and gating games come from (the worker pool; tests inject fakes). */
export interface SelfPlaySource {
  selfPlay(job: SelfPlayPoolJob, handlers: PoolHandlers<SelfPlayGameRecord>, signal: AbortSignal): Promise<SelfPlayPoolSummary>;
  gating(job: GatingPoolJob, handlers: PoolHandlers<GatingGameRecord>, signal: AbortSignal): Promise<GatingPoolSummary>;
}

/** Gating result of one game from the new network's point of view. */
export function gatingOutcome(game: Pick<GatingGameRecord, "newIsWhite" | "result">): "win" | "draw" | "loss" {
  if (game.result === 1) return "draw";
  const whiteWon = game.result === 2;
  return whiteWon === game.newIsWhite ? "win" : "loss";
}

function canShareMemory(): boolean {
  return typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

interface Slot {
  index: number;
  worker: SelfPlayWorkerLike;
  ready: boolean;
  stopped: boolean;
  /** Game being played (null = idle). */
  game: number | null;
  newIsWhite: boolean;
  board: LiveBoard | null;
}

interface PoolSpec {
  mode: SelfPlayWorkerInit["mode"];
  module: WebAssembly.Module;
  moduleInfo: WasmModuleInfo | null;
  networks: Array<ArrayBuffer | null>;
  hashMb: number;
  settings: GameSettings;
  size: number;
  /** Games to complete (null = until stopped). */
  total: number | null;
  firstIndex: number;
  task(index: number): { seed: number; newIsWhite?: boolean };
  names(newIsWhite: boolean): { white: string; black: string };
  /** Handles a finished game event; returns false for events that are not results. */
  result(ev: SelfPlayWorkerEvent): Promise<boolean> | boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs games on `spec.size` workers until `spec.total` games completed or `signal` aborts.
 * Resolves `{ completed, stopped }`; rejects when a worker cannot start, the result handler
 * fails, or the engine fails MAX_CONSECUTIVE_GAME_ERRORS games in a row.
 */
function runPool(
  spec: PoolSpec,
  handlers: Pick<PoolHandlers<unknown>, "onBoards" | "onLog" | "onReady">,
  signal: AbortSignal,
  createWorker: (index: number) => SelfPlayWorkerLike,
): Promise<{ completed: number; stopped: boolean }> {
  if (signal.aborted || spec.total === 0) return Promise.resolve({ completed: 0, stopped: signal.aborted });
  const stopBuffer = canShareMemory() ? new SharedArrayBuffer(4) : null;
  const stopFlag = stopBuffer ? new Int32Array(stopBuffer) : null;

  return new Promise((resolve, reject) => {
    const slots: Slot[] = [];
    let nextIndex = spec.firstIndex;
    let completed = 0;
    let consecutiveErrors = 0;
    let readyCount = 0;
    let stopping = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Result handlers run one at a time, in completion order. */
    let results: Promise<void> = Promise.resolve();

    const inFlight = () => slots.reduce((n, s) => n + (s.game !== null ? 1 : 0), 0);

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
      for (const s of slots) {
        s.worker.onmessage = null;
        s.worker.onerror = null;
        s.worker.terminate();
      }
      // Let the result handlers of games that already arrived finish before settling.
      results.then(
        () => (err ? reject(err) : resolve({ completed, stopped: stopping })),
        (e: unknown) => reject(e instanceof Error ? e : new Error(messageOf(e))),
      );
    };

    const maybeDone = () => {
      if (!stopping && spec.total !== null && completed >= spec.total && inFlight() === 0) finish(null);
    };

    const assign = (slot: Slot) => {
      if (settled || stopping || !slot.ready || slot.game !== null) return;
      if (spec.total !== null && completed + inFlight() >= spec.total) {
        maybeDone();
        return;
      }
      const index = nextIndex++;
      const task = spec.task(index);
      slot.game = index;
      slot.newIsWhite = task.newIsWhite ?? true;
      slot.worker.postMessage({ type: "play", gameIndex: index, seed: task.seed, newIsWhite: task.newIsWhite });
    };

    const publishBoards = () => {
      handlers.onBoards?.(slots.filter((s) => s.board !== null).map((s) => s.board as LiveBoard));
    };

    const onAbort = () => {
      if (settled || stopping) return;
      stopping = true;
      if (stopFlag) Atomics.store(stopFlag, 0, 1);
      for (const s of slots) {
        try {
          s.worker.postMessage({ type: "stop" });
        } catch {
          s.stopped = true;
        }
      }
      if (slots.every((s) => s.stopped)) finish(null);
      else graceTimer = setTimeout(() => finish(null), STOP_GRACE_MS);
    };

    const onEvent = (slot: Slot, ev: SelfPlayWorkerEvent) => {
      if (settled) return;
      switch (ev.type) {
        case "ready":
          slot.ready = true;
          readyCount++;
          if (readyCount === slots.length) handlers.onReady?.(slots.length);
          assign(slot);
          return;
        case "init-error":
          finish(new Error(`The engine could not be started for self-play: ${ev.message}`));
          return;
        case "board": {
          if (slot.game !== ev.gameIndex) return;
          const names = spec.names(slot.newIsWhite);
          slot.board = { slot: slot.index, fen: ev.fen, lastMove: ev.lastMove, ply: ev.ply, white: names.white, black: names.black };
          publishBoards();
          return;
        }
        case "log":
          handlers.onLog?.(ev.level, ev.message);
          return;
        case "game-error":
          slot.game = null;
          if (stopping) return;
          consecutiveErrors++;
          handlers.onLog?.("warn", `Game ${ev.gameIndex + 1} was abandoned: ${ev.message}`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_GAME_ERRORS) {
            finish(new Error(`The engine failed ${consecutiveErrors} games in a row. Last problem: ${ev.message}`));
            return;
          }
          assign(slot);
          return;
        case "aborted":
          slot.game = null;
          return;
        case "stopped":
          slot.stopped = true;
          slot.game = null;
          if (stopping && slots.every((s) => s.stopped)) finish(null);
          return;
        case "game":
        case "gating-game": {
          slot.game = null;
          consecutiveErrors = 0;
          completed++;
          results = results.then(async () => {
            await spec.result(ev);
          });
          results.catch((e: unknown) => finish(e instanceof Error ? e : new Error(messageOf(e))));
          assign(slot);
          maybeDone();
          return;
        }
      }
    };

    signal.addEventListener("abort", onAbort);
    const init: Omit<SelfPlayWorkerInit, "slot"> = {
      type: "init",
      mode: spec.mode,
      module: spec.module,
      moduleInfo: spec.moduleInfo,
      networks: spec.networks,
      hashMb: spec.hashMb,
      stopBuffer,
      settings: spec.settings,
    };
    for (let i = 0; i < spec.size; i++) {
      let worker: SelfPlayWorkerLike;
      try {
        worker = createWorker(i);
      } catch (e) {
        finish(new Error(`Could not start a self-play worker: ${messageOf(e)}`));
        return;
      }
      const slot: Slot = { index: i, worker, ready: false, stopped: false, game: null, newIsWhite: true, board: null };
      slots.push(slot);
      worker.onmessage = (ev: MessageEvent) => onEvent(slot, ev.data as SelfPlayWorkerEvent);
      worker.onerror = (ev: ErrorEvent) => {
        ev.preventDefault?.();
        if (stopping) {
          slot.stopped = true;
          if (slots.every((s) => s.stopped)) finish(null);
          return;
        }
        finish(new Error(`A self-play worker failed${ev.message ? `: ${ev.message}` : " to load"}.`));
      };
      try {
        worker.postMessage({ ...init, slot: i });
      } catch (e) {
        finish(new Error(`Could not send the engine to a self-play worker: ${messageOf(e)}`));
        return;
      }
    }
  });
}

async function prepareModule(wasm: ArrayBuffer | WebAssembly.Module): Promise<{ module: WebAssembly.Module; info: WasmModuleInfo | null }> {
  const module = wasm instanceof WebAssembly.Module ? wasm : await compileModule(wasm);
  return { module, info: moduleInfoOf(module) };
}

/** The real self-play source: selfplay.worker.ts workers. */
export function createWorkerSelfPlaySource(createWorker: (index: number) => SelfPlayWorkerLike = createSelfPlayWorker): SelfPlaySource {
  return {
    async selfPlay(job, handlers, signal) {
      const { module, info } = await prepareModule(job.wasm);
      let positions = 0;
      const out = await runPool(
        {
          mode: "selfplay",
          module,
          moduleInfo: info,
          networks: [job.network],
          hashMb: job.hashMb,
          settings: job.settings,
          size: Math.max(1, job.games === null ? job.concurrency : Math.min(job.concurrency, job.games)),
          total: job.games,
          firstIndex: job.firstGameIndex,
          task: (index) => ({ seed: selfPlayGameSeed(job.seed, index) }),
          names: () => ({ white: job.engineName, black: job.engineName }),
          result: async (ev) => {
            if (ev.type !== "game") return false;
            positions += ev.game.positions;
            await handlers.onGame(ev.game);
            return true;
          },
        },
        handlers,
        signal,
        createWorker,
      );
      return { games: out.completed, positions, stopped: out.stopped };
    },

    async gating(job, handlers, signal) {
      const { module, info } = await prepareModule(job.wasm);
      const tally = { wins: 0, draws: 0, losses: 0 };
      const out = await runPool(
        {
          mode: "gating",
          module,
          moduleInfo: info,
          networks: [job.newNetwork, job.oldNetwork],
          hashMb: job.hashMb,
          settings: job.settings,
          size: Math.max(1, Math.min(job.concurrency, job.games)),
          total: job.games,
          firstIndex: 0,
          task: (index) => gatingGameSetup(job.seed, index),
          names: (newIsWhite) => (newIsWhite ? { white: job.names.new, black: job.names.old } : { white: job.names.old, black: job.names.new }),
          result: async (ev) => {
            if (ev.type !== "gating-game") return false;
            const o = gatingOutcome(ev.game);
            if (o === "win") tally.wins++;
            else if (o === "draw") tally.draws++;
            else tally.losses++;
            await handlers.onGame(ev.game);
            return true;
          },
        },
        handlers,
        signal,
        createWorker,
      );
      return { played: tally.wins + tally.draws + tally.losses, ...tally, stopped: out.stopped };
    },
  };
}
