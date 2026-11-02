// Run-wizard support: validateConfig() lists user-facing problems with a TrainingRunConfig and
// estimate() predicts its size (docs/NNUE_FORMAT.md "Training-run guidance").
import type { DatasetRecord, EngineRecord, NetworkRecord, TrainingRunConfig } from "@/types";
import { isValidHidden, MAX_HIDDEN, MIN_HIDDEN } from "@/nnue/format";
import { parameterCount } from "@/nnue/init";
import { validateHyperParams } from "@/nnue/trainer";
import { MIN_USEFUL_POSITIONS, MIN_USEFUL_STEPS, POSITIONS_PER_GAME_ESTIMATE } from "./constants";
import { NETWORK_ENGINE_ID } from "./selfplay-job";
import type { RunEstimate } from "./types";

/** Lookups validation needs (repositories in the app). */
export interface ValidationSources {
  network(id: string): Promise<NetworkRecord | undefined>;
  networkHasData(id: string): Promise<boolean>;
  dataset(id: string): Promise<DatasetRecord | undefined>;
  engine(id: string): Promise<EngineRecord | undefined>;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const fmt = (n: number) => n.toLocaleString("en-US");

/** Hidden size the run's network will have (null when the source network is unknown). */
async function targetHidden(config: TrainingRunConfig, src: ValidationSources): Promise<number | null> {
  const n = config.network;
  if (n.mode === "new") return n.hidden;
  if (n.mode === "widen") return n.newHidden;
  const rec = await src.network(n.networkId);
  return rec ? rec.hidden : null;
}

/** User-facing problems with a run configuration; [] means it can be started. */
export async function validateRunConfig(config: TrainingRunConfig, src: ValidationSources): Promise<string[]> {
  const problems: string[] = [];
  if (!config || typeof config !== "object") return ["The run settings are missing."];
  if (typeof config.name !== "string" || config.name.trim() === "") problems.push("Give the run a name.");

  // --- network ---
  const n = config.network;
  let sourceExists = false;
  if (!n || typeof n !== "object") {
    problems.push("Choose whether to train a new network or continue / widen an existing one.");
  } else if (n.mode === "new") {
    if (!isValidHidden(n.hidden)) problems.push(`The hidden size must be a multiple of 8 between ${MIN_HIDDEN} and ${fmt(MAX_HIDDEN)} (got ${String(n.hidden)}).`);
    if (n.activation !== 0 && n.activation !== 1) problems.push("Choose an activation function (CReLU or SCReLU).");
  } else if (n.mode === "continue" || n.mode === "widen") {
    const rec = n.networkId ? await src.network(n.networkId) : undefined;
    if (!rec) problems.push(`The network to ${n.mode === "continue" ? "continue training" : "widen"} no longer exists. Choose another one.`);
    else if (!(await src.networkHasData(rec.id))) problems.push(`The weights of the network "${rec.name}" are missing. Import it again or choose another network.`);
    else sourceExists = true;
    if (n.mode === "widen") {
      if (!isValidHidden(n.newHidden)) problems.push(`The new hidden size must be a multiple of 8 between ${MIN_HIDDEN} and ${fmt(MAX_HIDDEN)} (got ${String(n.newHidden)}).`);
      else if (rec && n.newHidden <= rec.hidden) problems.push(`Widening needs a larger hidden size than the network's current ${rec.hidden} (got ${n.newHidden}).`);
    }
  } else {
    problems.push(`Unknown network mode "${String((n as { mode?: unknown }).mode)}".`);
  }

  // --- data ---
  const data = config.data ?? { datasetIds: [], selfPlay: null };
  const ids = Array.isArray(data.datasetIds) ? data.datasetIds : [];
  let positions = 0;
  let missing = 0;
  for (const id of ids) {
    const ds = await src.dataset(id);
    if (!ds) missing++;
    else positions += ds.positions;
  }
  if (missing > 0) problems.push(missing === 1 ? "One of the selected datasets no longer exists." : `${missing} of the selected datasets no longer exist.`);
  const sp = data.selfPlay;
  if (!sp && positions === 0) problems.push("There is nothing to train on: choose datasets that contain positions, or generate data with self-play.");

  if (sp) {
    if (!sp.engineId) {
      problems.push("Choose the engine that plays the self-play games.");
    } else if (sp.engineId === NETWORK_ENGINE_ID) {
      if (!sourceExists) {
        problems.push(
          "Self-play with the run's own network needs an existing network for the first cycle. Choose an engine for self-play, or continue / widen an existing network.",
        );
      }
    } else if (!(await src.engine(sp.engineId))) {
      problems.push("The self-play engine no longer exists. Choose another engine.");
    }
    if (!isInt(sp.games) || sp.games < 1) problems.push("Self-play needs at least 1 game per cycle.");
    else if (sp.games > 1_000_000) problems.push("Self-play is limited to 1,000,000 games per cycle.");
    if (!isInt(sp.concurrency) || sp.concurrency < 1) problems.push("Use at least 1 self-play worker.");
    if (!isInt(sp.randomPlies) || sp.randomPlies < 0 || sp.randomPlies > 60) problems.push("Random opening plies must be between 0 and 60.");
    if (!isInt(sp.maxPlies) || sp.maxPlies < 10) problems.push("The maximum game length must be at least 10 plies.");
    else if (isInt(sp.randomPlies) && sp.maxPlies <= sp.randomPlies) problems.push("The maximum game length must be longer than the random opening.");
    if (!isInt(sp.skipPlies) || sp.skipPlies < 0) problems.push("Skipped plies must be 0 or more.");
    const l = sp.limits ?? {};
    for (const [key, label] of [
      ["depth", "depth"],
      ["nodes", "nodes"],
      ["movetimeMs", "move time"],
    ] as const) {
      const v = l[key];
      if (v !== undefined && v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) problems.push(`The self-play ${label} limit must be a positive number.`);
    }
  }

  // --- hyperparameters ---
  const h = config.hyper;
  if (!h) {
    problems.push("The training settings are missing.");
  } else {
    try {
      validateHyperParams(h);
    } catch (e) {
      problems.push((e instanceof Error ? e.message : String(e)).replace(/^Invalid training settings: /, "Training settings: ").replace(/([^.])$/, "$1."));
    }
    if (!isInt(h.threads) || h.threads < 1) problems.push("Use at least 1 training thread.");
  }

  // --- loop ---
  const loop = config.loop;
  if (loop) {
    if (loop.enabled) {
      if (!sp) problems.push("The reinforcement loop needs self-play: every cycle generates new games with the newest network.");
      if (loop.cycles !== null && (!isInt(loop.cycles) || loop.cycles < 1)) problems.push("The number of cycles must be at least 1 (or unlimited).");
      if (loop.keepCycles !== null && (!isInt(loop.keepCycles) || loop.keepCycles < 1)) problems.push("Keep the data of at least 1 cycle (or all of them).");
    }
    if (loop.gating) {
      if (!loop.enabled) problems.push("Gating compares each cycle's network with the previous one, so it needs the reinforcement loop.");
      const g = loop.gating;
      if (!isInt(g.games) || g.games < 2) problems.push("Gating needs at least 2 games (one with each colour).");
      if (!(typeof g.minScore === "number" && g.minScore >= 0 && g.minScore <= 1)) problems.push("The gating score threshold must be between 0 and 1 (e.g. 0.55 = 55%).");
    }
  }
  return problems;
}

/** Positions the first cycle will train on: existing datasets + planned self-play. */
async function plannedPositions(config: TrainingRunConfig, src: ValidationSources): Promise<number> {
  let positions = 0;
  for (const id of config.data?.datasetIds ?? []) {
    const ds = await src.dataset(id);
    if (ds) positions += ds.positions;
  }
  const sp = config.data?.selfPlay;
  if (sp && isInt(sp.games) && sp.games > 0) positions += sp.games * POSITIONS_PER_GAME_ESTIMATE;
  return positions;
}

/** Size and duration indicators for the run wizard (first cycle). */
export async function estimateRun(config: TrainingRunConfig, src: ValidationSources): Promise<RunEstimate> {
  const warnings: string[] = [];
  const positions = await plannedPositions(config, src);
  const h = config.hyper;
  const split = h && Number.isFinite(h.validationSplit) ? Math.min(0.5, Math.max(0, h.validationSplit)) : 0;
  const trainPositions = positions > 1 ? Math.max(1, positions - Math.max(split > 0 ? 1 : 0, Math.round(positions * split))) : positions;
  const batch = h && isInt(h.batchSize) && h.batchSize > 0 ? Math.min(h.batchSize, Math.max(1, trainPositions)) : 1;
  const stepsPerEpoch = trainPositions > 0 ? Math.ceil(trainPositions / batch) : 0;
  const epochs = h && isInt(h.epochs) && h.epochs > 0 ? h.epochs : 0;
  const totalSteps = stepsPerEpoch * epochs;
  const hidden = await targetHidden(config, src);
  const parameters = hidden !== null && isValidHidden(hidden) ? parameterCount(hidden) : 0;

  if (positions === 0) {
    warnings.push("There are no positions to train on yet: add datasets or enable self-play.");
  } else {
    if (totalSteps < MIN_USEFUL_STEPS) {
      const suggestion = epochs > 0 ? Math.max(1, Math.floor((trainPositions * epochs) / MIN_USEFUL_STEPS)) : 0;
      const neededEpochs = stepsPerEpoch > 0 ? Math.ceil(MIN_USEFUL_STEPS / stepsPerEpoch) : 0;
      warnings.push(
        `Only ${fmt(totalSteps)} optimizer steps per cycle — below about ${fmt(MIN_USEFUL_STEPS)} a network barely learns. ` +
          `Use a smaller batch size${suggestion > 0 && suggestion < batch ? ` (about ${fmt(suggestion)})` : ""}` +
          `${neededEpochs > epochs ? ` or about ${fmt(neededEpochs)} epochs` : " or more epochs"}.`,
      );
    }
    if (positions < MIN_USEFUL_POSITIONS) {
      warnings.push(
        `Only about ${fmt(positions)} positions. A network usually needs a few hundred thousand positions to beat the simple material + piece-square evaluation — ` +
          "more self-play games or datasets will help.",
      );
    }
  }
  return { positions, stepsPerEpoch, totalSteps, parameters, warnings };
}
