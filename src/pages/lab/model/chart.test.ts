import { describe, expect, it } from "vitest";
import { bestPoint, buildRunChartData, withLivePoints, type ChartInputPoint } from "./chart";

const pt = (cycle: number, positions: number, trainLoss = 0.1, valLoss: number | null = null, lr = 0.001, epoch = 0): ChartInputPoint => ({
  cycle,
  epoch,
  positions,
  trainLoss,
  valLoss,
  lr,
});

describe("buildRunChartData", () => {
  it("offsets cycles whose position count restarts at zero", () => {
    // Cycle indexes are 0-based (as the service stores them); labels are 1-based.
    const d = buildRunChartData([pt(0, 0), pt(0, 1000), pt(0, 2000), pt(1, 0), pt(1, 500)]);
    expect(d.train.map((p) => p.x)).toEqual([0, 1000, 2000, 2000, 2500]);
    expect(d.markers).toEqual([{ x: 2000, label: "Cycle 2" }]);
  });

  it("keeps run-wide cumulative counts as they are", () => {
    const d = buildRunChartData([pt(0, 100), pt(0, 2000), pt(1, 2100), pt(1, 3000)]);
    expect(d.train.map((p) => p.x)).toEqual([100, 2000, 2100, 3000]);
    expect(d.markers).toEqual([{ x: 2100, label: "Cycle 2" }]);
  });

  it("replaces the abandoned tail when a cycle's training restarts", () => {
    const d = buildRunChartData([pt(1, 0), pt(1, 1000), pt(1, 2000), pt(1, 500, 0.2), pt(1, 1500, 0.15)]);
    expect(d.rows.map((r) => [r.x, r.trainLoss])).toEqual([
      [0, 0.1],
      [500, 0.2],
      [1500, 0.15],
    ]);
  });

  it("splits validation and learning-rate series and skips values a log axis cannot show", () => {
    const d = buildRunChartData([pt(1, 0, NaN, 0.3, 0.001), pt(1, 100, 0.2, null, 0.0005), pt(1, 200, 0.1, 0.25, 0)]);
    expect(d.train).toEqual([
      { x: 100, y: 0.2 },
      { x: 200, y: 0.1 },
    ]);
    expect(d.val).toEqual([
      { x: 0, y: 0.3 },
      { x: 200, y: 0.25 },
    ]);
    expect(d.lr).toEqual([
      { x: 0, y: 0.001 },
      { x: 100, y: 0.0005 },
    ]);
  });

  it("handles no points", () => {
    expect(buildRunChartData([])).toEqual({ train: [], val: [], lr: [], markers: [], rows: [] });
  });
});

describe("withLivePoints", () => {
  it("appends only live points newer than the persisted ones", () => {
    const persisted = [pt(1, 0), pt(1, 1000)];
    const merged = withLivePoints(persisted, [pt(1, 900), pt(1, 1200), pt(2, 10)]);
    expect(merged.map((p) => [p.cycle, p.positions])).toEqual([
      [1, 0],
      [1, 1000],
      [1, 1200],
      [2, 10],
    ]);
    expect(withLivePoints(persisted, [])).toBe(persisted);
    expect(withLivePoints([], [pt(1, 5)])).toHaveLength(1);
  });
});

describe("bestPoint", () => {
  it("finds the minimum", () => {
    expect(
      bestPoint([
        { x: 1, y: 3 },
        { x: 2, y: 1 },
        { x: 3, y: 2 },
      ]),
    ).toEqual({ x: 2, y: 1 });
    expect(bestPoint([])).toBeNull();
  });
});
