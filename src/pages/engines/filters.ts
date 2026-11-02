// Searching, filtering and sorting the Engine Library. Pure functions (unit-tested in
// filters.test.ts); the page memoizes their results, so ~200 engines stay instant.
import type { EngineKind, EngineRecord } from "@/types";

export const ENGINE_KINDS: readonly EngineKind[] = ["blocks", "eval", "full", "scratch", "nnue", "wasm"];

export type KindFilter = EngineKind | "all";
export type LibrarySort = "updated" | "name" | "kind" | "created";

export const LIBRARY_SORTS: ReadonlyArray<{ id: LibrarySort; label: string }> = [
  { id: "updated", label: "Recently updated" },
  { id: "name", label: "Name" },
  { id: "kind", label: "Kind" },
  { id: "created", label: "Created" },
];

/** Settings keys (useSetting) that remember the library's filter and sort order. */
export const KIND_FILTER_SETTING = "library.kindFilter";
export const SORT_SETTING = "library.sort";

export function isEngineKind(value: unknown): value is EngineKind {
  return typeof value === "string" && (ENGINE_KINDS as readonly string[]).includes(value);
}

export function isKindFilter(value: unknown): value is KindFilter {
  return value === "all" || isEngineKind(value);
}

export function isLibrarySort(value: unknown): value is LibrarySort {
  return LIBRARY_SORTS.some((s) => s.id === value);
}

/** Lower-case, accents removed, whitespace collapsed — so "Élan" matches "elan". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a query; every word must appear somewhere in the engine's text. */
export function searchTokens(query: string): string[] {
  const text = normalizeSearchText(query);
  return text ? text.split(" ") : [];
}

// Engine records are immutable snapshots with stable identities, so their search text can be
// cached per object (a changed engine is a new object and gets fresh text).
const haystacks = new WeakMap<EngineRecord, string>();

function haystackOf(engine: EngineRecord): string {
  let text = haystacks.get(engine);
  if (text === undefined) {
    const tags = Array.isArray(engine.tags) ? engine.tags.join(" ") : "";
    text = normalizeSearchText(`${engine.name ?? ""}\n${engine.description ?? ""}\n${tags}`);
    haystacks.set(engine, text);
  }
  return text;
}

/** True when the engine's name, description or tags contain every search word. */
export function engineMatches(engine: EngineRecord, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const text = haystackOf(engine);
  return tokens.every((t) => text.includes(t));
}

export function filterEngines(engines: readonly EngineRecord[], opts: { query: string; kind: KindFilter }): EngineRecord[] {
  const tokens = searchTokens(opts.query);
  return engines.filter((e) => (opts.kind === "all" || e.kind === opts.kind) && engineMatches(e, tokens));
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: EngineRecord, b: EngineRecord) => collator.compare(a.name ?? "", b.name ?? "") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const kindRank = (k: EngineKind) => {
  const i = ENGINE_KINDS.indexOf(k);
  return i < 0 ? ENGINE_KINDS.length : i;
};

/** A sorted copy (the input list is shared, read-only hook data). */
export function sortEngines(engines: readonly EngineRecord[], sort: LibrarySort): EngineRecord[] {
  const list = [...engines];
  switch (sort) {
    case "name":
      return list.sort(byName);
    case "kind":
      return list.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || byName(a, b));
    case "created":
      return list.sort((a, b) => time(b.createdAt) - time(a.createdAt) || byName(a, b));
    case "updated":
      return list.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || byName(a, b));
  }
}

/** Number of engines per kind, plus "all". */
export function countByKind(engines: readonly EngineRecord[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: engines.length, blocks: 0, eval: 0, full: 0, scratch: 0, nnue: 0, wasm: 0 };
  for (const e of engines) if (isEngineKind(e.kind)) counts[e.kind]++;
  return counts;
}
