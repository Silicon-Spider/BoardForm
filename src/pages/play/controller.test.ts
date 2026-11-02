import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChessGame, START_FEN, randomPlies } from "@/chess";
import type { CompileDiagnostic, GameRecord, SearchInfo, SearchLimits, SearchResult, TimeControl } from "@/types";
import { GameController, type ControllerDeps, type EngineHandle, type GameState } from "./controller";
import { DEFAULT_SETUP, engineSide, HUMAN_SIDE } from "./setup";
import type { GameSetup, PersistedGame, PlayerMeta } from "./types";

// --- fakes -----------------------------------------------------------------------------------

type Responder = (game: ChessGame, limits: SearchLimits, engine: FakeEngine, onInfo?: (i: SearchInfo) => void) => Promise<SearchResult> | SearchResult;

const info = (scoreCp: number | null, pv: string[] = [], mate: number | null = null): SearchInfo => ({ depth: 4, seldepth: 6, scoreCp, mate, nodes: 1000, timeMs: 5, nps: 200_000, pv });
const done = (bestMove: string | null, extra: Partial<SearchResult> = {}): SearchResult => ({ bestMove, info: info(0, bestMove ? [bestMove] : []), elapsedMs: 5, stopReason: "done", ...extra });

/** Plays the first legal move (or a scripted reply) and lets the test advance the fake clock. */
class FakeEngine implements EngineHandle {
  readonly capabilities = { abiVersion: 1, eval: true, trace: false, perft: false, nnue: false, setOption: true, name: null, stopFlag: true };
  positions: string[][] = [];
  limits: SearchLimits[] = [];
  terminated = false;
  stops = 0;
  private game: ChessGame | null = null;
  private pendingStop: (() => void) | null = null;

  constructor(private readonly respond: Responder = (g) => done(g.legalMoves()[0] ?? null)) {}

  async newGame(): Promise<void> {}
  async position(startFen: string, moves: string[]): Promise<boolean> {
    this.positions.push([...moves]);
    this.game = ChessGame.fromMoves(startFen, moves);
    return this.game !== null;
  }
  async go(limits: SearchLimits, onInfo?: (i: SearchInfo) => void): Promise<SearchResult> {
    this.limits.push(limits);
    return this.respond(this.game!, limits, this, onInfo);
  }
  /** A search that only ends when stop() is called. */
  waitForStop(): Promise<SearchResult> {
    return new Promise((resolve) => {
      this.pendingStop = () => resolve(done(this.game!.legalMoves()[0], { stopReason: "stopped" }));
    });
  }
  stop(): void {
    this.stops++;
    this.pendingStop?.();
    this.pendingStop = null;
  }
  terminate(): void {
    this.terminated = true;
  }
}

interface Harness {
  deps: ControllerDeps;
  saved: GameRecord[];
  persisted: PersistedGame[];
  engines: Record<string, FakeEngine>;
  loads: string[];
}

function harness(engines: Record<string, FakeEngine>, opts: { loadError?: unknown } = {}): Harness {
  const h: Harness = {
    saved: [],
    persisted: [],
    engines,
    loads: [],
    deps: {
      async loadEngine(id) {
        h.loads.push(id);
        if (opts.loadError) throw opts.loadError;
        const e = engines[id];
        if (!e) throw new Error(`Engine not found (it may have been deleted).`);
        return e;
      },
      async saveGame(r) {
        h.saved.push(r);
      },
      persist(g) {
        h.persisted.push(structuredClone(g));
      },
      now: () => Date.now(),
      wallNow: () => Date.now(),
      newId: () => "game-1",
    },
  };
  return h;
}

const meta = (side: GameSetup["white"], name: string): PlayerMeta =>
  side.player === "human"
    ? { kind: "human", name, engineId: null, engineKind: null, color: null, hashMb: null, limits: {}, timeControl: side.timeControl }
    : { kind: "engine", name, engineId: side.engineId, engineKind: "eval", color: "#fff", hashMb: 16, limits: side.limits, timeControl: side.timeControl };

function startGame(h: Harness, white: GameSetup["white"], black: GameSetup["black"], extra: { moves?: string[]; startFen?: string; delay?: number } = {}) {
  const setup: GameSetup = { ...DEFAULT_SETUP, white, black };
  return GameController.start(
    {
      setup,
      players: { w: meta(white, white.player === "human" ? "You" : "WhiteBot"), b: meta(black, black.player === "human" ? "You" : "BlackBot") },
      start: { startFen: extra.startFen ?? START_FEN, moves: extra.moves ?? [], opening: null },
      moveDelayMs: extra.delay ?? 0,
    },
    h.deps,
  );
}

/** Lets promises and (fake) timers run. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Runs pending promises first (no time passes), then advances time in small steps until `pred` holds. */
async function until(c: GameController, pred: (s: GameState) => boolean, stepMs = 10, maxSteps = 2000) {
  for (let i = 0; i < maxSteps; i++) {
    await settle(0);
    if (pred(c.getState())) return;
    await settle(stepMs);
  }
  expect(pred(c.getState())).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const clock = (baseMs: number, incMs = 0): TimeControl => ({ baseMs, incMs });

// --- tests -----------------------------------------------------------------------------------

describe("GameController: human vs engine", () => {
  it("loads the engine, waits for the human, then lets the engine reply", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    expect(c.getState().phase).toBe("loading");
    await until(c, (s) => s.phase === "playing");
    expect(h.loads).toEqual(["e1"]);
    expect(c.getState().turn).toBe("w");
    expect(c.humanMove({ from: "e7", to: "e5" })).toBe(false); // not White's move
    expect(c.humanMove({ from: "e2", to: "e4" })).toBe(true);
    await until(c, (s) => s.moves.length === 2);
    expect(h.engines.e1.positions[0]).toEqual(["e2e4"]);
    expect(h.engines.e1.limits[0]).toEqual({ movetimeMs: 1000 });
    const s = c.getState();
    expect(s.san[0]).toBe("e4");
    expect(s.turn).toBe("w");
    expect(s.evals).toEqual([null, 0]);
    expect(h.persisted.at(-1)?.moves).toEqual(s.moves);
    c.dispose();
    expect(h.engines.e1.terminated).toBe(true);
  });

  it("an illegal engine move loses the game and the game is saved", async () => {
    const h = harness({ e1: new FakeEngine(() => done("e2e5")) });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    c.humanMove("e2e4");
    await until(c, (s) => s.phase === "finished");
    expect(c.getState().end).toMatchObject({ result: "1-0", termination: "illegal-move", winner: "w" });
    await until(c, (s) => s.save.status === "saved");
    expect(h.saved[0]).toMatchObject({ id: "game-1", result: "1-0", termination: "illegal-move", moves: ["e2e4"], matchId: null });
    expect(h.engines.e1.terminated).toBe(true);
  });

  it("no move while legal moves exist is an engine error", async () => {
    const h = harness({ e1: new FakeEngine(() => done(null)) });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    c.humanMove("d2d4");
    await until(c, (s) => s.phase === "finished");
    expect(c.getState().end).toMatchObject({ result: "1-0", termination: "engine-error", reason: "BlackBot produced no move." });
  });

  it("a crash is an engine error", async () => {
    const h = harness({ e1: new FakeEngine(() => done(null, { stopReason: "error", error: "WebAssembly trap: unreachable" })) });
    const c = startGame(h, engineSide("e1"), HUMAN_SIDE);
    await until(c, (s) => s.phase === "finished");
    expect(c.getState().end).toMatchObject({ result: "0-1", termination: "engine-error" });
    expect(c.getState().end?.reason).toContain("unreachable");
  });

  it("charges the engine's thinking time and adds the increment", async () => {
    const h = harness({
      e1: new FakeEngine((g) => {
        vi.setSystemTime(Date.now() + 2000); // the engine thinks for 2 s
        return done(g.legalMoves()[0]);
      }),
    });
    const tc = clock(300_000, 3000);
    const c = startGame(h, { ...HUMAN_SIDE, timeControl: tc }, engineSide("e1", {}, tc));
    await until(c, (s) => s.phase === "playing");
    expect(c.getState().running).toBe("w");
    await settle(1500); // the human thinks 1.5 s
    c.humanMove("e2e4");
    await until(c, (s) => s.moves.length === 2);
    const s = c.getState();
    expect(s.clock.w).toBe(300_000 - 1500 + 3000);
    expect(s.clock.b).toBe(300_000 - 2000 + 3000);
    expect(s.times).toEqual([1500, 2000]);
    // The engine got both clocks.
    expect(h.engines.e1.limits[0].clock).toEqual({ wtime: 301_500, btime: 300_000, winc: 3000, binc: 3000 });
    c.dispose();
  });

  it("the human flags on a 1+0 clock", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, { ...HUMAN_SIDE, timeControl: clock(60_000) }, engineSide("e1", {}, clock(60_000)));
    await until(c, (s) => s.phase === "playing");
    await settle(60_100);
    expect(c.getState().phase).toBe("finished");
    expect(c.getState().end).toMatchObject({ result: "0-1", termination: "timeout", winner: "b", reason: "You ran out of time." });
    expect(c.getState().clock.w).toBe(0);
    // An aborted-with-no-moves game is not saved, but a timeout is.
    await until(c, (s) => s.save.status === "saved");
  });

  it("an engine timeout with a clock is a flag fall; without a clock the move is played", async () => {
    const tc = clock(10_000);
    // The host stopped the search after the clock ran out (remaining + 100 ms).
    const h1 = harness({
      e1: new FakeEngine((g) => {
        vi.setSystemTime(Date.now() + 10_100);
        return done(g.legalMoves()[0], { stopReason: "timeout", elapsedMs: 10_100 });
      }),
    });
    const c1 = startGame(h1, engineSide("e1", {}, tc), { ...HUMAN_SIDE, timeControl: tc });
    await until(c1, (s) => s.phase === "finished");
    expect(c1.getState().end).toMatchObject({ result: "0-1", termination: "timeout" });
    expect(c1.getState().clock.w).toBe(0);

    const h2 = harness({ e1: new FakeEngine((g) => done(g.legalMoves()[0], { stopReason: "timeout" })) });
    const c2 = startGame(h2, engineSide("e1", { movetimeMs: 200 }), HUMAN_SIDE);
    await until(c2, (s) => s.moves.length === 1);
    expect(c2.getState().phase).toBe("playing");
    expect(c2.getState().engines.w?.logs.join("\n")).toMatch(/overran its time limit/);
    c2.dispose();
  });

  it("overrunning the per-move cap with clock time left is not a flag fall", async () => {
    const tc = clock(300_000);
    const h = harness({
      e1: new FakeEngine((g) => {
        vi.setSystemTime(Date.now() + 480); // 0.3 s cap, answered after 0.48 s
        return done(g.legalMoves()[0], { stopReason: "timeout", elapsedMs: 480 });
      }),
    });
    const c = startGame(h, engineSide("e1", { movetimeMs: 300 }, tc), { ...HUMAN_SIDE, timeControl: tc });
    await until(c, (s) => s.moves.length === 1);
    expect(c.getState().phase).toBe("playing");
    expect(c.getState().clock.w).toBe(300_000 - 480);
    expect(c.getState().engines.w?.logs.join("\n")).toMatch(/per-move limit/);
    c.dispose();
  });

  it("takes back the engine reply and the human move", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    expect(c.getState().takebackPlies).toBe(0);
    c.humanMove("e2e4");
    await until(c, (s) => s.moves.length === 2);
    expect(c.getState().takebackPlies).toBe(2);
    expect(c.takeback()).toBe(true);
    expect(c.getState().moves).toEqual([]);
    expect(c.getState().turn).toBe("w");
    expect(c.humanMove("d2d4")).toBe(true);
    c.dispose();
  });

  it("after a takeback the eval bar shows the last evaluation still in the game", async () => {
    // The engine (Black) reports +50 then +120 from its own point of view.
    let reply = 0;
    const scores = [50, 120];
    const h = harness({ e1: new FakeEngine((g) => ({ ...done(g.legalMoves()[0]), info: info(scores[reply++] ?? 0) })) });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    c.humanMove("e2e4");
    await until(c, (s) => s.moves.length === 2);
    c.humanMove("d2d4");
    await until(c, (s) => s.moves.length === 4);
    expect(c.getState().liveEval).toEqual({ cp: -120, mate: null });
    c.takeback();
    expect(c.getState().moves.length).toBe(2);
    expect(c.getState().liveEval).toEqual({ cp: -50, mate: null });
    c.takeback();
    expect(c.getState().liveEval).toBeNull();
    c.dispose();
  });

  it("takeback while the engine thinks stops it and undoes one ply", async () => {
    const thinker = new FakeEngine((_g, _l, e) => e.waitForStop());
    const h = harness({ e1: thinker });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    c.humanMove("e2e4");
    await until(c, (s) => s.engines.b?.status === "thinking");
    expect(c.getState().takebackPlies).toBe(1);
    c.takeback();
    await settle(10);
    expect(thinker.stops).toBe(1);
    expect(c.getState().moves).toEqual([]);
    expect(c.getState().phase).toBe("playing");
    c.dispose();
  });

  it("an engine declines an early draw offer and accepts a level one from ply 40", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    expect(c.offerDraw().accepted).toBe(false);
    expect(c.getState().notice?.text).toMatch(/declines the draw: it is too early/);
    expect(c.getState().phase).toBe("playing");
    c.dispose();

    // 40 book plies, then the engine (White) moves with a 0.00 score and the human offers a draw.
    const h2 = harness({ e1: new FakeEngine() });
    const book = randomPlies(40, 7);
    const c2 = startGame(h2, engineSide("e1"), HUMAN_SIDE, { moves: book });
    await until(c2, (s) => s.moves.length === 41 || s.phase === "finished");
    expect(c2.getState().phase).toBe("playing");
    expect(c2.offerDraw().accepted).toBe(true);
    expect(c2.getState().end).toMatchObject({ result: "1/2-1/2", termination: "draw-agreed", reason: "WhiteBot accepted your draw offer." });
  });
});

describe("GameController: engine vs engine", () => {
  const script = (moves: string[]) => (g: ChessGame) => done(moves[g.ply()] ?? null);

  it("plays a game to checkmate and saves it", async () => {
    const fools = ["f2f3", "e7e5", "g2g4", "d8h4"];
    const h = harness({ w: new FakeEngine(script(fools)), b: new FakeEngine(script(fools)) });
    const c = startGame(h, engineSide("w"), engineSide("b"));
    await until(c, (s) => s.phase === "finished");
    expect(c.getState().end).toMatchObject({ result: "0-1", termination: "checkmate", winner: "b" });
    await until(c, (s) => s.save.status === "saved");
    expect(h.saved[0].san).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(h.saved[0].white).toEqual({ type: "engine", engineId: "w", name: "WhiteBot" });
    expect(h.engines.w.terminated && h.engines.b.terminated).toBe(true);
  });

  it("waits the move delay between moves and can pause / resume", async () => {
    const h = harness({ w: new FakeEngine(), b: new FakeEngine() });
    const c = startGame(h, engineSide("w"), engineSide("b"), { delay: 500 });
    await until(c, (s) => s.moves.length === 1);
    await settle(200);
    expect(c.getState().moves.length).toBe(1); // still waiting
    await settle(400);
    expect(c.getState().moves.length).toBe(2);
    c.pause();
    expect(c.getState().phase).toBe("paused");
    await settle(2000);
    expect(c.getState().moves.length).toBe(2);
    c.resume();
    await until(c, (s) => s.moves.length === 3);
    c.dispose();
  });

  it("book moves count as played but not as clock moves", async () => {
    const h = harness({ w: new FakeEngine(), b: new FakeEngine() });
    const tc: TimeControl = { baseMs: 60_000, incMs: 0, movesPerControl: 1 };
    // A move delay, so the instant fake engines do not play the whole game in one go.
    const c = startGame(h, engineSide("w", {}, tc), engineSide("b", {}, tc), { moves: ["e2e4", "e7e5"], delay: 50 });
    await until(c, (s) => s.moves.length === 3);
    // movesPerControl = 1: every move adds the base time again.
    expect(c.getState().clock.w).toBe(120_000);
    expect(h.engines.w.limits[0].clock?.movestogo).toBe(1);
    expect(c.getState().bookPlies).toBe(2);
    c.dispose();
  });
});

describe("GameController: loading, aborting, persistence", () => {
  it("reports build errors with diagnostics and does not start", async () => {
    const diagnostics: CompileDiagnostic[] = [{ severity: "error", code: 2304, message: "Cannot find name 'x'.", file: "eval.ts", line: 3, column: 5 }];
    const err = Object.assign(new Error('"Broken" failed to compile'), { result: { diagnostics } });
    const h = harness({}, { loadError: err });
    const c = startGame(h, HUMAN_SIDE, engineSide("broken"));
    await until(c, (s) => s.phase === "failed");
    expect(c.getState().loadError).toMatchObject({ side: "b", engineId: "broken", diagnostics });
    expect(h.persisted).toEqual([]);
    c.abort();
    expect(c.getState().save.status).toBe("skipped");
    expect(h.saved).toEqual([]);
  });

  it("aborting before any move does not save a game", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, HUMAN_SIDE, engineSide("e1"));
    await until(c, (s) => s.phase === "playing");
    c.abort();
    expect(c.getState().end?.termination).toBe("aborted");
    await settle(10);
    expect(c.getState().save.status).toBe("skipped");
    expect(h.saved).toEqual([]);
  });

  it("restores an interrupted game without charging the time it was away", async () => {
    const h = harness({ e1: new FakeEngine() });
    const tc = clock(120_000);
    const c = startGame(h, { ...HUMAN_SIDE, timeControl: tc }, engineSide("e1", {}, tc));
    await until(c, (s) => s.phase === "playing");
    c.humanMove("e2e4");
    await until(c, (s) => s.moves.length === 2);
    await settle(7000); // the human thinks; the periodic persist charges the running clock
    c.dispose(); // leaving the page
    const stored = h.persisted.at(-1)!;
    expect(stored.end).toBeNull();
    expect(stored.clock.w).toBeLessThanOrEqual(120_000 - 7000 + 10);

    await settle(3_600_000); // an hour later
    const h2 = harness({ e1: new FakeEngine() });
    const r = GameController.restore(stored, h2.deps, 0)!;
    expect(r.getState().phase).toBe("interrupted");
    expect(r.getState().clock.w).toBe(stored.clock.w);
    r.resume();
    await until(r, (s) => s.phase === "playing");
    expect(r.getState().running).toBe("w");
    await settle(1000);
    expect(r.humanMove("d2d4")).toBe(true);
    // Charged only for the second after resuming, not for the hour away.
    expect(r.getState().clock.w).toBeLessThanOrEqual(stored.clock.w! - 1000);
    expect(r.getState().clock.w).toBeGreaterThanOrEqual(stored.clock.w! - 1020);
    r.dispose();
  });

  it("restore rejects games whose moves are illegal", () => {
    const h = harness({});
    const bad = { v: 1, id: "x", startFen: START_FEN, moves: ["e2e5"], players: {} } as unknown as PersistedGame;
    expect(GameController.restore(bad, h.deps, 0)).toBeNull();
  });

  it("resign ends the game for the human side", async () => {
    const h = harness({ e1: new FakeEngine() });
    const c = startGame(h, engineSide("e1"), HUMAN_SIDE);
    await until(c, (s) => s.moves.length === 1);
    c.resign();
    expect(c.getState().end).toMatchObject({ result: "1-0", termination: "resign", winner: "w" });
    c.dispose();
  });
});
