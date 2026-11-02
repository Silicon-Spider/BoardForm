// React hooks over the storage layer (docs/ARCHITECTURE.md §5). Main thread only.
//
// * List hooks return `undefined` while loading, then the records newest-updated first.
// * Single-record hooks return `undefined` while loading, `null` when the record does not exist
//   (or the id is empty), else the record.
// * All components share one cache per store / query (./cache.ts): one query no matter how many
//   components ask, refreshed after changes made in this tab, other tabs or workers.
// * References are stable: an unchanged record keeps its identity across refreshes, and an
//   unchanged list keeps the same array. Treat returned data as read-only (copy before sorting).
// * If reading fails (e.g. the database was closed because a newer version opened in another
//   tab), the hook throws the StorageError during render so the page's error boundary shows it.
//   useSetting never throws — it falls back to `fallback` and logs.

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { DatasetRecord, EngineRecord, GameRecord, MatchRecord, NetworkRecord, TrainingRunRecord } from "@/types";
import { toast } from "@/app/toast";
import {
  gamesQuery,
  listQuery,
  settingQuery,
  writeSetting,
  type ListStore,
  type LiveQuery,
  type QueryState,
} from "./cache";
import { getDatabaseStatus, onDatabaseEvent, type DatabaseEvent, type StoreValue } from "./db";
import { deepEqual } from "./equal";
import type { GamesListOptions } from "./repos";

const noopSubscribe = (): (() => void) => () => {};

/** Wraps a query failure so it cannot be confused with a record (records are plain objects). */
class QueryFailure {
  constructor(readonly error: unknown) {}
}
const failures = new WeakMap<object, QueryFailure>();
function failureOf(state: QueryState<unknown> & { status: "error" }): QueryFailure {
  let f = failures.get(state);
  if (!f) {
    f = new QueryFailure(state.error);
    failures.set(state, f);
  }
  return f;
}

function useQueryState<T>(q: LiveQuery<T>): QueryState<T> {
  return useSyncExternalStore(q.subscribe, q.getSnapshot, q.getSnapshot);
}

function useList<S extends ListStore>(store: S): Array<StoreValue<S>> | undefined {
  const state = useQueryState(listQuery(store));
  if (state.status === "error") throw state.error;
  return state.status === "ready" ? state.data : undefined;
}

/** id → record index per list snapshot (lists are immutable snapshots, so a WeakMap is safe). */
const indexes = new WeakMap<object, Map<string, { id: string }>>();
function indexById<R extends { id: string }>(list: R[]): Map<string, R> {
  let index = indexes.get(list) as Map<string, R> | undefined;
  if (!index) {
    index = new Map();
    for (const r of list) index.set(r.id, r);
    indexes.set(list, index);
  }
  return index;
}

function useRecord<S extends ListStore>(store: S, id: string | null | undefined): StoreValue<S> | null | undefined {
  const q = id ? listQuery(store) : null;
  const getSnapshot = useCallback((): StoreValue<S> | null | undefined | QueryFailure => {
    if (!q || !id) return null;
    const state = q.getSnapshot();
    if (state.status === "loading") return undefined;
    if (state.status === "error") return failureOf(state);
    // A record that was just written may not be in the snapshot yet: report "loading", not "missing".
    return indexById(state.data).get(id) ?? (q.isPending(id) ? undefined : null);
  }, [q, id]);
  const value = useSyncExternalStore(q ? q.subscribe : noopSubscribe, getSnapshot, getSnapshot);
  if (value instanceof QueryFailure) throw value.error;
  return value;
}

export function useEngines(): EngineRecord[] | undefined {
  return useList("engines");
}
export function useEngine(id: string | null | undefined): EngineRecord | null | undefined {
  return useRecord("engines", id);
}
export function useNetworks(): NetworkRecord[] | undefined {
  return useList("networks");
}
export function useNetwork(id: string | null | undefined): NetworkRecord | null | undefined {
  return useRecord("networks", id);
}
export function useDatasets(): DatasetRecord[] | undefined {
  return useList("datasets");
}
export function useDataset(id: string | null | undefined): DatasetRecord | null | undefined {
  return useRecord("datasets", id);
}
export function useTrainingRuns(): TrainingRunRecord[] | undefined {
  return useList("trainingRuns");
}
export function useTrainingRun(id: string | null | undefined): TrainingRunRecord | null | undefined {
  return useRecord("trainingRuns", id);
}
export function useMatches(): MatchRecord[] | undefined {
  return useList("matches");
}
export function useMatch(id: string | null | undefined): MatchRecord | null | undefined {
  return useRecord("matches", id);
}

/** Games newest first; `{ matchId }` for one match, `{ limit }` for the newest N. */
export function useGames(opts?: GamesListOptions): GameRecord[] | undefined {
  const state = useQueryState(gamesQuery(opts));
  if (state.status === "error") throw state.error;
  return state.status === "ready" ? state.data : undefined;
}

/**
 * A persisted setting. Returns `fallback` while loading and when the key was never set. The setter
 * updates every component using the key at once (and other tabs after the write), and reports a
 * failed write with a toast. The setter is stable for a given key.
 */
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const state = useQueryState(settingQuery(key));
  // Keep one fallback reference while its contents are unchanged, so callers can put a literal
  // (`useSetting("x", { depth: 8 })`) in effect dependencies without re-running them every render.
  const fallbackRef = useRef(fallback);
  if (fallbackRef.current !== fallback && !deepEqual(fallbackRef.current, fallback)) fallbackRef.current = fallback;
  const setValue = useCallback(
    (v: T) => {
      writeSetting(key, v).catch((err: unknown) => {
        console.error(`[storage] could not save setting "${key}"`, err);
        toast("Could not save your setting", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
      });
    },
    [key],
  );
  const value = state.status === "ready" && state.data.exists ? (state.data.value as T) : fallbackRef.current;
  return [value, setValue];
}

const subscribeDatabase = (cb: () => void): (() => void) => onDatabaseEvent(() => cb());

/**
 * The current database problem (null when fine) — e.g. `reloadRequired` after a newer version of
 * the app upgraded the database in another tab. Use it to show a "Reload" banner.
 */
export function useDatabaseStatus(): DatabaseEvent | null {
  return useSyncExternalStore(subscribeDatabase, getDatabaseStatus, getDatabaseStatus);
}
