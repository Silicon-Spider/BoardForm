import { describe, expect, it } from "vitest";
import type { TrainingPoint, TrainingRunRecord } from "@/types";
import { worseThanStart } from "./outcome";

type RunPart = Pick<TrainingRunRecord, "config" | "networkHistory" | "points">;

const point = (cycle: number, epoch: number, step: number, valLoss: number | null): TrainingPoint => ({
  t: 0,
  cycle,
  epoch,
  step,
  positions: step * 16,
  trainLoss: 0.01,
  valLoss,
  lr: 0.001,
});

function run(mode: "new" | "continue" | "widen", history: RunPart["networkHistory"], points: TrainingPoint[]): RunPart {
  const network: TrainingRunRecord["config"]["network"] =
    mode === "new" ? { mode, hidden: 128, activation: 1 } : mode === "continue" ? { mode, networkId: "src" } : { mode, networkId: "src", newHidden: 256 };
  return { config: { network } as TrainingRunRecord["config"], networkHistory: history, points };
}

describe("worseThanStart", () => {
  const history = (valLoss: number | null, cycle = 0, gating?: { score: number; games: number; accepted: boolean }) => [
    { networkId: "n1", cycle, createdAt: 1, valLoss, ...(gating ? { gating } : {}) },
  ];

  it("reports a continued network that ended worse than it started", () => {
    expect(worseThanStart(run("continue", history(0.012), [point(0, 0, 0, 0.0087), point(0, 1, 500, 0.012)]))).toEqual({ finalLoss: 0.012, startLoss: 0.0087 });
    expect(worseThanStart(run("widen", history(0.02), [point(0, 0, 0, 0.01)]))).toEqual({ finalLoss: 0.02, startLoss: 0.01 });
  });

  it("is quiet when training improved it, for new networks and without the starting measurement", () => {
    expect(worseThanStart(run("continue", history(0.008), [point(0, 0, 0, 0.0087)]))).toBeNull();
    expect(worseThanStart(run("continue", history(0.0087), [point(0, 0, 0, 0.0087)]))).toBeNull();
    expect(worseThanStart(run("new", history(0.5), [point(0, 0, 0, 0.1)]))).toBeNull();
    expect(worseThanStart(run("continue", history(0.012), [point(0, 1, 500, 0.012)]))).toBeNull();
    expect(worseThanStart(run("continue", history(0.012), [point(0, 0, 0, null)]))).toBeNull();
    expect(worseThanStart(run("continue", history(null), [point(0, 0, 0, 0.0087)]))).toBeNull();
    expect(worseThanStart(run("continue", [], [point(0, 0, 0, 0.0087)]))).toBeNull();
  });

  it("only compares the first cycle (later cycles start from the run's own networks)", () => {
    expect(worseThanStart(run("continue", history(0.012, 1), [point(0, 0, 0, 0.0087), point(1, 0, 0, 0.0087)]))).toBeNull();
    // A rejected later network leaves the first cycle's network current.
    const both: RunPart["networkHistory"] = [
      { networkId: "n1", cycle: 0, createdAt: 1, valLoss: 0.012 },
      { networkId: "n2", cycle: 1, createdAt: 2, valLoss: 0.011, gating: { score: 0.3, games: 10, accepted: false } },
    ];
    expect(worseThanStart(run("continue", both, [point(0, 0, 0, 0.0087)]))).toEqual({ finalLoss: 0.012, startLoss: 0.0087 });
  });
});
