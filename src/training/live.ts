// Live state of the work executing in this tab, for React: zustand stores keyed by run id
// (LiveRunState) and dataset id (DatasetJobState). Services publish through Throttled so the UI
// re-renders at most ~4 times per second however often progress arrives.
import { create } from "zustand";
import { LIVE_THROTTLE_MS } from "./constants";
import type { DatasetJobState, LiveRunState, SelfPlayProgress } from "./types";

interface RunStore {
  runs: Record<string, LiveRunState>;
  /** Ids of the runs executing in this tab (a stable array: replaced only when the set changes). */
  activeIds: string[];
}

interface DatasetJobStore {
  jobs: Record<string, DatasetJobState>;
}

export const useLiveRunStore = create<RunStore>(() => ({ runs: {}, activeIds: [] }));
export const useDatasetJobStore = create<DatasetJobStore>(() => ({ jobs: {} }));

export function setLiveRun(state: LiveRunState): void {
  useLiveRunStore.setState((s) => {
    const known = s.activeIds.includes(state.runId);
    return { runs: { ...s.runs, [state.runId]: state }, activeIds: known ? s.activeIds : [...s.activeIds, state.runId] };
  });
}

export function clearLiveRun(runId: string): void {
  useLiveRunStore.setState((s) => {
    if (!(runId in s.runs) && !s.activeIds.includes(runId)) return s;
    const runs = { ...s.runs };
    delete runs[runId];
    return { runs, activeIds: s.activeIds.filter((id) => id !== runId) };
  });
}

export function getLiveRun(runId: string): LiveRunState | null {
  return useLiveRunStore.getState().runs[runId] ?? null;
}

export function setDatasetJob(state: DatasetJobState): void {
  useDatasetJobStore.setState((s) => ({ jobs: { ...s.jobs, [state.datasetId]: state } }));
}

export function getDatasetJob(datasetId: string): DatasetJobState | null {
  return useDatasetJobStore.getState().jobs[datasetId] ?? null;
}

export function clearDatasetJob(datasetId: string): void {
  useDatasetJobStore.setState((s) => {
    if (!(datasetId in s.jobs)) return s;
    const jobs = { ...s.jobs };
    delete jobs[datasetId];
    return { jobs };
  });
}

/** Live state of a run executing in this tab; null otherwise (then read the stored record). */
export function useLiveRun(runId: string | null | undefined): LiveRunState | null {
  return useLiveRunStore((s) => (runId ? (s.runs[runId] ?? null) : null));
}

/** Runs executing in this tab (re-renders only when the set changes). */
export function useActiveRunIds(): string[] {
  return useLiveRunStore((s) => s.activeIds);
}

/** Live state of a dataset generation job of this tab (kept after it ends, until reload). */
export function useDatasetJob(datasetId: string | null | undefined): DatasetJobState | null {
  return useDatasetJobStore((s) => (datasetId ? (s.jobs[datasetId] ?? null) : null));
}

export function emptySelfPlayProgress(gamesTotal: number | null, workers = 0): SelfPlayProgress {
  return { gamesDone: 0, gamesTotal, positions: 0, posPerSec: 0, workers, boards: [], results: { white: 0, draw: 0, black: 0 }, avgPlies: 0 };
}

/**
 * Coalesces frequent updates: `schedule()` runs `publish` at most once per `intervalMs`
 * (trailing), `now()` runs it immediately. Timers are cleared by `cancel()`.
 */
export class Throttled {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;

  constructor(
    private readonly publish: () => void,
    private readonly intervalMs: number = LIVE_THROTTLE_MS,
  ) {}

  schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.intervalMs - Date.now());
    this.timer = setTimeout(() => this.now(), wait);
  }

  now(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.last = Date.now();
    try {
      this.publish();
    } catch (err) {
      console.error("[training] live update failed", err);
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Positions-per-second over a sliding window (default 20 s), robust to bursty arrivals
 * (positions arrive one game at a time).
 */
export class RateMeter {
  private samples: Array<{ t: number; total: number }> = [];

  constructor(private readonly windowMs = 20_000) {}

  /** Records the running total at time `t`. */
  add(t: number, total: number): void {
    this.samples.push({ t, total });
    const cutoff = t - this.windowMs;
    while (this.samples.length > 2 && (this.samples[1] as { t: number }).t <= cutoff) this.samples.shift();
  }

  /** Rate between the oldest sample in the window and `t` (0 with fewer than two samples). */
  rate(t: number, total: number): number {
    const first = this.samples[0];
    if (!first || t <= first.t) return 0;
    return ((total - first.total) * 1000) / (t - first.t);
  }

  reset(t: number, total: number): void {
    this.samples = [{ t, total }];
  }
}
