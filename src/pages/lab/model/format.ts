// Pure display helpers for the NNUE Lab pages (no React, no storage): status labels, loss / LR
// formatting, cycle wording, dataset and self-play descriptions.
import type {
  DatasetRecord,
  EngineLimits,
  SelfPlayConfig,
  TrainingRunConfig,
  TrainingRunRecord,
  TrainingRunStatus,
} from "@/types";
import { formatCount, formatScore } from "@/utils/format";

/** Bytes per stored training position (docs/NNUE_FORMAT.md, PackedPosition). */
export const BYTES_PER_POSITION = 32;

// ------------------------------------------------------------------------------- run status

export interface StatusMeta {
  label: string;
  /** Badge classes from global.css. */
  badge: string;
  /** One short sentence for tooltips and notices. */
  description: string;
}

export const RUN_STATUS: Readonly<Record<TrainingRunStatus, StatusMeta>> = {
  queued: { label: "Queued", badge: "badge", description: "Waiting to start." },
  selfplay: { label: "Self-play", badge: "badge badge-accent", description: "Playing games to collect training positions." },
  training: { label: "Training", badge: "badge badge-accent", description: "Training the network on the collected positions." },
  evaluating: { label: "Evaluating", badge: "badge badge-violet", description: "Playing the new network against the previous one." },
  paused: { label: "Paused", badge: "badge badge-warn", description: "Paused — resume to continue where it left off." },
  finished: { label: "Finished", badge: "badge badge-ok", description: "All cycles are done." },
  stopped: { label: "Stopped", badge: "badge", description: "Stopped — the best network so far was kept." },
  error: { label: "Error", badge: "badge badge-danger", description: "Stopped because of an error." },
};

const ACTIVE: ReadonlySet<TrainingRunStatus> = new Set<TrainingRunStatus>(["queued", "selfplay", "training", "evaluating"]);

/** Statuses of a run that is (supposed to be) executing somewhere. */
export function isActiveStatus(status: TrainingRunStatus): boolean {
  return ACTIVE.has(status);
}

/** Statuses from which training.start() continues the run. */
export function canStartStatus(status: TrainingRunStatus): boolean {
  return status === "queued" || status === "paused" || status === "stopped" || status === "error";
}

/** Label for the start button: "Start", "Resume", "Continue" or "Retry". */
export function startLabel(status: TrainingRunStatus): string {
  switch (status) {
    case "paused":
      return "Resume";
    case "stopped":
      return "Continue";
    case "error":
      return "Retry";
    default:
      return "Start";
  }
}

/** Phase of a run for the stepper: from the live state when executing here, else the status. */
export type RunPhase = "idle" | "selfplay" | "training" | "evaluating";

export function phaseOfStatus(status: TrainingRunStatus): RunPhase {
  return status === "selfplay" || status === "training" || status === "evaluating" ? status : "idle";
}

/**
 * The phase a run that is not executing in this tab was in, from its stored record: the status
 * while it runs elsewhere; after a pause / stop / error the service renames progress.phase to the
 * status, so fall back to the training cursor (run.resume) and the progress totals.
 */
export function persistedPhase(run: Pick<TrainingRunRecord, "status" | "progress" | "resume" | "config">): RunPhase {
  const s = phaseOfStatus(run.status);
  if (s !== "idle") return s;
  if (run.status === "finished" || run.status === "queued") return "idle";
  const p = run.progress.phase;
  if (p === "selfplay" || p === "training" || p === "evaluating") return p;
  if (run.resume) return "training";
  const total = run.progress.total;
  if (total > 0 && run.config.data.selfPlay && total === run.config.data.selfPlay.games) return "selfplay";
  if (total > 0 && run.config.loop.gating && total === run.config.loop.gating.games) return "evaluating";
  return "idle";
}

export const PHASE_LABELS: Readonly<Record<RunPhase, string>> = {
  idle: "Idle",
  selfplay: "Self-play",
  training: "Training",
  evaluating: "Evaluating",
};

/**
 * A paused run that the app paused itself because the tab closed mid-run (the service writes a log
 * line about it), as opposed to one the user paused.
 */
export function wasInterrupted(run: Pick<TrainingRunRecord, "status" | "log">): boolean {
  if (run.status !== "paused") return false;
  for (let i = run.log.length - 1; i >= 0 && i >= run.log.length - 5; i--) {
    if (/interrupt|was closed|reopen/i.test(run.log[i].message)) return true;
    if (/paused/i.test(run.log[i].message)) return false;
  }
  return false;
}

// ------------------------------------------------------------------------------- cycles

// The service counts cycles from 0 (TrainingRunRecord.cycle, networkHistory[].cycle,
// TrainingPoint.cycle, LiveRunState.cycle); people count from 1.

/** 1-based cycle number for display. */
export function cycleNumber(cycleIndex: number): number {
  return Math.max(0, Math.floor(cycleIndex) || 0) + 1;
}

/** "Cycle 2 of 5", "Cycle 2 of unlimited" or "Single cycle" for a 0-based cycle index. */
export function cycleText(cycleIndex: number, config: Pick<TrainingRunConfig, "loop">): string {
  const n = cycleNumber(cycleIndex);
  if (!config.loop.enabled) return "Single cycle";
  if (config.loop.cycles === null) return `Cycle ${n} of unlimited`;
  return `Cycle ${n} of ${Math.max(n, config.loop.cycles)}`;
}

/** Short cycle cell for tables ("2 / 5", "2 / ∞", "1 / 1") for a 0-based cycle index. */
export function cycleShort(cycleIndex: number, config: Pick<TrainingRunConfig, "loop">): string {
  const n = cycleNumber(cycleIndex);
  if (!config.loop.enabled) return "1 / 1";
  return `${n} / ${config.loop.cycles === null ? "∞" : Math.max(n, config.loop.cycles)}`;
}

// ------------------------------------------------------------------------------- numbers

/** Whole numbers for prose and small counts: 1000 → "1,000"; compact from a million ("1.23M"). */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n) < 1e6 ? Math.round(n).toLocaleString("en-US") : formatCount(n);
}

/** "1 game", "1,000 games", "2.50M positions". */
export function countOf(n: number, word: string, pluralWord = word + "s"): string {
  return `${formatInt(n)} ${n === 1 ? word : pluralWord}`;
}

/** Loss with 4 significant digits ("0.04213"); "—" when unknown. */
export function formatLoss(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (Math.abs(v) < 1e-4) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** Learning rate: 0.001 → "0.001", 0.00001 → "1e-5", 0.0025 → "0.0025". */
export function formatLr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (Math.abs(v) >= 1e-4) return String(Number(v.toPrecision(3)));
  const [mant, exp] = v.toExponential(1).split("e");
  const m = Number(mant);
  return `${m === Math.round(m) ? m.toFixed(0) : mant}e${Number(exp)}`;
}

/** White-POV centipawns as pawns ("+0.35"), "—" when unknown. */
export function formatCp(cp: number | null | undefined): string {
  return formatScore(cp ?? null);
}

/** Gating score as a percentage: 0.5625 → "56%". */
export function formatScorePct(score: number | null | undefined, digits = 0): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return "—";
  return `${(score * 100).toFixed(digits)}%`;
}

/** Packed game result (White POV) → "1-0", "½-½", "0-1". */
export function resultText(result: 0 | 1 | 2): string {
  return result === 2 ? "1-0" : result === 0 ? "0-1" : "½-½";
}

/** Approximate stored size of a dataset (positions × 32 B). */
export function datasetBytes(ds: Pick<DatasetRecord, "positions">): number {
  return Math.max(0, ds.positions) * BYTES_PER_POSITION;
}

/** "5k nodes · depth 8 · 0.5 s/move", "no limits". */
export function describeEngineLimits(limits: EngineLimits | null | undefined): string {
  if (!limits) return "no limits";
  const parts: string[] = [];
  if (limits.nodes) parts.push(`${formatInt(limits.nodes)} nodes`);
  if (limits.depth) parts.push(`depth ${limits.depth}`);
  if (limits.movetimeMs) parts.push(`${Number((limits.movetimeMs / 1000).toFixed(3))} s/move`);
  return parts.length ? parts.join(" · ") : "no limits";
}

export function hasAnyLimit(limits: EngineLimits | null | undefined): boolean {
  return !!limits && !!(limits.nodes || limits.depth || limits.movetimeMs);
}

/** Pseudo engine id: the stock NNUE engine running a network (the run's newest, or a chosen one). */
export const NETWORK_ENGINE_ID = "$network";

/** "Classic · 5k nodes · 8 random plies". */
export function describeSelfPlay(cfg: SelfPlayConfig, engineName: string): string {
  return [engineName, describeEngineLimits(cfg.limits), `${cfg.randomPlies} random ${cfg.randomPlies === 1 ? "ply" : "plies"}`].join(" · ");
}

/** Where a dataset's positions came from, e.g. "Self-play · Classic · 5k nodes". */
export function describeDatasetSource(
  ds: Pick<DatasetRecord, "source">,
  names: { engine?: string | null; network?: string | null },
): string {
  const s = ds.source;
  if (s.kind === "import") return "Imported file";
  if (s.kind === "merge") return "Merged datasets";
  const who =
    s.engineId === NETWORK_ENGINE_ID || (!s.engineId && s.networkId)
      ? `NNUE ${names.network ? `“${names.network}”` : "network"}`
      : (names.engine ?? s.engineName ?? "Unknown engine");
  const parts = ["Self-play", who];
  if (s.limits && hasAnyLimit(s.limits)) parts.push(describeEngineLimits(s.limits));
  return parts.join(" · ");
}

// ------------------------------------------------------------------------------- run summaries

/** Latest validation loss of a run (its newest point with one, else the newest network's). */
export function latestValLoss(run: Pick<TrainingRunRecord, "points" | "networkHistory">): number | null {
  for (let i = run.points.length - 1; i >= 0; i--) {
    const v = run.points[i].valLoss;
    if (v !== null && Number.isFinite(v)) return v;
  }
  for (let i = run.networkHistory.length - 1; i >= 0; i--) {
    const v = run.networkHistory[i].valLoss;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Latest training loss of a run, or null before the first point. */
export function latestTrainLoss(run: Pick<TrainingRunRecord, "points">): number | null {
  for (let i = run.points.length - 1; i >= 0; i--) {
    const v = run.points[i].trainLoss;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Fraction 0..1 of the persisted progress, or null when unknown. */
export function progressFraction(p: { done: number; total: number } | null | undefined): number | null {
  if (!p || !(p.total > 0) || !Number.isFinite(p.done)) return null;
  return Math.min(1, Math.max(0, p.done / p.total));
}

/** Upper-cases the first letter ("invalid x" → "Invalid x"). */
export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Error → message for toasts (StorageError messages are already written for users). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "Something went wrong.";
}

/** File name without its extension: "my net.nnue" → "my net". */
export function baseName(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return (i > 0 ? fileName.slice(0, i) : fileName).trim();
}
