// Everything the Lab service needs from the rest of the app, as one injectable bundle. The app
// wires the real implementations in defaults.ts; tests pass fakes (fake-indexeddb repos, a fake
// self-play source, a scripted or in-process trainer, a lock manager, a recording notifier).
import type { EngineRecord, TrainingRunRecord } from "@/types";
import type { DatasetsRepo, NetworksRepo, Repo } from "@/storage/repos";
import type { TrainCheckpoint, TrainHandlers, TrainJob } from "@/nnue/protocol";
import type { DatasetWriterOptions } from "./dataset-writer";
import type { SelfPlaySource } from "./selfplay-pool";

/** Toasts and header activities (@/app/toast, @/app/activity in the app). */
export interface Notifier {
  toast(message: string, opts?: { kind?: "info" | "success" | "warn" | "error"; detail?: string }): void;
  setActivity(a: { id: string; kind: "training" | "selfplay"; label: string; detail?: string; progress?: number | null; href?: string }): void;
  clearActivity(id: string): void;
}

/** What the orchestrator needs from a trainer (TrainerClient in the app). */
export interface TrainerLike {
  /** Resolves with the final checkpoint (finished, or the stop checkpoint after stop()). */
  start(job: TrainJob, handlers?: TrainHandlers): Promise<TrainCheckpoint>;
  /** Graceful stop: start() resolves with the latest weights. */
  stop(): void;
  /** Kills the worker; start() rejects. */
  terminate(): void;
}

export interface EngineArtifacts {
  engine: EngineRecord;
  wasm: ArrayBuffer;
  network: ArrayBuffer | null;
}

export interface LockHandle {
  release(): void;
}

/** Cross-tab exclusivity (Web Locks in the app). Keys are run ids or datasetLockKey(datasetId). */
export interface RunLocks {
  /** Takes the lock if no tab holds it; null = another tab (or this one) holds it. */
  acquire(key: string): Promise<LockHandle | null>;
  /** True when some tab (not necessarily another one) holds the lock; null = unknown. */
  isHeld(key: string): Promise<boolean | null>;
}

export interface ServiceTiming {
  /** Minimum interval between checkpoint writes (epoch ends are always written). */
  checkpointPersistMs: number;
  /** Trainer checkpoint rhythm in optimizer steps. */
  checkpointEverySteps: number;
  /** Minimum interval between run record writes while a run executes. */
  runFlushMs: number;
  /** Minimum interval between stored training points. */
  pointIntervalMs: number;
  /** Live state throttle. */
  liveThrottleMs: number;
  datasetWriter: DatasetWriterOptions;
}

export interface ServiceDeps {
  runs: Repo<TrainingRunRecord>;
  networks: NetworksRepo;
  datasets: DatasetsRepo;
  engines: Repo<EngineRecord>;
  selfPlay: SelfPlaySource;
  createTrainer(): TrainerLike;
  /** The stock NNUE engine module (template + eval-nnue.ts). */
  stockNnueWasm(): Promise<ArrayBuffer>;
  /** An engine's module (built if needed) and attached network. */
  engineArtifacts(engineId: string): Promise<EngineArtifacts>;
  /** Background-work budget (Settings): upper bound for workers and trainer threads. */
  maxWorkers(): Promise<number>;
  defaultHashMb(): Promise<number>;
  /** Engine source files and template version for new NNUE engines. */
  nnueEngineFiles(): { files: Record<string, string>; templateVersion: number };
  locks: RunLocks;
  notify: Notifier;
  /** Resolves once start-up seeding finished (whenSeeded in the app). */
  whenReady(): Promise<void>;
  newId(): string;
  timing: ServiceTiming;
}
