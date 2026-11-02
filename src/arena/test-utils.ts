// Test helpers for the arena unit tests (not used by the app): a scriptable fake engine.
import { ChessGame } from "@/chess";
import type { SearchInfo, SearchLimits, SearchResult } from "@/types";
import type { GameEngine } from "./types";
import type { PoolEngine } from "./runner";

export interface FakeTurn {
  /** Position the engine was given. */
  game: ChessGame;
  limits: SearchLimits;
  /** 0-based count of go() calls on this engine. */
  call: number;
}

export interface FakeReply {
  /** Default: the first legal move (sorted), or null without legal moves. */
  bestMove?: string | null;
  /** Side-to-move POV. */
  scoreCp?: number | null;
  mate?: number | null;
  /** No info at all. */
  noInfo?: boolean;
  elapsedMs?: number;
  stopReason?: SearchResult["stopReason"];
  error?: string;
  /** Resolve after this many ms (real time). */
  delayMs?: number;
}

export type FakeBehaviour = (turn: FakeTurn) => FakeReply;

/** Deterministic default: first legal move in sorted order, score 0, 10 ms. */
export const firstLegal: FakeBehaviour = () => ({});

export class FakeEngine implements GameEngine, PoolEngine {
  game: ChessGame | null = null;
  calls = 0;
  newGames = 0;
  limitsSeen: SearchLimits[] = [];
  stopped = 0;
  terminated = false;
  rejectPosition = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly behaviour: FakeBehaviour = firstLegal,
    readonly id = "fake",
  ) {}

  get alive(): boolean {
    return !this.terminated;
  }

  async newGame(): Promise<void> {
    if (this.terminated) throw new Error("terminated");
    this.newGames++;
  }

  async position(startFen: string, moves: string[]): Promise<boolean> {
    if (this.terminated) throw new Error("terminated");
    if (this.rejectPosition) return false;
    this.game = ChessGame.fromMoves(startFen, moves);
    return this.game !== null;
  }

  async go(limits: SearchLimits, onInfo?: (i: SearchInfo) => void): Promise<SearchResult> {
    if (this.terminated) throw new Error("terminated");
    const game = this.game!;
    this.limitsSeen.push(limits);
    const reply = this.behaviour({ game, limits, call: this.calls++ });
    if (reply.delayMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, reply.delayMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
    const legal = game.legalMoves().sort();
    const bestMove = reply.bestMove !== undefined ? reply.bestMove : (legal[0] ?? null);
    const info: SearchInfo | null = reply.noInfo
      ? null
      : {
          depth: 5,
          seldepth: 7,
          scoreCp: reply.mate ? null : (reply.scoreCp ?? 0),
          mate: reply.mate ?? null,
          nodes: 1000,
          timeMs: reply.elapsedMs ?? 10,
          nps: 100_000,
          pv: bestMove ? [bestMove] : [],
        };
    if (info) onInfo?.(info);
    return { bestMove, info, elapsedMs: reply.elapsedMs ?? 10, stopReason: reply.stopReason ?? "done", error: reply.error };
  }

  stop(): void {
    this.stopped++;
    this.wake?.();
  }

  terminate(): void {
    this.terminated = true;
    this.wake?.();
  }
}
