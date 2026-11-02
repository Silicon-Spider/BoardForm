import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DB_NAME,
  StorageError,
  closeDatabase,
  getDatabaseStatus,
  isQuotaError,
  onDatabaseEvent,
  toStorageError,
  withTransaction,
  type DatabaseEvent,
} from "./db";
import { subscribe, type ChangeEvent } from "./events";
import { enginesRepo } from "./repos";
import { makeEngine, resetStorage } from "./test-utils";

beforeEach(resetStorage);
const offs: Array<() => void> = [];
afterEach(async () => {
  while (offs.length) offs.pop()!();
  vi.restoreAllMocks();
  await closeDatabase();
});

function openRaw(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked: the storage module did not close its connection"));
  });
}

function dbEvents(): DatabaseEvent[] {
  const events: DatabaseEvent[] = [];
  offs.push(onDatabaseEvent((e) => events.push(e)));
  return events;
}

async function errorOf(p: Promise<unknown>): Promise<StorageError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }
  throw new Error("expected a rejection");
}

describe("connection lifecycle", () => {
  it("creates every store and index of the schema", async () => {
    await enginesRepo.list(); // opens and creates the database
    const raw = await openRaw(1);
    try {
      expect([...raw.objectStoreNames].sort()).toEqual(
        ["datasetChunks", "datasets", "engines", "games", "matches", "networkData", "networks", "settings", "trainingRuns"].sort(),
      );
      const tx = raw.transaction([...raw.objectStoreNames], "readonly");
      const indexes = (s: string) => [...tx.objectStore(s).indexNames].sort();
      expect(indexes("engines")).toEqual(["updatedAt"]);
      expect(indexes("networks")).toEqual(["updatedAt"]);
      expect(indexes("networkData")).toEqual([]);
      expect(indexes("datasets")).toEqual(["updatedAt"]);
      expect(indexes("datasetChunks")).toEqual(["datasetId"]);
      expect(indexes("games")).toEqual(["createdAt", "matchId"]);
      expect(indexes("matches")).toEqual(["updatedAt"]);
      expect(indexes("trainingRuns")).toEqual(["updatedAt"]);
      expect(indexes("settings")).toEqual([]);
      expect(tx.objectStore("settings").keyPath).toBe("key");
      expect(tx.objectStore("engines").keyPath).toBe("id");
    } finally {
      raw.close();
    }
  });

  it("steps aside when a newer version opens in another tab and asks for a reload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await enginesRepo.put(makeEngine("a"));
    const events = dbEvents();

    const newer = await openRaw(2); // would be "blocked" if we kept our connection open
    newer.close();

    expect(events.map((e) => e.type)).toEqual(["version-change"]);
    expect(events[0].reloadRequired).toBe(true);
    expect(getDatabaseStatus()?.type).toBe("version-change");
    const err = await errorOf(enginesRepo.get("a"));
    expect(err.code).toBe("database-closed");
    expect(err.message).toMatch(/Reload this tab/);
  });

  it("reopens a fresh database after another tab deleted it and tells local caches to refresh", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await enginesRepo.put(makeEngine("a"));
    const events = dbEvents();
    const changes: ChangeEvent[] = [];
    offs.push(subscribe("*", (e) => changes.push(e)));

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });

    expect(events.map((e) => e.type)).toEqual(["deleted"]);
    expect(changes).toContainEqual({ store: "engines", id: "*", op: "delete" });
    expect(changes).toContainEqual({ store: "settings", id: "*", op: "delete" });
    expect(await enginesRepo.list()).toEqual([]); // transparently reopened
    await enginesRepo.put(makeEngine("b"));
    expect((await enginesRepo.get("b"))?.id).toBe("b");
  });

  it("explains when IndexedDB is unavailable, and recovers once it is back", async () => {
    const factory = indexedDB;
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    const err = await errorOf(enginesRepo.list());
    expect(err.code).toBe("unavailable");
    expect(err.message).toMatch(/IndexedDB/);
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = factory;
    expect(await enginesRepo.list()).toEqual([]); // a failed open is retried
  });

  it("explains when the saved database is newer than this version of the app", async () => {
    (await openRaw(5)).close();
    const err = await errorOf(enginesRepo.list());
    expect(err.code).toBe("version-mismatch");
    expect(err.message).toMatch(/newer version of Chess Builder/);
  });
});

describe("withTransaction", () => {
  it("rolls back when the callback fails, with a descriptive error", async () => {
    const err = await errorOf(
      withTransaction("save the test data", ["engines"], "readwrite", async (tx) => {
        await tx.objectStore("engines").put(makeEngine("x"));
        throw new Error("changed my mind");
      }),
    );
    expect(err.message).toBe("Could not save the test data: changed my mind");
    expect(await enginesRepo.get("x")).toBeUndefined();
  });

  it("returns the callback's result after the commit", async () => {
    const n = await withTransaction("count", ["engines"], "readwrite", async (tx) => {
      await tx.objectStore("engines").put(makeEngine("y"));
      return tx.objectStore("engines").count();
    });
    expect(n).toBe(1);
  });
});

describe("error mapping", () => {
  it("recognises quota errors from every browser", async () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError(new StorageError("quota-exceeded", "x"))).toBe(true);
    expect(isQuotaError(new Error("other"))).toBe(false);
    const err = await toStorageError(new DOMException("full", "QuotaExceededError"), "save the dataset chunk");
    expect(err.code).toBe("quota-exceeded");
    expect(err.message).toMatch(/^Browser storage is full, so Chess Builder could not save the dataset chunk\./);
    expect(err.message).toMatch(/deleting datasets/);
  });

  it("maps other failures and passes StorageErrors through", async () => {
    const own = new StorageError("not-found", "gone");
    expect(await toStorageError(own, "x")).toBe(own);
    expect((await toStorageError(new DOMException("x", "DataCloneError"), "save it")).code).toBe("data-clone");
    expect((await toStorageError(new DOMException("x", "AbortError"), "save it")).message).toMatch(/cancelled/);
    expect((await toStorageError(new DOMException("disk", "UnknownError"), "save it")).message).toMatch(/restarting the browser/);
    const plain = await toStorageError("weird", "save it");
    expect(plain.code).toBe("failed");
    expect(plain.message).toBe("Could not save it: weird");
  });
});
