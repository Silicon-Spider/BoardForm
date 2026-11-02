import { describe, expect, it } from "vitest";
import { ChessGame, OPENINGS, pickOpenings } from "@/chess";
import type { MatchConfig, ParticipantConfig } from "@/types";
import { buildSchedule, buildSlots, countGames, openingForSlot, pairingsOf, withOpening } from "./schedule";

const p = (engineId: string): ParticipantConfig => ({ engineId, limits: { nodes: 1000 }, timeControl: null });

function config(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    name: "Test",
    participants: [p("a"), p("b")],
    format: "round-robin",
    gamesPerPairing: 2,
    openings: { mode: "book", seed: 42 },
    concurrency: 2,
    adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: null },
    saveGames: true,
    ...overrides,
  };
}

describe("pairings", () => {
  it("round robin pairs every two participants once", () => {
    const pairs = pairingsOf(config({ participants: [p("a"), p("b"), p("c"), p("d")] }));
    expect(pairs.map((x) => `${x.a}-${x.b}`)).toEqual(["0-1", "0-2", "0-3", "1-2", "1-3", "2-3"]);
  });

  it("gauntlet pairs participant 0 with each of the others only", () => {
    const pairs = pairingsOf(config({ format: "gauntlet", participants: [p("a"), p("b"), p("c"), p("d")] }));
    expect(pairs.map((x) => `${x.a}-${x.b}`)).toEqual(["0-1", "0-2", "0-3"]);
  });

  it("counts the games", () => {
    expect(countGames(config({ participants: [p("a"), p("b"), p("c")], gamesPerPairing: 4 }))).toBe(12);
    expect(countGames(config({ format: "gauntlet", participants: [p("a"), p("b"), p("c")], gamesPerPairing: 3 }))).toBe(6);
    expect(countGames(config({ participants: [p("a")] }))).toBe(0);
  });
});

describe("schedule", () => {
  it("indexes games 0..n-1 and alternates colours within each pairing", () => {
    const cfg = config({ participants: [p("a"), p("b"), p("c")], gamesPerPairing: 4 });
    const slots = buildSlots(cfg);
    expect(slots.map((s) => s.index)).toEqual(slots.map((_, i) => i));
    for (let pairing = 0; pairing < 3; pairing++) {
      const games = slots.filter((s) => s.pairing === pairing).sort((x, y) => x.game - y.game);
      expect(games.map((g) => g.game)).toEqual([0, 1, 2, 3]);
      for (const g of games) {
        const first = games[0];
        if (g.game % 2 === 0) expect([g.white, g.black]).toEqual([first.white, first.black]);
        else expect([g.white, g.black]).toEqual([first.black, first.white]);
      }
    }
    // Every participant plays as many games with White as with Black.
    for (let i = 0; i < 3; i++) {
      expect(slots.filter((s) => s.white === i).length).toBe(slots.filter((s) => s.black === i).length);
    }
  });

  it("interleaves pairings: each pair round plays every pairing before the next round", () => {
    const slots = buildSlots(config({ participants: [p("a"), p("b"), p("c")], gamesPerPairing: 4 }));
    expect(slots.slice(0, 6).map((s) => s.game)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(slots.slice(6).map((s) => s.game)).toEqual([2, 3, 2, 3, 2, 3]);
  });

  it("handles an odd number of games per pairing", () => {
    const slots = buildSlots(config({ gamesPerPairing: 3 }));
    expect(slots.map((s) => [s.white, s.black, s.openingSlot])).toEqual([
      [0, 1, 0],
      [1, 0, 0],
      [0, 1, 1],
    ]);
  });

  it("gives both games of a colour-swapped pair the same book opening", () => {
    const games = buildSchedule(config({ participants: [p("a"), p("b"), p("c")], gamesPerPairing: 4, openings: { mode: "book", seed: 7 } }));
    for (const g of games) {
      expect(g.opening).not.toBeNull();
      const twin = games.find((x) => x.pairing === g.pairing && x.game === (g.game % 2 === 0 ? g.game + 1 : g.game - 1))!;
      expect(twin.opening).toBe(g.opening);
      expect(twin.openingMoves).toEqual(g.openingMoves);
      expect(twin.white).toBe(g.black);
    }
    // Different pairs get different openings (the book is shuffled, not repeated, while it lasts).
    const slots = new Set(games.map((g) => g.openingSlot));
    const names = new Set(games.map((g) => g.opening));
    expect(names.size).toBe(slots.size);
    // The openings are the seeded book selection in slot order.
    const expected = pickOpenings(slots.size, 7);
    for (const g of games) expect(g.opening).toBe(expected[g.openingSlot].name);
  });

  it("shares random openings between colour-swapped games and keeps them legal", () => {
    const games = buildSchedule(config({ gamesPerPairing: 6, openings: { mode: "random-plies", randomPlies: 6, seed: 3 } }));
    for (const g of games) {
      expect(g.openingMoves).toHaveLength(6);
      expect(ChessGame.fromMoves("startpos", g.openingMoves)).not.toBeNull();
      expect(g.opening).toBe("Random opening (6 plies)");
    }
    expect(games[0].openingMoves).toEqual(games[1].openingMoves);
    expect(games[2].openingMoves).toEqual(games[3].openingMoves);
    expect(games[0].openingMoves).not.toEqual(games[2].openingMoves);
  });

  it("uses the start position without openings", () => {
    const games = buildSchedule(config({ openings: { mode: "none" } }));
    expect(games.every((g) => g.openingMoves.length === 0 && g.opening === null && g.startFen === "startpos")).toBe(true);
  });

  it("is deterministic for a config and changes with the seed", () => {
    const a = buildSchedule(config({ gamesPerPairing: 10, openings: { mode: "book", seed: 99 } }));
    const b = buildSchedule(config({ gamesPerPairing: 10, openings: { mode: "book", seed: 99 } }));
    const c = buildSchedule(config({ gamesPerPairing: 10, openings: { mode: "book", seed: 100 } }));
    expect(b).toEqual(a);
    expect(c.map((g) => g.opening)).not.toEqual(a.map((g) => g.opening));
    const r1 = buildSchedule(config({ openings: { mode: "random-plies", randomPlies: 8, seed: 5 } }));
    const r2 = buildSchedule(config({ openings: { mode: "random-plies", randomPlies: 8, seed: 5 } }));
    expect(r2).toEqual(r1);
  });

  it("computes single games exactly like the full schedule (used when resuming)", () => {
    for (const openings of [{ mode: "book" as const, seed: 11 }, { mode: "random-plies" as const, randomPlies: 4, seed: 11 }]) {
      const cfg = config({ participants: [p("a"), p("b"), p("c")], gamesPerPairing: 3, openings });
      const full = buildSchedule(cfg);
      const slots = buildSlots(cfg);
      expect(slots.map((s) => withOpening(cfg, s))).toEqual(full);
      expect(openingForSlot(cfg, 0).openingMoves).toEqual(full[0].openingMoves);
    }
  });

  it("repeats the shuffled book when a match needs more openings than it has", () => {
    const pairs = OPENINGS.length + 3;
    const games = buildSchedule(config({ gamesPerPairing: pairs * 2, openings: { mode: "book", seed: 1 } }));
    expect(games).toHaveLength(pairs * 2);
    expect(games[OPENINGS.length * 2].opening).toBe(games[0].opening);
  });
});
