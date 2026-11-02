// Source-tree helpers for full / scratch engines: path validation, rename / delete with the entry
// file and open editor tabs kept consistent. Pure functions (unit-tested).

// Path validation itself is shared with the file tree: validateFilePath / normalizeFilePath from
// @/components/code.

/** "helpers" → "helpers.ts" (only when the last segment has no extension), like the file tree. */
export function withExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base !== "" && !base.includes(".") ? path + ".ts" : path;
}

/**
 * Starter contents of a newly created file. The hints use import paths that work from where the
 * file is (`../position` inside `lib/`); `others` are the engine's other files (a `Position`
 * example only makes sense when there is a position.ts) and `entry` is the entry file.
 */
export function newFileContents(path: string, others: readonly string[] = [], entry = "main.ts"): string {
  const name = path.split("/").pop() ?? path;
  if (path === entry) {
    return [`// ${name} — the entry file`, "//", "// Export the cb_* functions of the Engine ABI from here (Help → Engine ABI).", "", ""].join("\n");
  }
  const lines = [`// ${name}`, "//"];
  if (others.includes("position.ts")) {
    lines.push("// Import what you need from the other files, for example:", `//   import { Position } from "${importSpecifier(path, "position.ts")}";`);
  } else {
    lines.push("// Mark the functions and constants other files need with `export`.");
  }
  lines.push(`// Use this module in ${entry} with  import { ... } from "${importSpecifier(entry, path)}";`, "", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Imports between the engine's files

/** The relative import specifier for `to` as written in file `from` (no ".ts"): "./lib/util", "../position". */
export function importSpecifier(from: string, to: string): string {
  const fromDir = from.split("/").slice(0, -1);
  const target = to.replace(/\.ts$/, "").split("/");
  let common = 0;
  while (common < fromDir.length && common < target.length - 1 && fromDir[common] === target[common]) common++;
  const up = fromDir.length - common;
  return (up === 0 ? "./" : "../".repeat(up)) + target.slice(common).join("/");
}

/** The engine path a relative specifier in file `from` points to, without ".ts"; null if it leaves the engine. */
export function resolveSpecifier(from: string, specifier: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of specifier.replace(/\.ts$/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** `import … from "./x"`, `export … from "./x"` and `import "./x"` with a relative specifier. */
const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*)(["'])(\.\.?\/[^"'\n]*)\2/g;

/** Rewrites the relative specifiers of `source` (a file at `path`); `map` returns the new one or null to keep it. */
function rewriteSpecifiers(source: string, map: (specifier: string) => string | null): string {
  return source.replace(RELATIVE_IMPORT, (all: string, lead: string, quote: string, spec: string) => {
    const next = map(spec);
    return next === null || next === spec ? all : `${lead}${quote}${next}${quote}`;
  });
}

/** Files (other than `path` itself) whose relative imports point to `path`. */
export function importersOf(files: Readonly<Record<string, string>>, path: string): string[] {
  const target = path.replace(/\.ts$/, "");
  const out: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (file === path) continue;
    for (const m of source.matchAll(RELATIVE_IMPORT)) {
      if (resolveSpecifier(file, m[3]) === target) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}

/**
 * Renames `from` to `to` and keeps the imports working: specifiers in other files that pointed to
 * `from` now point to `to`, and the renamed file's own relative imports are adjusted when it moved
 * to another folder. Returns the new files and the files whose imports were changed.
 */
export function renameWithImports(files: Readonly<Record<string, string>>, from: string, to: string): { files: Record<string, string>; updated: string[] } {
  const target = from.replace(/\.ts$/, "");
  const updated: string[] = [];
  const out: Record<string, string> = {};
  for (const [file, source] of Object.entries(files)) {
    let next: string;
    if (file === from) {
      // Its own imports: same targets, seen from the new folder.
      next = rewriteSpecifiers(source, (spec) => {
        const resolved = resolveSpecifier(from, spec);
        if (resolved === null) return null;
        const respelled = importSpecifier(to, resolved === target ? to : resolved + ".ts");
        return spec.endsWith(".ts") ? respelled + ".ts" : respelled;
      });
    } else {
      next = rewriteSpecifiers(source, (spec) => {
        if (resolveSpecifier(file, spec) !== target) return null;
        const respelled = importSpecifier(file, to);
        return spec.endsWith(".ts") ? respelled + ".ts" : respelled;
      });
    }
    if (next !== source) updated.push(file === from ? to : file);
    out[file === from ? to : file] = next;
  }
  return { files: out, updated };
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
