import { describe, expect, it } from "vitest";
import type { TimeControl } from "@/types";
import { DEFAULT_MAX_WAIT_MS, searchDeadlineMs, sideToMoveOf, toSearchLimits } from "./limits";

const tc = (baseMs: number, incMs = 0, movesPerControl?: number): TimeControl => ({ baseMs, incMs, movesPerControl });
const base = { whiteTc: null, blackTc: null, whiteMs: null, blackMs: null, sideToMove: "w" as const, movesPlayed: 0 };

describe("toSearchLimits", () => {
  it("passes caps through and defaults to 1 s when nothing limits the search", () => {
    expect(toSearchLimits({ ...base, limits: { depth: 6 } })).toEqual({ depth: 6 });
    expect(toSearchLimits({ ...base, limits: { nodes: 25_000.4, movetimeMs: 250 } })).toEqual({ nodes: 25_000, movetimeMs: 250 });
    expect(toSearchLimits({ ...base, limits: {} })).toEqual({ movetimeMs: 1000 });
    expect(toSearchLimits({ ...base, limits: { depth: 0, nodes: 0, movetimeMs: 0 } })).toEqual({ movetimeMs: 1000 });
  });

  it("builds a clock from both sides' time controls", () => {
    const r = toSearchLimits({ ...base, limits: {}, whiteTc: tc(60_000, 1000), blackTc: tc(60_000, 2000), whiteMs: 59_500.6, blackMs: 55_000 });
    expect(r).toEqual({ clock: { wtime: 59_501, btime: 55_000, winc: 1000, binc: 2000 } });
  });

  it("combines caps with the clock", () => {
    const r = toSearchLimits({ ...base, limits: { depth: 12 }, whiteTc: tc(10_000), blackTc: tc(10_000), whiteMs: 9000, blackMs: 8000, sideToMove: "b" });
    expect(r).toEqual({ depth: 12, clock: { wtime: 9000, btime: 8000, winc: 0, binc: 0 } });
  });

  it("computes movestogo from movesPerControl and the plies played", () => {
    const run = (movesPlayed: number, sideToMove: "w" | "b") =>
      toSearchLimits({ ...base, limits: {}, whiteTc: tc(300_000, 0, 40), blackTc: tc(300_000, 0, 40), whiteMs: 1000, blackMs: 1000, sideToMove, movesPlayed }).clock?.movestogo;
    expect(run(0, "w")).toBe(40);
    expect(run(1, "b")).toBe(40);
    expect(run(78, "w")).toBe(1); // White's 40th move
    expect(run(79, "b")).toBe(1);
    expect(run(80, "w")).toBe(40); // a new period
    expect(run(81, "b")).toBe(40);
  });

  it("omits movestogo for sudden death / increment controls", () => {
    const r = toSearchLimits({ ...base, limits: {}, whiteTc: tc(1000, 100), blackTc: tc(1000, 100), whiteMs: 900, blackMs: 900 });
    expect(r.clock && "movestogo" in r.clock).toBe(false);
  });

  it("mirrors the mover's clock when the opponent has none", () => {
    const r = toSearchLimits({ ...base, limits: {}, whiteTc: tc(30_000, 500), whiteMs: 25_000 });
    expect(r.clock).toEqual({ wtime: 25_000, btime: 25_000, winc: 500, binc: 500 });
    const b = toSearchLimits({ ...base, limits: {}, blackTc: tc(30_000, 500), blackMs: 20_000, sideToMove: "b" });
    expect(b.clock).toEqual({ wtime: 20_000, btime: 20_000, winc: 500, binc: 500 });
  });

  it("ignores the clock when the mover has none (or its time is unknown)", () => {
    expect(toSearchLimits({ ...base, limits: {}, blackTc: tc(30_000), blackMs: 30_000 })).toEqual({ movetimeMs: 1000 });
    expect(toSearchLimits({ ...base, limits: { depth: 3 }, whiteTc: tc(30_000), whiteMs: null })).toEqual({ depth: 3 });
  });

  it("clamps negative remaining time to zero", () => {
    const r = toSearchLimits({ ...base, limits: {}, whiteTc: tc(1000), blackTc: tc(1000), whiteMs: -40, blackMs: 500 });
    expect(r.clock).toMatchObject({ wtime: 0, btime: 500 });
  });
});

describe("searchDeadlineMs", () => {
  it("gives movetime 100 ms + 10 % grace", () => {
    expect(searchDeadlineMs({ movetimeMs: 1000 }, "w")).toBe(1200);
    expect(searchDeadlineMs({ movetimeMs: 50, depth: 3 }, "w")).toBe(155);
  });

  it("uses the mover's remaining clock time + 100 ms", () => {
    const clock = { wtime: 5000, btime: 3000, winc: 0, binc: 0 };
    expect(searchDeadlineMs({ clock }, "w")).toBe(5100);
    expect(searchDeadlineMs({ clock }, "b")).toBe(3100);
    expect(searchDeadlineMs({ clock }, null)).toBe(5100);
    expect(searchDeadlineMs({ clock, movetimeMs: 1000 }, "w")).toBe(1200);
  });

  it("falls back to maxWait for depth / node searches and never times out infinite ones", () => {
    expect(searchDeadlineMs({ depth: 20 }, "w")).toBe(DEFAULT_MAX_WAIT_MS);
    expect(searchDeadlineMs({ nodes: 1e6 }, "w", 5000)).toBe(5000);
    expect(searchDeadlineMs({}, "w", 5000)).toBe(5000);
    expect(searchDeadlineMs({ infinite: true, movetimeMs: 10 }, "w")).toBeNull();
    // maxWaitMs = Infinity disables the safety deadline (a timer of Infinity would fire at once).
    expect(searchDeadlineMs({ depth: 20 }, "w", Infinity)).toBeNull();
    expect(searchDeadlineMs({ depth: 20, movetimeMs: 500 }, "w", Infinity)).toBe(650);
  });
});

describe("sideToMoveOf", () => {
  it("follows the move count from startpos or a FEN", () => {
    expect(sideToMoveOf("startpos", [])).toBe("w");
    expect(sideToMoveOf("startpos", ["e2e4"])).toBe("b");
    expect(sideToMoveOf("8/8/8/8/8/8/8/K6k b - - 0 1", [])).toBe("b");
    expect(sideToMoveOf("fen 8/8/8/8/8/8/8/K6k b - - 0 1", ["h1g1"])).toBe("w");
    expect(sideToMoveOf("garbage", [])).toBeNull();
  });
});
