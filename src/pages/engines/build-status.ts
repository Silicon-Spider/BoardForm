// Build state of each engine card ("Built · 75 KB", "Not built yet", "Sources changed since the
// last build"). Checking a build hashes the engine's assembled sources (isBuildCurrent), so the
// result is cached per engine *version* (id + updatedAt) and checks run a few at a time: a library
// of ~200 engines hashes each engine once, not on every render.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isBuildCurrent } from "@/engine-host";
import type { EngineRecord } from "@/types";

export type BuildStatus =
  | { state: "checking" }
  | { state: "built"; sizeBytes: number; builtAt: number }
  | { state: "stale"; sizeBytes: number; builtAt: number }
  | { state: "none" }
  | { state: "uploaded"; sizeBytes: number }
  | { state: "no-module" };

/** Size of stored module bytes (realm-independent check, like the storage layer's). */
const byteLength = (b: unknown): number =>
  Object.prototype.toString.call(b) === "[object ArrayBuffer]" ? (b as ArrayBuffer).byteLength : 0;

/**
 * The status when it can be known without hashing (uploaded modules, engines never built), or
 * null when the stored build has to be compared with the sources.
 */
export function immediateBuildStatus(engine: EngineRecord): BuildStatus | null {
  if (engine.kind === "wasm") {
    const size = byteLength(engine.wasm);
    return size > 0 ? { state: "uploaded", sizeBytes: size } : { state: "no-module" };
  }
  if (!engine.build || byteLength(engine.build.wasm) === 0) return { state: "none" };
  return null;
}

/** Status once isBuildCurrent() has answered. */
export function checkedBuildStatus(engine: EngineRecord, current: boolean): BuildStatus {
  const build = engine.build;
  if (!build) return { state: "none" };
  const sizeBytes = build.sizeBytes || byteLength(build.wasm);
  return current ? { state: "built", sizeBytes, builtAt: build.builtAt } : { state: "stale", sizeBytes, builtAt: build.builtAt };
}

// --- cache + check queue -----------------------------------------------------------------------

const CHECKING: BuildStatus = { state: "checking" };
/** Hashes running at once (each takes a few ms; this keeps the main thread smooth). */
const MAX_PARALLEL_CHECKS = 3;

/** Status per engine version ("<id>@<updatedAt>"); only the newest version of an engine is kept. */
const statuses = new Map<string, BuildStatus>();
const storedKey = new Map<string, string>();
/** Highest updatedAt seen per engine: results for older versions are dropped. */
const newestVersion = new Map<string, number>();
const queued = new Set<string>();
const queue: Array<{ key: string; engine: EngineRecord }> = [];
let running = 0;
const listeners = new Set<() => void>();

const versionKey = (engine: EngineRecord) => `${engine.id}@${engine.updatedAt}`;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(engine: EngineRecord, key: string, status: BuildStatus): BuildStatus {
  const previous = storedKey.get(engine.id);
  if (previous !== undefined && previous !== key) statuses.delete(previous);
  storedKey.set(engine.id, key);
  statuses.set(key, status);
  return status;
}

function noteVersion(engine: EngineRecord): void {
  const seen = newestVersion.get(engine.id);
  if (seen === undefined || engine.updatedAt > seen) newestVersion.set(engine.id, engine.updatedAt);
}

/** Cached status of this engine version (a stable object, as useSyncExternalStore requires). */
function statusFor(engine: EngineRecord): BuildStatus {
  const key = versionKey(engine);
  const cached = statuses.get(key);
  if (cached) return cached;
  noteVersion(engine);
  const immediate = immediateBuildStatus(engine);
  // Caching during render is safe: the value is a pure function of the record.
  return immediate ? store(engine, key, immediate) : CHECKING;
}

function pump(): void {
  while (running < MAX_PARALLEL_CHECKS && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    isBuildCurrent(job.engine)
      .catch(() => false)
      .then((current) => {
        // A newer version of the engine appeared meanwhile: its own check will report.
        if ((newestVersion.get(job.engine.id) ?? -Infinity) > job.engine.updatedAt) return;
        store(job.engine, job.key, checkedBuildStatus(job.engine, current));
        for (const l of listeners) l();
      })
      .finally(() => {
        queued.delete(job.key);
        running--;
        pump();
      });
  }
}

function requestCheck(engine: EngineRecord): void {
  const key = versionKey(engine);
  if (statuses.has(key) || queued.has(key)) return;
  queued.add(key);
  queue.push({ key, engine });
  pump();
}

/** The engine's build status; "checking" until its sources have been hashed once. */
export function useBuildStatus(engine: EngineRecord): BuildStatus {
  const getSnapshot = useCallback(() => statusFor(engine), [engine]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (status.state === "checking") requestCheck(engine);
  }, [status, engine]);
  return status;
}
