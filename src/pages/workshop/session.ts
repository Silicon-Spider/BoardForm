// EngineSession: the test bench's engine. It is started lazily, on the first test action
// (preparing = saving pending edits and building if needed), restarted after a new build, a
// network or hash-size change, and terminated when the Workshop closes. It also collects the
// engine's console output (cb_log lines and "[host] ..." notes).
import { BuildError, loadEngine, type EngineClient } from "@/engine-host";
import type { EngineCapabilities } from "@/types";

export type SessionPhase = "idle" | "starting" | "ready" | "error";

export interface SessionState {
  phase: SessionPhase;
  /** Progress while starting ("Compiling…", "Starting the engine…"). */
  statusText: string | null;
  error: string | null;
  /** The start failed because the engine does not compile. */
  buildFailed: boolean;
  caps: EngineCapabilities | null;
  /** Number of engine instances started so far (changes whenever a new engine is running). */
  generation: number;
}

export interface SessionOptions {
  engineId: string;
  /** Saves pending edits and builds the engine; throws (e.g. BuildError) when it cannot run. */
  prepare(onStatus: (s: string) => void): Promise<void>;
  /** Current hash size in MiB. */
  hashMb(): number;
  label(): string;
  /** loadEngine itself failed to compile the engine (after prepare() succeeded). */
  onBuildError?(err: BuildError): void;
}

/** Console lines kept (older ones are dropped). */
export const LOG_LIMIT = 2000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class EngineSession {
  private client: EngineClient | null = null;
  private starting: Promise<EngineClient> | null = null;
  /** Bumped by restart() and close(): starts begun before it are stale. */
  private epoch = 0;
  private closed = false;
  private state: SessionState = { phase: "idle", statusText: null, error: null, buildFailed: false, caps: null, generation: 0 };
  private readonly stateListeners = new Set<() => void>();

  private lines: readonly string[] = [];
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly logListeners = new Set<() => void>();

  constructor(private readonly opts: SessionOptions) {}

  // --- state -------------------------------------------------------------------------------

  readonly getState = (): SessionState => this.state;
  readonly subscribe = (l: () => void): (() => void) => {
    this.stateListeners.add(l);
    return () => {
      this.stateListeners.delete(l);
    };
  };

  private setState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.stateListeners]) l();
  }

  /** The running client, if any (does not start one). */
  get current(): EngineClient | null {
    return this.client && this.client.alive ? this.client : null;
  }

  // --- console -----------------------------------------------------------------------------

  readonly getLog = (): readonly string[] => this.lines;
  readonly subscribeLog = (l: () => void): (() => void) => {
    this.logListeners.add(l);
    return () => {
      this.logListeners.delete(l);
    };
  };

  /** Adds a console line (batched: engines can log a lot). */
  log(line: string): void {
    this.buffer.push(line);
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flushLog(), 60);
  }

  clearLog(): void {
    this.buffer = [];
    this.lines = [];
    for (const l of [...this.logListeners]) l();
  }

  private flushLog(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const next = this.lines.concat(this.buffer);
    this.buffer = [];
    this.lines = next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
    for (const l of [...this.logListeners]) l();
  }

  // --- lifecycle ---------------------------------------------------------------------------

  /** The engine, started if needed (builds first). Rejects with the reason it cannot run. */
  getClient(): Promise<EngineClient> {
    if (this.closed) return Promise.reject(new Error("The Workshop was closed."));
    const live = this.current;
    if (live) return Promise.resolve(live);
    if (this.starting) return this.starting;
    const run = this.start(this.epoch);
    this.starting = run;
    run.then(
      () => {
        if (this.starting === run) this.starting = null;
      },
      () => {
        if (this.starting === run) this.starting = null;
      },
    );
    return run;
  }

  private async start(epoch: number): Promise<EngineClient> {
    const stale = () => epoch !== this.epoch || this.closed;
    this.setState({ phase: "starting", statusText: "Preparing…", error: null, buildFailed: false });
    const status = (s: string) => {
      if (!stale()) this.setState({ statusText: s });
    };
    const fail = (err: unknown): never => {
      this.setState({ phase: "error", statusText: null, error: messageOf(err), buildFailed: err instanceof BuildError, caps: null });
      throw err;
    };
    try {
      await this.opts.prepare(status);
    } catch (err) {
      if (stale()) return this.afterStale();
      return fail(err);
    }
    if (stale()) return this.afterStale();
    let client: EngineClient;
    try {
      client = await loadEngine(this.opts.engineId, {
        hashMb: this.opts.hashMb(),
        onLog: (s) => this.log(s),
        onStatus: status,
        label: this.opts.label(),
      });
    } catch (err) {
      if (stale()) return this.afterStale();
      if (err instanceof BuildError) this.opts.onBuildError?.(err);
      return fail(err);
    }
    if (stale()) {
      client.terminate();
      return this.afterStale();
    }
    this.client = client;
    const caps = client.capabilities;
    this.setState({ phase: "ready", statusText: null, error: null, buildFailed: false, caps, generation: this.state.generation + 1 });
    this.log(`[workshop] engine started${caps.name ? ` — ${caps.name}` : ""} (hash ${this.opts.hashMb()} MiB)`);
    return client;
  }

  /** A start that was overtaken by restart(): hand callers the new engine instead. */
  private afterStale(): Promise<EngineClient> {
    if (this.closed) return Promise.reject(new Error("The Workshop was closed."));
    return this.getClient();
  }

  /**
   * Replaces the engine (after a build, a network or hash change). A session that had an engine
   * (or was starting one) starts the new one at once; an idle one stays idle until needed.
   */
  restart(reason: string): void {
    if (this.closed) return;
    const wasActive = this.client !== null || this.starting !== null;
    this.epoch++;
    this.starting = null;
    if (this.client) {
      this.client.terminate();
      this.client = null;
      this.log(`[workshop] restarting the engine: ${reason}`);
    }
    if (wasActive) {
      void this.getClient().catch(() => {
        /* reported through the state */
      });
    } else {
      this.setState({ phase: "idle", statusText: null, error: null, buildFailed: false, caps: null });
    }
  }

  /** Stops whatever the engine is doing (search or perft). */
  stop(): void {
    this.current?.stop();
  }

  /** Unmount: terminate the engine. open() makes the session usable again (React StrictMode). */
  close(): void {
    this.closed = true;
    this.epoch++;
    this.starting = null;
    this.client?.terminate();
    this.client = null;
    if (this.state.phase !== "idle") this.state = { ...this.state, phase: "idle", statusText: null, error: null, buildFailed: false, caps: null };
  }

  open(): void {
    this.closed = false;
  }
}
