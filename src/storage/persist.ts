// Persistent-storage permission and quota estimate (StorageManager). Worker-safe: in workers only
// estimate() / persisted() exist, persist() is window-only and reports false there.

export interface StorageEstimateInfo {
  /** Bytes used by this origin; NaN when the browser does not say. */
  usage: number;
  /** Bytes this origin may use; NaN when the browser does not say. */
  quota: number;
  /** True when the browser promised not to evict this origin's data under storage pressure. */
  persisted: boolean;
}

function storageManager(): StorageManager | null {
  if (typeof navigator === "undefined") return null;
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
  return storage ?? null;
}

/**
 * Ask the browser to keep this site's data even under storage pressure ("persistent storage").
 * Resolves true if storage is (now) persistent. Never rejects. Chrome decides silently; Firefox
 * may show a permission prompt, in which case this resolves only after the user answers — so do
 * not block UI on it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = storageManager();
  if (!storage) return false;
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true;
    if (typeof storage.persist !== "function") return false;
    return await storage.persist();
  } catch {
    return false;
  }
}

/** How much storage the app uses and may use. Never rejects (unknown values are NaN / false). */
export async function storageEstimate(): Promise<StorageEstimateInfo> {
  const storage = storageManager();
  let usage = Number.NaN;
  let quota = Number.NaN;
  let persisted = false;
  if (storage) {
    try {
      if (typeof storage.estimate === "function") {
        const est = await storage.estimate();
        if (typeof est.usage === "number") usage = est.usage;
        if (typeof est.quota === "number") quota = est.quota;
      }
    } catch {
      /* unknown */
    }
    try {
      if (typeof storage.persisted === "function") persisted = await storage.persisted();
    } catch {
      /* unknown */
    }
  }
  return { usage, quota, persisted };
}
