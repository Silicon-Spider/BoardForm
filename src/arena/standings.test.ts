import { describe, expect, it } from "vitest";
import type { GameResult, MatchConfig, MatchGameSummary, ParticipantConfig } from "@/types";
import { eloEstimate } from "@/utils/elo";
import { normalizeMatchConfig, validateMatchConfig, defaultMatchConfig, defaultConcurrency } from "./config";
import { buildSlots } from "./schedule";
import { autoMatchName, colorStats, computeStandings, crosstable, participantLabels, resolveResults, scoreLine } from "./standings";

const p = (engineId: string): ParticipantConfig => ({ engineId, limits: { nodes: 1000 }, timeControl: null });

function config(ids: string[], gamesPerPairing = 2, format: MatchConfig["format"] = "round-robin"): MatchConfig {
  return {
    name: "T",
    participants: ids.map(p),
    format,
    gamesPerPairing,
    openings: { mode: "none", seed: 1 },
    concurrency: 1,
    adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: null },
    saveGames: false,
  };
}

/** Results for the schedule, by a function of (white participant, black participant) → result. */
function resultsFor(cfg: MatchConfig, outcome: (white: number, black: number, index: number) => GameResult): MatchGameSummary[] {
  return buildSlots(cfg).map((s) => ({
    index: s.index,
    whiteId: cfg.participants[s.white].engineId,
    blackId: cfg.participants[s.black].engineId,
    result: outcome(s.white, s.black, s.index),
    termination: "checkmate",
    plies: 40,
  }));
}

describe("standings", () => {
  it("counts W/D/L, points and score for two engines with a head-to-head Elo", () => {
    const cfg = config(["a", "b"], 10);
    // a wins 6 (any colour), 2 draws, b wins 2.
    const res = resultsFor(cfg, (_w, _b, i) => (i < 6 ? (i % 2 === 0 ? "1-0" : "0-1") : i < 8 ? "1/2-1/2" : i % 2 === 0 ? "0-1" : "1-0"));
    const rows = computeStandings(cfg, res);
    const a = rows.find((r) => r.participant === 0)!;
    const b = rows.find((r) => r.participant === 1)!;
    expect(a).toMatchObject({ games: 10, wins: 6, draws: 2, losses: 2, points: 7, rank: 1 });
    expect(b).toMatchObject({ games: 10, wins: 2, draws: 2, losses: 6, points: 3, rank: 2 });
    expect(a.score).toBeCloseTo(0.7);
    expect(a.elo.elo).toBeCloseTo(eloEstimate({ wins: 6, draws: 2, losses: 2 }).elo);
    expect(a.elo.elo).toBeGreaterThan(100);
    expect(b.elo.elo).toBeCloseTo(-a.elo.elo);
    expect(b.elo.error).toBeCloseTo(a.elo.error);
    expect(a.elo.los).toBeGreaterThan(0.9);
    expect(a.elo.los + b.elo.los).toBeCloseTo(1);
    expect(rows[0].participant).toBe(0);
  });

  it("ignores unfinished results and works without games", () => {
    const cfg = config(["a", "b"]);
    const rows = computeStandings(cfg, []);
    expect(rows.every((r) => r.games === 0 && Number.isNaN(r.score) && r.rank === 1)).toBe(true);
    expect(scoreLine(cfg, [], ["A", "B"])).toBeNull();
    const star = resultsFor(cfg, () => "*");
    expect(computeStandings(cfg, star).every((r) => r.games === 0)).toBe(true);
  });

  it("builds a crosstable and ranks a round robin with Sonneborn-Berger tie-breaks", () => {
    const cfg = config(["a", "b", "c"], 2);
    // a beats b twice, b beats c twice, c beats a twice: all on 2 points. SB: equal → wins equal → index.
    const beats = (x: number, y: number) => (x === 0 && y === 1) || (x === 1 && y === 2) || (x === 2 && y === 0);
    const res = resultsFor(cfg, (w, b) => (beats(w, b) ? "1-0" : "0-1"));
    const cross = crosstable(cfg, resolveResults(cfg, res));
    expect(cross[0][1]).toEqual({ points: 2, games: 2 });
    expect(cross[1][0]).toEqual({ points: 0, games: 2 });
    expect(cross[2][0]).toEqual({ points: 2, games: 2 });
    const rows = computeStandings(cfg, res);
    expect(rows.map((r) => r.points)).toEqual([2, 2, 2]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1]);

    // Now a also draws c twice instead of losing: a 3, c 1 + 2 = ... recompute.
    const res2 = resultsFor(cfg, (w, b) => {
      if ((w === 0 && b === 2) || (w === 2 && b === 0)) return "1/2-1/2";
      return beats(w, b) ? "1-0" : "0-1";
    });
    const rows2 = computeStandings(cfg, res2);
    expect(rows2.map((r) => [r.participant, r.points])).toEqual([
      [0, 3],
      [1, 2],
      [2, 1],
    ]);
    expect(rows2.map((r) => r.rank)).toEqual([1, 2, 3]);
    // Elo against the field: the leader is positive, the last negative.
    expect(rows2[0].elo.elo).toBeGreaterThan(0);
    expect(rows2[2].elo.elo).toBeLessThan(0);
  });

  it("uses Sonneborn-Berger to break equal points", () => {
    const cfg = config(["a", "b", "c", "d"], 1);
    // a: beats b, draws c, loses d → 1.5 ; b: beats c and d → 2 ; ...
    const table: Record<string, GameResult> = {};
    const set = (x: number, y: number, r: "x" | "y" | "d") => {
      table[`${x}-${y}`] = r === "x" ? "1-0" : r === "y" ? "0-1" : "1/2-1/2";
      table[`${y}-${x}`] = r === "x" ? "0-1" : r === "y" ? "1-0" : "1/2-1/2";
    };
    set(0, 1, "x");
    set(0, 2, "d");
    set(0, 3, "y");
    set(1, 2, "x");
    set(1, 3, "x");
    set(2, 3, "d");
    const res = resultsFor(cfg, (w, b) => table[`${w}-${b}`]);
    const rows = computeStandings(cfg, res);
    // b: 2 pts; a: 1.5; d: 1.5; c: 1.
    expect(rows[0].participant).toBe(1);
    const a = rows.find((r) => r.participant === 0)!;
    const d = rows.find((r) => r.participant === 3)!;
    expect(a.points).toBe(1.5);
    expect(d.points).toBe(1.5);
    // SB(a) = 1·2 (beat b) + 0.5·1 (drew c) = 2.5 ; SB(d) = 1·1.5 (beat a) + 0.5·1 (drew c) = 2
    expect(a.sonnebornBerger).toBeCloseTo(2.5);
    expect(d.sonnebornBerger).toBeCloseTo(2);
    expect(a.rank).toBeLessThan(d.rank);
  });

  it("keeps an engine that plays twice as two participants", () => {
    const cfg = config(["x", "x", "y"], 2);
    const res = resultsFor(cfg, (w) => (w === 1 ? "1-0" : w === 0 ? "0-1" : "1/2-1/2"));
    const rows = computeStandings(cfg, res);
    expect(rows.map((r) => r.games)).toEqual([4, 4, 4]);
    expect(resolveResults(cfg, res)).toHaveLength(res.length);
    expect(participantLabels(cfg, (id) => (id === "x" ? "Classic" : "Blocky"))).toEqual(["Classic (1)", "Classic (2)", "Blocky"]);
  });

  it("counts results by colour", () => {
    const cfg = config(["a", "b"], 4);
    const res = resultsFor(cfg, (_w, _b, i) => (["1-0", "1/2-1/2", "0-1", "1-0"] as GameResult[])[i]);
    expect(colorStats(res)).toEqual({ white: 2, draws: 1, black: 1 });
  });

  it("writes one-line summaries and default names", () => {
    const two = config(["a", "b"], 2);
    const res = resultsFor(two, (w) => (w === 0 ? "1-0" : "1/2-1/2"));
    expect(scoreLine(two, res, ["Classic", "Blocky"])).toBe("Classic 1.5 – 0.5 Blocky");
    expect(autoMatchName(two, ["Classic", "Blocky"])).toBe("Classic vs Blocky");
    const three = config(["a", "b", "c"]);
    expect(autoMatchName(three, ["A", "B", "C"])).toBe("Round robin (3 engines)");
    expect(autoMatchName({ ...three, format: "gauntlet" }, ["A", "B", "C"])).toBe("Gauntlet: A vs 2 engines");
    const res3 = resultsFor(three, (w) => (w === 0 ? "1-0" : "0-1"));
    expect(scoreLine(three, res3, ["A", "B", "C"])).toMatch(/^A leads with/);
  });
});

describe("match config", () => {
  it("has the documented defaults", () => {
    const cfg = defaultMatchConfig({ engineIds: ["a", "b"], hashMb: 32, maxWorkers: 14 });
    expect(cfg.adjudication).toEqual({ resignScoreCp: 900, resignMoves: 4, drawScoreCp: 10, drawMoves: 8, drawMinPly: 80, maxPlies: 400 });
    expect(cfg.concurrency).toBe(4);
    expect(cfg.participants[0]).toMatchObject({ engineId: "a", hashMb: 32 });
    expect(cfg.saveGames).toBe(true);
    expect(defaultConcurrency(1)).toBe(1);
    expect(defaultConcurrency(5)).toBe(2);
  });

  it("validates", () => {
    const ok = normalizeMatchConfig({ ...config(["a", "b"]), name: " Duel " });
    expect(ok.name).toBe("Duel");
    expect(validateMatchConfig(ok)).toEqual([]);
    expect(validateMatchConfig({ ...ok, participants: [p("a")] })).toContain("Add at least two engines.");
    expect(validateMatchConfig({ ...ok, name: "" })).toContain("Give the match a name.");
    expect(validateMatchConfig({ ...ok, participants: [p("a"), p("")] })).toContain("Choose an engine for every participant.");
    expect(validateMatchConfig({ ...ok, gamesPerPairing: 0 }).length).toBe(1);
    expect(validateMatchConfig({ ...ok, concurrency: 9 }, { maxConcurrency: 8 })).toEqual(["Games at once must be from 1 to 8."]);
    expect(validateMatchConfig({ ...ok, openings: { mode: "random-plies", randomPlies: 0 } }).length).toBe(1);
    expect(validateMatchConfig({ ...ok, gamesPerPairing: 1000, participants: ["a", "b", "c", "d", "e"].map(p) })).toEqual([]);
    expect(validateMatchConfig({ ...ok, gamesPerPairing: 1000, participants: ["a", "b", "c", "d", "e", "f"].map(p) })[0]).toMatch(/the limit is/);
  });

  it("normalizes numbers and fills a seed", () => {
    const n = normalizeMatchConfig({
      ...config(["a", "b"]),
      gamesPerPairing: 3.6,
      openings: { mode: "random-plies", randomPlies: 7.2 },
      participants: [
        { engineId: "a", limits: { depth: 0, nodes: 2500.4 }, timeControl: { baseMs: 0, incMs: 0 } },
        { engineId: "b", limits: {}, timeControl: { baseMs: 60_000, incMs: 500, movesPerControl: 0 }, hashMb: 0 },
      ],
    });
    expect(n.gamesPerPairing).toBe(4);
    expect(n.openings.randomPlies).toBe(7);
    expect(typeof n.openings.seed).toBe("number");
    expect(n.participants[0]).toEqual({ engineId: "a", limits: { nodes: 2500 }, timeControl: null });
    expect(n.participants[1]).toEqual({ engineId: "b", limits: {}, timeControl: { baseMs: 60_000, incMs: 500 } });
  });
});
