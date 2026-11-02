// Shared, self-refreshing query caches behind the React hooks in ./hooks.ts.
// React-free, so it is unit-tested in Node and could serve non-React code too.
//
// * One LiveQuery per key ("list:engines", "games:<matchId>:<limit>", "setting:<key>") no matter
//   how many components use it — they all share its single in-flight query and its data.
// * It loads when the first subscriber arrives, listens to change events for its store (this tab,
//   other tabs, workers) and re-queries after a burst of changes settles (debounce + max wait).
//   List caches re-read only the changed ids when few records changed.
// * Results are structurally shared with the previous data: unchanged records keep their object
//   identity, and an unchanged result keeps the previous array, so React skips re-rendering.
// * After the last subscriber leaves, the cache stays alive (and fresh) for `graceMs`, so
//   navigating between pages does not flash loading states; then it is dropped.
// * A failed query puts the cache in an "error" state (hooks throw it to the page's error boundary).
//   An errored cache with no subscribers is dropped, so a remount retries from scratch.

import type { GameRecord } from "@/types";
import type { StoreValue } from "./db";
import { deepEqual } from "./equal";
import { ALL_RECORDS, subscribe, type ChangeEvent } from "./events";
import {
  compareNewestUpdated,
  datasetsRepo,
  enginesRepo,
  gamesRepo,
  getManyById,
  getSettingRecord,
  matchesRepo,
  networksRepo,
  runsRepo,
  settingsRepo,
  type GamesListOptions,
} from "./repos";
import { whenSeeded } from "./seed";
import type { StoreName } from "./stores";

export type QueryState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly error: unknown };

/** Timing knobs (mutable for tests). */
export const cacheConfig = {
  /** Quiet time after the last change event before re-querying. */
  debounceMs: 30,
  /** Upper bound on how long a continuous stream of changes can postpone a re-query. */
  maxWaitMs: 250,
  /** How long an unused cache stays alive (and fresh) after its last subscriber left. */
  graceMs: 30_000,
  /** Up to this many changed ids are re-read individually; more triggers a full re-query. */
  maxPatchIds: 32,
  /** First retry delay after a failure while subscribers remain (doubles, capped at 30 s). */
  retryMs: 2_000,
};

export interface LiveQueryOptions<T> {
  /** Store whose change events invalidate this query. */
  store: StoreName;
  /** The full query. */
  load(): Promise<T>;
  /** Cheap update for a few changed record ids; resolve undefined to fall back to `load()`. */
  patch?(current: T, changedIds: readonly string[]): Promise<T | undefined>;
  /** Return false for events that cannot affect this query. */
  relevant?(event: ChangeEvent): boolean;
  /** Structural sharing: return `prev` (or parts of it) where `next` is equal. Default: deepEqual. */
  share?(prev: T, next: T): T;
}

type Timer = ReturnType<typeof setTimeout>;

const LOADING: QueryState<never> = Object.freeze({ status: "loading" });
const EMPTY_IDS: ReadonlySet<string> = new Set();

function unrefTimer(t: Timer): Timer {
  // Node (tests) would otherwise stay alive for long grace / retry timers. Browsers return numbers.
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}

interface Lifecycle<T> {
  dispose(q: LiveQuery<T>): void;
  revive(q: LiveQuery<T>): void;
}

export class LiveQuery<T> {
  /** Diagnostics: full loads and incremental patches performed so far. */
  readonly stats = { loads: 0, patches: 0 };

  private state: QueryState<T> = LOADING;
  private readonly listeners = new Set<() => void>();
  private stopEvents: (() => void) | null = null;
  private started = false;
  private disposed = false;

  private pendingFull = false;
  private readonly pendingIds = new Set<string>();
  private inFlightFull = false;
  private inFlightIds: ReadonlySet<string> = EMPTY_IDS;
  private running = false;
  /** Bumped by setLocal(); a query that started before an optimistic write is discarded. */
  private localVersion = 0;

  private timer: Timer | null = null;
  private burstStart = 0;
  private graceTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private retryDelay = 0;

  constructor(
    readonly key: string,
    private readonly opts: LiveQueryOptions<T>,
    private readonly lifecycle: Lifecycle<T>,
  ) {
    // Dropped again if nobody subscribes (e.g. a render that React never committed).
    this.armGrace();
  }

  /** Current state; the same object until something changes (useSyncExternalStore-safe). */
  getSnapshot = (): QueryState<T> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) this.revive();
    this.listeners.add(listener);
    this.clearGrace();
    this.start();
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      if (this.state.status === "error") this.dispose();
      else this.armGrace();
    };
  };

  /**
   * True while a refresh that may involve `id` is queued or running. Single-record hooks use this
   * to report "loading" rather than "missing" for a record that was just written.
   */
  isPending(id: string): boolean {
    return this.pendingFull || this.inFlightFull || this.pendingIds.has(id) || this.inFlightIds.has(id);
  }

  /** Optimistically replace the data (useSetting). Queries already in flight are discarded. */
  setLocal(data: T): void {
    this.localVersion++;
    this.setData(data);
  }

  /** Re-query soon (e.g. after a failed optimistic write). */
  invalidate(): void {
    if (!this.started || this.disposed) return;
    this.pendingFull = true;
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.clearGrace();
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.pendingFull = false;
    this.pendingIds.clear();
    this.lifecycle.dispose(this);
  }

  // --- internals -------------------------------------------------------------------------------

  private revive(): void {
    this.disposed = false;
    this.state = LOADING;
    this.retryDelay = 0;
    this.lifecycle.revive(this);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    // Listen before loading so changes committed during the first load are not missed.
    this.stopEvents = subscribe(this.opts.store, this.onChange);
    this.pendingFull = true;
    this.runFlush();
  }

  private onChange = (e: ChangeEvent): void => {
    if (this.opts.relevant && !this.opts.relevant(e)) return;
    if (e.id === ALL_RECORDS) this.pendingFull = true;
    else this.pendingIds.add(e.id);
    this.schedule();
    // Snapshots derived through isPending() may change now; plain snapshots are unaffected.
    this.notify();
  };

  private schedule(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (this.timer === null) this.burstStart = now;
    else clearTimeout(this.timer);
    const due = Math.min(now + cacheConfig.debounceMs, this.burstStart + cacheConfig.maxWaitMs);
    this.timer = setTimeout(this.onTimer, Math.max(0, due - now));
  }

  private onTimer = (): void => {
    this.timer = null;
    this.runFlush();
  };

  private runFlush(): void {
    if (this.running || this.disposed) return;
    if (!this.pendingFull && this.pendingIds.size === 0) return;
    this.running = true;
    void this.flush().finally(() => {
      this.running = false;
      this.clearInFlight();
      // Changes that arrived while we were querying.
      if (!this.disposed && (this.pendingFull || this.pendingIds.size > 0)) this.schedule();
    });
  }

  private async flush(): Promise<void> {
    const current = this.state.status === "ready" ? this.state.data : undefined;
    const ids = [...this.pendingIds];
    const full = this.pendingFull || current === undefined || !this.opts.patch || ids.length > cacheConfig.maxPatchIds;
    this.pendingFull = false;
    this.pendingIds.clear();
    this.inFlightFull = full;
    this.inFlightIds = new Set(ids);
    const version = this.localVersion;
    try {
      let next: T | undefined;
      if (!full && current !== undefined && this.opts.patch) {
        this.stats.patches++;
        next = await this.opts.patch(current, ids);
      }
      if (next === undefined) {
        this.stats.loads++;
        next = await this.opts.load();
      }
      if (this.disposed) return;
      if (version !== this.localVersion) {
        // An optimistic local write happened meanwhile; this result may predate it — read again.
        this.pendingFull = true;
        return;
      }
      this.retryDelay = 0;
      // Clear the in-flight markers before notifying, so isPending() is already false for the
      // records this refresh settled; and notify even when the data is unchanged, because
      // snapshots derived through isPending() (single-record hooks) still change.
      this.clearInFlight();
      if (!this.setData(next)) this.notify();
    } catch (error) {
      this.clearInFlight();
      if (!this.disposed) this.fail(error);
    }
  }

  private clearInFlight(): void {
    this.inFlightFull = false;
    this.inFlightIds = EMPTY_IDS;
  }

  private fail(error: unknown): void {
    console.error(`[storage] query "${this.key}" failed`, error);
    this.setState({ status: "error", error });
    if (this.listeners.size === 0) {
      this.dispose();
      return;
    }
    // Still subscribed (e.g. useSetting, which never throws): keep retrying with backoff.
    this.retryDelay = Math.min(this.retryDelay > 0 ? this.retryDelay * 2 : cacheConfig.retryMs, 30_000);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = unrefTimer(
      setTimeout(() => {
        this.retryTimer = null;
        this.pendingFull = true;
        this.runFlush();
      }, this.retryDelay),
    );
  }

  /** Apply new data; returns false (and notifies nobody) when it equals the current data. */
  private setData(next: T): boolean {
    if (this.state.status === "ready") {
      const prev = this.state.data;
      const shared = this.opts.share ? this.opts.share(prev, next) : deepEqual(prev, next) ? prev : next;
      if (shared === prev) return false; // unchanged: keep the snapshot (and every reference in it)
      this.setState({ status: "ready", data: shared });
    } else {
      this.setState({ status: "ready", data: next });
    }
    return true;
  }

  private setState(state: QueryState<T>): void {
    this.state = state;
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("[storage] query listener threw", err);
      }
    }
  }

  private armGrace(): void {
    this.clearGrace();
    this.graceTimer = unrefTimer(
      setTimeout(() => {
        this.graceTimer = null;
        if (this.listeners.size === 0) this.dispose();
      }, cacheConfig.graceMs),
    );
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Registry

const registry = new Map<string, LiveQuery<unknown>>();

export function getLiveQuery<T>(key: string, create: () => LiveQueryOptions<T>): LiveQuery<T> {
  const existing = registry.get(key);
  if (existing) return existing as unknown as LiveQuery<T>;
  const q = new LiveQuery<T>(key, create(), {
    dispose: (self) => {
      if (registry.get(key) === (self as unknown)) registry.delete(key);
    },
    revive: (self) => {
      if (!registry.has(key)) registry.set(key, self as unknown as LiveQuery<unknown>);
    },
  });
  registry.set(key, q as unknown as LiveQuery<unknown>);
  return q;
}

/** The live query for `key` if one exists (does not create it). */
export function peekLiveQuery<T>(key: string): LiveQuery<T> | undefined {
  return registry.get(key) as unknown as LiveQuery<T> | undefined;
}

/** Drop every cache (tests). */
export function resetLiveQueries(): void {
  for (const q of [...registry.values()]) q.dispose();
  registry.clear();
}

// ---------------------------------------------------------------------------------------------
// Structural sharing

/** Reuse records of `prev` that are deep-equal to their counterpart (by id) in `next`; reuse `prev` itself if nothing changed. */
export function shareById<R extends { id: string }>(prev: R[], next: R[]): R[] {
  const prevById = new Map<string, R>();
  for (const r of prev) prevById.set(r.id, r);
  let same = prev.length === next.length;
  const out = next.map((r, i) => {
    const old = prevById.get(r.id);
    const v = old !== undefined && deepEqual(old, r) ? old : r;
    if (same && prev[i] !== v) same = false;
    return v;
  });
  return same ? prev : out;
}

// ---------------------------------------------------------------------------------------------
// The queries used by the hooks

export type ListStore = "engines" | "networks" | "datasets" | "matches" | "trainingRuns";

const listLoaders: { [S in ListStore]: () => Promise<Array<StoreValue<S>>> } = {
  // Wait for a first-run seeding in progress, so the library never flashes its empty state.
  engines: async () => {
    await whenSeeded();
    return enginesRepo.list();
  },
  networks: () => networksRepo.list(),
  datasets: () => datasetsRepo.list(),
  matches: () => matchesRepo.list(),
  trainingRuns: () => runsRepo.list(),
};

/** Every record of a store, newest-updated first (same order as the repo's list()). */
export function listQuery<S extends ListStore>(store: S): LiveQuery<Array<StoreValue<S>>> {
  type R = StoreValue<S>;
  return getLiveQuery<R[]>(`list:${store}`, () => ({
    store,
    load: listLoaders[store],
    async patch(current, ids) {
      const fetched = await getManyById(store, ids);
      const byId = new Map<string, R>();
      for (const r of current) byId.set(r.id, r);
      ids.forEach((id, i) => {
        const r = fetched[i];
        if (r === undefined) byId.delete(id);
        else byId.set(id, r);
      });
      return [...byId.values()].sort(compareNewestUpdated);
    },
    share: shareById,
  }));
}

export function gamesQueryKey(opts: GamesListOptions = {}): string {
  const matchId = typeof opts.matchId === "string" ? JSON.stringify(opts.matchId) : "*";
  return `games:${matchId}:${opts.limit ?? ""}`;
}

/** Games newest first, optionally of one match and/or limited (same semantics as gamesRepo.list). */
export function gamesQuery(opts: GamesListOptions = {}): LiveQuery<GameRecord[]> {
  const matchId = typeof opts.matchId === "string" ? opts.matchId : undefined;
  const limit = opts.limit;
  return getLiveQuery<GameRecord[]>(gamesQueryKey(opts), () => ({
    store: "games",
    load: () => gamesRepo.list({ matchId, limit }),
    share: shareById,
  }));
}

export interface SettingSnapshot {
  /** False when the key was never set (the hook then returns its fallback). */
  readonly exists: boolean;
  readonly value: unknown;
}

const MISSING_SETTING: SettingSnapshot = Object.freeze({ exists: false, value: undefined });

const settingKey = (key: string): string => `setting:${key}`;

export function settingQuery(key: string): LiveQuery<SettingSnapshot> {
  return getLiveQuery<SettingSnapshot>(settingKey(key), () => ({
    store: "settings",
    relevant: (e) => e.id === key || e.id === ALL_RECORDS,
    async load() {
      const record = await getSettingRecord(key);
      return record === undefined || record.value === undefined ? MISSING_SETTING : { exists: true, value: record.value };
    },
  }));
}

/** Persist a setting, updating every user of that key immediately (optimistically). */
export async function writeSetting(key: string, value: unknown): Promise<void> {
  const q = peekLiveQuery<SettingSnapshot>(settingKey(key));
  q?.setLocal(value === undefined ? MISSING_SETTING : { exists: true, value });
  try {
    await settingsRepo.set(key, value);
  } catch (err) {
    q?.invalidate(); // show what is really stored
    throw err;
  }
}
