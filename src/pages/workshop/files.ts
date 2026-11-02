// Source-tree helpers for full / scratch engines: path validation, rename / delete with the entry
// file and open editor tabs kept consistent. Pure functions (unit-tested).

// Path validation itself is shared with the file tree: validateFilePath / normalizeFilePath from
// @/components/code.

/** "helpers" → "helpers.ts" (only when the last segment has no extension), like the file tree. */
export function withExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base !== "" && !base.includes(".") ? path + ".ts" : path;
}

/** Starter contents of a newly created file. */
export function newFileContents(path: string): string {
  const name = path.split("/").pop() ?? path;
  const module = name.replace(/\.ts$/, "");
  return [
    `// ${name}`,
    "//",
    `// Import what you need from the other files, for example:`,
    `//   import { Position } from "./position";`,
    `// and use this module elsewhere with  import { ... } from "./${module}";`,
    "",
    "",
  ].join("\n");
}

/** Files with `from` renamed to `to` (key order kept). */
export function renameInFiles(files: Readonly<Record<string, string>>, from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k === from ? to : k] = v;
  return out;
}

export function withoutFile(files: Readonly<Record<string, string>>, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) if (k !== path) out[k] = v;
  return out;
}

/** Sorted paths: the entry file first, then folders before files, alphabetical. */
export function sortPaths(paths: readonly string[], entry: string): string[] {
  return [...paths].sort((a, b) => {
    if (a === entry) return -1;
    if (b === entry) return 1;
    const da = a.includes("/") ? 0 : 1;
    const db = b.includes("/") ? 0 : 1;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------------------------
// Open editor tabs

/** Adds `path` to the open tabs (at the end) unless it is already open. */
export function openTab(tabs: readonly string[], path: string): string[] {
  return tabs.includes(path) ? [...tabs] : [...tabs, path];
}

/**
 * Closes a tab. When the active tab closes, its right neighbour becomes active (else the left one,
 * else none).
 */
export function closeTab(tabs: readonly string[], path: string, active: string | null): { tabs: string[]; active: string | null } {
  const i = tabs.indexOf(path);
  if (i < 0) return { tabs: [...tabs], active };
  const next = tabs.filter((t) => t !== path);
  if (active !== path) return { tabs: next, active };
  return { tabs: next, active: next[i] ?? next[i - 1] ?? null };
}

export function renameTab(tabs: readonly string[], from: string, to: string): string[] {
  return tabs.map((t) => (t === from ? to : t));
}

/** Drops tabs whose files no longer exist and keeps at most `max` (the most recent ones). */
export function pruneTabs(tabs: readonly string[], files: readonly string[], max = 8): string[] {
  const set = new Set(files);
  const kept = tabs.filter((t) => set.has(t));
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}
