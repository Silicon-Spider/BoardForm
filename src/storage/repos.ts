// Typed repositories over the IndexedDB stores (docs/ARCHITECTURE.md §4–5).
// Worker-safe (no React / DOM) — workers import "@/storage/repos" directly.
//
// Every write resolves after its transaction committed and then announces the change through
// ./events (same tab synchronously, other tabs / workers via BroadcastChannel).
// Every failure rejects with a StorageError (./db) carrying a user-readable message.

import type {
  DatasetChunkRecord,
  DatasetRecord,
  EngineRecord,
  GameRecord,
  MatchRecord,
  NetworkDataRecord,
  NetworkRecord,
  SettingRecord,
  TrainingRunRecord,
} from "@/types";
import { StorageError, withTransaction, type StoreValue } from "./db";
import { ALL_RECORDS, emitChanges, type ChangeEvent } from "./events";
import { STORE_NAMES, type StoreName } from "./stores";

// ---------------------------------------------------------------------------------------------
// Shapes

export interface Repo<T> {
  /** Every record, newest `updatedAt` first (ties: id ascending). */
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  /** Insert or replace (stored exactly as given — `updatedAt` is not touched). */
  put(record: T): Promise<void>;
  /**
   * Shallow-merge `patch` into the stored record, bump `updatedAt` and save — all inside one
   * transaction. `id` cannot be changed. Resolves with the merged record; rejects with a
   * StorageError (code "not-found") if the record does not exist.
   */
  update(id: string, patch: Partial<T>): Promise<T>;
  /** Delete (succeeds if the record does not exist). */
  remove(id: string): Promise<void>;
}

export interface NetworksRepo extends Repo<NetworkRecord> {
  /** Deletes the metadata record and its NetworkDataRecord together. */
  remove(id: string): Promise<void>;
  getData(id: string): Promise<NetworkDataRecord | undefined>;
  putData(record: NetworkDataRecord): Promise<void>;
}

export interface DatasetsRepo extends Repo<DatasetRecord> {
  /** Deletes all chunks of the dataset (in batches), then the record. */
  remove(id: string): Promise<void>;
  /** Stores a chunk under its canonical id `chunkId(datasetId, index)` (a different `id` is corrected). */
  putChunk(record: DatasetChunkRecord): Promise<void>;
  getChunk(datasetId: string, index: number): Promise<DatasetChunkRecord | undefined>;
  chunkCount(datasetId: string): Promise<number>;
  /**
   * The dataset's chunks in `index` order, read a few at a time in short transactions — safe to
   * `await` other work between iterations. Chunks added after iteration started are not included.
   */
  iterateChunks(datasetId: string): AsyncGenerator<DatasetChunkRecord>;
}

export interface GamesListOptions {
  /** Only games of this arena match. */
  matchId?: string;
  /** At most this many games (the newest). */
  limit?: number;
}

export interface GamesRepo {
  /** Newest `createdAt` first (ties: id descending), optionally filtered by match and limited. */
  list(opts?: GamesListOptions): Promise<GameRecord[]>;
  get(id: string): Promise<GameRecord | undefined>;
  put(record: GameRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes every game of the match (in batches). */
  removeByMatch(matchId: string): Promise<void>;
}

export interface SettingsRepo {
  /** The stored value, or `fallback` when the key was never set (or set to undefined). */
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const LABELS: Record<StoreName, { one: string; many: string }> = {
  engines: { one: "engine", many: "engines" },
  networks: { one: "network", many: "networks" },
  networkData: { one: "network weights", many: "network weights" },
  datasets: { one: "dataset", many: "datasets" },
  datasetChunks: { one: "dataset chunk", many: "dataset chunks" },
  games: { one: "game", many: "games" },
  matches: { one: "match", many: "matches" },
  trainingRuns: { one: "training run", many: "training runs" },
  settings: { one: "setting", many: "settings" },
};

/** Chunks fetched per transaction by iterateChunks (chunks can be large). */
const CHUNK_READ_BATCH = 8;
/** Keys deleted per transaction by cascading deletes. */
export const DELETE_BATCH = 256;

const timeOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sort order of every `list()`: newest `updatedAt` first, then id ascending. */
export function compareNewestUpdated(a: { id: string; updatedAt?: unknown }, b: { id: string; updatedAt?: unknown }): number {
  return timeOf(b.updatedAt) - timeOf(a.updatedAt) || compareIds(a.id, b.id);
}

/** Sort order of `gamesRepo.list()`: newest `createdAt` first, then id descending (what an IndexedDB "prev" cursor yields). */
export function compareNewestCreated(a: { id: string; createdAt?: unknown }, b: { id: string; createdAt?: unknown }): number {
  return timeOf(b.createdAt) - timeOf(a.createdAt) || compareIds(b.id, a.id);
}

function requireRecord(record: unknown, what: string, action: string): Record<string, unknown> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new StorageError("invalid-data", `Could not ${action}: expected a ${what} record, got ${record === null ? "null" : typeof record}.`);
  }
  return record as Record<string, unknown>;
}

function requireKey(value: unknown, what: string, action: string, field = "id"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageError("invalid-data", `Could not ${action}: the ${what} has no ${field}.`);
  }
  return value;
}

/** Primary key of a record of `store` (settings are keyed by `key`, everything else by `id`). */
export function recordKey(store: StoreName, record: unknown): string {
  const r = requireRecord(record, LABELS[store].one, `save the ${LABELS[store].one}`);
  return store === "settings"
    ? requireKey(r.key, "setting", "save the setting", "key")
    : requireKey(r.id, LABELS[store].one, `save the ${LABELS[store].one}`);
}

async function putOne<S extends StoreName>(store: S, record: StoreValue<S>): Promise<void> {
  const id = recordKey(store, record);
  await withTransaction(`save the ${LABELS[store].one}`, [store], "readwrite", async (tx) => {
    await tx.objectStore(store).put(record);
  });
  emitChanges([{ store, id, op: "put" }]);
}

async function deleteOne<S extends StoreName>(store: S, id: string): Promise<void> {
  await withTransaction(`delete the ${LABELS[store].one}`, [store], "readwrite", (tx) => tx.objectStore(store).delete(id));
  emitChanges([{ store, id, op: "delete" }]);
}

async function deleteKeysInBatches<S extends StoreName>(store: S, keys: readonly string[], action: string): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    await withTransaction(action, [store], "readwrite", async (tx) => {
      const os = tx.objectStore(store);
      await Promise.all(batch.map((k) => os.delete(k)));
    });
    emitChanges(batch.map((id): ChangeEvent => ({ store, id, op: "delete" })));
  }
}

/** Several records by key in one transaction (missing ones are undefined). */
export async function getManyById<S extends StoreName>(store: S, ids: readonly string[]): Promise<Array<StoreValue<S> | undefined>> {
  if (ids.length === 0) return [];
  return withTransaction(`load the ${LABELS[store].many}`, [store], "readonly", (tx) => {
    const os = tx.objectStore(store);
    return Promise.all(ids.map((id) => os.get(id)));
  });
}

/**
 * All records of a store in primary-key order, `batchSize` per short transaction (used for
 * backups, so huge stores never have to fit in one `getAll`).
 */
export async function* readStoreInBatches<S extends StoreName>(store: S, batchSize: number): AsyncGenerator<Array<StoreValue<S>>> {
  let after: string | undefined;
  for (;;) {
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const [keys, values] = await withTransaction(`read the ${LABELS[store].many}`, [store], "readonly", (tx) => {
      const os = tx.objectStore(store);
      return Promise.all([os.getAllKeys(range, batchSize), os.getAll(range, batchSize)]);
    });
    if (values.length > 0) yield values;
    if (values.length < batchSize || keys.length === 0) return;
    after = keys[keys.length - 1];
  }
}

/** Insert or replace many records in one transaction (imports). */
export async function putMany<S extends StoreName>(store: S, records: ReadonlyArray<StoreValue<S>>, action: string): Promise<void> {
  if (records.length === 0) return;
  const ids = records.map((r) => recordKey(store, r));
  await withTransaction(action, [store], "readwrite", async (tx) => {
    const os = tx.objectStore(store);
    await Promise.all(records.map((r) => os.put(r)));
  });
  emitChanges(ids.map((id): ChangeEvent => ({ store, id, op: "put" })));
}

/** Delete every record in every store (Settings → "delete all data"). The next ensureSeeded() re-creates the starter engines. */
export async function clearAllData(): Promise<void> {
  await withTransaction("delete all data", STORE_NAMES, "readwrite", async (tx) => {
    await Promise.all(STORE_NAMES.map((s) => tx.objectStore(s).clear()));
  });
  emitChanges(STORE_NAMES.map((store): ChangeEvent => ({ store, id: ALL_RECORDS, op: "delete" })));
}

// ---------------------------------------------------------------------------------------------
// Generic repo for stores with `updatedAt`

type TimestampedStore = "engines" | "networks" | "datasets" | "matches" | "trainingRuns";

function createRepo<S extends TimestampedStore>(store: S): Repo<StoreValue<S>> {
  const { one, many } = LABELS[store];
  return {
    async list() {
      const all = await withTransaction(`load the ${many}`, [store], "readonly", (tx) => tx.objectStore(store).getAll());
      return all.sort(compareNewestUpdated);
    },
    get(id) {
      return withTransaction(`load the ${one}`, [store], "readonly", (tx) => tx.objectStore(store).get(id));
    },
    put(record) {
      return putOne(store, record);
    },
    async update(id, patch) {
      const merged = await withTransaction(`update the ${one}`, [store], "readwrite", async (tx) => {
        const os = tx.objectStore(store);
        const existing = await os.get(id);
        if (existing === undefined) {
          throw new StorageError("not-found", `Could not update the ${one}: it no longer exists (id ${id}).`);
        }
        // Strictly increasing even for several updates within one millisecond.
        const updatedAt = Math.max(Date.now(), timeOf(existing.updatedAt) + 1);
        const next: StoreValue<S> = { ...existing, ...patch, id: existing.id, updatedAt };
        await os.put(next);
        return next;
      });
      emitChanges([{ store, id, op: "put" }]);
      return merged;
    },
    remove(id) {
      return deleteOne(store, id);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repos

export const enginesRepo: Repo<EngineRecord> = createRepo("engines");

const baseNetworks = createRepo("networks");
export const networksRepo: NetworksRepo = {
  ...baseNetworks,
  async remove(id) {
    await withTransaction("delete the network", ["networks", "networkData"], "readwrite", async (tx) => {
      await Promise.all([tx.objectStore("networks").delete(id), tx.objectStore("networkData").delete(id)]);
    });
    emitChanges([
      { store: "networks", id, op: "delete" },
      { store: "networkData", id, op: "delete" },
    ]);
  },
  getData(id) {
    return withTransaction("load the network weights", ["networkData"], "readonly", (tx) => tx.objectStore("networkData").get(id));
  },
  putData(record) {
    return putOne("networkData", record);
  },
};

/** Canonical chunk id: "<datasetId>:<index zero-padded to 6 digits>". */
export function chunkId(datasetId: string, index: number): string {
  return `${datasetId}:${String(index).padStart(6, "0")}`;
}

function chunkIndexOfKey(key: string): number {
  const n = Number(key.slice(key.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

async function chunkKeys(datasetId: string): Promise<string[]> {
  const keys = await withTransaction("list the dataset chunks", ["datasetChunks"], "readonly", (tx) =>
    tx.objectStore("datasetChunks").index("datasetId").getAllKeys(datasetId),
  );
  // Numeric order (string order would break past 999,999 chunks).
  return keys.sort((a, b) => chunkIndexOfKey(a) - chunkIndexOfKey(b) || compareIds(a, b));
}

const baseDatasets = createRepo("datasets");
export const datasetsRepo: DatasetsRepo = {
  ...baseDatasets,
  async remove(id) {
    // Chunks first, in batches (no single huge transaction), then the record — if the tab closes
    // midway the dataset is still listed and can simply be deleted again.
    await deleteKeysInBatches("datasetChunks", await chunkKeys(id), "delete the dataset's positions");
    await baseDatasets.remove(id);
    // Chunks a still-running generator wrote in the meantime.
    const leftovers = await chunkKeys(id);
    if (leftovers.length > 0) await deleteKeysInBatches("datasetChunks", leftovers, "delete the dataset's positions");
  },
  async putChunk(record) {
    const action = "save the dataset chunk";
    const r = requireRecord(record, "dataset chunk", action);
    const datasetId = requireKey(r.datasetId, "dataset chunk", action, "datasetId");
    if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) {
      throw new StorageError("invalid-data", `Could not ${action}: the chunk index must be a non-negative integer (got ${String(record.index)}).`);
    }
    const id = chunkId(datasetId, record.index);
    await putOne("datasetChunks", record.id === id ? record : { ...record, id });
  },
  getChunk(datasetId, index) {
    return withTransaction("load the dataset chunk", ["datasetChunks"], "readonly", (tx) =>
      tx.objectStore("datasetChunks").get(chunkId(datasetId, index)),
    );
  },
  chunkCount(datasetId) {
    return withTransaction("count the dataset chunks", ["datasetChunks"], "readonly", (tx) =>
      tx.objectStore("datasetChunks").index("datasetId").count(datasetId),
    );
  },
  async *iterateChunks(datasetId) {
    const keys = await chunkKeys(datasetId);
    for (let i = 0; i < keys.length; i += CHUNK_READ_BATCH) {
      const records = await getManyById("datasetChunks", keys.slice(i, i + CHUNK_READ_BATCH));
      for (const r of records) if (r !== undefined) yield r; // undefined = deleted meanwhile
    }
  },
};

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || limit === null || Number.isNaN(limit) || limit === Infinity) return undefined;
  return Math.max(0, Math.floor(limit));
}

export const gamesRepo: GamesRepo = {
  async list(opts = {}) {
    const limit = normalizeLimit(opts.limit);
    if (limit === 0) return [];
    if (typeof opts.matchId === "string") {
      const matchId = opts.matchId;
      const games = await withTransaction("load the match's games", ["games"], "readonly", (tx) =>
        tx.objectStore("games").index("matchId").getAll(matchId),
      );
      games.sort(compareNewestCreated);
      return limit === undefined ? games : games.slice(0, limit);
    }
    if (limit === undefined) {
      const all = await withTransaction("load the games", ["games"], "readonly", (tx) => tx.objectStore("games").getAll());
      return all.sort(compareNewestCreated);
    }
    // Newest first straight from the createdAt index, without reading every game.
    return withTransaction("load the games", ["games"], "readonly", async (tx) => {
      const out: GameRecord[] = [];
      let cursor = await tx.objectStore("games").index("createdAt").openCursor(null, "prev");
      while (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor = await cursor.continue();
      }
      return out;
    });
  },
  get(id) {
    return withTransaction("load the game", ["games"], "readonly", (tx) => tx.objectStore("games").get(id));
  },
  put(record) {
    return putOne("games", record);
  },
  remove(id) {
    return deleteOne("games", id);
  },
  async removeByMatch(matchId) {
    const keys = await withTransaction("list the match's games", ["games"], "readonly", (tx) =>
      tx.objectStore("games").index("matchId").getAllKeys(matchId),
    );
    await deleteKeysInBatches("games", keys, "delete the match's games");
  },
};

export const matchesRepo: Repo<MatchRecord> = createRepo("matches");
export const runsRepo: Repo<TrainingRunRecord> = createRepo("trainingRuns");

/** The raw settings record (undefined = never set). */
export function getSettingRecord(key: string): Promise<SettingRecord | undefined> {
  return withTransaction(`load the setting "${key}"`, ["settings"], "readonly", (tx) => tx.objectStore("settings").get(key));
}

export const settingsRepo: SettingsRepo = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const record = await getSettingRecord(key);
    return record === undefined || record.value === undefined ? fallback : (record.value as T);
  },
  set(key, value) {
    return putOne("settings", { key, value });
  },
  async remove(key) {
    await withTransaction(`delete the setting "${key}"`, ["settings"], "readwrite", (tx) => tx.objectStore("settings").delete(key));
    emitChanges([{ store: "settings", id: key, op: "delete" }]);
  },
};
