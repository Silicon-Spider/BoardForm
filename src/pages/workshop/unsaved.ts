// Last-resort backup of the Workshop's unsaved edits in localStorage.
//
// Autosave writes to IndexedDB, which is asynchronous: an edit typed a moment before a reload or
// before the tab is closed starts its write in beforeunload / pagehide, but the browser may tear
// the page down before that write commits. localStorage writes are synchronous, so while the page
// is going away the Workshop also copies the not-yet-stored edits there. The next time the engine
// opens, edits that are newer than the stored record are applied again (and saved normally); the
// copy is removed as soon as everything is safely stored.
//
// No React: Workshop.tsx wires it up, the unit tests use an in-memory Storage.
import type { EngineRecord } from "@/types";

const PREFIX = "cb.workshop.unsaved.";

export interface UnsavedBackup {
  /** When the copy was written (Date.now()). */
  at: number;
  /** The edits (fields of EngineRecord) that were not stored yet. */
  patch: Partial<EngineRecord>;
}

/** Storage-like object (window.localStorage, or a stand-in in tests). */
export type BackupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): BackupStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // blocked storage (privacy settings, sandboxed frames)
  }
}

/** The patch without fields that cannot go through JSON (module bytes are flushed at once anyway). */
function serializablePatch(patch: Partial<EngineRecord>): Partial<EngineRecord> | null {
  const { wasm: _wasm, build: _build, ...rest } = patch;
  return Object.keys(rest).length > 0 ? rest : null;
}

/** Stores a copy of unsaved edits. Returns false when there was nothing to store or it failed. */
export function writeBackup(engineId: string, patch: Partial<EngineRecord>, at: number, storage: BackupStorage | null = defaultStorage()): boolean {
  const data = serializablePatch(patch);
  if (!storage || !data) return false;
  try {
    storage.setItem(PREFIX + engineId, JSON.stringify({ at, patch: data } satisfies UnsavedBackup));
    return true;
  } catch {
    return false; // quota or blocked storage: nothing more we can do while the page closes
  }
}

export function readBackup(engineId: string, storage: BackupStorage | null = defaultStorage()): UnsavedBackup | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFIX + engineId);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<UnsavedBackup> | null;
    if (!value || typeof value.at !== "number" || !Number.isFinite(value.at) || typeof value.patch !== "object" || value.patch === null) return null;
    return { at: value.at, patch: value.patch };
  } catch {
    return null;
  }
}

export function clearBackup(engineId: string, storage: BackupStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(PREFIX + engineId);
  } catch {
    /* blocked storage */
  }
}

/**
 * The backed-up edits that the stored record is still missing, or null. A record stored at or
 * after the moment of the backup already has them (or was changed since, e.g. in another tab,
 * and wins); re-applying edits that did get stored in the same millisecond is harmless.
 */
export function editsToRestore(backup: UnsavedBackup | null, stored: EngineRecord): Partial<EngineRecord> | null {
  if (!backup) return null;
  const storedAt = typeof stored.updatedAt === "number" && Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0;
  return storedAt <= backup.at ? backup.patch : null;
}
