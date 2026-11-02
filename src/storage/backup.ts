// Whole-database backups and single-engine files. Worker-safe.
//
// Backup file (JSON):
//   { "format": "chess-builder-backup", "version": 1, "exportedAt": "<ISO date>", "app": "chess-builder",
//     "dbVersion": 1, "options": { includeDatasets, includeGames },
//     "stores": { "<store>": [record, ...], ... }, "counts": { "<store>": n, ... } }
// Engine file (JSON):
//   { "format": "chess-builder-engine", "version": 1, "exportedAt": "<ISO date>",
//     "engine": EngineRecord (build removed), "network": { "record": NetworkRecord, "data": NetworkDataRecord } | null }
// Binary values (wasm modules, network weights, dataset chunks) are tagged base64 — see ./codec.ts.

import type { EngineKind, EngineRecord, NetworkDataRecord, NetworkRecord } from "@/types";
import { decodeValue, encodeValue } from "./codec";
import { DB_VERSION, StorageError, withTransaction, type StoreValue } from "./db";
import { emitChanges, type ChangeEvent } from "./events";
import { newId } from "./id";
import { chunkId, enginesRepo, networksRepo, putMany, readStoreInBatches } from "./repos";
import { STORE_NAMES, type StoreName } from "./stores";

export const BACKUP_FORMAT = "chess-builder-backup";
export const BACKUP_VERSION = 1;
export const ENGINE_FILE_FORMAT = "chess-builder-engine";
export const ENGINE_FILE_VERSION = 1;

export interface BackupOptions {
  /** Include datasets and their position chunks (often by far the largest data). Default false. */
  includeDatasets?: boolean;
  /** Include saved games. Default true. */
  includeGames?: boolean;
}

export type StoreCounts = Record<StoreName, number>;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === "[object ArrayBuffer]";

function invalid(message: string, cause?: unknown): StorageError {
  return new StorageError("invalid-data", message, cause === undefined ? undefined : { cause });
}

function zeroCounts(): StoreCounts {
  return Object.fromEntries(STORE_NAMES.map((s) => [s, 0])) as StoreCounts;
}

async function readJsonFile(file: Blob, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw invalid(`Could not read the ${what}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM added by some editors
  try {
    return JSON.parse(text);
  } catch (err) {
    throw invalid(`This file is not a valid Chess Builder ${what} (it is not readable JSON — was it truncated?).`, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Backup

/** Records read per transaction while exporting (chunks and network weights are large). */
function readBatchSize(store: StoreName): number {
  return store === "datasetChunks" ? 16 : store === "networkData" ? 4 : 200;
}

/** Records written per transaction while importing. */
function writeBatchSize(store: StoreName): number {
  return store === "datasetChunks" ? 16 : store === "networkData" ? 4 : 250;
}

/**
 * Export the database as one JSON file. Datasets (positions) are excluded by default because they
 * can be hundreds of MB; games are included by default.
 */
export async function exportBackup(opts: BackupOptions = {}): Promise<Blob> {
  const includeDatasets = opts.includeDatasets ?? false;
  const includeGames = opts.includeGames ?? true;
  const stores = STORE_NAMES.filter(
    (s) => (includeDatasets || (s !== "datasets" && s !== "datasetChunks")) && (includeGames || s !== "games"),
  );
  const header = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: "chess-builder",
    dbVersion: DB_VERSION,
    options: { includeDatasets, includeGames },
  });
  // Built from many small strings (one per record) so no single giant string is ever needed.
  const parts: string[] = [header.slice(0, -1), ',"stores":{'];
  const counts: Partial<StoreCounts> = {};
  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    parts.push(`${i > 0 ? "," : ""}${JSON.stringify(store)}:[`);
    let n = 0;
    for await (const batch of readStoreInBatches(store, readBatchSize(store))) {
      for (const record of batch) parts.push((n++ > 0 ? "," : "") + JSON.stringify(encodeValue(record)));
    }
    counts[store] = n;
    parts.push("]");
  }
  parts.push(`},"counts":${JSON.stringify(counts)}}`);
  return new Blob(parts, { type: "application/json" });
}

function validateBackupRecord(store: StoreName, value: unknown, index: number): unknown {
  const where = `record ${index + 1} of "${store}"`;
  if (!isObject(value)) throw invalid(`This backup is damaged: ${where} is not a record.`);
  if (store === "settings") {
    if (typeof value.key !== "string" || value.key === "") throw invalid(`This backup is damaged: ${where} has no key.`);
    return value;
  }
  if (typeof value.id !== "string" || value.id === "") throw invalid(`This backup is damaged: ${where} has no id.`);
  if (store === "datasetChunks") {
    const { datasetId, index: chunkIndex } = value;
    if (typeof datasetId !== "string" || typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw invalid(`This backup is damaged: ${where} does not say which dataset it belongs to.`);
    }
    if (!isArrayBuffer(value.data)) throw invalid(`This backup is damaged: ${where} has no position data.`);
    return { ...value, id: chunkId(datasetId, chunkIndex) };
  }
  if (store === "networkData" && !isArrayBuffer(value.quantized)) {
    throw invalid(`This backup is damaged: ${where} has no network weights.`);
  }
  return value;
}

/**
 * Restore a backup made by exportBackup(). Records whose id already exists are overwritten; other
 * existing data is kept. The whole file is validated before anything is written. Resolves with
 * the number of records restored per store.
 */
export async function importBackup(file: Blob): Promise<StoreCounts> {
  const raw = await readJsonFile(file, "backup");
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) {
    if (isObject(raw) && raw.format === ENGINE_FILE_FORMAT) {
      throw invalid("This is a single-engine file, not a backup — import it from the Engines page instead.");
    }
    throw invalid("This file is not a Chess Builder backup.");
  }
  if (typeof raw.version !== "number" || raw.version < 1) throw invalid("This backup is damaged: it has no format version.");
  if (raw.version > BACKUP_VERSION) {
    throw invalid(
      `This backup was made by a newer version of Chess Builder (backup format ${raw.version}). Reload the page to update the app, then try again.`,
    );
  }
  const storesJson = raw.stores;
  if (!isObject(storesJson)) throw invalid("This backup is damaged: it contains no data.");

  // Decode and validate everything first, so a damaged file changes nothing.
  const prepared: Array<{ store: StoreName; records: unknown[] }> = [];
  for (const store of STORE_NAMES) {
    const list = storesJson[store];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw invalid(`This backup is damaged: "${store}" is not a list.`);
    const records = new Array<unknown>(list.length);
    for (let i = 0; i < list.length; i++) {
      records[i] = validateBackupRecord(store, decodeValue(list[i]), i);
      list[i] = null; // release the raw JSON as we go (backups with datasets can be huge)
    }
    prepared.push({ store, records });
  }

  const counts = zeroCounts();
  for (const { store, records } of prepared) {
    const size = writeBatchSize(store);
    for (let i = 0; i < records.length; i += size) {
      const batch = records.slice(i, i + size) as Array<StoreValue<typeof store>>;
      await putMany(store, batch, "restore the backup");
      counts[store] += batch.length;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Single-engine files

interface EngineFileNetwork {
  record: NetworkRecord;
  data: NetworkDataRecord;
}

const ENGINE_KINDS: readonly EngineKind[] = ["blocks", "eval", "full", "scratch", "nnue", "wasm"];
const DEFAULT_ENGINE_COLOR = "#94a3b8";

/**
 * Export one engine — its sources / blocks / module plus the network it uses (weights included) —
 * as a JSON file. The compiled build is left out: it is recreated on first use after import.
 */
export async function exportEngineFile(id: string): Promise<Blob> {
  const engine = await enginesRepo.get(id);
  if (!engine) throw new StorageError("not-found", "This engine no longer exists, so it cannot be exported.");
  let network: EngineFileNetwork | null = null;
  if (engine.networkId) {
    const [record, data] = await Promise.all([networksRepo.get(engine.networkId), networksRepo.getData(engine.networkId)]);
    if (record && data) network = { record, data };
  }
  const envelope = {
    format: ENGINE_FILE_FORMAT,
    version: ENGINE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    engine: { ...engine, build: null, networkId: network ? network.record.id : null },
    network,
  };
  return new Blob([JSON.stringify(encodeValue(envelope))], { type: "application/json" });
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === "string");

function parseEngine(value: unknown): EngineRecord {
  if (!isObject(value)) throw invalid("This engine file is damaged: it contains no engine.");
  const kind = value.kind;
  if (typeof kind !== "string" || !ENGINE_KINDS.includes(kind as EngineKind)) {
    throw invalid(`This engine file has an unknown engine type "${String(kind)}" — was it made by a newer version of Chess Builder?`);
  }
  if (value.files !== undefined && value.files !== null && !isStringRecord(value.files)) {
    throw invalid("This engine file is damaged: its source files are not text.");
  }
  if (kind === "wasm" && !isArrayBuffer(value.wasm)) {
    throw invalid("This engine file is damaged: its WebAssembly module is missing.");
  }
  const options = isObject(value.options) && typeof value.options.hashMb === "number" && value.options.hashMb > 0
    ? (value.options as unknown as EngineRecord["options"])
    : { hashMb: 16 };
  return {
    ...(value as unknown as EngineRecord),
    kind: kind as EngineKind,
    name: typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim() : "Imported engine",
    description: typeof value.description === "string" ? value.description : "",
    color: typeof value.color === "string" && value.color !== "" ? value.color : DEFAULT_ENGINE_COLOR,
    options,
    build: null,
  };
}

function parseNetwork(value: unknown): EngineFileNetwork {
  if (!isObject(value) || !isObject(value.record) || !isObject(value.data)) {
    throw invalid("This engine file is damaged: its network is incomplete.");
  }
  const record = value.record;
  const data = value.data;
  if (!isArrayBuffer(data.quantized)) throw invalid("This engine file is damaged: the network weights are missing.");
  if (typeof record.hidden !== "number" || (record.activation !== 0 && record.activation !== 1)) {
    throw invalid("This engine file is damaged: the network description is invalid.");
  }
  return {
    record: {
      ...(record as unknown as NetworkRecord),
      name: typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : "Imported network",
      description: typeof record.description === "string" ? record.description : "",
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : data.quantized.byteLength,
      stats: isObject(record.stats)
        ? (record.stats as unknown as NetworkRecord["stats"])
        : { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
    },
    data: {
      ...(data as unknown as NetworkDataRecord),
      float: isObject(data.float) ? (data.float as unknown as NetworkDataRecord["float"]) : null,
      optimizer: isObject(data.optimizer) ? (data.optimizer as unknown as NetworkDataRecord["optimizer"]) : null,
    },
  };
}

/** `name`, or `name (imported)` / `name (imported 2)` ... if that name is taken (case-insensitive). */
export function uniqueImportName(name: string, taken: readonly string[]): string {
  const norm = (s: string) => s.trim().toLocaleLowerCase();
  const used = new Set(taken.map(norm));
  if (!used.has(norm(name))) return name;
  let candidate = `${name} (imported)`;
  for (let n = 2; used.has(norm(candidate)); n++) candidate = `${name} (imported ${n})`;
  return candidate;
}

/**
 * Import a file made by exportEngineFile(). The engine (and its network) get new ids, so importing
 * the same file twice gives two copies; a clashing name gets " (imported)" appended. Any build in
 * the file is dropped (rebuilt on first use). Resolves with the new engine id.
 */
export async function importEngineFile(file: Blob): Promise<string> {
  const raw = await readJsonFile(file, "engine file");
  if (!isObject(raw) || raw.format !== ENGINE_FILE_FORMAT) {
    if (isObject(raw) && raw.format === BACKUP_FORMAT) {
      throw invalid("This is a full backup, not a single engine — restore it from Settings instead.");
    }
    throw invalid("This file is not a Chess Builder engine file.");
  }
  if (typeof raw.version !== "number" || raw.version > ENGINE_FILE_VERSION) {
    throw invalid("This engine file was made by a newer version of Chess Builder. Reload the page to update the app, then try again.");
  }
  const engine = parseEngine(decodeValue(raw.engine));
  const network = raw.network === null || raw.network === undefined ? null : parseNetwork(decodeValue(raw.network));

  const now = Date.now();
  const engineId = newId();
  const networkId = network ? newId() : null;
  await withTransaction("import the engine", ["engines", "networks", "networkData"], "readwrite", async (tx) => {
    const engines = tx.objectStore("engines");
    const existing = await engines.getAll();
    if (network && networkId) {
      const nets = tx.objectStore("networks");
      const existingNets = await nets.getAll();
      const parent = network.record.parentId;
      await nets.put({
        ...network.record,
        id: networkId,
        name: uniqueImportName(network.record.name, existingNets.map((n) => n.name)),
        parentId: parent && existingNets.some((n) => n.id === parent) ? parent : null,
        createdAt: now,
        updatedAt: now,
        builtin: false,
      });
      await tx.objectStore("networkData").put({ ...network.data, id: networkId });
    }
    const parent = engine.parentId;
    await engines.put({
      ...engine,
      id: engineId,
      name: uniqueImportName(engine.name, existing.map((e) => e.name)),
      parentId: parent && existing.some((e) => e.id === parent) ? parent : null,
      networkId,
      createdAt: now,
      updatedAt: now,
      build: null,
      builtin: false,
    });
  });
  const events: ChangeEvent[] = [{ store: "engines", id: engineId, op: "put" }];
  if (networkId) {
    events.push({ store: "networks", id: networkId, op: "put" }, { store: "networkData", id: networkId, op: "put" });
  }
  emitChanges(events);
  return engineId;
}
