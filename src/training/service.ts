// The Lab service: the training-run registry of this tab (TrainingService), plus the dataset and
// network services, built over injectable dependencies (see deps.ts; defaults.ts wires the app).
import type { TrainingLogEntry, TrainingRunConfig, TrainingRunRecord } from "@/types";
import { MAX_RUN_LOG, bestDataId, checkpointDataId } from "./constants";
import { GenerationRegistry, createDatasetService } from "./datasets";
import type { LockHandle, ServiceDeps } from "./deps";
import { createNetworkService } from "./networks";
import { ACTIVE_STATUSES, RunController } from "./run-controller";
import type { DatasetService, NetworkService, TrainingService } from "./types";
import { estimateRun, validateRunConfig, type ValidationSources } from "./validate";

interface ActiveEntry {
  starting: Promise<void>;
  controller: RunController | null;
}

export interface LabService {
  training: TrainingService;
  datasets: DatasetService;
  networks: NetworkService;
  /** Start-up: resume or mark interrupted runs (idempotent). Resolves when done. */
  init(): Promise<void>;
  /** Writes pending run state and buffered self-play games now (the page is being hidden). */
  persistAll(): Promise<void>;
}

function logEntry(level: TrainingLogEntry["level"], message: string): TrainingLogEntry {
  return { t: Date.now(), level, message };
}

function appendLog(log: TrainingLogEntry[], entry: TrainingLogEntry): TrainingLogEntry[] {
  const next = [...log, entry];
  return next.length > MAX_RUN_LOG ? next.slice(next.length - MAX_RUN_LOG) : next;
}

/** Datasets / networks a run reads or writes. */
function runDatasets(run: TrainingRunRecord): Set<string> {
  return new Set([...(run.config.data?.datasetIds ?? []), ...(run.datasetIds ?? [])]);
}

function runNetworks(run: TrainingRunRecord): Set<string> {
  const ids = new Set<string>();
  const n = run.config.network;
  if (n && n.mode !== "new") ids.add(n.networkId);
  for (const e of run.networkHistory ?? []) ids.add(e.networkId);
  if (run.networkId) ids.add(run.networkId);
  return ids;
}

export function createLabService(deps: ServiceDeps): LabService {
  const active = new Map<string, ActiveEntry>();
  const registry = new GenerationRegistry();
  let initPromise: Promise<void> | null = null;

  /** Runs executing here, or (by their status) in another tab that holds their lock. */
  async function activeRuns(): Promise<TrainingRunRecord[]> {
    const out: TrainingRunRecord[] = [];
    const seen = new Set<string>();
    for (const [id, entry] of active) {
      seen.add(id);
      const rec = entry.controller?.snapshot() ?? (await deps.runs.get(id));
      if (rec) out.push(rec);
    }
    for (const run of await deps.runs.list()) {
      if (seen.has(run.id) || !ACTIVE_STATUSES.has(run.status)) continue;
      // A stale status (its tab was closed) does not block anything; unknown lock state counts as active.
      if ((await deps.locks.isHeld(run.id)) !== false) out.push(run);
    }
    return out;
  }

  async function datasetUser(datasetId: string): Promise<string | null> {
    for (const run of await activeRuns()) if (runDatasets(run).has(datasetId)) return run.config.name;
    return null;
  }

  async function networkUser(networkId: string): Promise<string | null> {
    for (const run of await activeRuns()) if (runNetworks(run).has(networkId)) return run.config.name;
    return null;
  }

  const networks = createNetworkService(deps, { usedByActiveRun: networkUser });
  const datasets = createDatasetService(deps, registry, { usedByActiveRun: datasetUser });

  const sources: ValidationSources = {
    network: (id) => deps.networks.get(id),
    networkHasData: async (id) => {
      const d = await deps.networks.getData(id);
      return !!d && !!d.quantized && d.quantized.byteLength > 0;
    },
    dataset: (id) => deps.datasets.get(id),
    engine: (id) => deps.engines.get(id),
  };

  /** Starts a controller for a run whose lock this tab holds. */
  function launch(runId: string, record: TrainingRunRecord, lock: LockHandle, entry: ActiveEntry): void {
    const controller = new RunController(
      {
        deps,
        registry,
        networks,
        onExit: () => {
          if (active.get(runId) === entry) active.delete(runId);
          lock.release();
        },
      },
      record,
    );
    entry.controller = controller;
    void controller.run();
  }

  async function startRun(runId: string, opts: { lock?: LockHandle } = {}): Promise<void> {
    const existing = active.get(runId);
    if (existing) return existing.starting;
    const entry: ActiveEntry = { starting: Promise.resolve(), controller: null };
    active.set(runId, entry);
    entry.starting = (async () => {
      let lock: LockHandle | null = opts.lock ?? null;
      try {
        const before = await deps.runs.get(runId);
        if (!before) throw new Error("This training run no longer exists.");
        if (before.status === "finished") throw new Error("This run has already finished. Start a new run to keep training its network.");
        lock ??= await deps.locks.acquire(runId);
        if (!lock) throw new Error("This run is already running in another tab.");
        // Re-read under the lock: another tab may have changed it meanwhile.
        const record = await deps.runs.get(runId);
        if (!record) throw new Error("This training run no longer exists.");
        if (record.status === "finished") throw new Error("This run has already finished.");
        launch(runId, record, lock, entry);
      } catch (err) {
        lock?.release();
        if (active.get(runId) === entry) active.delete(runId);
        throw err;
      }
    })();
    return entry.starting;
  }

  /** Changes the status of a run that is not executing here (under its lock). */
  async function setIdleStatus(runId: string, status: "paused" | "stopped", message: string): Promise<void> {
    const rec = await deps.runs.get(runId);
    if (!rec) throw new Error("This training run no longer exists.");
    const changeable = status === "paused" ? ACTIVE_STATUSES.has(rec.status) : rec.status !== "finished" && rec.status !== "stopped";
    if (!changeable) return;
    const lock = await deps.locks.acquire(runId);
    if (!lock) throw new Error(`This run is running in another tab; ${status === "paused" ? "pause" : "stop"} it there.`);
    try {
      let fresh = await deps.runs.get(runId);
      if (!fresh) return;
      if (status === "stopped") {
        // Keep the best network trained so far, as a stop during training does.
        const controller = new RunController({ deps, registry, networks, onExit: () => undefined }, fresh);
        await controller.saveIdleStopSnapshot();
        fresh = await deps.runs.get(runId);
        if (!fresh) return;
      }
      await deps.runs.update(runId, {
        status,
        progress: { ...fresh.progress, phase: status },
        log: appendLog(fresh.log ?? [], logEntry("info", message)),
      });
    } finally {
      lock.release();
    }
  }

  /** Waits for a run executing here to pause / stop. */
  async function stopActive(runId: string, mode: "pause" | "stop"): Promise<boolean> {
    const entry = active.get(runId);
    if (!entry) return false;
    try {
      await entry.starting;
    } catch {
      return true; // it never started
    }
    if (entry.controller) await entry.controller.requestStop(mode);
    return true;
  }

  const training: TrainingService = {
    async createRun(config: TrainingRunConfig, opts = {}) {
      const problems = await validateRunConfig(config, sources);
      if (problems.length > 0) throw new Error(problems.join(" "));
      const now = Date.now();
      const copy = structuredClone(config);
      copy.name = copy.name.trim();
      const record: TrainingRunRecord = {
        id: deps.newId(),
        createdAt: now,
        updatedAt: now,
        config: copy,
        status: "queued",
        autoResume: opts.autoResume ?? true,
        cycle: 0,
        progress: { phase: "queued", done: 0, total: 0 },
        networkId: null,
        engineId: null,
        networkHistory: [],
        datasetIds: [...new Set(copy.data.datasetIds)],
        points: [],
        log: [logEntry("info", "Run created.")],
        error: null,
        resume: null,
      };
      await deps.runs.put(record);
      if (opts.start !== false) await startRun(record.id);
      return record.id;
    },

    start: (runId) => startRun(runId),

    async pause(runId) {
      if (await stopActive(runId, "pause")) return;
      await setIdleStatus(runId, "paused", "Paused.");
    },

    async stop(runId) {
      if (await stopActive(runId, "stop")) return;
      await setIdleStatus(runId, "stopped", "Stopped.");
    },

    async deleteRun(runId, opts = {}) {
      let lock: LockHandle | null = null;
      if (!(await stopActive(runId, "pause"))) {
        lock = await deps.locks.acquire(runId);
        if (!lock) throw new Error("This run is running in another tab. Stop it there before deleting it.");
      }
      try {
        const rec = await deps.runs.get(runId);
        if (!rec) return;
        await deps.networks.remove(checkpointDataId(runId));
        await deps.networks.remove(bestDataId(runId));
        const others = (await activeRuns()).filter((r) => r.id !== runId);
        if (opts.deleteNetworks) {
          const source = rec.config.network.mode === "new" ? null : rec.config.network.networkId;
          const inUse = new Set(others.flatMap((r) => [...runNetworks(r)]));
          for (const id of new Set(rec.networkHistory.map((e) => e.networkId))) {
            if (id !== source && !inUse.has(id)) await deps.networks.remove(id);
          }
        }
        if (opts.deleteDatasets) {
          const configured = new Set(rec.config.data.datasetIds);
          const inUse = new Set(others.flatMap((r) => [...runDatasets(r)]));
          for (const id of rec.datasetIds) {
            if (!configured.has(id) && !inUse.has(id) && !registry.isGenerating(id)) await deps.datasets.remove(id);
          }
        }
        await deps.runs.remove(runId);
      } finally {
        lock?.release();
      }
    },

    async setAutoResume(runId, on) {
      await deps.runs.update(runId, { autoResume: on });
    },

    isActive: (runId) => active.has(runId),

    activeRunIds: () => [...active.keys()],

    validateConfig: (config) => validateRunConfig(config, sources),

    estimate: (config) => estimateRun(config, sources),
  };

  async function initOnce(): Promise<void> {
    await deps.whenReady();
    let runs: TrainingRunRecord[];
    try {
      runs = await deps.runs.list();
    } catch (err) {
      console.error("[training] could not read the training runs", err);
      return;
    }
    for (const run of runs) {
      if (!ACTIVE_STATUSES.has(run.status) || active.has(run.id)) continue;
      try {
        const lock = await deps.locks.acquire(run.id);
        if (!lock) continue; // another tab is running it
        const fresh = await deps.runs.get(run.id);
        if (!fresh || !ACTIVE_STATUSES.has(fresh.status)) {
          lock.release();
          continue;
        }
        if (fresh.autoResume) {
          await deps.runs.update(run.id, { log: appendLog(fresh.log ?? [], logEntry("info", "Interrupted when the tab was closed; resuming automatically.")) });
          await startRun(run.id, { lock });
          deps.notify.toast(`Resumed the training run "${fresh.config.name}"`, { kind: "info" });
        } else {
          try {
            await deps.runs.update(run.id, {
              status: "paused",
              progress: { ...fresh.progress, phase: "paused" },
              log: appendLog(fresh.log ?? [], logEntry("warn", "Interrupted when the tab was closed")),
            });
          } finally {
            lock.release();
          }
        }
      } catch (err) {
        console.error(`[training] could not recover the run "${run.config?.name ?? run.id}"`, err);
      }
    }
  }

  return {
    training,
    datasets,
    networks,
    init() {
      initPromise ??= initOnce();
      return initPromise;
    },
    async persistAll() {
      await Promise.all([...[...active.values()].map((e) => e.controller?.persistNow()), registry.persistAll()]);
    },
  };
}
