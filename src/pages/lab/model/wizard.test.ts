import { describe, expect, it } from "vitest";
import type { DatasetRecord, EngineRecord, NetworkRecord } from "@/types";
import { validateHyperParams } from "@/nnue/trainer";
import {
  MIN_RECOMMENDED_STEPS,
  TRAINING_PRESETS,
  applyPreset,
  applyQueryPreset,
  buildRunConfig,
  cleanHyper,
  defaultRunName,
  defaultWidenTarget,
  defaultWizardState,
  detectPreset,
  firstStepWithProblems,
  restoreDraft,
  stepProblems,
  stepWarnings,
  stepsFor,
  suggestHyper,
  summarizeConfig,
  type WizardContext,
  type WizardState,
} from "./wizard";

const net = (id: string, hidden = 64, extra: Partial<NetworkRecord> = {}): NetworkRecord => ({
  id,
  name: `Net ${id}`,
  description: "",
  createdAt: 1,
  updatedAt: 1,
  hidden,
  activation: 1,
  parentId: null,
  stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
  sizeBytes: 68 + 1542 * hidden,
  ...extra,
});

const dataset = (id: string, positions: number): DatasetRecord => ({
  id,
  name: `Data ${id}`,
  description: "",
  createdAt: 1,
  updatedAt: 1,
  positions,
  games: Math.round(positions / 100),
  chunks: 1,
  source: { kind: "import" },
});

const engine = (id: string, name: string): EngineRecord => ({
  id,
  name,
  description: "",
  kind: "eval",
  createdAt: 1,
  updatedAt: 1,
  color: "#123456",
  options: { hashMb: 16 },
});

const ctx = (extra: Partial<WizardContext> = {}): WizardContext => ({
  networks: [net("a", 64), net("b", 512)],
  datasets: [dataset("d1", 50_000), dataset("d2", 20_000)],
  engines: [engine("classic", "Classic")],
  maxWorkers: 6,
  ...extra,
});

const base = (): WizardState => defaultWizardState({ maxWorkers: 6, engineId: "classic", threads: 4 });

describe("defaults and presets", () => {
  it("starts with a valid new-network run using self-play with the given engine", () => {
    const s = base();
    expect(s.networkMode).toBe("new");
    expect(s.selfPlay).toMatchObject({ engineId: "classic", limits: { nodes: 5000 }, randomPlies: 8, maxPlies: 300, skipPlies: 8, concurrency: 6 });
    expect(s.hyper.threads).toBe(4);
    expect(detectPreset(s.hyper)).toBe("balanced");
    for (const step of ["network", "data", "training", "loop", "review"] as const) expect(stepProblems(step, s, ctx())).toEqual([]);
  });

  it("caps trainer threads at the worker limit", () => {
    expect(defaultWizardState({ maxWorkers: 2, engineId: null, threads: 8 }).hyper.threads).toBe(2);
  });

  it("every preset passes the trainer's own validation and is detected again", () => {
    for (const p of TRAINING_PRESETS) {
      const h = applyPreset(base().hyper, p.id);
      expect(() => validateHyperParams(h)).not.toThrow();
      expect(detectPreset(h)).toBe(p.id);
      expect(h.threads).toBe(4);
    }
  });

  it("drops schedule fields the preset does not use", () => {
    const stepped = applyPreset(base().hyper, "long");
    expect(stepped.lrGamma).toBe(0.3);
    const quick = applyPreset(stepped, "quick");
    expect(quick.lrGamma).toBeUndefined();
    expect(quick.lrStepEpochs).toBeUndefined();
    expect(quick.finalLearningRate).toBeUndefined();
  });

  it("edits turn a preset into custom", () => {
    expect(detectPreset({ ...applyPreset(base().hyper, "quick"), epochs: 3 })).toBe("custom");
  });
});

describe("buildRunConfig", () => {
  it("builds a single-cycle config when the loop is off", () => {
    const c = buildRunConfig(base(), "Default name");
    expect(c.name).toBe("Default name");
    expect(c.network).toEqual({ mode: "new", hidden: 128, activation: 1 });
    expect(c.data.selfPlay?.engineId).toBe("classic");
    expect(c.loop).toEqual({ enabled: false, cycles: 1, selfPlayWithLatest: false, keepCycles: null, gating: null });
    expect(c.publishEngine).toBe(true);
    // cosine schedule: no step-schedule fields
    expect(c.hyper.lrGamma).toBeUndefined();
  });

  it("leaves gating out without the loop (it compares consecutive cycles)", () => {
    const c = buildRunConfig({ ...base(), gatingEnabled: true }, "x");
    expect(c.loop.gating).toBeNull();
    expect(stepProblems("loop", { ...base(), gatingEnabled: true, gating: { games: 1, limits: {}, minScore: 0.9 } }, ctx())).toEqual([]);
  });

  it("maps the loop, unlimited cycles, kept cycles and gating", () => {
    const s: WizardState = {
      ...base(),
      name: "  My run  ",
      loopEnabled: true,
      cyclesUnlimited: true,
      keepAllCycles: false,
      keepCycles: 2,
      gatingEnabled: true,
      gating: { games: 30, limits: { nodes: 2000 }, minScore: 0.55 },
    };
    const c = buildRunConfig(s, "x");
    expect(c.name).toBe("My run");
    expect(c.loop).toEqual({ enabled: true, cycles: null, selfPlayWithLatest: true, keepCycles: 2, gating: { games: 30, limits: { nodes: 2000 }, minScore: 0.55 } });
  });

  it("builds continue / widen network modes and leaves self-play out when off", () => {
    const cont = buildRunConfig({ ...base(), networkMode: "continue", sourceNetworkId: "a", selfPlayEnabled: false, datasetIds: ["d1", "d1"] }, "x");
    expect(cont.network).toEqual({ mode: "continue", networkId: "a" });
    expect(cont.data).toEqual({ datasetIds: ["d1"], selfPlay: null });
    const widen = buildRunConfig({ ...base(), networkMode: "widen", sourceNetworkId: "a", widenTo: 128 }, "x");
    expect(widen.network).toEqual({ mode: "widen", networkId: "a", newHidden: 128 });
  });

  it("copies nested objects (editing the state later does not change the config)", () => {
    const s = base();
    const c = buildRunConfig(s, "x");
    s.selfPlay.limits.nodes = 1;
    expect(c.data.selfPlay?.limits.nodes).toBe(5000);
  });

  it("cleanHyper keeps only the active schedule's fields", () => {
    const h = { ...base().hyper, lrGamma: 0.5, lrStepEpochs: 2, finalLearningRate: 1e-5 };
    expect(cleanHyper({ ...h, lrSchedule: "step" })).toMatchObject({ lrGamma: 0.5, lrStepEpochs: 2 });
    expect(cleanHyper({ ...h, lrSchedule: "step" }).finalLearningRate).toBeUndefined();
    expect(cleanHyper({ ...h, lrSchedule: "constant" }).lrGamma).toBeUndefined();
    expect(cleanHyper({ ...h, lrSchedule: "cosine" }).finalLearningRate).toBe(1e-5);
  });
});

describe("step checks", () => {
  it("network step: missing source, deleted source and too-small widen target", () => {
    expect(stepProblems("network", { ...base(), networkMode: "continue" }, ctx())).toEqual(["Choose the network to continue training."]);
    expect(stepProblems("network", { ...base(), networkMode: "continue", sourceNetworkId: "gone" }, ctx())[0]).toMatch(/no longer exists/);
    expect(stepProblems("network", { ...base(), networkMode: "widen", sourceNetworkId: "b", widenTo: 256 }, ctx())[0]).toMatch(/larger than the network's current 512/);
    expect(stepProblems("network", { ...base(), networkMode: "widen", sourceNetworkId: "a", widenTo: 100 }, ctx())[0]).toMatch(/multiple of 8/);
    expect(stepProblems("network", { ...base(), hidden: 12 }, ctx())[0]).toMatch(/multiple of 8/);
    // still loading: no existence check
    expect(stepProblems("network", { ...base(), networkMode: "continue", sourceNetworkId: "gone" }, ctx({ networks: undefined }))).toEqual([]);
  });

  it("data step: needs a dataset or self-play, and sane self-play numbers", () => {
    expect(stepProblems("data", { ...base(), selfPlayEnabled: false }, ctx())).toEqual(["Choose at least one dataset or turn on self-play games."]);
    expect(stepProblems("data", { ...base(), selfPlayEnabled: false, datasetIds: ["d1"] }, ctx())).toEqual([]);
    const bad = { ...base(), selfPlay: { ...base().selfPlay, engineId: "", limits: {}, games: 0, concurrency: 9, maxPlies: 100, skipPlies: 150 } };
    const p = stepProblems("data", bad, ctx());
    expect(p).toContain("Choose the engine that plays the self-play games.");
    expect(p.some((x) => /search limit/.test(x))).toBe(true);
    expect(p.some((x) => /games per cycle/.test(x))).toBe(true);
    expect(p.some((x) => /1 and 6 workers/.test(x))).toBe(true);
    expect(p).toContain("Skip fewer plies than the maximum game length.");
    expect(stepProblems("data", { ...base(), selfPlay: { ...base().selfPlay, engineId: "deleted" } }, ctx())[0]).toMatch(/no longer exists/);
  });

  it("self-play with the run's own network needs a network to start from", () => {
    const s = { ...base(), selfPlay: { ...base().selfPlay, engineId: "$network" } };
    expect(stepProblems("data", s, ctx())[0]).toMatch(/nothing to play with in the first cycle/);
    const cont = { ...s, networkMode: "continue" as const, sourceNetworkId: "a" };
    expect(stepProblems("data", cont, ctx())).toEqual([]);
    expect(stepWarnings("data", cont, ctx())).toHaveLength(1);
  });

  it("training step: reuses the trainer's validation messages", () => {
    const p = stepProblems("training", { ...base(), hyper: { ...base().hyper, epochs: 0 } }, ctx());
    expect(p[0]).toMatch(/^Epochs must be a positive integer/);
    expect(stepProblems("training", { ...base(), hyper: { ...base().hyper, threads: 7 } }, ctx())[0]).toMatch(/trainer threads/);
  });

  it("loop step: the loop needs self-play; gating needs games and a limit", () => {
    expect(stepProblems("loop", { ...base(), loopEnabled: true, selfPlayEnabled: false, datasetIds: ["d1"] }, ctx())[0]).toMatch(/needs new games/);
    const g = stepProblems("loop", { ...base(), loopEnabled: true, gatingEnabled: true, gating: { games: 1, limits: {}, minScore: 0.7 } }, ctx());
    expect(g).toHaveLength(3);
    expect(firstStepWithProblems({ ...base(), loopEnabled: true, gatingEnabled: true, gating: { games: 1, limits: {}, minScore: 0.5 } }, ctx())).toBe("loop");
    expect(firstStepWithProblems(base(), ctx())).toBeNull();
  });
});

describe("step counts and suggestions", () => {
  it("counts steps as ceil(train / batch) × epochs", () => {
    expect(stepsFor(10_000, { batchSize: 1000, epochs: 3, validationSplit: 0.1 })).toEqual({ trainPositions: 9000, stepsPerEpoch: 9, totalSteps: 27 });
    expect(stepsFor(0, { batchSize: 1000, epochs: 3, validationSplit: 0.1 }).totalSteps).toBe(0);
  });

  it("suggests a smaller batch first, then more epochs", () => {
    const h = { ...applyPreset(base().hyper, "long") }; // batch 4096, 30 epochs
    const s = suggestHyper(h, 50_000)!;
    expect(s.batchSize).toBeLessThan(4096);
    expect(stepsFor(50_000, s).totalSteps).toBeGreaterThanOrEqual(MIN_RECOMMENDED_STEPS);
    expect(s.epochs).toBe(30);

    const tiny = suggestHyper({ ...h, epochs: 2 }, 5_000)!;
    expect(tiny.batchSize).toBe(128);
    expect(tiny.epochs).toBeGreaterThan(2);
    expect(tiny.epochs).toBeLessThanOrEqual(60);
    // step schedule rhythm scales with the epochs
    expect(tiny.lrStepEpochs).toBeGreaterThanOrEqual(1);
  });

  it("returns null when there are enough steps or no data", () => {
    expect(suggestHyper(base().hyper, 5_000_000)).toBeNull();
    expect(suggestHyper(base().hyper, 0)).toBeNull();
  });
});

describe("query presets and names", () => {
  it("preselects continue / widen from the URL", () => {
    const networks = [net("a", 64)];
    expect(applyQueryPreset(base(), { networkId: "a", mode: "continue" }, networks)).toMatchObject({ networkMode: "continue", sourceNetworkId: "a" });
    expect(applyQueryPreset(base(), { networkId: "a", mode: "widen" }, networks)).toMatchObject({ networkMode: "widen", sourceNetworkId: "a", widenTo: 128 });
    expect(applyQueryPreset(base(), { datasetIds: "d1,d2,d1" }, networks)).toMatchObject({ datasetIds: ["d1", "d2"], selfPlayEnabled: false });
    expect(applyQueryPreset(base(), {}, networks)).toEqual(base());
  });

  it("widen targets the next preset size", () => {
    expect(defaultWidenTarget(16)).toBe(32);
    expect(defaultWidenTarget(100)).toBe(128);
    expect(defaultWidenTarget(512)).toBe(1024);
    expect(defaultWidenTarget(2048)).toBe(2048);
  });

  it("suggests readable names", () => {
    expect(defaultRunName(base(), {}, 0)).toMatch(/^HL128 SCReLU · /);
    expect(defaultRunName({ ...base(), networkMode: "continue", sourceNetworkId: "a" }, { networks: [net("a")] }, 0)).toMatch(/^Net a · continued · /);
    expect(defaultRunName({ ...base(), networkMode: "widen", sourceNetworkId: "a", widenTo: 256 }, { networks: [net("a")] }, 0)).toMatch(/^Net a → HL256 · /);
  });
});

describe("drafts", () => {
  it("restores a saved draft and repairs malformed fields", () => {
    const d = base();
    const saved = { v: 1, savedAt: 5, step: "training", state: { ...d, hidden: 256, datasetIds: ["d1", 7], hyper: { ...d.hyper, epochs: "x" }, selfPlay: { ...d.selfPlay, limits: { nodes: -1, depth: 6 } } } };
    const r = restoreDraft(JSON.parse(JSON.stringify(saved)), d)!;
    expect(r.step).toBe("training");
    expect(r.state.hidden).toBe(256);
    expect(r.state.datasetIds).toEqual(["d1"]);
    expect(r.state.hyper.epochs).toBe(d.hyper.epochs);
    expect(r.state.selfPlay.limits).toEqual({ depth: 6 });
  });

  it("round-trips the defaults exactly", () => {
    const d = base();
    expect(restoreDraft(JSON.parse(JSON.stringify({ v: 1, savedAt: 1, step: "network", state: d })), d)!.state).toEqual(d);
  });

  it("rejects unknown versions and junk", () => {
    expect(restoreDraft(null, base())).toBeNull();
    expect(restoreDraft({ v: 2, state: {} }, base())).toBeNull();
    expect(restoreDraft("draft", base())).toBeNull();
  });
});

describe("summarizeConfig", () => {
  it("describes every section in words", () => {
    const s: WizardState = { ...base(), datasetIds: ["d1"], loopEnabled: true, cycles: 4, gatingEnabled: true };
    expect(buildRunConfig(s, "x").loop.gating).not.toBeNull();
    const sections = summarizeConfig(buildRunConfig(s, "x"), ctx());
    expect(sections.map((x) => x.id)).toEqual(["network", "data", "training", "loop"]);
    const text = JSON.stringify(sections);
    expect(text).toContain("128 neurons");
    expect(text).toContain("1 dataset · 50.0k positions");
    expect(text).toContain("1,000 games per cycle by Classic");
    expect(text).toContain("4 cycles");
    expect(text).toContain("20 games at 5,000 nodes, needs 55%");
    expect(text).toContain("75% search score, 25% game result");
  });

  it("names deleted engines, networks and datasets", () => {
    const s: WizardState = { ...base(), networkMode: "continue", sourceNetworkId: "zzz", datasetIds: ["nope"], selfPlay: { ...base().selfPlay, engineId: "gone" } };
    const text = JSON.stringify(summarizeConfig(buildRunConfig(s, "x"), ctx()));
    expect(text).toContain("a deleted network");
    expect(text).toContain("(1 deleted)");
    expect(text).toContain("by a deleted engine");
  });
});
