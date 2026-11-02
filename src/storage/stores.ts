// Object store names of the "chess-builder" IndexedDB database (docs/ARCHITECTURE.md §4).
// Kept in a dependency-free module so db.ts and events.ts can both use it without an import cycle.

export type StoreName =
  | "engines"
  | "networks"
  | "networkData"
  | "datasets"
  | "datasetChunks"
  | "games"
  | "matches"
  | "trainingRuns"
  | "settings";

export const STORE_NAMES: readonly StoreName[] = Object.freeze([
  "engines",
  "networks",
  "networkData",
  "datasets",
  "datasetChunks",
  "games",
  "matches",
  "trainingRuns",
  "settings",
] as const);

const STORE_SET: ReadonlySet<string> = new Set(STORE_NAMES);

export function isStoreName(value: unknown): value is StoreName {
  return typeof value === "string" && STORE_SET.has(value);
}
