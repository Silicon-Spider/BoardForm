// Self-play with the real template engine (compiled with asc in Node): game loop, recording
// filters, determinism, gating games, the worker message handler and the pool scheduler (workers
// replaced by in-process fakes running the real handler).
import { beforeAll, describe, expect, it } from "vitest";
import { ChessGame } from "@/chess";
import { compileEngine } from "@/blocks/testing/engine-harness";
import { EngineInstance } from "@/engine-host/instance";
import { PACKED_SIZE, packedScore, packedToFen, validatePacked } from "@/nnue/pack";
import { gameSettingsFor } from "./selfplay-job";
import { createSelfPlayWorkerHandler, playGatingGame, playSelfPlayGame, type PlayingEngine } from "./selfplay-core";
import { createWorkerSelfPlaySource, gatingOutcome, type SelfPlayWorkerLike } from "./selfplay-pool";
import type { SelfPlayGameRecord, SelfPlayWorkerEvent, SelfPlayWorkerRequest } from "./selfplay-protocol";
import { Adjudicator, scoreFromInfo } from "./scores";

let wasm: Uint8Array;
beforeAll(async () => {
  const out = await compileEngine(null);
  if (!out.wasm) throw new Error(`template did not compile:\n${out.log}`);
  wasm = out.wasm;
}, 180_000);

const SETTINGS = gameSettingsFor({ limits: { nodes: 400 }, randomPlies: 6, maxPlies: 160, skipPlies: 8 });
const ctx = { shouldStop: () => false };

describe("scores and adjudication", () => {
  it("converts mates to huge scores and adjudicates after a streak", () => {
    expect(scoreFromInfo({ depth: 5, seldepth: 5, scoreCp: null, mate: 3, nodes: 1, timeMs: 1, nps: 1, pv: [] })).toBe(29997);
    expect(scoreFromInfo({ depth: 5, seldepth: 5, scoreCp: null, mate: -2, nodes: 1, timeMs: 1, nps: 1, pv: [] })).toBe(-29998);
    expect(scoreFromInfo(null)).toBeNull();
    const a = new Adjudicator(2500, 3);
    expect([a.push(2600), a.push(3000), a.push(-2600), a.push(-2500), a.push(-9999)]).toEqual([null, null, null, null, 0]);
    const b = new Adjudicator(2500, 2);
    expect([b.push(2600), b.push(null), b.push(2600), b.push(2700)]).toEqual([null, null, null, 2]);
  });
});

describe("self-play games with the template engine", () => {
  it("records filtered, labelled positions and is deterministic for a seed", async () => {
    const engine = await EngineInstance.create(wasm, { hashMb: 1 });
    const game = (await playSelfPlayGame(engine, SETTINGS, 1234, 0, ctx)) as SelfPlayGameRecord;
    expect(game).not.toBeNull();
    expect(["checkmate", "stalemate", "threefold", "fifty-move", "insufficient-material", "max-moves", "adjudication"]).toContain(game.termination);
    expect(game.plies).toBeLessThanOrEqual(160);
    expect(game.searched).toBe(game.plies - 6);
    expect(game.positions).toBeGreaterThan(0);
    expect(game.positions + Object.values(game.skipped).reduce((s, n) => s + n, 0)).toBe(game.searched);
    expect(game.skipped.early).toBe(2); // plies 6 and 7 are searched but below skipPlies = 8
    const data = new Uint8Array(game.data);
    expect(data.length).toBe(game.positions * PACKED_SIZE);
    for (let i = 0; i < game.positions; i++) {
      const off = i * PACKED_SIZE;
      expect(validatePacked(data, off)).toBeNull();
      expect(data[off + 26]).toBe(game.result);
      expect(Math.abs(packedScore(data, off))).toBeLessThan(3000);
      const fen = packedToFen(data, off);
      expect(new ChessGame(fen).inCheck()).toBe(false);
    }
    // Same seed, fresh engine → the same game.
    const again = (await playSelfPlayGame(await EngineInstance.create(wasm, { hashMb: 1 }), SETTINGS, 1234, 0, ctx)) as SelfPlayGameRecord;
    expect(again.plies).toBe(game.plies);
    expect(new Uint8Array(again.data)).toEqual(data);
    // Another seed → another opening.
    const other = (await playSelfPlayGame(engine, SETTINGS, 99, 1, ctx)) as SelfPlayGameRecord;
    expect(new Uint8Array(other.data)).not.toEqual(data);
  });

  it("abandons a game when stopped and reports engine misbehaviour", async () => {
    const engine = await EngineInstance.create(wasm, { hashMb: 1 });
    let calls = 0;
    expect(await playSelfPlayGame(engine, SETTINGS, 5, 0, { shouldStop: () => ++calls > 10 })).toBeNull();
    const liar: PlayingEngine = { newGame() {}, position: () => true, go: () => ({ bestMove: "e2e5", info: null }) };
    await expect(playSelfPlayGame(liar, SETTINGS, 5, 0, ctx)).rejects.toThrow(/illegal move "e2e5"/);
    const mute: PlayingEngine = { newGame() {}, position: () => true, go: () => ({ bestMove: null, info: null }) };
    await expect(playSelfPlayGame(mute, SETTINGS, 5, 0, ctx)).rejects.toThrow(/produced no move/);
  });

  it("plays gating games between two instances", async () => {
    const a = await EngineInstance.create(wasm, { hashMb: 1 });
    const b = await EngineInstance.create(wasm, { hashMb: 1 });
    const g = await playGatingGame(a, b, SETTINGS, 77, 0, true, ctx);
    expect(g).not.toBeNull();
    expect([0, 1, 2]).toContain(g!.result);
    expect(g!.newIsWhite).toBe(true);
    expect(gatingOutcome({ newIsWhite: true, result: 2 })).toBe("win");
    expect(gatingOutcome({ newIsWhite: false, result: 2 })).toBe("loss");
    expect(gatingOutcome({ newIsWhite: false, result: 0 })).toBe("win");
    expect(gatingOutcome({ newIsWhite: true, result: 1 })).toBe("draw");
  });
});

/** In-process stand-in for selfplay.worker.ts (the real handler and engine, async messages). */
class InProcessSelfPlayWorker implements SelfPlayWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  private readonly handle: (msg: SelfPlayWorkerRequest) => void;

  constructor(failInit = false) {
    this.handle = createSelfPlayWorkerHandler(
      {
        post: (event: SelfPlayWorkerEvent) => {
          setTimeout(() => {
            if (!this.terminated) this.onmessage?.({ data: event } as MessageEvent);
          }, 0);
        },
      },
      failInit
        ? {
            createEngine: async () => {
              throw new Error("Not a BoardForm engine: missing required export cb_go");
            },
          }
        : {},
    );
  }

  postMessage(message: SelfPlayWorkerRequest): void {
    setTimeout(() => {
      if (!this.terminated) this.handle(message);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("self-play pool", () => {
  const job = (games: number | null, concurrency: number) => ({
    wasm: wasm.slice().buffer,
    network: null,
    hashMb: 1,
    engineName: "Template",
    settings: SETTINGS,
    games,
    concurrency,
    seed: 42,
    firstGameIndex: 10,
  });

  it("hands out games until the target is reached and shuts the workers down", async () => {
    const workers: InProcessSelfPlayWorker[] = [];
    const source = createWorkerSelfPlaySource(() => {
      const w = new InProcessSelfPlayWorker();
      workers.push(w);
      return w;
    });
    const games: SelfPlayGameRecord[] = [];
    let boards = 0;
    let ready = 0;
    const summary = await source.selfPlay(job(5, 3), { onGame: (g) => void games.push(g), onBoards: () => boards++, onReady: (n) => (ready = n) }, new AbortController().signal);
    expect(summary.games).toBe(5);
    expect(summary.stopped).toBe(false);
    expect(summary.positions).toBe(games.reduce((s, g) => s + g.positions, 0));
    expect(games.map((g) => g.gameIndex).sort((x, y) => x - y)).toEqual([10, 11, 12, 13, 14]);
    expect(ready).toBe(3);
    expect(boards).toBeGreaterThan(0);
    expect(workers).toHaveLength(3);
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("stops quickly, keeping the games that were completed", async () => {
    const source = createWorkerSelfPlaySource(() => new InProcessSelfPlayWorker());
    const controller = new AbortController();
    let completed = 0;
    const t0 = Date.now();
    const summary = await source.selfPlay(
      job(null, 2),
      {
        onGame: () => {
          if (++completed === 2) controller.abort();
        },
      },
      controller.signal,
    );
    expect(summary.stopped).toBe(true);
    expect(summary.games).toBeGreaterThanOrEqual(2);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });

  it("runs gating matches and reports start-up failures", async () => {
    const source = createWorkerSelfPlaySource(() => new InProcessSelfPlayWorker());
    const net = new ArrayBuffer(0);
    const results: string[] = [];
    const g = await source.gating(
      { wasm: wasm.slice().buffer, newNetwork: net, oldNetwork: net, hashMb: 1, names: { new: "New", old: "Old" }, settings: SETTINGS, games: 4, concurrency: 2, seed: 3 },
      { onGame: (rec) => void results.push(`${rec.gameIndex}:${rec.newIsWhite ? "w" : "b"}`) },
      new AbortController().signal,
    );
    expect(g.played).toBe(4);
    expect(g.wins + g.draws + g.losses).toBe(4);
    expect(results.sort()).toEqual(["0:w", "1:b", "2:w", "3:b"]);

    const broken = createWorkerSelfPlaySource(() => new InProcessSelfPlayWorker(true));
    await expect(broken.selfPlay(job(3, 2), { onGame: () => {} }, new AbortController().signal)).rejects.toThrow(/could not be started for self-play: Not a BoardForm engine/);
  });
});
