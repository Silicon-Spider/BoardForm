// DatasetService: self-play generation jobs, import / export, merge, samples, removal.
import type { DatasetRecord, SelfPlayConfig } from "@/types";
import { PACKED_SIZE, packedScore, packedToFen, type PackedResult } from "@/nnue/pack";
import { formatCount } from "@/utils/format";
import { DatasetWriter } from "./dataset-writer";
import { cbdsHeader, describeSkipped, readDatasetFile } from "./dataset-files";
import { datasetLockKey } from "./constants";
import type { LockHandle, ServiceDeps } from "./deps";
import { Throttled, emptySelfPlayProgress, getDatasetJob, setDatasetJob, clearDatasetJob } from "./live";
import { baseName } from "./networks";
import { describeEngineLimits } from "./scores";
import { NETWORK_ENGINE_ID, resolveSelfPlayEngine, runSelfPlayJob } from "./selfplay-job";
import type { DatasetJobState, DatasetSample, DatasetService, GenerateDatasetOptions, SelfPlayProgress } from "./types";

/** A job writing a dataset: stop() ends it, persist() stores what it has buffered so far. */
export interface GenerationJob {
  stop(): Promise<void>;
  persist?(): Promise<void>;
}

/** Datasets being written by a job of this tab (generation jobs and the self-play of runs). */
export class GenerationRegistry {
  private readonly jobs = new Map<string, GenerationJob>();

  isGenerating(datasetId: string): boolean {
    return this.jobs.has(datasetId);
  }

  add(datasetId: string, job: GenerationJob): void {
    this.jobs.set(datasetId, job);
  }

  /** Stores every job's buffered positions now (the page is being hidden and may be closed). */
  async persistAll(): Promise<void> {
    await Promise.all(
      [...this.jobs.values()].map((j) => j.persist?.().catch((e: unknown) => console.warn("[training] could not save a dataset's latest games", e))),
    );
  }

  delete(datasetId: string): void {
    this.jobs.delete(datasetId);
  }

  stop(datasetId: string): Promise<void> {
    return this.jobs.get(datasetId)?.stop() ?? Promise.resolve();
  }
}

export interface DatasetServiceHooks {
  /** Name of an active training run that uses the dataset, or null. */
  usedByActiveRun(datasetId: string): Promise<string | null>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Checks a self-play configuration; returns the first problem or null. */
export function selfPlayProblem(sp: SelfPlayConfig | null | undefined): string | null {
  if (!sp) return "Self-play settings are missing.";
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  if (!sp.engineId) return "Choose the engine that plays the games.";
  if (!isInt(sp.games) || sp.games < 1) return "Play at least 1 game.";
  if (!isInt(sp.concurrency) || sp.concurrency < 1) return "Use at least 1 worker.";
  if (!isInt(sp.randomPlies) || sp.randomPlies < 0 || sp.randomPlies > 60) return "Random opening plies must be between 0 and 60.";
  if (!isInt(sp.maxPlies) || sp.maxPlies <= sp.randomPlies || sp.maxPlies < 10) return "The maximum game length must be at least 10 plies and longer than the random opening.";
  if (!isInt(sp.skipPlies) || sp.skipPlies < 0) return "Skipped plies must be 0 or more.";
  return null;
}

export function createDatasetService(deps: ServiceDeps, registry: GenerationRegistry, hooks: DatasetServiceHooks): DatasetService {
  /** Runs one generation job in the background (never rejects). Releases `lock` at the end. */
  async function runGeneration(
    dataset: DatasetRecord,
    opts: GenerateDatasetOptions,
    controller: AbortController,
    lock: LockHandle,
    handle: { writer: DatasetWriter | null },
  ): Promise<void> {
    const id = dataset.id;
    const sp = opts.selfPlay;
    const activityId = `dataset:${id}`;
    const href = `/lab/datasets/${id}`;
    let state: DatasetJobState = { datasetId: id, status: "running", progress: emptySelfPlayProgress(sp.games), error: null };
    const live = new Throttled(() => setDatasetJob(state), deps.timing.liveThrottleMs);
    const activity = () => {
      const p = state.progress;
      // Until the workers report ready the engine is being built / instantiated (can take a while
      // the first time an engine is used).
      const starting = p.workers === 0 && p.gamesDone === 0;
      deps.notify.setActivity({
        id: activityId,
        kind: "selfplay",
        label: dataset.name,
        detail: starting ? "Preparing the engine…" : `${p.gamesDone}/${p.gamesTotal ?? "∞"} games · ${formatCount(p.positions)} positions`,
        progress: p.gamesTotal ? Math.min(1, p.gamesDone / p.gamesTotal) : null,
        href,
      });
    };
    const update = (progress: SelfPlayProgress) => {
      state = { ...state, progress };
      live.schedule();
    };
    setDatasetJob(state);
    activity();
    const activityTimer = setInterval(activity, 1000);
    let writer: DatasetWriter | null = null;
    try {
      const engine = await resolveSelfPlayEngine(deps, sp.engineId, opts.networkId ?? null);
      if (controller.signal.aborted) {
        state = { ...state, status: "stopped" };
        return;
      }
      writer = await DatasetWriter.open(deps.datasets, id, deps.timing.datasetWriter);
      handle.writer = writer;
      const workers = Math.max(1, Math.min(sp.concurrency, await deps.maxWorkers()));
      const summary = await runSelfPlayJob({
        source: deps.selfPlay,
        writer,
        engine,
        config: sp,
        games: sp.games,
        concurrency: workers,
        seed: Math.floor(Math.random() * 2 ** 31),
        // Appending: continue the game numbering so openings differ from the earlier games.
        firstGameIndex: opts.appendTo ? dataset.games : 0,
        offset: { games: 0, positions: 0, total: sp.games },
        signal: controller.signal,
        onProgress: update,
        onLog: (level, message) => {
          if (level === "warn") console.warn(`[training] ${dataset.name}: ${message}`);
        },
      });
      await writer.close();
      writer = null;
      handle.writer = null;
      state = { ...state, status: summary.stopped ? "stopped" : "finished" };
      const stored = await deps.datasets.get(id);
      deps.notify.toast(summary.stopped ? `Stopped generating "${dataset.name}"` : `Dataset "${dataset.name}" is ready`, {
        kind: summary.stopped ? "info" : "success",
        detail: `${formatCount(summary.positions)} new positions from ${summary.games} games${stored ? ` (${formatCount(stored.positions)} in total)` : ""}.`,
      });
    } catch (err) {
      const message = messageOf(err);
      // Keep what was generated before the failure.
      if (writer) await writer.close().catch(() => writer?.dispose());
      state = { ...state, status: "error", error: message };
      deps.notify.toast(`Generating "${dataset.name}" failed`, { kind: "error", detail: message });
    } finally {
      handle.writer = null;
      clearInterval(activityTimer);
      live.cancel();
      state = { ...state, progress: { ...state.progress, workers: 0, boards: [] } };
      setDatasetJob(state);
      registry.delete(id);
      lock.release();
      deps.notify.clearActivity(activityId);
    }
  }

  return {
    async generate(opts) {
      const problem = selfPlayProblem(opts.selfPlay);
      if (problem) throw new Error(problem);
      const sp: SelfPlayConfig = { ...opts.selfPlay, limits: { ...opts.selfPlay.limits } };
      // Check the engine / network now so mistakes are reported to the caller, not as a toast.
      let engineName: string;
      let networkId: string | null = null;
      if (sp.engineId === NETWORK_ENGINE_ID) {
        if (!opts.networkId) throw new Error("Choose the network the stock NNUE engine should play with.");
        const net = await deps.networks.get(opts.networkId);
        if (!net) throw new Error("The chosen network no longer exists.");
        engineName = `NNUE engine (${net.name})`;
        networkId = net.id;
      } else {
        const engine = await deps.engines.get(sp.engineId);
        if (!engine) throw new Error("The chosen engine no longer exists.");
        engineName = engine.name;
        networkId = engine.networkId ?? null;
      }

      let dataset: DatasetRecord;
      let lock: LockHandle | null = null;
      if (opts.appendTo) {
        const existing = await deps.datasets.get(opts.appendTo);
        if (!existing) throw new Error("The dataset to add games to no longer exists.");
        if (registry.isGenerating(existing.id)) throw new Error(`"${existing.name}" is already being generated.`);
        // One writer per dataset, also across tabs (two writers would overwrite each other's chunks).
        lock = await deps.locks.acquire(datasetLockKey(existing.id));
        if (!lock) throw new Error(`"${existing.name}" is being generated in another tab.`);
        dataset = existing;
      } else {
        const name = (opts.name ?? "").trim();
        if (!name) throw new Error("Give the dataset a name.");
        const now = Date.now();
        dataset = {
          id: deps.newId(),
          name,
          description: opts.description?.trim() || `Self-play by ${engineName}, ${describeEngineLimits(sp.limits)} per move, ${sp.randomPlies} random opening plies.`,
          createdAt: now,
          updatedAt: now,
          positions: 0,
          games: 0,
          chunks: 0,
          source: {
            kind: "selfplay",
            engineId: sp.engineId === NETWORK_ENGINE_ID ? null : sp.engineId,
            engineName,
            networkId,
            limits: { ...sp.limits },
            randomPlies: sp.randomPlies,
          },
        };
        await deps.datasets.put(dataset);
        lock = (await deps.locks.acquire(datasetLockKey(dataset.id))) ?? { release() {} };
      }
      const controller = new AbortController();
      const handle: { writer: DatasetWriter | null } = { writer: null };
      let done: Promise<void> = Promise.resolve();
      registry.add(dataset.id, {
        stop: async () => {
          controller.abort();
          await done;
        },
        persist: () => handle.writer?.persistNow() ?? Promise.resolve(),
      });
      done = runGeneration(dataset, { ...opts, selfPlay: sp }, controller, lock, handle);
      return dataset.id;
    },

    stop(datasetId) {
      return registry.stop(datasetId);
    },

    isGenerating(datasetId) {
      return registry.isGenerating(datasetId);
    },

    async importFile(file, opts = {}) {
      const name = (opts.name ?? "").trim() || baseName(file, "Imported dataset");
      const fileName = (file as Partial<File>).name ?? "a file";
      const id = deps.newId();
      const now = Date.now();
      await deps.datasets.put({
        id,
        name,
        description: `Imported from ${fileName}.`,
        createdAt: now,
        updatedAt: now,
        positions: 0,
        games: 0,
        chunks: 0,
        source: { kind: "import" },
      });
      let writer: DatasetWriter | null = null;
      try {
        writer = await DatasetWriter.open(deps.datasets, id, deps.timing.datasetWriter);
        const w = writer;
        const report = await readDatasetFile(file, (data, count) => w.add(data, count, 0));
        await writer.close();
        writer = null;
        if (report.positions === 0) {
          throw new Error(
            report.format === "text"
              ? `No positions found. Use a .cbds file or text lines like "<FEN> | <score> | <result>".${report.problems.length ? ` First problem: ${report.problems[0]}.` : ""}`
              : "The file contains no valid positions.",
          );
        }
        const skipped = describeSkipped(report);
        await deps.datasets.update(id, {
          description: `Imported from ${fileName} (${report.format === "cbds" ? ".cbds" : "text"}): ${report.positions.toLocaleString("en-US")} positions.${skipped ? ` ${skipped}` : ""}`,
        });
        if (skipped) deps.notify.toast(`Imported "${name}" with problems`, { kind: "warn", detail: skipped });
        return id;
      } catch (err) {
        writer?.dispose();
        await deps.datasets.remove(id).catch(() => undefined);
        throw err instanceof Error ? err : new Error(messageOf(err));
      }
    },

    async exportFile(datasetId) {
      const record = await deps.datasets.get(datasetId);
      if (!record) throw new Error("The dataset no longer exists.");
      const parts: ArrayBuffer[] = [];
      let count = 0;
      for await (const chunk of deps.datasets.iterateChunks(datasetId)) {
        const n = Math.min(chunk.count, Math.floor(chunk.data.byteLength / PACKED_SIZE));
        if (n <= 0) continue;
        parts.push(n * PACKED_SIZE === chunk.data.byteLength ? chunk.data : chunk.data.slice(0, n * PACKED_SIZE));
        count += n;
      }
      return new Blob([cbdsHeader(count), ...parts], { type: "application/octet-stream" });
    },

    async merge(ids, name) {
      const trimmed = (name ?? "").trim();
      if (!trimmed) throw new Error("Give the merged dataset a name.");
      const unique = [...new Set(ids)];
      if (unique.length < 1) throw new Error("Choose the datasets to merge.");
      const sources: DatasetRecord[] = [];
      for (const id of unique) {
        const ds = await deps.datasets.get(id);
        if (!ds) throw new Error("One of the datasets to merge no longer exists.");
        sources.push(ds);
      }
      const id = deps.newId();
      const now = Date.now();
      await deps.datasets.put({
        id,
        name: trimmed,
        description: `Merged from ${sources.map((s) => `"${s.name}"`).join(", ")}.`,
        createdAt: now,
        updatedAt: now,
        positions: 0,
        games: 0,
        chunks: 0,
        source: { kind: "merge" },
      });
      let writer: DatasetWriter | null = null;
      try {
        writer = await DatasetWriter.open(deps.datasets, id, deps.timing.datasetWriter);
        for (const src of sources) {
          for await (const chunk of deps.datasets.iterateChunks(src.id)) {
            const n = Math.min(chunk.count, Math.floor(chunk.data.byteLength / PACKED_SIZE));
            if (n > 0) await writer.add(new Uint8Array(chunk.data, 0, n * PACKED_SIZE), n, 0);
          }
        }
        await writer.close();
        writer = null;
        await deps.datasets.update(id, { games: sources.reduce((s, d) => s + d.games, 0) });
        return id;
      } catch (err) {
        writer?.dispose();
        await deps.datasets.remove(id).catch(() => undefined);
        throw err instanceof Error ? err : new Error(messageOf(err));
      }
    },

    async samplePositions(datasetId, count) {
      const want = Math.max(0, Math.floor(count));
      if (want === 0) return [];
      const chunks = await deps.datasets.chunkCount(datasetId);
      if (chunks === 0) return [];
      // Read a few random chunks (more when they hold too few positions) and pick random positions
      // from them: uniform enough for previews without reading the whole dataset.
      const order = Array.from({ length: chunks }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j] as number, order[i] as number];
      }
      const minChunks = Math.min(chunks, Math.max(1, Math.ceil(want / 64)), 8);
      const pool: Array<{ data: Uint8Array; count: number }> = [];
      let total = 0;
      for (const index of order) {
        if (pool.length >= minChunks && total >= want) break;
        const chunk = await deps.datasets.getChunk(datasetId, index);
        if (!chunk) continue;
        const n = Math.min(chunk.count, Math.floor(chunk.data.byteLength / PACKED_SIZE));
        if (n <= 0) continue;
        pool.push({ data: new Uint8Array(chunk.data), count: n });
        total += n;
      }
      if (total === 0) return [];
      const chosen = new Set<number>();
      const target = Math.min(want, total);
      while (chosen.size < target) chosen.add(Math.floor(Math.random() * total));
      const out: DatasetSample[] = [];
      for (let global of [...chosen].sort((a, b) => a - b)) {
        let c = 0;
        while (global >= (pool[c] as { count: number }).count) global -= (pool[c++] as { count: number }).count;
        const { data } = pool[c] as { data: Uint8Array };
        const off = global * PACKED_SIZE;
        try {
          out.push({ fen: packedToFen(data, off), scoreWhite: packedScore(data, off), result: data[off + 26] as PackedResult });
        } catch {
          // corrupt record: skip it
        }
      }
      return out;
    },

    async remove(datasetId) {
      if (registry.isGenerating(datasetId)) throw new Error("This dataset is still being generated. Stop the generation first.");
      if ((await deps.locks.isHeld(datasetLockKey(datasetId))) === true) {
        throw new Error("This dataset is being generated in another tab. Stop the generation there first.");
      }
      const run = await hooks.usedByActiveRun(datasetId);
      if (run) throw new Error(`The training run "${run}" is using this dataset. Pause or stop the run first.`);
      await deps.datasets.remove(datasetId);
      if (getDatasetJob(datasetId)) clearDatasetJob(datasetId);
    },
  };
}
