// playEngineGame's move loop (runEngineGame) with fake engines.
import { describe, expect, it } from "vitest";
import { parsePgn } from "@/chess";
import type { AdjudicationConfig, ParticipantConfig, TimeControl } from "@/types";
import { MATE_SCORE } from "./adjudication";
import { runEngineGame, whitePovScore } from "./game";
import { FakeEngine, type FakeBehaviour, type FakeReply } from "./test-utils";
import type { PlayEngineGameOptions } from "./types";

const NO_ADJ: AdjudicationConfig = { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: null };

function side(name: string, config: Partial<ParticipantConfig> = {}) {
  return { engineId: name.toLowerCase(), name, config: { engineId: name.toLowerCase(), limits: { nodes: 1000 }, timeControl: null, ...config } };
}

/** Plays the scripted moves in order, then the first legal move. */
const script =
  (moves: string[], extra: (call: number) => FakeReply = () => ({})): FakeBehaviour =>
  ({ call }) => ({ ...(call < moves.length ? { bestMove: moves[call] } : {}), ...extra(call) });

function play(white: FakeEngine, black: FakeEngine, opts: Partial<PlayEngineGameOptions> = {}) {
  return runEngineGame(
    {
      white: side("Alpha"),
      black: side("Beta"),
      startFen: "startpos",
      adjudication: NO_ADJ,
      updateIntervalMs: 0,
      ...opts,
    },
    { white, black },
  );
}

describe("rules endings", () => {
  it("plays to checkmate and writes a PGN", async () => {
    const w = new FakeEngine(script(["f2f3", "g2g4"]));
    const b = new FakeEngine(script(["e7e5", "d8h4"]));
    const g = await play(w, b, { event: "Test match", round: "3" });
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("checkmate");
    expect(g.moves).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(g.san).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(g.times).toEqual([10, 10, 10, 10]);
    expect(g.evals).toEqual([0, 0, 0, 0]);
    expect(w.newGames).toBe(1);
    expect(b.newGames).toBe(1);
    const parsed = parsePgn(g.pgn)!;
    expect(parsed.moves).toEqual(g.moves);
    expect(parsed.headers).toMatchObject({ Event: "Test match", Round: "3", White: "Alpha", Black: "Beta", Result: "0-1", Termination: "normal", TimeControl: "-" });
  });

  it("stops at the ply limit with a draw", async () => {
    const g = await play(new FakeEngine(), new FakeEngine(), { adjudication: { ...NO_ADJ, maxPlies: 12 } });
    expect(g.result).toBe("1/2-1/2");
    expect(g.termination).toBe("max-moves");
    expect(g.moves).toHaveLength(12);
  });

  it("ends immediately when the start position is already over", async () => {
    const g = await play(new FakeEngine(), new FakeEngine(), { startFen: "7k/5QQ1/8/8/8/8/8/K7 b - - 0 1" });
    expect(g.termination).toBe("checkmate");
    expect(g.result).toBe("1-0");
    expect(g.moves).toEqual([]);
  });
});

describe("engine failures", () => {
  it("an illegal move loses", async () => {
    const g = await play(new FakeEngine(script(["e2e4", "e4e6"])), new FakeEngine(script(["e7e5"])));
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("illegal-move");
    expect(g.detail).toContain("e4e6");
    expect(g.moves).toEqual(["e2e4", "e7e5"]);
    expect(parsePgn(g.pgn)!.headers.Termination).toBe("rules infraction");
    expect(g.pgn).toContain("{White (Alpha) played");
  });

  it("a move that is not UCI (here SAN) is illegal", async () => {
    const g = await play(new FakeEngine(), new FakeEngine(script(["Nf6"])));
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("illegal-move");
  });

  it("no move while legal moves exist is an engine error", async () => {
    const g = await play(new FakeEngine(), new FakeEngine(() => ({ bestMove: null })));
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("engine-error");
    expect(g.detail).toMatch(/no move/);
    expect(g.moves).toHaveLength(1);
  });

  it("a crash loses with the engine's error message", async () => {
    const g = await play(new FakeEngine(({ call }) => (call === 2 ? { bestMove: null, stopReason: "error", error: "WebAssembly trap: unreachable" } : {})), new FakeEngine());
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("engine-error");
    expect(g.detail).toContain("WebAssembly trap: unreachable");
    expect(g.moves).toHaveLength(4);
  });

  it("an engine that rejects the position loses", async () => {
    const b = new FakeEngine();
    b.rejectPosition = true;
    const g = await play(new FakeEngine(), b);
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("engine-error");
  });

  it("a rejected go() promise counts as a crash", async () => {
    const w = new FakeEngine();
    w.go = () => Promise.reject(new Error("The engine was terminated."));
    const g = await play(w, new FakeEngine());
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("engine-error");
  });
});

describe("time", () => {
  const tc = (baseMs: number, incMs = 0, movesPerControl?: number): TimeControl => ({ baseMs, incMs, ...(movesPerControl ? { movesPerControl } : {}) });

  it("charges the time used and adds the increment; the engines get both clocks", async () => {
    const w = new FakeEngine(() => ({ elapsedMs: 200 }));
    const b = new FakeEngine(() => ({ elapsedMs: 100 }));
    const g = await play(w, b, {
      white: side("Alpha", { timeControl: tc(1_000, 50), limits: {} }),
      black: side("Beta", { timeControl: tc(2_000, 0), limits: {} }),
      adjudication: { ...NO_ADJ, maxPlies: 8 },
    });
    expect(g.termination).toBe("max-moves");
    expect(w.limitsSeen.map((l) => l.clock?.wtime)).toEqual([1000, 850, 700, 550]);
    expect(b.limitsSeen.map((l) => l.clock?.btime)).toEqual([2000, 1900, 1800, 1700]);
    expect(w.limitsSeen[1].clock).toMatchObject({ wtime: 850, btime: 1900, winc: 50, binc: 0 });
    expect(w.limitsSeen.every((l) => l.nodes === undefined)).toBe(true);
    const tags = parsePgn(g.pgn)!.headers;
    expect(tags.TimeControl).toBe("?");
    expect(tags.WhiteTimeControl).toBe("1+0.05");
    expect(tags.BlackTimeControl).toBe("2");
  });

  it("flags when a move takes longer than the remaining time", async () => {
    const w = new FakeEngine(({ call }) => ({ elapsedMs: call === 2 ? 700 : 200 }));
    const g = await play(w, new FakeEngine(), { white: side("Alpha", { timeControl: tc(1_000) }), black: side("Beta", { timeControl: tc(1_000) }) });
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("timeout");
    expect(g.detail).toMatch(/ran out of time/);
    expect(g.moves).toHaveLength(4);
    const tags = parsePgn(g.pgn)!.headers;
    expect(tags.Termination).toBe("time forfeit");
    expect(tags.TimeControl).toBe("1");
  });

  it("a host timeout loses on time even without a clock", async () => {
    // Nodes only: the host's safety limit stopped the search, and the detail says so.
    const g = await play(new FakeEngine(), new FakeEngine(() => ({ stopReason: "timeout", elapsedMs: 1200 })));
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("timeout");
    expect(g.detail).toMatch(/still running after 60 seconds, the longest a search limited only by depth or nodes may take/);
    // A time per move that the engine overran.
    const m = await play(new FakeEngine(), new FakeEngine(() => ({ stopReason: "timeout", elapsedMs: 1200 })), { black: side("Beta", { limits: { movetimeMs: 100 } }) });
    expect(m.result).toBe("1-0");
    expect(m.detail).toMatch(/did not stop within its limit and had to be cut short/);
  });

  it("is a draw when the opponent of the flagging side cannot mate", async () => {
    const g = await play(new FakeEngine(() => ({ elapsedMs: 2_000 })), new FakeEngine(), {
      startFen: "4k3/8/8/8/8/8/8/3QK3 w - - 0 1",
      white: side("Alpha", { timeControl: tc(1_000) }),
      black: side("Beta", { timeControl: tc(1_000) }),
    });
    expect(g.result).toBe("1/2-1/2");
    expect(g.termination).toBe("timeout");
    expect(g.detail).toMatch(/no mating material/);
  });

  it("passes moves-to-go for classical time controls and adds the base time per period", async () => {
    const w = new FakeEngine(() => ({ elapsedMs: 400 }));
    await play(w, new FakeEngine(() => ({ elapsedMs: 1 })), {
      white: side("Alpha", { timeControl: tc(1_000, 0, 2), limits: {} }),
      black: side("Beta", { timeControl: tc(1_000, 0, 2), limits: {} }),
      adjudication: { ...NO_ADJ, maxPlies: 10 },
    });
    expect(w.limitsSeen.map((l) => l.clock?.movestogo)).toEqual([2, 1, 2, 1, 2]);
    // 1000 → 600 → 200 + 1000 (period done) → 800 → 400 + 1000 ...
    expect(w.limitsSeen.map((l) => l.clock?.wtime)).toEqual([1000, 600, 1200, 800, 1400]);
  });

  it("keeps opening moves off the clock and out of the evals", async () => {
    const w = new FakeEngine(() => ({ elapsedMs: 100, scoreCp: 25 }));
    const b = new FakeEngine(() => ({ elapsedMs: 100, scoreCp: 40 }));
    const g = await play(w, b, {
      openingMoves: ["e2e4", "e7e5", "g1f3"],
      opening: "Test opening",
      eco: "C40",
      white: side("Alpha", { timeControl: tc(5_000, 0, 3), limits: {} }),
      black: side("Beta", { timeControl: tc(5_000, 0, 3), limits: {} }),
      adjudication: { ...NO_ADJ, maxPlies: 7 },
    });
    expect(g.moves.slice(0, 3)).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(g.openingPlies).toBe(3);
    expect(g.evals.slice(0, 3)).toEqual([null, null, null]);
    expect(g.times.slice(0, 3)).toEqual([0, 0, 0]);
    // Black moves first after the book: full clock, a whole period to go.
    expect(b.limitsSeen[0].clock).toMatchObject({ wtime: 5000, btime: 5000, movestogo: 3 });
    expect(w.limitsSeen[0].clock).toMatchObject({ wtime: 5000, btime: 4900, movestogo: 3 });
    // Engine evals in White's view: White's engine +25, Black's engine +40 for Black.
    expect(g.evals.slice(3)).toEqual([-40, 25, -40, 25]);
    const tags = parsePgn(g.pgn)!.headers;
    expect(tags).toMatchObject({ Opening: "Test opening", ECO: "C40", PlyCount: "7" });
  });

  it("an illegal opening move only shortens the opening", async () => {
    const logs: string[] = [];
    const g = await play(new FakeEngine(), new FakeEngine(), {
      openingMoves: ["e2e4", "e2e4"],
      adjudication: { ...NO_ADJ, maxPlies: 4 },
      onLog: (_l, t) => logs.push(t),
    });
    expect(g.openingPlies).toBe(1);
    expect(g.moves[0]).toBe("e2e4");
    expect(logs.join("\n")).toMatch(/not legal/);
  });
});

describe("adjudication in games", () => {
  it("resigns when both engines agree for N moves each", async () => {
    // Side-to-move POV: White's engine sees +10 pawns, Black's engine sees -10 pawns (= White +10).
    const g = await play(new FakeEngine(() => ({ scoreCp: 1000 })), new FakeEngine(() => ({ scoreCp: -1000 })), {
      adjudication: { ...NO_ADJ, resignScoreCp: 900, resignMoves: 4 },
    });
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("resign");
    expect(g.moves).toHaveLength(8);
    expect(parsePgn(g.pgn)!.headers.Termination).toBe("adjudication");
  });

  it("counts mate scores as decisive", async () => {
    const g = await play(new FakeEngine(() => ({ mate: -5 })), new FakeEngine(() => ({ mate: 6 })), {
      adjudication: { ...NO_ADJ, resignScoreCp: 900, resignMoves: 2 },
    });
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("resign");
    expect(g.evals).toEqual([-MATE_SCORE, -MATE_SCORE, -MATE_SCORE, -MATE_SCORE]);
  });

  it("draws when both scores stay near zero after the minimum ply", async () => {
    const g = await play(new FakeEngine(() => ({ scoreCp: 5 })), new FakeEngine(() => ({ scoreCp: -3 })), {
      adjudication: { ...NO_ADJ, drawScoreCp: 10, drawMoves: 3, drawMinPly: 4 },
    });
    expect(g.result).toBe("1/2-1/2");
    expect(g.termination).toBe("adjudication");
    expect(g.moves).toHaveLength(10);
  });

  it("does not adjudicate with unknown scores", async () => {
    const g = await play(new FakeEngine(() => ({ noInfo: true })), new FakeEngine(() => ({ noInfo: true })), {
      adjudication: { resignScoreCp: 1, resignMoves: 1, drawScoreCp: 10000, drawMoves: 1, drawMinPly: 0, maxPlies: 6 },
    });
    expect(g.termination).toBe("max-moves");
    expect(g.moves).toHaveLength(6);
    expect(g.evals.every((e) => e === null)).toBe(true);
  });
});

describe("abort and live updates", () => {
  it("stops a running search and returns an aborted game", async () => {
    const controller = new AbortController();
    const w = new FakeEngine(() => ({ delayMs: 5_000 }));
    const b = new FakeEngine();
    setTimeout(() => controller.abort(), 30);
    const t0 = Date.now();
    const g = await play(w, b, { signal: controller.signal });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(g.result).toBe("*");
    expect(g.termination).toBe("aborted");
    expect(w.stopped).toBeGreaterThan(0);
    expect(parsePgn(g.pgn)!.headers.Result).toBe("*");
  });

  it("reports the game through onUpdate, ending with the final position", async () => {
    const views: Array<{ moves: string[]; thinking?: string | null; whiteInfo: unknown }> = [];
    const g = await play(new FakeEngine(script(["f2f3", "g2g4"])), new FakeEngine(script(["e7e5", "d8h4"])), {
      onUpdate: (v) => views.push({ moves: v.moves, thinking: v.thinking, whiteInfo: v.whiteInfo }),
    });
    expect(views.length).toBeGreaterThan(4);
    const last = views[views.length - 1];
    expect(last.moves).toEqual(g.moves);
    expect(last.thinking).toBeNull();
    expect(last.whiteInfo).not.toBeNull();
  });

  it("throttles onUpdate", async () => {
    let count = 0;
    await play(new FakeEngine(() => ({ elapsedMs: 1 })), new FakeEngine(() => ({ elapsedMs: 1 })), {
      updateIntervalMs: 60_000,
      adjudication: { ...NO_ADJ, maxPlies: 40 },
      onUpdate: () => count++,
    });
    // The first update, then only the final one.
    expect(count).toBeLessThanOrEqual(3);
  });
});

describe("whitePovScore", () => {
  it("converts side-to-move scores and maps mates", () => {
    const info = (scoreCp: number | null, mate: number | null) => ({ depth: 1, seldepth: 1, scoreCp, mate, nodes: 1, timeMs: 1, nps: 1, pv: [] });
    expect(whitePovScore(info(35, null), "w")).toBe(35);
    expect(whitePovScore(info(35, null), "b")).toBe(-35);
    expect(whitePovScore(info(null, 3), "b")).toBe(-MATE_SCORE);
    expect(whitePovScore(info(null, -2), "b")).toBe(MATE_SCORE);
    expect(whitePovScore(info(31_000, null), "w")).toBe(MATE_SCORE);
    expect(whitePovScore(null, "w")).toBeNull();
    expect(whitePovScore(info(null, null), "w")).toBeNull();
  });
});
