import { describe, expect, it } from "vitest";
import { cannotMate, chargeMove, initialClocks, movesBySide, remainingAt } from "./clock";

describe("chargeMove", () => {
  it("charges the elapsed time and adds the increment", () => {
    expect(chargeMove({ baseMs: 300_000, incMs: 3000 }, 300_000, 12_500, 1)).toEqual({ ms: 290_500, flagged: false });
    expect(chargeMove({ baseMs: 60_000, incMs: 0 }, 10_000, 9_999, 30)).toEqual({ ms: 1, flagged: false });
  });

  it("flags when the time ran out, without adding the increment", () => {
    expect(chargeMove({ baseMs: 60_000, incMs: 2000 }, 5000, 5000, 3)).toEqual({ ms: 0, flagged: true });
    expect(chargeMove({ baseMs: 60_000, incMs: 2000 }, 5000, 7000, 3)).toEqual({ ms: 0, flagged: true });
  });

  it("adds the base time again after each completed control period", () => {
    const tc = { baseMs: 5_400_000, incMs: 30_000, movesPerControl: 40 };
    // Move 39: increment only.
    expect(chargeMove(tc, 100_000, 10_000, 39).ms).toBe(120_000);
    // Move 40 completes the period: increment + another 90 minutes.
    expect(chargeMove(tc, 100_000, 10_000, 40).ms).toBe(120_000 + 5_400_000);
    // And again at move 80, not at 41.
    expect(chargeMove(tc, 100_000, 10_000, 41).ms).toBe(120_000);
    expect(chargeMove(tc, 100_000, 10_000, 80).ms).toBe(120_000 + 5_400_000);
  });

  it("treats negative elapsed time as zero", () => {
    expect(chargeMove({ baseMs: 1000, incMs: 0 }, 1000, -50, 1)).toEqual({ ms: 1000, flagged: false });
  });
});

describe("remainingAt / movesBySide / initialClocks", () => {
  it("counts a running clock down and never below zero", () => {
    expect(remainingAt(10_000, null, 99_999)).toBe(10_000);
    expect(remainingAt(10_000, 1000, 4000)).toBe(7000);
    expect(remainingAt(10_000, 1000, 50_000)).toBe(0);
  });

  it("splits plies between the sides", () => {
    expect(movesBySide("w", 0, "w")).toBe(0);
    expect(movesBySide("w", 1, "w")).toBe(1);
    expect(movesBySide("w", 1, "b")).toBe(0);
    expect(movesBySide("w", 4, "b")).toBe(2);
    expect(movesBySide("b", 3, "b")).toBe(2);
    expect(movesBySide("b", 3, "w")).toBe(1);
  });

  it("starts each clock at its base time", () => {
    expect(initialClocks({ baseMs: 60_000, incMs: 0 }, null)).toEqual({ w: 60_000, b: null });
  });
});

describe("cannotMate", () => {
  it("a lone king or king + one minor piece cannot mate", () => {
    expect(cannotMate("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "w")).toBe(true);
    expect(cannotMate("4k3/8/8/8/8/8/8/3NK3 w - - 0 1", "w")).toBe(true);
    expect(cannotMate("4k3/8/8/8/8/8/8/3BK3 w - - 0 1", "w")).toBe(true);
    expect(cannotMate("4k3/8/8/8/8/8/8/3nK3 w - - 0 1", "b")).toBe(true);
  });

  it("pawns, rooks, queens or two minors can mate", () => {
    expect(cannotMate("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "w")).toBe(false);
    expect(cannotMate("4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "w")).toBe(false);
    expect(cannotMate("4k3/8/8/8/8/8/8/2NNK3 w - - 0 1", "w")).toBe(false);
    expect(cannotMate("4k3/8/8/8/8/8/8/2BNK3 w - - 0 1", "w")).toBe(false);
  });

  it("bishops on one square colour cannot mate, on both colours they can", () => {
    // c1 and e3 are both dark squares.
    expect(cannotMate("4k3/8/8/8/8/4B3/8/2B1K3 w - - 0 1", "w")).toBe(true);
    // c1 (dark) and f1 (light).
    expect(cannotMate("4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1", "w")).toBe(false);
  });
});
