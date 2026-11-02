// New-run wizard model (pure): the editable state, its defaults, training presets, turning the
// state into a TrainingRunConfig, per-step checks, step-count suggestions, draft restore and the
// human-readable config summary that the review step and the run dashboard show.
import type {
  Activation,
  DatasetRecord,
  EngineLimits,
  EngineRecord,
  NetworkRecord,
  SelfPlayConfig,
  TrainingHyperParams,
  TrainingRunConfig,
} from "@/types";
import { ACTIVATION_NAMES, DEFAULT_ACTIVATION, DEFAULT_HIDDEN, HIDDEN_SIZE_PRESETS, MAX_HIDDEN, isValidHidden, networkFileSize } from "@/nnue/format";
import { parameterCount } from "@/nnue/init";
import { DEFAULT_HYPER_PARAMS, validateHyperParams } from "@/nnue/trainer";
import { formatBytes, formatCount, formatPercent } from "@/utils/format";
import { NETWORK_ENGINE_ID, capitalize, describeEngineLimits, formatInt, formatLr, hasAnyLimit } from "./format";

// ------------------------------------------------------------------------------- state

export type NetworkMode = "new" | "continue" | "widen";
export type WizardStepId = "network" | "data" | "training" | "loop" | "review";

export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; label: string }> = [
  { id: "network", label: "Network" },
  { id: "data", label: "Data" },
  { id: "training", label: "Training" },
  { id: "loop", label: "Loop & publishing" },
  { id: "review", label: "Review" },
];

export interface GatingDraft {
  games: number;
  limits: EngineLimits;
  minScore: number;
}

export interface WizardState {
  /** Run name; "" = use the suggested name. */
  name: string;
  networkMode: NetworkMode;
  /** New network: hidden size and activation. */
  hidden: number;
  activation: Activation;
  /** Continue / widen: the network to start from. */
  sourceNetworkId: string | null;
  /** Widen: the new hidden size (null = not chosen yet). */
  widenTo: number | null;
  datasetIds: string[];
  selfPlayEnabled: boolean;
  selfPlay: SelfPlayConfig;
  hyper: TrainingHyperParams;
  loopEnabled: boolean;
  cycles: number;
  cyclesUnlimited: boolean;
  selfPlayWithLatest: boolean;
  keepAllCycles: boolean;
  keepCycles: number;
  gatingEnabled: boolean;
  gating: GatingDraft;
  publishEngine: boolean;
  autoResume: boolean;
}

/** Guidance from docs/NNUE_FORMAT.md: below ~1000 optimizer steps a network barely learns. */
export const MIN_RECOMMENDED_STEPS = 1000;
export const GATING_MIN_SCORE = 0.5;
export const GATING_MAX_SCORE = 0.6;
export const DEFAULT_SELFPLAY_LIMITS: Readonly<EngineLimits> = { nodes: 5000 };

export interface WizardDefaultsContext {
  /** The user's background-work limit (Settings). */
  maxWorkers: number;
  /** Engine for self-play (normally the "Classic" starter). */
  engineId: string | null;
  /** Trainer threads available (1 when multi-threaded training is not supported). */
  threads: number;
}

export function defaultSelfPlay(maxWorkers: number, engineId: string | null): SelfPlayConfig {
  return {
    engineId: engineId ?? "",
    limits: { ...DEFAULT_SELFPLAY_LIMITS },
    randomPlies: 8,
    games: 1000,
    concurrency: Math.max(1, Math.floor(maxWorkers)),
    maxPlies: 300,
    skipPlies: 8,
  };
}

export function defaultWizardState(ctx: WizardDefaultsContext): WizardState {
  const threads = Math.max(1, Math.min(Math.floor(ctx.threads), Math.max(1, Math.floor(ctx.maxWorkers))));
  return {
    name: "",
    networkMode: "new",
    hidden: DEFAULT_HIDDEN,
    activation: DEFAULT_ACTIVATION,
    sourceNetworkId: null,
    widenTo: null,
    datasetIds: [],
    selfPlayEnabled: true,
    selfPlay: defaultSelfPlay(ctx.maxWorkers, ctx.engineId),
    hyper: applyPreset({ ...DEFAULT_HYPER_PARAMS, threads }, "balanced"),
    loopEnabled: false,
    cycles: 5,
    cyclesUnlimited: false,
    selfPlayWithLatest: true,
    keepAllCycles: true,
    keepCycles: 3,
    gatingEnabled: false,
    gating: { games: 20, limits: { ...DEFAULT_SELFPLAY_LIMITS }, minScore: 0.55 },
    publishEngine: true,
    autoResume: true,
  };
}

/** The next preset hidden size above `hidden` (or double it), capped at the format maximum. */
export function defaultWidenTarget(hidden: number): number {
  const next = HIDDEN_SIZE_PRESETS.find((h) => h > hidden);
  return next ?? Math.min(MAX_HIDDEN, Math.max(hidden + 8, Math.ceil((hidden * 2) / 8) * 8));
}

/** Preselection from the URL: ?networkId=<id>&mode=continue|widen and ?datasetIds=<id>,<id>. */
export function applyQueryPreset(
  state: WizardState,
  q: { networkId?: string | null; mode?: string | null; datasetIds?: string | null },
  networks: readonly NetworkRecord[] | undefined,
): WizardState {
  let next = state;
  const mode = q.mode === "widen" ? "widen" : q.mode === "continue" || q.networkId ? "continue" : null;
  if (q.networkId && mode) {
    const src = networks?.find((n) => n.id === q.networkId) ?? null;
    next = {
      ...next,
      networkMode: mode,
      sourceNetworkId: q.networkId,
      widenTo: mode === "widen" && src ? defaultWidenTarget(src.hidden) : null,
    };
  }
  const ids = (q.datasetIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) next = { ...next, datasetIds: [...new Set(ids)], selfPlayEnabled: false };
  return next;
}

// ------------------------------------------------------------------------------- presets

export type PresetId = "quick" | "balanced" | "long";

type PresetHyper = Pick<TrainingHyperParams, "epochs" | "batchSize" | "learningRate" | "lrSchedule" | "evalWeight" | "weightDecay" | "validationSplit"> &
  Partial<Pick<TrainingHyperParams, "lrGamma" | "lrStepEpochs" | "finalLearningRate">>;

export interface TrainingPreset {
  id: PresetId;
  label: string;
  description: string;
  hyper: PresetHyper;
}

export const TRAINING_PRESETS: readonly TrainingPreset[] = [
  {
    id: "quick",
    label: "Quick test",
    description: "Tiny and fast — two short epochs to check that everything works.",
    hyper: { epochs: 2, batchSize: 256, learningRate: 0.002, lrSchedule: "constant", evalWeight: 0.75, weightDecay: 0.01, validationSplit: 0.1 },
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "A good default for tens to hundreds of thousands of positions.",
    hyper: {
      epochs: 12,
      batchSize: 1024,
      learningRate: 0.001,
      lrSchedule: "cosine",
      finalLearningRate: 0.00001,
      evalWeight: 0.75,
      weightDecay: 0.01,
      validationSplit: 0.05,
    },
  },
  {
    id: "long",
    label: "Long run",
    description: "More epochs and bigger batches with a stepped learning rate — for a million positions or more.",
    hyper: {
      epochs: 30,
      batchSize: 4096,
      learningRate: 0.001,
      lrSchedule: "step",
      lrGamma: 0.3,
      lrStepEpochs: 10,
      evalWeight: 0.75,
      weightDecay: 0.01,
      validationSplit: 0.02,
    },
  },
];

/** Fills the preset's hyperparameters (threads and seed are kept). */
export function applyPreset(hyper: TrainingHyperParams, id: PresetId): TrainingHyperParams {
  const preset = TRAINING_PRESETS.find((p) => p.id === id);
  if (!preset) return hyper;
  const next: TrainingHyperParams = { ...hyper, ...preset.hyper };
  if (preset.hyper.lrGamma === undefined) delete next.lrGamma;
  if (preset.hyper.lrStepEpochs === undefined) delete next.lrStepEpochs;
  if (preset.hyper.finalLearningRate === undefined) delete next.finalLearningRate;
  return next;
}

const near = (a: number | undefined, b: number | undefined) =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));

/** The preset these hyperparameters match exactly, or "custom". */
export function detectPreset(hyper: TrainingHyperParams): PresetId | "custom" {
  for (const p of TRAINING_PRESETS) {
    const h = p.hyper;
    const same =
      h.epochs === hyper.epochs &&
      h.batchSize === hyper.batchSize &&
      near(h.learningRate, hyper.learningRate) &&
      h.lrSchedule === hyper.lrSchedule &&
      near(h.evalWeight, hyper.evalWeight) &&
      near(h.weightDecay, hyper.weightDecay) &&
      near(h.validationSplit, hyper.validationSplit) &&
      (h.lrSchedule !== "step" || (near(h.lrGamma, hyper.lrGamma) && h.lrStepEpochs === hyper.lrStepEpochs)) &&
      (h.lrSchedule !== "cosine" || near(h.finalLearningRate, hyper.finalLearningRate));
    if (same) return p.id;
  }
  return "custom";
}

/** Drops schedule settings the chosen schedule does not use. */
export function cleanHyper(h: TrainingHyperParams): TrainingHyperParams {
  const out: TrainingHyperParams = { ...h };
  if (out.lrSchedule !== "step") {
    delete out.lrGamma;
    delete out.lrStepEpochs;
  }
  if (out.lrSchedule !== "cosine") delete out.finalLearningRate;
  return out;
}

// ------------------------------------------------------------------------------- steps

export interface StepCount {
  trainPositions: number;
  stepsPerEpoch: number;
  totalSteps: number;
}

/** `steps = ceil(train / batch) × epochs` with train = positions × (1 − validation split). */
export function stepsFor(positions: number, hyper: Pick<TrainingHyperParams, "batchSize" | "epochs" | "validationSplit">): StepCount {
  const train = Math.max(0, Math.floor(positions * (1 - Math.min(0.5, Math.max(0, hyper.validationSplit)))));
  const batch = Math.max(1, Math.floor(hyper.batchSize));
  const stepsPerEpoch = train > 0 ? Math.ceil(train / batch) : 0;
  return { trainPositions: train, stepsPerEpoch, totalSteps: stepsPerEpoch * Math.max(0, Math.floor(hyper.epochs)) };
}

const MIN_SUGGESTED_BATCH = 128;
const MAX_SUGGESTED_EPOCHS = 60;

/**
 * Settings with enough optimizer steps for `positions` training positions: first a smaller batch
 * (halving, down to 128), then more epochs (up to 60). Null when the current settings are already
 * fine, or nothing can be improved.
 */
export function suggestHyper(hyper: TrainingHyperParams, positions: number, minSteps = MIN_RECOMMENDED_STEPS): TrainingHyperParams | null {
  const { trainPositions, totalSteps } = stepsFor(positions, hyper);
  if (trainPositions <= 0 || totalSteps >= minSteps) return null;
  let batch = Math.max(1, Math.floor(hyper.batchSize));
  let epochs = Math.max(1, Math.floor(hyper.epochs));
  while (batch > MIN_SUGGESTED_BATCH && Math.ceil(trainPositions / batch) * epochs < minSteps) {
    batch = Math.max(MIN_SUGGESTED_BATCH, Math.floor(batch / 2));
  }
  const perEpoch = Math.ceil(trainPositions / batch);
  if (perEpoch * epochs < minSteps) epochs = Math.min(MAX_SUGGESTED_EPOCHS, Math.max(epochs, Math.ceil(minSteps / perEpoch)));
  if (batch === hyper.batchSize && epochs === hyper.epochs) return null;
  const next: TrainingHyperParams = { ...hyper, batchSize: batch, epochs };
  // Keep a step schedule's rhythm proportional to the run length.
  if (next.lrSchedule === "step" && hyper.lrStepEpochs && epochs !== hyper.epochs) {
    next.lrStepEpochs = Math.max(1, Math.round((hyper.lrStepEpochs * epochs) / hyper.epochs));
  }
  return next;
}

// ------------------------------------------------------------------------------- config

export interface WizardContext {
  networks?: readonly NetworkRecord[];
  datasets?: readonly DatasetRecord[];
  engines?: readonly EngineRecord[];
  maxWorkers: number;
}

/** A readable default run name, e.g. "HL128 SCReLU · Nov 2, 14:05". */
export function defaultRunName(state: WizardState, ctx: Pick<WizardContext, "networks">, now = Date.now()): string {
  const src = state.sourceNetworkId ? ctx.networks?.find((n) => n.id === state.sourceNetworkId) : undefined;
  let base: string;
  if (state.networkMode === "new") base = `HL${state.hidden} ${ACTIVATION_NAMES[state.activation]}`;
  else if (state.networkMode === "continue") base = src ? `${src.name} · continued` : "Continued network";
  else base = src ? `${src.name} → HL${state.widenTo ?? "?"}` : "Widened network";
  const when = new Date(now).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${base} · ${when}`;
}

/** The TrainingRunConfig for training.createRun / validateConfig / estimate. */
export function buildRunConfig(state: WizardState, defaultName: string): TrainingRunConfig {
  const network: TrainingRunConfig["network"] =
    state.networkMode === "new"
      ? { mode: "new", hidden: state.hidden, activation: state.activation }
      : state.networkMode === "continue"
        ? { mode: "continue", networkId: state.sourceNetworkId ?? "" }
        : { mode: "widen", networkId: state.sourceNetworkId ?? "", newHidden: state.widenTo ?? 0 };
  const loopOn = state.loopEnabled;
  return {
    name: state.name.trim() || defaultName,
    network,
    data: {
      datasetIds: [...new Set(state.datasetIds)],
      selfPlay: state.selfPlayEnabled ? { ...state.selfPlay, limits: { ...state.selfPlay.limits } } : null,
    },
    hyper: cleanHyper(state.hyper),
    loop: {
      enabled: loopOn,
      cycles: loopOn ? (state.cyclesUnlimited ? null : state.cycles) : 1,
      selfPlayWithLatest: loopOn && state.selfPlayEnabled && state.selfPlayWithLatest,
      keepCycles: loopOn && !state.keepAllCycles ? state.keepCycles : null,
      // Gating compares a cycle's network with the previous cycle's, so it only exists with the loop.
      gating: loopOn && state.gatingEnabled ? { games: state.gating.games, limits: { ...state.gating.limits }, minScore: state.gating.minScore } : null,
    },
    publishEngine: state.publishEngine,
  };
}

const isInt = (v: number, lo: number, hi = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= lo && v <= hi;

/** Blocking problems of one step ([] = fine). Lists that are still loading skip existence checks. */
export function stepProblems(step: WizardStepId, s: WizardState, ctx: WizardContext): string[] {
  const out: string[] = [];
  const src = s.sourceNetworkId && ctx.networks ? (ctx.networks.find((n) => n.id === s.sourceNetworkId) ?? null) : undefined;
  switch (step) {
    case "network":
      if (s.networkMode === "new") {
        if (!isValidHidden(s.hidden)) out.push("Choose a hidden size: a multiple of 8 between 8 and 2048.");
      } else {
        if (!s.sourceNetworkId) out.push(s.networkMode === "continue" ? "Choose the network to continue training." : "Choose the network to widen.");
        else if (src === null) out.push("That network no longer exists — choose another one.");
        if (s.networkMode === "widen" && src) {
          if (s.widenTo === null || !isValidHidden(s.widenTo)) out.push("Choose the new hidden size: a multiple of 8 up to 2048.");
          else if (s.widenTo <= src.hidden) out.push(`Choose a hidden size larger than the network's current ${src.hidden} neurons.`);
        }
      }
      break;
    case "data": {
      const existing = ctx.datasets ? s.datasetIds.filter((id) => ctx.datasets!.some((d) => d.id === id)) : s.datasetIds;
      if (existing.length === 0 && !s.selfPlayEnabled) out.push("Choose at least one dataset or turn on self-play games.");
      if (ctx.datasets && existing.length < s.datasetIds.length) out.push("Some selected datasets no longer exist — untick them.");
      if (s.selfPlayEnabled) {
        const sp = s.selfPlay;
        if (!sp.engineId) out.push("Choose the engine that plays the self-play games.");
        else if (sp.engineId === NETWORK_ENGINE_ID) {
          if (s.networkMode === "new") {
            out.push(
              "A new network has nothing to play with in the first cycle. Choose an engine for self-play (later cycles can use the newest network — see the loop step), or continue / widen an existing network.",
            );
          }
        } else if (ctx.engines && !ctx.engines.some((e) => e.id === sp.engineId)) {
          out.push("The self-play engine no longer exists — choose another one.");
        }
        if (!hasAnyLimit(sp.limits)) out.push("Set at least one search limit for self-play, for example 5,000 nodes.");
        if (!isInt(sp.games, 1, 1_000_000)) out.push("Play between 1 and 1,000,000 games per cycle.");
        if (!isInt(sp.concurrency, 1, Math.max(1, ctx.maxWorkers))) out.push(`Use between 1 and ${Math.max(1, ctx.maxWorkers)} workers (your limit in Settings).`);
        if (!isInt(sp.maxPlies, 10, 2000)) out.push("Set the maximum game length between 10 and 2,000 plies.");
        if (!isInt(sp.randomPlies, 0, 60)) out.push("Use between 0 and 60 random opening plies.");
        else if (isInt(sp.maxPlies, 10, 2000) && sp.randomPlies >= sp.maxPlies) out.push("Make the maximum game length longer than the random opening.");
        if (!isInt(sp.skipPlies, 0, 200)) out.push("Skip between 0 and 200 plies at the start of each game.");
        else if (isInt(sp.maxPlies, 10, 2000) && sp.skipPlies >= sp.maxPlies) out.push("Skip fewer plies than the maximum game length.");
      }
      break;
    }
    case "training": {
      try {
        validateHyperParams(s.hyper);
      } catch (e) {
        const msg = e instanceof Error ? e.message.replace(/^Invalid training settings:\s*/, "") : String(e);
        out.push(capitalize(msg) + (msg.endsWith(".") ? "" : "."));
      }
      if (!isInt(s.hyper.threads, 1, Math.max(1, ctx.maxWorkers))) out.push(`Use between 1 and ${Math.max(1, ctx.maxWorkers)} trainer threads (your limit in Settings).`);
      if (s.hyper.lrSchedule === "step" && s.hyper.lrStepEpochs !== undefined && !isInt(s.hyper.lrStepEpochs, 1, 10_000)) {
        out.push("Lower the learning rate every 1 or more epochs.");
      }
      break;
    }
    case "loop":
      if (s.loopEnabled) {
        if (!s.selfPlayEnabled) out.push("The reinforcement loop needs new games every cycle: turn on self-play in the Data step, or turn the loop off.");
        if (!s.cyclesUnlimited && !isInt(s.cycles, 1, 10_000)) out.push("Run between 1 and 10,000 cycles, or choose “until I stop it”.");
        if (!s.keepAllCycles && !isInt(s.keepCycles, 1, 10_000)) out.push("Keep the data of at least the newest cycle.");
      }
      if (s.gatingEnabled && s.loopEnabled) {
        if (!isInt(s.gating.games, 2, 10_000)) out.push("Play at least 2 gating games.");
        if (!hasAnyLimit(s.gating.limits)) out.push("Set a search limit for the gating games, for example 5,000 nodes.");
        if (!(s.gating.minScore >= GATING_MIN_SCORE && s.gating.minScore <= GATING_MAX_SCORE)) out.push("Set the minimum gating score between 50% and 60%.");
      }
      break;
    case "review":
      for (const id of ["network", "data", "training", "loop"] as const) out.push(...stepProblems(id, s, ctx));
      break;
  }
  return out;
}

/** Non-blocking advice for a step. */
export function stepWarnings(step: WizardStepId, s: WizardState, _ctx: WizardContext): string[] {
  const out: string[] = [];
  if (step === "data" && s.selfPlayEnabled && s.selfPlay.engineId === NETWORK_ENGINE_ID && s.networkMode !== "new") {
    out.push("The network you start from plays the first cycle's games; later cycles use the newest network.");
  }
  if (step === "loop" && s.loopEnabled && !s.cyclesUnlimited && s.cycles === 1) {
    out.push("With one cycle the loop never repeats — use 2 or more cycles, or turn the loop off.");
  }
  return out;
}

/** The first step with problems (for "fix this" jumps), or null. */
export function firstStepWithProblems(s: WizardState, ctx: WizardContext): WizardStepId | null {
  for (const id of ["network", "data", "training", "loop"] as const) if (stepProblems(id, s, ctx).length) return id;
  return null;
}

// ------------------------------------------------------------------------------- drafts

export const DRAFT_SETTING_KEY = "lab.newRunDraft.v1";

export interface WizardDraft {
  v: 1;
  savedAt: number;
  step: WizardStepId;
  state: WizardState;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

function limitsOf(v: unknown, fallback: EngineLimits): EngineLimits {
  if (!isObj(v)) return { ...fallback };
  const out: EngineLimits = {};
  for (const k of ["depth", "nodes", "movetimeMs"] as const) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x > 0) out[k] = x;
  }
  return out;
}

/** Restores a saved draft over the defaults, dropping anything malformed. Null when unusable. */
export function restoreDraft(raw: unknown, defaults: WizardState): WizardDraft | null {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.state)) return null;
  const s = raw.state;
  const d = defaults;
  const mode = s.networkMode === "continue" || s.networkMode === "widen" ? s.networkMode : "new";
  const sp = isObj(s.selfPlay) ? s.selfPlay : {};
  const hy = isObj(s.hyper) ? s.hyper : {};
  const ga = isObj(s.gating) ? s.gating : {};
  const schedule = hy.lrSchedule === "constant" || hy.lrSchedule === "step" || hy.lrSchedule === "cosine" ? hy.lrSchedule : d.hyper.lrSchedule;
  const hyper: TrainingHyperParams = {
    epochs: num(hy.epochs, d.hyper.epochs),
    batchSize: num(hy.batchSize, d.hyper.batchSize),
    learningRate: num(hy.learningRate, d.hyper.learningRate),
    lrSchedule: schedule,
    evalWeight: num(hy.evalWeight, d.hyper.evalWeight),
    weightDecay: num(hy.weightDecay, d.hyper.weightDecay),
    validationSplit: num(hy.validationSplit, d.hyper.validationSplit),
    threads: num(hy.threads, d.hyper.threads),
    seed: num(hy.seed, d.hyper.seed),
  };
  if (typeof hy.lrGamma === "number" && Number.isFinite(hy.lrGamma)) hyper.lrGamma = hy.lrGamma;
  if (typeof hy.lrStepEpochs === "number" && Number.isFinite(hy.lrStepEpochs)) hyper.lrStepEpochs = hy.lrStepEpochs;
  if (typeof hy.finalLearningRate === "number" && Number.isFinite(hy.finalLearningRate)) hyper.finalLearningRate = hy.finalLearningRate;
  const state: WizardState = {
    name: str(s.name, d.name),
    networkMode: mode,
    hidden: num(s.hidden, d.hidden),
    activation: s.activation === 0 || s.activation === 1 ? s.activation : d.activation,
    sourceNetworkId: typeof s.sourceNetworkId === "string" && s.sourceNetworkId ? s.sourceNetworkId : null,
    widenTo: typeof s.widenTo === "number" && Number.isFinite(s.widenTo) ? s.widenTo : null,
    datasetIds: Array.isArray(s.datasetIds) ? s.datasetIds.filter((x): x is string => typeof x === "string" && !!x) : [],
    selfPlayEnabled: bool(s.selfPlayEnabled, d.selfPlayEnabled),
    selfPlay: {
      engineId: str(sp.engineId, d.selfPlay.engineId),
      limits: limitsOf(sp.limits, d.selfPlay.limits),
      randomPlies: num(sp.randomPlies, d.selfPlay.randomPlies),
      games: num(sp.games, d.selfPlay.games),
      concurrency: num(sp.concurrency, d.selfPlay.concurrency),
      maxPlies: num(sp.maxPlies, d.selfPlay.maxPlies),
      skipPlies: num(sp.skipPlies, d.selfPlay.skipPlies),
    },
    hyper,
    loopEnabled: bool(s.loopEnabled, d.loopEnabled),
    cycles: num(s.cycles, d.cycles),
    cyclesUnlimited: bool(s.cyclesUnlimited, d.cyclesUnlimited),
    selfPlayWithLatest: bool(s.selfPlayWithLatest, d.selfPlayWithLatest),
    keepAllCycles: bool(s.keepAllCycles, d.keepAllCycles),
    keepCycles: num(s.keepCycles, d.keepCycles),
    gatingEnabled: bool(s.gatingEnabled, d.gatingEnabled),
    gating: { games: num(ga.games, d.gating.games), limits: limitsOf(ga.limits, d.gating.limits), minScore: num(ga.minScore, d.gating.minScore) },
    publishEngine: bool(s.publishEngine, d.publishEngine),
    autoResume: bool(s.autoResume, d.autoResume),
  };
  const step = WIZARD_STEPS.some((x) => x.id === raw.step) ? (raw.step as WizardStepId) : "network";
  return { v: 1, savedAt: num(raw.savedAt, 0), step, state };
}

/** True when the state differs from the defaults in anything the user would miss. */
export function isPristine(state: WizardState, defaults: WizardState): boolean {
  return JSON.stringify(state) === JSON.stringify(defaults);
}

// ------------------------------------------------------------------------------- summary

export interface SummaryItem {
  label: string;
  value: string;
}

export interface SummarySection {
  id: "network" | "data" | "training" | "loop";
  title: string;
  items: SummaryItem[];
}

export interface SummaryContext {
  networks?: readonly NetworkRecord[];
  datasets?: readonly DatasetRecord[];
  engines?: readonly EngineRecord[];
}

function engineLabel(id: string, ctx: SummaryContext): string {
  if (id === NETWORK_ENGINE_ID) return "this run's newest network";
  const e = ctx.engines?.find((x) => x.id === id);
  return e ? e.name : ctx.engines ? "a deleted engine" : "…";
}

function networkLabel(id: string, ctx: SummaryContext): string {
  const n = ctx.networks?.find((x) => x.id === id);
  if (n) return `${n.name} (HL${n.hidden} ${ACTIVATION_NAMES[n.activation]})`;
  return ctx.networks ? "a deleted network" : "…";
}

const SCHEDULE_TEXT = (h: TrainingHyperParams): string => {
  if (h.lrSchedule === "constant") return `${formatLr(h.learningRate)}, constant`;
  if (h.lrSchedule === "step") {
    const every = h.lrStepEpochs ?? Math.max(1, Math.round(h.epochs / 3));
    return `${formatLr(h.learningRate)}, ×${h.lrGamma ?? 0.1} every ${every} ${every === 1 ? "epoch" : "epochs"}`;
  }
  return `${formatLr(h.learningRate)} → ${formatLr(h.finalLearningRate ?? h.learningRate * 0.01)}, cosine`;
};

/** Human-readable sections describing a run configuration. */
export function summarizeConfig(config: TrainingRunConfig, ctx: SummaryContext): SummarySection[] {
  const net = config.network;
  const netItems: SummaryItem[] = [];
  if (net.mode === "new") {
    netItems.push({ label: "Start", value: "A new network with random weights" });
    netItems.push({ label: "Hidden size", value: `${net.hidden} neurons (${formatCount(parameterCount(net.hidden))} parameters, ${formatBytes(networkFileSize(net.hidden))})` });
    netItems.push({ label: "Activation", value: ACTIVATION_NAMES[net.activation] });
  } else if (net.mode === "continue") {
    netItems.push({ label: "Start", value: "Continue training an existing network" });
    netItems.push({ label: "Network", value: networkLabel(net.networkId, ctx) });
  } else {
    const src = ctx.networks?.find((x) => x.id === net.networkId);
    netItems.push({ label: "Start", value: "Widen an existing network" });
    netItems.push({ label: "Network", value: networkLabel(net.networkId, ctx) });
    netItems.push({ label: "New hidden size", value: `${net.newHidden} neurons${src ? ` (from ${src.hidden})` : ""}` });
  }

  const dataItems: SummaryItem[] = [];
  const ds = config.data.datasetIds.map((id) => ctx.datasets?.find((d) => d.id === id)).filter((d): d is DatasetRecord => !!d);
  if (config.data.datasetIds.length === 0) dataItems.push({ label: "Datasets", value: "None" });
  else {
    const positions = ds.reduce((a, d) => a + d.positions, 0);
    const missing = config.data.datasetIds.length - ds.length;
    dataItems.push({
      label: "Datasets",
      value:
        `${config.data.datasetIds.length} ${config.data.datasetIds.length === 1 ? "dataset" : "datasets"}` +
        (ctx.datasets ? ` · ${formatCount(positions)} positions` : "") +
        (ctx.datasets && missing > 0 ? ` (${missing} deleted)` : ""),
    });
  }
  const sp = config.data.selfPlay;
  if (!sp) dataItems.push({ label: "Self-play", value: "Off — trains on the datasets only" });
  else {
    dataItems.push({ label: "Self-play", value: `${formatInt(sp.games)} games ${config.loop.enabled ? "per cycle " : ""}by ${engineLabel(sp.engineId, ctx)}` });
    dataItems.push({ label: "Search limit", value: describeEngineLimits(sp.limits) });
    dataItems.push({
      label: "Games",
      value: `${sp.randomPlies} random opening ${sp.randomPlies === 1 ? "ply" : "plies"}, up to ${sp.maxPlies} plies, first ${sp.skipPlies} skipped`,
    });
    dataItems.push({ label: "Workers", value: String(sp.concurrency) });
  }

  const h = config.hyper;
  const trainItems: SummaryItem[] = [
    { label: "Epochs", value: `${h.epochs} · batch size ${formatInt(h.batchSize)}` },
    { label: "Learning rate", value: SCHEDULE_TEXT(h) },
    { label: "Eval weight (λ)", value: `${h.evalWeight} — ${Math.round(h.evalWeight * 100)}% search score, ${Math.round((1 - h.evalWeight) * 100)}% game result` },
    { label: "Regularisation", value: `weight decay ${h.weightDecay} · ${formatPercent(h.validationSplit, 0)} held out for validation` },
    { label: "Threads · seed", value: `${h.threads} · ${h.seed}` },
  ];

  const loop = config.loop;
  const loopItems: SummaryItem[] = [];
  if (!loop.enabled) loopItems.push({ label: "Reinforcement loop", value: "Off — one cycle" });
  else {
    loopItems.push({ label: "Reinforcement loop", value: loop.cycles === null ? "Until you stop it" : `${loop.cycles} ${loop.cycles === 1 ? "cycle" : "cycles"}` });
    if (sp) loopItems.push({ label: "Later cycles", value: loop.selfPlayWithLatest ? "Self-play with the newest network" : `Self-play with ${engineLabel(sp.engineId, ctx)}` });
    loopItems.push({ label: "Data kept", value: loop.keepCycles === null ? "All cycles" : `Newest ${loop.keepCycles} ${loop.keepCycles === 1 ? "cycle" : "cycles"}` });
  }
  loopItems.push({
    label: "Gating",
    value: loop.gating
      ? `${loop.gating.games} games at ${describeEngineLimits(loop.gating.limits)}, needs ${Math.round(loop.gating.minScore * 100)}%`
      : "Off — every new network is kept",
  });
  loopItems.push({ label: "Publish an engine", value: config.publishEngine ? "Yes — it always uses the newest accepted network" : "No" });

  return [
    { id: "network", title: "Network", items: netItems },
    { id: "data", title: "Data", items: dataItems },
    { id: "training", title: "Training", items: trainItems },
    { id: "loop", title: "Loop & publishing", items: loopItems },
  ];
}
