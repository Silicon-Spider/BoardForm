// AnalysisSession: one engine analysing the analysis board's current position without a time
// limit. Every position change restarts the search (debounced): stop() → position() → go(infinite).
// Framework-agnostic like GameController; React reads it with subscribe()/getState().
import { ChessGame } from "@/chess";
import type { CompileDiagnostic, EngineCapabilities, SearchInfo } from "@/types";
import type { EngineHandle } from "./controller";

export interface AnalysisDeps {
  /** Builds (if needed) and starts the engine for unlimited analysis. */
  createEngine(engineId: string, opts: { onLog: (line: string) => void; onStatus: (text: string) => void }): Promise<{ client: EngineHandle; name: string }>;
}

export type AnalysisStatus =
  /** No engine chosen, or analysis never started. */
  | "off"
  | "loading"
  | "analysing"
  /** Stopped by the user (the last info stays visible). */
  | "stopped"
  /** The search ended by itself (maximum depth, no move) or the position is game over. */
  | "finished"
  | "error";

export interface AnalysisState {
  engineId: string | null;
  engineName: string | null;
  status: AnalysisStatus;
  statusText: string | null;
  info: SearchInfo | null;
  /** Position key `info` belongs to (see positionKey). */
  infoKey: string | null;
  /** FEN `info` belongs to. */
  infoFen: string | null;
  error: string | null;
  diagnostics: CompileDiagnostic[] | null;
  logs: readonly string[];
  capabilities: EngineCapabilities | null;
}

/** Restart delay after a position change, so stepping through moves does not thrash the engine. */
export const ANALYSIS_DEBOUNCE_MS = 120;
const LOG_LIMIT = 300;
const INFO_EMIT_MS = 100;

export function positionKey(startFen: string, moves: readonly string[]): string {
  return `${startFen}|${moves.join(" ")}`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function diagnosticsOf(err: unknown): CompileDiagnostic[] | null {
  const result = (err as { result?: { diagnostics?: unknown } } | null)?.result;
  return result && Array.isArray(result.diagnostics) ? (result.diagnostics as CompileDiagnostic[]) : null;
}

const OUTCOME_TEXT: Record<string, string> = {
  checkmate: "Checkmate — nothing left to analyse.",
  stalemate: "Stalemate — the game is drawn.",
  threefold: "Draw by threefold repetition.",
  "fifty-move": "Draw by the fifty-move rule.",
  "insufficient-material": "Draw — insufficient material.",
};

function initialState(engineId: string | null): AnalysisState {
  return { engineId, engineName: null, status: "off", statusText: null, info: null, infoKey: null, infoFen: null, error: null, diagnostics: null, logs: [], capabilities: null };
}

export class AnalysisSession {
  private s: AnalysisState = initialState(null);
  private readonly listeners = new Set<() => void>();
  private client: EngineHandle | null = null;
  private loading: Promise<EngineHandle | null> | null = null;
  private running = false;
  private position: { startFen: string; moves: string[]; key: string; fen: string } | null = null;
  private loadGen = 0;
  private searchGen = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: AnalysisDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): AnalysisState => this.s;

  get isRunning(): boolean {
    return this.running;
  }

  /** Chooses the engine (a running analysis continues with the new one). */
  setEngine(engineId: string | null): void {
    if (this.disposed || engineId === this.s.engineId) return;
    this.dropClient();
    this.s = initialState(engineId);
    if (!engineId) this.running = false;
    this.emit();
    if (this.running) this.restart(0);
  }

  setRunning(on: boolean): void {
    if (this.disposed || on === this.running) return;
    this.running = on && !!this.s.engineId;
    if (this.running) {
      this.patch({ error: null, diagnostics: null });
      this.restart(0);
      return;
    }
    this.cancelRestart();
    this.searchGen++;
    this.client?.stop();
    if (this.s.status === "analysing" || this.s.status === "loading") this.patch({ status: this.client ? "stopped" : "off", statusText: null });
    if (!this.client) {
      // Stopped while the engine was still loading: forget the load.
      this.loadGen++;
      this.loading = null;
    }
  }

  setPosition(startFen: string, moves: readonly string[]): void {
    const key = positionKey(startFen, moves);
    if (this.disposed || this.position?.key === key) return;
    const game = ChessGame.fromMoves(startFen, moves);
    this.position = { startFen, moves: [...moves], key, fen: game?.fen() ?? startFen };
    if (this.running) this.restart(ANALYSIS_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRestart();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.dropClient();
    this.listeners.clear();
  }

  // --- internals -------------------------------------------------------------------------------

  private dropClient(): void {
    this.loadGen++;
    this.searchGen++;
    this.cancelRestart();
    this.loading = null;
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        c.stop();
        c.terminate();
      } catch (err) {
        console.warn("[play] could not stop the analysis engine", err);
      }
    }
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private restart(delayMs: number): void {
    this.cancelRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.analyse();
    }, delayMs);
  }

  private ensureClient(): Promise<EngineHandle | null> {
    if (this.client) return Promise.resolve(this.client);
    if (this.loading) return this.loading;
    const engineId = this.s.engineId;
    if (!engineId) return Promise.resolve(null);
    const gen = ++this.loadGen;
    this.patch({ status: "loading", statusText: "Preparing…", error: null, diagnostics: null });
    const job = (async (): Promise<EngineHandle | null> => {
      try {
        const { client, name } = await this.deps.createEngine(engineId, {
          onLog: (line) => {
            if (gen === this.loadGen) this.log(line);
          },
          onStatus: (text) => {
            if (gen === this.loadGen) this.patch({ statusText: text });
          },
        });
        if (gen !== this.loadGen) {
          client.terminate();
          return null;
        }
        await client.newGame();
        if (gen !== this.loadGen) {
          client.terminate();
          return null;
        }
        this.client = client;
        this.patch({ engineName: name, capabilities: client.capabilities, statusText: null });
        return client;
      } catch (err) {
        if (gen !== this.loadGen) return null;
        this.running = false;
        this.patch({ status: "error", statusText: null, error: messageOf(err), diagnostics: diagnosticsOf(err) });
        return null;
      } finally {
        if (gen === this.loadGen) this.loading = null;
      }
    })();
    this.loading = job;
    return job;
  }

  private async analyse(): Promise<void> {
    if (!this.running || !this.position || this.disposed) return;
    const client = await this.ensureClient();
    if (!client || !this.running || !this.position || this.disposed) return;
    const gen = ++this.searchGen;
    const pos = this.position;
    client.stop(); // ends the previous search; the calls below wait behind it
    const outcome = ChessGame.fromMoves(pos.startFen, pos.moves)?.outcome();
    if (outcome) {
      this.patch({ status: "finished", info: null, infoKey: pos.key, infoFen: pos.fen, statusText: OUTCOME_TEXT[outcome.termination] ?? "The game is over." });
      return;
    }
    this.patch({ status: "analysing", statusText: null, info: null, infoKey: pos.key, infoFen: pos.fen, error: null });
    try {
      const ok = await client.position(pos.startFen, pos.moves);
      if (gen !== this.searchGen) return;
      if (!ok) {
        this.patch({ status: "error", error: "The engine rejected this position." });
        return;
      }
      const result = await client.go({ infinite: true }, (info) => {
        if (gen !== this.searchGen) return;
        this.s = { ...this.s, info };
        this.emitSoon();
      });
      if (gen !== this.searchGen) return;
      const info = result.info ?? this.s.info;
      if (result.stopReason === "error") {
        this.patch({ status: "error", info, error: `The engine crashed${result.error ? `: ${result.error}` : ""}. It was restarted — change the position to analyse again.` });
      } else {
        this.patch({
          status: "finished",
          info,
          statusText: result.bestMove ? "The engine finished its search." : "The engine returned without analysing this position.",
        });
      }
    } catch (err) {
      if (gen !== this.searchGen) return;
      this.patch({ status: "error", error: messageOf(err) });
    }
  }

  private log(line: string): void {
    const logs = this.s.logs.length >= LOG_LIMIT ? [...this.s.logs.slice(this.s.logs.length - LOG_LIMIT + 1), line] : [...this.s.logs, line];
    this.s = { ...this.s, logs };
    this.emitSoon();
  }

  private patch(p: Partial<AnalysisState>): void {
    this.s = { ...this.s, ...p };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    for (const l of [...this.listeners]) l();
  }

  private emitSoon(): void {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, INFO_EMIT_MS);
  }
}
