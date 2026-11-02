import { describe, expect, it } from "vitest";
import type { NetworkRecord, TrainingRunConfig } from "@/types";
import { ChessGame } from "@/chess";
import {
  baseName,
  canStartStatus,
  countOf,
  cycleNumber,
  cycleShort,
  cycleText,
  datasetBytes,
  describeDatasetSource,
  describeEngineLimits,
  describeSelfPlay,
  formatInt,
  formatLoss,
  formatLr,
  formatScorePct,
  isActiveStatus,
  latestValLoss,
  persistedPhase,
  progressFraction,
  resultText,
  startLabel,
  wasInterrupted,
} from "./format";
import { SAMPLE_POSITIONS, evalAgrees } from "./samples";
import { childrenOf, parentChain } from "./lineage";

const loop = (enabled: boolean, cycles: number | null): Pick<TrainingRunConfig, "loop"> => ({
  loop: { enabled, cycles, selfPlayWithLatest: false, keepCycles: null, gating: null },
});

describe("status helpers", () => {
  it("classifies statuses", () => {
    expect(isActiveStatus("training")).toBe(true);
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("paused")).toBe(false);
    expect(canStartStatus("error")).toBe(true);
    expect(canStartStatus("finished")).toBe(false);
    expect(startLabel("paused")).toBe("Resume");
    expect(startLabel("error")).toBe("Retry");
    expect(startLabel("queued")).toBe("Start");
  });

  it("works out the phase of a stored run", () => {
    const config = {
      name: "x",
      network: { mode: "new" as const, hidden: 16, activation: 1 as const },
      data: { datasetIds: [], selfPlay: { engineId: "e", limits: { nodes: 1 }, randomPlies: 0, games: 200, concurrency: 1, maxPlies: 100, skipPlies: 0 } },
      hyper: { epochs: 1, batchSize: 1, learningRate: 0.001, lrSchedule: "constant" as const, evalWeight: 0.75, weightDecay: 0, validationSplit: 0, threads: 1, seed: 1 },
      loop: { enabled: true, cycles: 2, selfPlayWithLatest: false, keepCycles: null, gating: { games: 20, limits: { nodes: 1 }, minScore: 0.5 } },
      publishEngine: false,
    };
    const run = (status: "training" | "paused" | "error" | "finished", phase: string, total: number, resume: { cycle: number; epoch: number; step: number } | null = null) => ({
      status,
      progress: { phase, done: 1, total },
      resume,
      config,
    });
    expect(persistedPhase(run("training", "training", 10))).toBe("training");
    expect(persistedPhase(run("paused", "paused", 4400, { cycle: 0, epoch: 1, step: 3 }))).toBe("training");
    expect(persistedPhase(run("error", "error", 200))).toBe("selfplay");
    expect(persistedPhase(run("paused", "paused", 20))).toBe("evaluating");
    expect(persistedPhase(run("paused", "selfplay", 7))).toBe("selfplay");
    expect(persistedPhase(run("finished", "finished", 1))).toBe("idle");
  });

  it("recognises runs the app paused itself", () => {
    const log = (message: string) => [{ t: 1, level: "info" as const, message }];
    expect(wasInterrupted({ status: "paused", log: log("Interrupted: the app was closed while this run was training.") })).toBe(true);
    expect(wasInterrupted({ status: "paused", log: log("Paused.") })).toBe(false);
    expect(wasInterrupted({ status: "stopped", log: log("Interrupted") })).toBe(false);
  });
});

describe("cycle wording", () => {
  it("formats 0-based cycle indexes as 1-based numbers", () => {
    expect(cycleText(1, loop(true, 5))).toBe("Cycle 2 of 5");
    expect(cycleText(2, loop(true, null))).toBe("Cycle 3 of unlimited");
    expect(cycleText(0, loop(false, 1))).toBe("Single cycle");
    expect(cycleText(0, loop(true, 5))).toBe("Cycle 1 of 5");
    expect(cycleText(4, loop(true, 5))).toBe("Cycle 5 of 5");
    expect(cycleShort(1, loop(true, null))).toBe("2 / ∞");
    expect(cycleShort(0, loop(false, 1))).toBe("1 / 1");
    expect(cycleNumber(0)).toBe(1);
  });
});

describe("number formatting", () => {
  it("formats losses and learning rates", () => {
    expect(formatLoss(0.0421345)).toBe("0.04213");
    expect(formatLoss(null)).toBe("—");
    expect(formatLoss(0.00001234)).toBe("1.23e-5");
    expect(formatLr(0.001)).toBe("0.001");
    expect(formatLr(0.00001)).toBe("1e-5");
    expect(formatLr(0.000025)).toBe("2.5e-5");
    expect(formatLr(0.0025)).toBe("0.0025");
    expect(formatScorePct(0.5625)).toBe("56%");
    expect(resultText(2)).toBe("1-0");
    expect(resultText(1)).toBe("½-½");
    expect(datasetBytes({ positions: 1000 })).toBe(32_000);
    expect(progressFraction({ done: 5, total: 10 })).toBe(0.5);
    expect(progressFraction({ done: 5, total: 0 })).toBeNull();
    expect(baseName("my net.v2.nnue")).toBe("my net.v2");
    expect(baseName(".hidden")).toBe(".hidden");
  });

  it("describes limits, self-play and dataset sources", () => {
    expect(describeEngineLimits({ nodes: 5000, depth: 8 })).toBe("5,000 nodes · depth 8");
    expect(describeEngineLimits({ nodes: 2_500_000 })).toBe("2.50M nodes");
    expect(countOf(1, "game")).toBe("1 game");
    expect(countOf(1000, "game")).toBe("1,000 games");
    expect(formatInt(1234567)).toBe("1.23M");
    expect(describeEngineLimits({})).toBe("no limits");
    expect(
      describeSelfPlay({ engineId: "x", limits: { movetimeMs: 250 }, randomPlies: 1, games: 1, concurrency: 1, maxPlies: 100, skipPlies: 0 }, "Classic"),
    ).toBe("Classic · 0.25 s/move · 1 random ply");
    expect(describeDatasetSource({ source: { kind: "selfplay", engineId: "e", engineName: "Old name", limits: { nodes: 1000 } } }, { engine: "Classic" })).toBe(
      "Self-play · Classic · 1,000 nodes",
    );
    expect(describeDatasetSource({ source: { kind: "selfplay", engineId: "$network", networkId: "n" } }, { network: "Net 1" })).toBe("Self-play · NNUE “Net 1”");
    expect(describeDatasetSource({ source: { kind: "import" } }, {})).toBe("Imported file");
  });

  it("finds the latest validation loss", () => {
    const p = (valLoss: number | null) => ({ t: 0, cycle: 1, epoch: 0, step: 0, positions: 0, trainLoss: 0.1, valLoss, lr: 0.001 });
    expect(latestValLoss({ points: [p(0.3), p(0.2), p(null)], networkHistory: [] })).toBe(0.2);
    expect(latestValLoss({ points: [], networkHistory: [{ networkId: "n", cycle: 1, createdAt: 0, valLoss: 0.5 }] })).toBe(0.5);
    expect(latestValLoss({ points: [], networkHistory: [] })).toBeNull();
  });
});

describe("sample positions", () => {
  it("are legal positions with unique ids", () => {
    expect(new Set(SAMPLE_POSITIONS.map((p) => p.id)).size).toBe(SAMPLE_POSITIONS.length);
    for (const p of SAMPLE_POSITIONS) expect(() => new ChessGame(p.fen)).not.toThrow();
  });

  it("judge evaluations by direction", () => {
    expect(evalAgrees("equal", 40)).toBe(true);
    expect(evalAgrees("white", -10)).toBe(false);
    expect(evalAgrees("black", -400)).toBe(true);
    expect(evalAgrees("white", null)).toBeNull();
  });
});

describe("lineage", () => {
  const n = (id: string, parentId: string | null, createdAt = 1): NetworkRecord => ({
    id,
    name: id,
    description: "",
    createdAt,
    updatedAt: createdAt,
    hidden: 16,
    activation: 1,
    parentId,
    stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
    sizeBytes: 0,
  });

  it("walks the parent chain and stops at missing records and cycles", () => {
    const all = [n("c", "b"), n("b", "a"), n("a", null)];
    expect(parentChain(all[0], all).map((e) => e.id)).toEqual(["b", "a"]);
    const missing = parentChain(n("x", "ghost"), all);
    expect(missing).toEqual([{ id: "ghost", network: null }]);
    const loopy = [n("p", "q"), n("q", "p")];
    expect(parentChain(loopy[0], loopy).map((e) => e.id)).toEqual(["q"]);
  });

  it("lists children newest first", () => {
    const all = [n("a", null), n("b", "a", 5), n("c", "a", 9)];
    expect(childrenOf("a", all).map((x) => x.id)).toEqual(["c", "b"]);
  });
});
