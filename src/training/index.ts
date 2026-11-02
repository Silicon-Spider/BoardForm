// @/training — the NNUE Lab service (docs/ARCHITECTURE.md §5 "@/training"): self-play data
// generation, training runs (new / continue / widen, reinforcement loop with gating), dataset and
// network management, background execution with auto-resume. Main thread only (workers import
// the submodules they need).
//
// The services are module singletons, so runs and generation jobs keep going while the user
// navigates; React reads them through useLiveRun / useActiveRunIds / useDatasetJob.
import { createDefaultDeps } from "./defaults";
import { createLabService } from "./service";
import type { DatasetService, NetworkService, TrainingService } from "./types";

export type * from "./types";
export { useLiveRun, useActiveRunIds, useDatasetJob, getLiveRun, getDatasetJob } from "./live";
export { NETWORK_ENGINE_ID } from "./selfplay-job";
export { describeEngineLimits } from "./scores";

const lab = createLabService(createDefaultDeps());

export const training: TrainingService = lab.training;
export const datasets: DatasetService = lab.datasets;
export const networks: NetworkService = lab.networks;

let initialized = false;

/**
 * Called once from src/main.tsx (idempotent). After start-up seeding: runs left in a running
 * status by a closed tab are resumed when they have autoResume, otherwise marked "paused".
 */
export function initTrainingService(): void {
  if (initialized) return;
  initialized = true;
  void lab.init().catch((err: unknown) => console.error("[training] start-up recovery failed", err));
  if (typeof document !== "undefined") {
    // A hidden tab may be closed next: save checkpoints and progress now rather than in 20 s.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void lab.persistAll();
    });
  }
}
