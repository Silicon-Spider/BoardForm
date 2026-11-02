// The app's wiring of the Lab service: real repositories, worker pools, trainer, engine host,
// preferences, toasts and header activities. Main thread only.
import { datasetsRepo, enginesRepo, networksRepo, newId, runsRepo, whenSeeded } from "@/storage";
import { getEngineArtifacts, getStockNnueWasm } from "@/engine-host";
import { TEMPLATE_VERSION, defaultFilesFor } from "@/engine-host/templates";
import { TrainerClient } from "@/nnue/trainerClient";
import { getDefaultHashMb, getMaxWorkers } from "@/app/preferences";
import { clearActivity, setActivity } from "@/app/activity";
import { toast } from "@/app/toast";
import {
  CHECKPOINT_EVERY_STEPS,
  CHECKPOINT_PERSIST_MS,
  DATASET_PARTIAL_FLUSH_MS,
  DATASET_UPDATE_MS,
  LIVE_THROTTLE_MS,
  POINT_INTERVAL_MS,
  RUN_FLUSH_MS,
} from "./constants";
import type { ServiceDeps } from "./deps";
import { createWebRunLocks } from "./locks";
import { createWorkerSelfPlaySource } from "./selfplay-pool";

export function createDefaultDeps(): ServiceDeps {
  return {
    runs: runsRepo,
    networks: networksRepo,
    datasets: datasetsRepo,
    engines: enginesRepo,
    selfPlay: createWorkerSelfPlaySource(),
    createTrainer: () => new TrainerClient(),
    stockNnueWasm: () => getStockNnueWasm(),
    engineArtifacts: (engineId) => getEngineArtifacts(engineId),
    maxWorkers: () => getMaxWorkers(),
    defaultHashMb: () => getDefaultHashMb(),
    nnueEngineFiles: () => ({ files: defaultFilesFor("nnue"), templateVersion: TEMPLATE_VERSION }),
    locks: createWebRunLocks(),
    notify: {
      toast: (message, opts) => {
        toast(message, opts);
      },
      setActivity: (a) => setActivity(a),
      clearActivity: (id) => clearActivity(id),
    },
    whenReady: () => whenSeeded(),
    newId,
    timing: {
      checkpointPersistMs: CHECKPOINT_PERSIST_MS,
      checkpointEverySteps: CHECKPOINT_EVERY_STEPS,
      runFlushMs: RUN_FLUSH_MS,
      pointIntervalMs: POINT_INTERVAL_MS,
      liveThrottleMs: LIVE_THROTTLE_MS,
      datasetWriter: { partialFlushMs: DATASET_PARTIAL_FLUSH_MS, recordUpdateMs: DATASET_UPDATE_MS },
    },
  };
}
