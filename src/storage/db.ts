// The "chess-builder" IndexedDB database: schema, connection lifecycle and error mapping.
// Worker-safe (no React / DOM): workers open their own connection through this module.
//
// Connection lifecycle
// * One shared connection per JS context, opened lazily by getDB().
// * "blocked": our open is waiting for older connections in other tabs to close (only possible
//   when a future schema version is introduced) — reported via onDatabaseEvent().
// * "versionchange": another tab wants to upgrade or delete the database. We close our connection
//   immediately so it can proceed, and report it. After an upgrade by a newer app version this tab
//   must reload (every later operation fails with a StorageError "database-closed"); after a
//   deletion the next operation simply recreates an empty database.
// * "close" (terminated): the browser dropped the connection (e.g. site data cleared); the next
//   operation reopens it.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
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
import { formatBytes } from "@/utils/format";
import { ALL_RECORDS, emitChanges } from "./events";
import { STORE_NAMES, type StoreName } from "./stores";

/** The app's original name; kept so data saved before the rename to BoardForm stays readable. */
export const DB_NAME = "chess-builder";
export const DB_VERSION = 1;

/** Typed schema (docs/ARCHITECTURE.md §4). Index key types are what you query them with. */
export interface BoardFormDB extends DBSchema {
  engines: { key: string; value: EngineRecord; indexes: { updatedAt: number } };
  networks: { key: string; value: NetworkRecord; indexes: { updatedAt: number } };
  networkData: { key: string; value: NetworkDataRecord };
  datasets: { key: string; value: DatasetRecord; indexes: { updatedAt: number } };
  datasetChunks: { key: string; value: DatasetChunkRecord; indexes: { datasetId: string } };
  games: { key: string; value: GameRecord; indexes: { createdAt: number; matchId: string } };
  matches: { key: string; value: MatchRecord; indexes: { updatedAt: number } };
  trainingRuns: { key: string; value: TrainingRunRecord; indexes: { updatedAt: number } };
  settings: { key: string; value: SettingRecord };
}

export type StoreValue<S extends StoreName> = BoardFormDB[S]["value"];

// ---------------------------------------------------------------------------------------------
// Errors

export type StorageErrorCode =
  /** IndexedDB is missing or disabled (some private-browsing modes / privacy settings). */
  | "unavailable"
  /** The browser refused to store more data. */
  | "quota-exceeded"
  /** This tab closed its connection because a newer app version opened in another tab — reload. */
  | "database-closed"
  /** The saved database is newer than the code running in this tab — reload. */
  | "version-mismatch"
  /** The record to update / export does not exist. */
  | "not-found"
  /** A record or an imported file is malformed. */
  | "invalid-data"
  /** A value cannot be stored (functions, class instances with methods, DOM nodes...). */
  | "data-clone"
  | "failed";

/** Every storage function rejects with this (message written for end users). */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** True for "storage is full" errors from any browser (and for StorageErrors with that code). */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof StorageError) return err.code === "quota-exceeded";
  const name = errorName(err);
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  // 22 = DOMException.QUOTA_EXCEEDED_ERR; 1014 = Firefox's legacy NS_ERROR_DOM_QUOTA_REACHED.
  return name !== "" && (code === 22 || code === 1014);
}

async function quotaMessage(action: string): Promise<string> {
  let usage = "";
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    const est = storage && typeof storage.estimate === "function" ? await storage.estimate() : undefined;
    if (est && typeof est.usage === "number" && typeof est.quota === "number" && est.quota > 0) {
      usage = ` BoardForm is using ${formatBytes(est.usage)} of the ${formatBytes(est.quota)} this browser allows.`;
    }
  } catch {
    /* the estimate is only a nicety */
  }
  return (
    `Browser storage is full, so BoardForm could not ${action}.${usage} ` +
    "Free up space by deleting datasets, old games or networks you no longer need " +
    "(export a backup first if you want to keep them), then try again."
  );
}

const UNAVAILABLE_MESSAGE =
  "This browser is not letting BoardForm use IndexedDB, so nothing can be saved. " +
  "Private / incognito windows and strict privacy settings can disable it — try a normal window, " +
  "or allow site data for this page.";

/** Convert any failure into a StorageError with a descriptive message. */
export async function toStorageError(err: unknown, action: string): Promise<StorageError> {
  if (err instanceof StorageError) return err;
  if (isQuotaError(err)) return new StorageError("quota-exceeded", await quotaMessage(action), { cause: err });
  const name = errorName(err);
  switch (name) {
    case "DataCloneError":
      return new StorageError(
        "data-clone",
        `Could not ${action}: the data contains a value the browser cannot store (such as a function or a class instance).`,
        { cause: err },
      );
    case "InvalidStateError":
      if (closedError) return closedError;
      return new StorageError(
        "failed",
        `Could not ${action}: the database connection was closed by the browser. Please try again.`,
        { cause: err },
      );
    case "AbortError":
      return new StorageError("failed", `Could not ${action}: the browser cancelled the database transaction.`, {
        cause: err,
      });
    case "DataError":
    case "ConstraintError":
      return new StorageError("invalid-data", `Could not ${action}: ${errorMessage(err)}`, { cause: err });
    case "UnknownError":
      return new StorageError(
        "failed",
        `Could not ${action}: the browser's storage reported an internal error (${errorMessage(err)}). ` +
          "This is usually a full disk or damaged browser profile data; restarting the browser often helps.",
        { cause: err },
      );
    default:
      return new StorageError("failed", `Could not ${action}: ${errorMessage(err)}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------------------------
// Database status events (for a "please reload" prompt in the UI)

export type DatabaseEventType =
  /** Opening is waiting for other (older) tabs to close their connection. */
  | "blocked"
  /** The database became usable again after being blocked. */
  | "ready"
  /** A newer app version upgraded the database in another tab; this tab must reload. */
  | "version-change"
  /** The database was deleted from another tab. */
  | "deleted"
  /** The browser closed the connection unexpectedly; it is reopened on the next operation. */
  | "terminated";

export interface DatabaseEvent {
  type: DatabaseEventType;
  /** User-facing explanation. */
  message: string;
  /** True when the UI should ask the user to reload the tab. */
  reloadRequired: boolean;
  at: number;
}

const dbListeners = new Set<(e: DatabaseEvent) => void>();
let lastDbEvent: DatabaseEvent | null = null;

/** Listen for connection problems (see DatabaseEventType). Returns an unsubscribe function. */
export function onDatabaseEvent(listener: (e: DatabaseEvent) => void): () => void {
  dbListeners.add(listener);
  return () => {
    dbListeners.delete(listener);
  };
}

/** The current problem, if any (null when the database is fine). */
export function getDatabaseStatus(): DatabaseEvent | null {
  return lastDbEvent;
}

function emitDatabaseEvent(type: DatabaseEventType, message: string, reloadRequired: boolean): void {
  const event: DatabaseEvent = { type, message, reloadRequired, at: Date.now() };
  lastDbEvent = type === "ready" ? null : event;
  if (reloadRequired) console.warn(`[storage] ${message}`);
  for (const l of [...dbListeners]) {
    try {
      l(event);
    } catch (err) {
      console.error("[storage] database event listener threw", err);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Connection

let dbPromise: Promise<IDBPDatabase<BoardFormDB>> | null = null;
/** Bumped whenever the shared connection is replaced, so stale callbacks can be ignored. */
let generation = 0;
/** Set once a newer version took over in another tab: every operation must fail until reload. */
let closedError: StorageError | null = null;

function createSchema(db: IDBPDatabase<BoardFormDB>, oldVersion: number): void {
  // Version 1 — initial schema. Later versions append `if (oldVersion < N) { ... }` steps.
  if (oldVersion < 1) {
    db.createObjectStore("engines", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    db.createObjectStore("networks", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    db.createObjectStore("networkData", { keyPath: "id" });
    db.createObjectStore("datasets", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    db.createObjectStore("datasetChunks", { keyPath: "id" }).createIndex("datasetId", "datasetId");
    const games = db.createObjectStore("games", { keyPath: "id" });
    games.createIndex("createdAt", "createdAt");
    // Games without a match (matchId null/undefined) are simply absent from this index.
    games.createIndex("matchId", "matchId");
    db.createObjectStore("matches", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    db.createObjectStore("trainingRuns", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
    db.createObjectStore("settings", { keyPath: "key" });
  }
}

function mapOpenError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const name = errorName(err);
  if (name === "VersionError") {
    return new StorageError(
      "version-mismatch",
      "Your saved data was written by a newer version of BoardForm than the one running in this tab. " +
        "Reload the page to get the latest version.",
      { cause: err },
    );
  }
  if (name === "SecurityError" || name === "InvalidStateError" || name === "NotSupportedError") {
    return new StorageError("unavailable", `${UNAVAILABLE_MESSAGE} (${name})`, { cause: err });
  }
  if (isQuotaError(err)) {
    return new StorageError(
      "quota-exceeded",
      "Browser storage is full, so BoardForm could not open its database. Free up disk space or site data and reload.",
      { cause: err },
    );
  }
  return new StorageError("failed", `Could not open the BoardForm database: ${errorMessage(err)}`, { cause: err });
}

async function openDatabase(gen: number): Promise<IDBPDatabase<BoardFormDB>> {
  if (typeof indexedDB === "undefined" || indexedDB === null) {
    throw new StorageError("unavailable", UNAVAILABLE_MESSAGE);
  }
  let wasBlocked = false;
  let db: IDBPDatabase<BoardFormDB>;
  try {
    db = await openDB<BoardFormDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        createSchema(database, oldVersion);
      },
      blocked() {
        wasBlocked = true;
        emitDatabaseEvent(
          "blocked",
          "BoardForm is open in another tab with an older version that is blocking a database upgrade. " +
            "Close or reload the other BoardForm tabs to continue.",
          false,
        );
      },
      blocking(_currentVersion, blockedVersion, event) {
        // Close right away so the other tab's upgrade / deletion can proceed.
        (event.target as IDBDatabase).close();
        if (gen === generation) dbPromise = null;
        if (blockedVersion === null) {
          emitDatabaseEvent(
            "deleted",
            "Your saved BoardForm data was deleted from another tab. Reload this tab to start fresh.",
            true,
          );
          // Local caches re-read (they will see the freshly recreated, empty database).
          emitChanges(
            STORE_NAMES.map((store) => ({ store, id: ALL_RECORDS, op: "delete" as const })),
            { broadcast: false },
          );
        } else {
          closedError = new StorageError(
            "database-closed",
            "BoardForm was updated in another tab, so this tab closed its connection to your saved data. " +
              "Reload this tab to keep working — nothing has been lost.",
          );
          emitDatabaseEvent("version-change", closedError.message, true);
        }
      },
      terminated() {
        if (gen === generation) dbPromise = null;
        emitDatabaseEvent(
          "terminated",
          "The browser closed the connection to your saved data unexpectedly (was site data cleared?). " +
            "It will be reopened automatically; reload the tab if something looks wrong.",
          false,
        );
      },
    });
  } catch (err) {
    throw mapOpenError(err);
  }
  if (wasBlocked) emitDatabaseEvent("ready", "The database is ready.", false);
  return db;
}

/** The shared connection (opened on first use). Rejects with a StorageError. */
export function getDB(): Promise<IDBPDatabase<BoardFormDB>> {
  if (closedError) return Promise.reject(closedError);
  if (!dbPromise) {
    const gen = ++generation;
    const p = openDatabase(gen);
    dbPromise = p;
    // A failed open is retried by the next call.
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

/**
 * Close the shared connection (tests; before deleting the database). The next operation reopens
 * it. Also clears a "database-closed" state.
 */
export async function closeDatabase(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  generation++;
  closedError = null;
  lastDbEvent = null;
  if (p) {
    try {
      (await p).close();
    } catch {
      /* it never opened */
    }
  }
}

/**
 * Run `fn` inside one transaction and resolve after the transaction has committed.
 *
 * * Every failure (including a commit failure such as a full disk) rejects with a StorageError
 *   whose message mentions `action` ("save the engine", ...).
 * * If `fn` throws, the transaction is aborted so partial writes are rolled back.
 * * `fn` must only await IndexedDB requests of `tx` — awaiting anything else lets the transaction
 *   auto-commit early (TransactionInactiveError).
 */
export async function withTransaction<Names extends ArrayLike<StoreName>, Mode extends IDBTransactionMode, T>(
  action: string,
  storeNames: Names,
  mode: Mode,
  fn: (tx: IDBPTransaction<BoardFormDB, Names, Mode>) => Promise<T>,
): Promise<T> {
  try {
    const db = await getDB();
    const tx = db.transaction(storeNames, mode);
    const done = tx.done;
    // `done` is awaited below; this handler only prevents an "unhandled rejection" when `fn`
    // fails first and we never reach that await.
    done.catch(() => undefined);
    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already finished or aborting */
      }
      throw err;
    }
    await done;
    return result;
  } catch (err) {
    throw await toStorageError(err, action);
  }
}
