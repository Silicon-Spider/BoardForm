// EngineClient: main-thread async wrapper around one engine.worker (docs/ARCHITECTURE.md §5).
//
// * Calls are serialized through a queue; `busy` is true while any call is running or queued.
// * Searches get a hard deadline (limits.ts searchDeadlineMs): the shared stop flag is raised, and
//   an engine that still does not answer STOP_GRACE_MS later has its worker terminated.
// * When a worker is terminated (deadline, stop() without SharedArrayBuffer, or a crash), a new one
//   is spawned from the cached WebAssembly.Module and the session is replayed: options, network,
//   new game, last position. The interrupted search resolves with the first move of the last PV.
// * stopReason "timeout" means the host had to intervene or the engine's own search time exceeded
//   the deadline, never just that a busy main thread handled an on-time answer late (judgeStop).
// * No promise stays pending forever: every call has a timeout (unless the caller passes
//   maxWaitMs: Infinity), crashes settle the call, and terminate() rejects everything still pending.
import type { EngineCapabilities, SearchInfo, SearchLimits, SearchResult, StopReason, TraceEntry } from "@/types";
import type { GoOutcome } from "./instance";
import { DEFAULT_MAX_WAIT_MS, STOP_GRACE_MS, searchDeadlineMs, sideToMoveOf } from "./limits";
import { compileModule, moduleInfoOf, type WasmModuleInfo } from "./module-info";
import type { EngineMethod, EngineMethods, EngineWorkerInit, EngineWorkerResponse } from "./protocol";

export interface EngineClientOptions {
  hashMb?: number;
  network?: ArrayBuffer | null;
  /** Engine output and host notes ("[host] ..."), e.g. for an engine console. */
  onLog?: (s: string) => void;
  label?: string;
  /**
   * Safety deadline for searches limited only by depth / nodes, and for other calls. Default 60 s;
   * `Infinity` disables it (stop() and terminate() still work).
   */
  maxWaitMs?: number;
}

/** A call failed. `crashed`: the engine trapped and was restarted. */
export class EngineCallError extends Error {
  constructor(
    message: string,
    readonly crashed: boolean,
  ) {
    super(message);
    this.name = "EngineCallError";
  }
}

const INIT_TIMEOUT_MS = 30_000;
/** perft is legitimately slow at high depths; it can be cancelled with stop(). */
const PERFT_TIMEOUT_FACTOR = 10;

interface ActiveCall {
  id: number;
  method: EngineMethod;
  onInfo?: (info: SearchInfo) => void;
  resolve(value: unknown): void;
  /** The worker reported an error (crashed = the instance is broken) or the call timed out. */
  fail(message: string, crashed: boolean): void;
  /** terminate(): reject without restarting anything. */
  abort(err: Error): void;
}

const noop = () => {};
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function canShareMemory(): boolean {
  return typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** setTimeout's largest delay (2^31 - 1 ms): browsers and Node fire longer or non-finite delays at once. */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

/** Like setTimeout, but never fires early: a non-finite delay means "never", huge ones are clamped. */
export function startTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> | undefined {
  if (!Number.isFinite(ms)) return undefined;
  return setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_DELAY_MS));
}

/**
 * The stop reason of a search the engine answered, judged by what happened in the worker rather
 * than by event-loop timing: on a busy main thread the deadline timer can fire while an answer that
 * arrived in time is still queued, and that must not count as a timeout (it can lose a game on time).
 *
 * - stop() was requested                                 → "stopped"
 * - the engine's own duration exceeds the deadline        → "timeout"
 * - the deadline fired while the engine was still running → "timeout" (flag raised when it returned)
 * - otherwise                                            → "done"
 */
export function judgeStop(hostReason: "stopped" | "timeout" | null, out: Pick<GoOutcome, "elapsedMs" | "stopFlagRaised">, deadlineMs: number | null): StopReason {
  if (hostReason === "stopped") return "stopped";
  if (deadlineMs !== null && out.elapsedMs > deadlineMs) return "timeout";
  if (hostReason === "timeout") return out.stopFlagRaised ? "timeout" : "done";
  return "done";
}

export class EngineClient {
  readonly label: string;

  private readonly module: WebAssembly.Module;
  private readonly moduleInfo: WasmModuleInfo | null;
  private readonly hashMb: number | null;
  private readonly maxWaitMs: number;
  private readonly onLog?: (s: string) => void;
  private readonly stopBuffer: SharedArrayBuffer | null;
  private readonly stopFlag: Int32Array | null;

  private caps: EngineCapabilities | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private nextId = 0;
  private active: ActiveCall | null = null;
  private initWaiter: { generation: number; done(err: Error | null, caps?: EngineCapabilities): void } | null = null;
  private currentGo: { requestStop(why: "stopped" | "timeout"): void } | null = null;
  private readonly queuedGos = new Set<{ stopRequested: boolean }>();

  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private reviving: Promise<void> | null = null;
  /** Set when the client can no longer be used (terminated, or a restart failed). */
  private fatal: Error | null = null;
  private disposed = false;

  // Session state replayed after a restart.
  private network: ArrayBuffer | null;
  private readonly options = new Map<string, string>();
  private lastPosition: { startFen: string; moves: string[] } | null = null;

  private constructor(module: WebAssembly.Module, opts: EngineClientOptions) {
    this.module = module;
    this.moduleInfo = moduleInfoOf(module);
    this.label = opts.label ?? "engine";
    this.hashMb = typeof opts.hashMb === "number" && opts.hashMb > 0 ? opts.hashMb : null;
    this.maxWaitMs = typeof opts.maxWaitMs === "number" && opts.maxWaitMs > 0 ? opts.maxWaitMs : DEFAULT_MAX_WAIT_MS;
    this.onLog = opts.onLog;
    // Copy: the caller may transfer its buffer elsewhere, and we need ours for restarts.
    this.network = opts.network && opts.network.byteLength > 0 ? opts.network.slice(0) : null;
    this.stopBuffer = canShareMemory() ? new SharedArrayBuffer(4) : null;
    this.stopFlag = this.stopBuffer ? new Int32Array(this.stopBuffer) : null;
  }

  /** Starts a worker running the engine. Rejects with the engine's start-up error. */
  static async create(wasm: ArrayBuffer | WebAssembly.Module, opts: EngineClientOptions = {}): Promise<EngineClient> {
    const module = wasm instanceof WebAssembly.Module ? wasm : await compileModule(wasm);
    const client = new EngineClient(module, opts);
    try {
      client.caps = await client.spawn();
    } catch (err) {
      client.terminate();
      throw err;
    }
    return client;
  }

  get capabilities(): EngineCapabilities {
    return this.caps!;
  }

  /** True while a call is running or queued. */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** False once terminated or after a failed restart. */
  get alive(): boolean {
    return this.fatal === null;
  }

  // --- public API --------------------------------------------------------------------------------

  newGame(): Promise<void> {
    return this.call("newGame", []);
  }

  position(startFen: string, moves: string[]): Promise<boolean> {
    const list = [...moves];
    return this.enqueue(async () => {
      const ok = await this.exec("position", [startFen, list], { timeoutMs: this.maxWaitMs, restartOnCrash: true });
      if (ok) this.lastPosition = { startFen, moves: list };
      return ok;
    });
  }

  /** Searches the current position. Resolves (never rejects) unless the client is terminated. */
  go(limits: SearchLimits, onInfo?: (i: SearchInfo) => void): Promise<SearchResult> {
    const ticket = { stopRequested: false };
    this.queuedGos.add(ticket);
    return this.enqueue(() => this.runGo(limits, onInfo, ticket)).finally(() => this.queuedGos.delete(ticket));
  }

  /**
   * Ends the running search (and any already queued) as soon as possible: through the stop flag,
   * or by terminating the worker when SharedArrayBuffer is unavailable or the engine ignores the
   * flag. Also cancels a running perft. No-op when idle.
   */
  stop(): void {
    for (const ticket of this.queuedGos) ticket.stopRequested = true;
    if (this.active?.method === "go") this.currentGo?.requestStop("stopped");
    else if (this.active?.method === "perft") this.active.fail("perft was stopped.", true);
  }

  eval(): Promise<number | null> {
    return this.call("eval", []);
  }

  evalTrace(): Promise<TraceEntry[] | null> {
    return this.call("evalTrace", []);
  }

  perft(depth: number): Promise<number | null> {
    return this.call("perft", [depth], this.maxWaitMs * PERFT_TIMEOUT_FACTOR);
  }

  setOption(name: string, value: string): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await this.exec("setOption", [name, value], { timeoutMs: this.maxWaitMs, restartOnCrash: true });
      if (ok) this.options.set(name, value);
      return ok;
    });
  }

  loadNetwork(bytes: ArrayBuffer): Promise<boolean> {
    let copy: ArrayBuffer;
    try {
      copy = bytes.slice(0); // now: the caller may transfer its buffer right after this call
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return this.enqueue(async () => {
      const ok = await this.exec("loadNetwork", [copy.slice(0)], { timeoutMs: this.maxWaitMs, restartOnCrash: true });
      if (ok) this.network = copy;
      return ok;
    });
  }

  /** Stops the worker for good. Pending and queued calls reject. */
  terminate(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fatal = new Error("The engine was terminated.");
    const active = this.active;
    this.active = null;
    this.initWaiter?.done(this.fatal);
    this.killWorker();
    active?.abort(this.fatal);
  }

  // --- queue & calls -----------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = async (): Promise<T> => {
      while (this.reviving) await this.reviving;
      if (this.fatal) throw this.fatal;
      return task();
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(noop, noop);
    return result.finally(() => {
      this.pending--;
    });
  }

  private call<M extends EngineMethod>(method: M, args: EngineMethods[M]["args"], timeoutMs: number = this.maxWaitMs): Promise<EngineMethods[M]["result"]> {
    return this.enqueue(() => this.exec(method, args, { timeoutMs, restartOnCrash: true }));
  }

  /** Sends one call to the current worker and waits for its answer. */
  private exec<M extends EngineMethod>(
    method: M,
    args: EngineMethods[M]["args"],
    opts: { timeoutMs: number; restartOnCrash: boolean },
  ): Promise<EngineMethods[M]["result"]> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(this.fatal ?? new Error("The engine is not running."));
        return;
      }
      const id = ++this.nextId;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        if (this.active?.id === id) this.active = null;
      };
      this.active = {
        id,
        method,
        resolve: (value) => {
          if (settled) return;
          settle();
          resolve(value as EngineMethods[M]["result"]);
        },
        fail: (message, crashed) => {
          if (settled) return;
          settle();
          if (crashed && opts.restartOnCrash) this.revive(message);
          reject(new EngineCallError(message, crashed));
        },
        abort: (err) => {
          if (settled) return;
          settle();
          reject(err);
        },
      };
      timer = startTimer(opts.timeoutMs, () => {
        // The worker is stuck inside the engine: treat like a crash (the worker gets replaced).
        if (this.active?.id === id) this.active.fail(`The engine did not answer ${method} within ${Math.round(opts.timeoutMs / 1000)} s.`, true);
      });
      try {
        worker.postMessage({ type: "call", id, method, args });
      } catch (err) {
        settle(); // e.g. DataCloneError: nothing was sent
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private runGo(limits: SearchLimits, onInfo: ((i: SearchInfo) => void) | undefined, ticket: { stopRequested: boolean }): Promise<SearchResult> {
    const worker = this.worker;
    if (!worker) return Promise.reject(this.fatal ?? new Error("The engine is not running."));
    // Stopped before it started and no flag to make it return instantly: skip the search.
    if (ticket.stopRequested && !this.stopFlag) return Promise.resolve({ bestMove: null, info: null, elapsedMs: 0, stopReason: "stopped" });

    return new Promise<SearchResult>((resolve, reject) => {
      const id = ++this.nextId;
      const t0 = performance.now();
      const deadline = searchDeadlineMs(limits, this.lastPosition ? sideToMoveOf(this.lastPosition.startFen, this.lastPosition.moves) : null, this.maxWaitMs);
      let lastInfo: SearchInfo | null = null;
      /** Why the host intervened (null = the engine finished on its own). */
      let reason: Exclude<StopReason, "done" | "error"> | null = ticket.stopRequested ? "stopped" : null;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const settle = () => {
        settled = true;
        clearTimeout(stopTimer);
        clearTimeout(killTimer);
        if (this.active?.id === id) this.active = null;
        if (this.currentGo === control) this.currentGo = null;
        if (this.stopFlag) Atomics.store(this.stopFlag, 0, 0);
      };

      /** Terminate fallback: kill the worker, answer with the last PV's first move, restart. */
      const kill = (why: "stopped" | "timeout") => {
        if (settled) return;
        settle();
        this.revive(why === "timeout" ? "the search overran its deadline" : "stopping a search that could not be stopped cooperatively");
        resolve({ bestMove: lastInfo?.pv[0] ?? null, info: lastInfo, elapsedMs: performance.now() - t0, stopReason: why });
      };

      const control = {
        requestStop: (why: "stopped" | "timeout") => {
          if (settled) return;
          reason ??= why;
          if (!this.stopFlag) {
            kill(reason);
            return;
          }
          Atomics.store(this.stopFlag, 0, 1);
          killTimer ??= setTimeout(() => kill(reason ?? why), STOP_GRACE_MS);
        },
      };
      this.currentGo = control;

      this.active = {
        id,
        method: "go",
        onInfo: (info) => {
          lastInfo = info;
          try {
            onInfo?.(info);
          } catch (err) {
            console.error("EngineClient onInfo callback failed", err);
          }
        },
        resolve: (value) => {
          if (settled) return;
          settle();
          const out = value as GoOutcome;
          resolve({ bestMove: out.bestMove, info: out.info ?? lastInfo, elapsedMs: out.elapsedMs, stopReason: judgeStop(reason, out, deadline) });
        },
        fail: (message, crashed) => {
          if (settled) return;
          settle();
          if (crashed) this.revive(message);
          resolve({ bestMove: null, info: lastInfo, elapsedMs: performance.now() - t0, stopReason: "error", error: message });
        },
        abort: (err) => {
          if (settled) return;
          settle();
          reject(err);
        },
      };

      if (this.stopFlag) Atomics.store(this.stopFlag, 0, ticket.stopRequested ? 1 : 0);
      try {
        worker.postMessage({ type: "call", id, method: "go", args: [limits] });
      } catch (err) {
        settle();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (deadline !== null) stopTimer = startTimer(deadline, () => control.requestStop("timeout"));
    });
  }

  // --- worker lifecycle --------------------------------------------------------------------------

  private spawn(): Promise<EngineCapabilities> {
    const generation = ++this.generation;
    return new Promise<EngineCapabilities>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module", name: "chess-engine" });
      } catch (err) {
        reject(new Error(`Could not start the engine worker: ${messageOf(err)}`));
        return;
      }
      this.worker = worker;
      let settled = false;
      const timer = setTimeout(() => done(new Error(`The engine did not start within ${INIT_TIMEOUT_MS / 1000} s.`)), INIT_TIMEOUT_MS);
      const done = (err: Error | null, caps?: EngineCapabilities) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.initWaiter?.generation === generation) this.initWaiter = null;
        if (err) {
          if (this.generation === generation) this.killWorker();
          reject(err);
        } else {
          resolve(caps!);
        }
      };
      this.initWaiter = { generation, done };
      worker.onmessage = (ev: MessageEvent) => this.onMessage(generation, ev.data as EngineWorkerResponse);
      worker.onerror = (ev: ErrorEvent) => {
        ev.preventDefault();
        this.onWorkerError(generation, ev.message || "unknown error");
      };
      worker.onmessageerror = () => this.onWorkerError(generation, "it sent a message that could not be read");
      const init: EngineWorkerInit = {
        type: "init",
        module: this.module,
        moduleInfo: this.moduleInfo,
        stopBuffer: this.stopBuffer,
        hashMb: this.hashMb,
        network: this.network,
      };
      worker.postMessage(init);
    });
  }

  /** Terminates the current worker; messages it already posted are ignored from now on. */
  private killWorker(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
  }

  /** Replaces the worker and replays the session. Calls queued meanwhile wait for it. */
  private revive(reason: string): void {
    if (this.disposed || this.fatal) return;
    this.killWorker();
    this.emitLog(`[host] restarting the engine: ${reason}`);
    const restart = (async () => {
      try {
        this.caps = await this.spawn();
        const replay = { timeoutMs: this.maxWaitMs, restartOnCrash: false };
        for (const [name, value] of this.options) await this.exec("setOption", [name, value], replay);
        await this.exec("newGame", [], replay);
        if (this.lastPosition) await this.exec("position", [this.lastPosition.startFen, this.lastPosition.moves], replay);
      } catch (err) {
        if (!this.fatal) {
          this.fatal = new Error(`The engine could not be restarted: ${messageOf(err)}`);
          this.emitLog(`[host] ${this.fatal.message}`);
        }
        this.killWorker();
      }
    })();
    const tracked: Promise<void> = restart.finally(() => {
      if (this.reviving === tracked) this.reviving = null;
    });
    this.reviving = tracked;
  }

  private onMessage(generation: number, msg: EngineWorkerResponse): void {
    if (generation !== this.generation) return;
    switch (msg.type) {
      case "ready":
        this.initWaiter?.done(null, msg.capabilities);
        return;
      case "init-error":
        this.initWaiter?.done(new Error(msg.message));
        return;
      case "log":
        this.emitLog(msg.text);
        return;
      case "info":
        if (this.active?.id === msg.id) this.active.onInfo?.(msg.info);
        return;
      case "result":
        if (this.active?.id === msg.id) this.active.resolve(msg.value);
        return;
      case "error":
        if (this.active?.id === msg.id) this.active.fail(msg.message, msg.crashed);
        return;
    }
  }

  /** The worker itself died (uncaught error, failed to load...). */
  private onWorkerError(generation: number, message: string): void {
    if (generation !== this.generation) return;
    const text = `The engine worker failed: ${message}`;
    if (this.initWaiter) this.initWaiter.done(new Error(text));
    else if (this.active) this.active.fail(text, true);
    else this.revive(text);
  }

  private emitLog(text: string): void {
    try {
      this.onLog?.(text);
    } catch (err) {
      console.error("EngineClient onLog callback failed", err);
    }
  }
}
