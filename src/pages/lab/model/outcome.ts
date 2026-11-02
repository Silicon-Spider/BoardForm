// How a finished run's network compares with the network it started from (pure).
import type { TrainingRunRecord } from "@/types";

export interface StartComparison {
  /** Validation loss of the network the run ended with (its best epoch). */
  finalLoss: number;
  /** Validation loss of the incoming network on the same held-out positions, before training. */
  startLoss: number;
}

/**
 * For a run that continued or widened an existing network: the final network's validation loss
 * and the starting network's, when training made it worse (null otherwise).
 *
 * The trainer measures the incoming network on the cycle's validation positions before the first
 * step (the point at epoch 0, step 0), so both numbers come from the same held-out data. Only the
 * first cycle is compared: later cycles start from this run's own networks (gating judges those).
 */
export function worseThanStart(run: Pick<TrainingRunRecord, "config" | "networkHistory" | "points">): StartComparison | null {
  if (run.config.network.mode === "new") return null;
  const current = [...run.networkHistory].reverse().find((h) => !h.gating || h.gating.accepted) ?? null;
  if (!current || current.cycle !== 0 || typeof current.valLoss !== "number" || !Number.isFinite(current.valLoss)) return null;
  const start = run.points.find((p) => p.cycle === 0 && p.epoch === 0 && p.step === 0);
  const startLoss = start?.valLoss;
  if (typeof startLoss !== "number" || !Number.isFinite(startLoss)) return null;
  return current.valLoss > startLoss ? { finalLoss: current.valLoss, startLoss } : null;
}
