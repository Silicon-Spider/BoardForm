// BoardForm's data in localStorage (everything else lives in IndexedDB).
//
// Every key the app writes starts with "cb." (from the app's original name, kept so existing
// data still works). The keys in use:
//   cb.theme                      colour theme (src/app/preferences.ts), read before first paint
//   cb.workshop.unsaved.<engineId> crash-recovery copy of unsaved Workshop edits (src/pages/workshop/unsaved.ts)
//   cb.play.snapshot              emergency copy of the running Play game (src/pages/play/persisted.ts)
// New keys must use the same prefix so "Delete all data" removes them too.

export const LOCAL_KEY_PREFIX = "cb.";

/** Keys that "Delete all data" keeps: the help promises that the colour theme survives. */
export const PRESERVED_LOCAL_KEYS: readonly string[] = ["cb.theme"];

/** The parts of the Storage interface the helpers need (window.localStorage, or a stand-in in tests). */
export type KeyedStorage = Pick<Storage, "length" | "key" | "removeItem">;

function defaultStorage(): KeyedStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked by privacy settings or a sandboxed frame
  }
}

/** Every BoardForm key currently in the storage. */
export function listLocalAppKeys(storage: KeyedStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(LOCAL_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    /* blocked storage: nothing readable */
  }
  return keys;
}

/**
 * Removes every BoardForm localStorage key except the preserved ones (the theme). Keys of other
 * apps on the same origin are left alone. Returns the removed keys. Never throws.
 */
export function clearLocalAppData(storage: KeyedStorage | null = defaultStorage()): string[] {
  // Collect first: removing while iterating by index would skip keys.
  const doomed = listLocalAppKeys(storage).filter((key) => !PRESERVED_LOCAL_KEYS.includes(key));
  const removed: string[] = [];
  for (const key of doomed) {
    try {
      storage?.removeItem(key);
      removed.push(key);
    } catch {
      /* keep going: remove as much as possible */
    }
  }
  return removed;
}
