// Adjudication rules and clock accounting.
import { describe, expect, it } from "vitest";
import type { AdjudicationConfig } from "@/types";
import { Adjudicator, MATE_SCORE } from "./adjudication";
import { chargeMove, hasMatingMaterial, initialClockMs } from "./clock";

const OFF: AdjudicationConfig = { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: null };

/** Feeds alternating white/black scores (White POV) starting at ply `startPly + 1`. */
function feed(adj: Adjudicator, scores: Array<[number | null, number | null]>, startPly = 0) {
  let ply = startPly;
  for (const [w, b] of scores) {
    const r1 = adj.record("w", w, ++ply);
    if (r1) return { ...r1, ply };
    const r2 = adj.record("b", b, ++ply);
    if (r2) return { ...r2, ply };
  }
  return null;
}

describe("resign adjudication", () => {
  const cfg: AdjudicationConfig = { ...OFF, resignScoreCp: 500, resignMoves: 3 };

  it("ends the game when both engines agree for N moves each", () => {
    const out = feed(new Adjudicator(cfg), [
      [600, 550],
      [700, 800],
      [900, 520],
    ]);
    expect(out).toMatchObject({ result: "1-0", termination: "resign", ply: 6 });
  });

  it("works for Black and with mate scores", () => {
    const out = feed(new Adjudicator(cfg), [
      [-MATE_SCORE, -600],
      [-MATE_SCORE, -MATE_SCORE],
      [-MATE_SCORE, -700],
    ]);
    expect(out).toMatchObject({ result: "0-1", termination: "resign" });
  });

  it("needs both engines to agree", () => {
    // White's engine thinks White is winning, Black's engine thinks Black is winning.
    expect(feed(new Adjudicator(cfg), Array.from({ length: 10 }, () => [800, -800] as [number, number]))).toBeNull();
    // Black's engine thinks it is only slightly worse.
    expect(feed(new Adjudicator(cfg), Array.from({ length: 10 }, () => [800, 300] as [number, number]))).toBeNull();
  });

  it("restarts the count when a score drops below the threshold or is unknown", () => {
    const adj = new Adjudicator(cfg);
    expect(
      feed(adj, [
        [600, 600],
        [600, 600],
        [600, 100], // Black's engine breaks the streak
        [600, 600],
        [600, null], // unknown score breaks it again
        [600, 600],
        [600, 600],
      ]),
    ).toBeNull();
    expect(feed(adj, [[600, 600]], 14)).toMatchObject({ result: "1-0" });
  });

  it("is off when the threshold is null", () => {
    expect(feed(new Adjudicator(OFF), Array.from({ length: 50 }, () => [MATE_SCORE, MATE_SCORE] as [number, number]))).toBeNull();
  });
});

describe("draw adjudication", () => {
  const cfg: AdjudicationConfig = { ...OFF, drawScoreCp: 10, drawMoves: 4, drawMinPly: 20 };

  it("only counts moves after drawMinPly", () => {
    const adj = new Adjudicator(cfg);
    // Plies 1..20: dead equal, but too early to count.
    expect(feed(adj, Array.from({ length: 10 }, () => [0, 0] as [number, number]))).toBeNull();
    // Plies 21..28: 4 moves each.
    const out = feed(adj, Array.from({ length: 4 }, () => [5, -8] as [number, number]), 20);
    expect(out).toMatchObject({ result: "1/2-1/2", termination: "adjudication", ply: 28 });
  });

  it("resets on a score outside the window", () => {
    const adj = new Adjudicator(cfg);
    const out = feed(
      adj,
      [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 40], // breaks Black's streak
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      20,
    );
    expect(out).toBeNull();
    expect(feed(adj, [[0, 0]], 34)).toMatchObject({ result: "1/2-1/2" });
  });

  it("allows drawScoreCp = 0 (only exact zeros)", () => {
    const adj = new Adjudicator({ ...cfg, drawScoreCp: 0, drawMoves: 1, drawMinPly: 0 });
    expect(adj.record("w", 1, 1)).toBeNull();
    expect(adj.record("b", 0, 2)).toBeNull();
    expect(adj.record("w", 0, 3)).toMatchObject({ result: "1/2-1/2" });
  });
});

describe("clock accounting", () => {
  it("starts from the base time; no clock is null", () => {
    expect(initialClockMs({ baseMs: 60_000, incMs: 1000 })).toBe(60_000);
    expect(initialClockMs(null)).toBeNull();
  });

  it("subtracts the time used and adds the increment", () => {
    const tc = { baseMs: 10_000, incMs: 100 };
    expect(chargeMove(tc, 10_000, 400, 0)).toEqual({ remaining: 9_700, flagged: false });
    expect(chargeMove(tc, 300, 300, 5)).toEqual({ remaining: 100, flagged: false });
  });

  it("flags when the move took longer than the remaining time (before the increment)", () => {
    const tc = { baseMs: 10_000, incMs: 5_000 };
    const r = chargeMove(tc, 1_000, 1_001, 3);
    expect(r.flagged).toBe(true);
    expect(r.remaining).toBe(-1);
  });

  it("adds the base time again after every completed period", () => {
    const tc = { baseMs: 60_000, incMs: 0, movesPerControl: 40 };
    expect(chargeMove(tc, 1_000, 500, 38)).toEqual({ remaining: 500, flagged: false }); // move 39
    expect(chargeMove(tc, 1_000, 500, 39)).toEqual({ remaining: 60_500, flagged: false }); // move 40
    expect(chargeMove(tc, 1_000, 500, 79)).toEqual({ remaining: 60_500, flagged: false }); // move 80
  });

  it("ignores moves without a clock", () => {
    expect(chargeMove(null, null, 99_999, 0)).toEqual({ remaining: null, flagged: false });
  });
});

describe("mating material", () => {
  it("recognises sides that cannot mate", () => {
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/4K3", "w")).toBe(false);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/3BK3", "w")).toBe(false);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/3NK3", "w")).toBe(false);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/2NNK3", "w")).toBe(true);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/2BNK3", "w")).toBe(true);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/P7/4K3", "w")).toBe(true);
    expect(hasMatingMaterial("8/8/8/4k3/8/8/8/R3K3", "w")).toBe(true);
    // Only the given side's pieces count.
    expect(hasMatingMaterial("q7/8/8/4k3/8/8/8/4K3", "w")).toBe(false);
    expect(hasMatingMaterial("q7/8/8/4k3/8/8/8/4K3 w - - 0 1", "b")).toBe(true);
  });
});
