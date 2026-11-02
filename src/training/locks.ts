// Web Locks for runs: the tab that executes a run holds "boardform:run:<id>" until it stops,
// so a second tab (or a reload racing the old page) never runs it twice. Without the Web Locks
// API every acquire succeeds (single-tab behaviour).
import { runLockName } from "./constants";
import type { LockHandle, RunLocks } from "./deps";

interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string }> }>;
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/** RunLocks over a Web Locks LockManager (navigator.locks by default). */
export function createWebRunLocks(manager: LockManagerLike | null = lockManager()): RunLocks {
  return {
    acquire(runId) {
      if (!manager) return Promise.resolve({ release() {} });
      return new Promise<LockHandle | null>((resolve) => {
        let settled = false;
        manager
          .request(runLockName(runId), { ifAvailable: true }, (lock) => {
            settled = true;
            if (!lock) {
              resolve(null);
              return;
            }
            // Held until release() resolves this promise.
            return new Promise<void>((release) => resolve({ release: () => release() }));
          })
          .catch(() => {
            // The API exists but is unusable here (e.g. SecurityError): behave like a single tab.
            if (!settled) resolve({ release() {} });
          });
      });
    },
    async isHeld(runId) {
      if (!manager || typeof manager.query !== "function") return null;
      try {
        const snapshot = await manager.query();
        const name = runLockName(runId);
        return (snapshot.held ?? []).some((l) => l.name === name);
      } catch {
        return null;
      }
    },
  };
}
