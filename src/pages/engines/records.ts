// Pure record logic for the Engine Library: building a new engine per approach, duplicating an
// engine, name suggestions and default colours. No React and no storage, so it is unit-tested in
// Node (records.test.ts). The page passes in ids, timestamps and the default hash size.
import { DEFAULT_WORKSPACE } from "@/blocks/default-workspace";
import { GENERATOR_VERSION, generateEvalSource } from "@/blocks/generator";
import { TEMPLATE_VERSION, defaultFilesFor, scratchFiles } from "@/engine-host/templates";
import { deepEqual } from "@/storage/equal";
import type { EngineKind, EngineRecord } from "@/types";

/** The ways to start an engine offered by the new-engine wizard (an engine kind, or a copy). */
export type Approach = EngineKind | "copy";

/** Starting point of a scratch engine (engine/variants/scratch-empty or scratch-minimal). */
export type ScratchVariant = "empty" | "minimal";

export interface NewEngineDetails {
  approach: Approach;
  name: string;
  description: string;
  color: string;
  /** scratch: which skeleton to start from (default "minimal"). */
  scratchVariant?: ScratchVariant;
  /** nnue: the chosen network. wasm: the chosen network, used only when the module supports NNUE. */
  networkId?: string | null;
  /** wasm: the uploaded module bytes. */
  wasm?: ArrayBuffer | null;
  /** wasm: the module exports cb_nnue_alloc and cb_nnue_load. */
  wasmSupportsNnue?: boolean;
  /** copy: the engine to copy. */
  source?: EngineRecord | null;
}

/** Values the caller supplies so record construction stays pure (and testable). */
export interface RecordContext {
  id: string;
  now: number;
  /** getDefaultHashMb() — the user's default transposition-table size. */
  hashMb: number;
}

export const MAX_NAME_LENGTH = 80;

const normalizeName = (s: string) => s.trim().toLocaleLowerCase();

/** `base` + `suffix`, shortening `base` so the name stays within MAX_NAME_LENGTH. */
const withSuffix = (base: string, suffix: string) => `${base.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trimEnd()}${suffix}`;

/** `base`, or `base 2`, `base 3` ... — the first that no engine uses yet (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, normalizeName));
  const b = base.trim() || "Untitled engine";
  if (!used.has(normalizeName(b))) return b;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(b, ` ${n}`);
    if (!used.has(normalizeName(candidate))) return candidate;
  }
}

/**
 * `name (copy)`, or `name (copy 2)` ... when taken. Copying a copy does not stack suffixes:
 * "Blocky (copy)" becomes "Blocky (copy 2)", not "Blocky (copy) (copy)".
 */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, normalizeName));
  const trimmed = name.trim() || "Untitled engine";
  const base = trimmed.replace(/\s*\(copy(?:\s+\d+)?\)$/i, "").trim() || trimmed;
  const first = withSuffix(base, " (copy)");
  if (!used.has(normalizeName(first))) return first;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(base, ` (copy ${n})`);
    if (!used.has(normalizeName(candidate))) return candidate;
  }
}

const BASE_NAMES: Record<Approach, string> = {
  blocks: "My blocks engine",
  eval: "My eval engine",
  full: "My engine",
  scratch: "My scratch engine",
  nnue: "My NNUE engine",
  wasm: "My uploaded engine",
  copy: "My engine",
};

/** What the name suggestion can be derived from, besides the approach. */
export interface NameHints {
  /** copy: the engine being copied. */
  source?: EngineRecord | null;
  /** nnue: name of the chosen network. */
  networkName?: string | null;
  /** wasm: the name the module reports through cb_name. */
  moduleName?: string | null;
  /** wasm: the uploaded file's name. */
  fileName?: string | null;
}

/** File name without its directory and extension ("engines/my-bot.wasm" → "my-bot"). */
export function fileBaseName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? fileName;
  return leaf.replace(/\.[^.]+$/, "").trim();
}

/** A unique, descriptive default name for a new engine (e.g. "My blocks engine 2"). */
export function suggestName(approach: Approach, taken: readonly string[], hints: NameHints = {}): string {
  if (approach === "copy" && hints.source) return copyName(hints.source.name, taken);
  if (approach === "wasm") {
    const fromModule = hints.moduleName?.trim();
    const fromFile = hints.fileName ? fileBaseName(hints.fileName) : "";
    const base = (fromModule || fromFile).slice(0, MAX_NAME_LENGTH);
    if (base) return uniqueName(base, taken);
  }
  if (approach === "nnue" && hints.networkName?.trim()) {
    return uniqueName(`${hints.networkName.trim()} engine`.slice(0, MAX_NAME_LENGTH), taken);
  }
  return uniqueName(BASE_NAMES[approach], taken);
}

/** Accent colours offered for engines (cards, charts, arena standings). */
export const ENGINE_COLORS: ReadonlyArray<{ value: string; name: string }> = [
  { value: "#5b9cf5", name: "Blue" },
  { value: "#4cc38a", name: "Green" },
  { value: "#f59e0b", name: "Amber" },
  { value: "#ef6363", name: "Red" },
  { value: "#a78bfa", name: "Violet" },
  { value: "#f472b6", name: "Pink" },
  { value: "#22d3ee", name: "Cyan" },
  { value: "#fb923c", name: "Orange" },
  { value: "#a3e635", name: "Lime" },
  { value: "#e879f9", name: "Fuchsia" },
  { value: "#eab308", name: "Gold" },
  { value: "#94a3b8", name: "Slate" },
];

/** The first palette colour no engine uses yet, so new engines are easy to tell apart. */
export function pickDefaultColor(usedColors: readonly string[]): string {
  const used = new Set(usedColors.map((c) => c.trim().toLowerCase()));
  const free = ENGINE_COLORS.find((c) => !used.has(c.value));
  return (free ?? ENGINE_COLORS[usedColors.length % ENGINE_COLORS.length]).value;
}

/** A CSS hex colour (#rgb or #rrggbb). */
export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** Tag the seed gives the built-in starter engines (it goes with `builtin: true`). */
export const STARTER_TAG = "starter";

/**
 * The freshly seeded starter engines that are not needed because the library already has an
 * identical twin: a starter engine with the same kind and name whose blocks and source files are
 * unchanged. "Restore starter engines" removes these again, so restoring never doubles a starter
 * the user still has, while starters that were deleted or edited come back as fresh copies.
 */
export function redundantRestoredStarters(existing: readonly EngineRecord[], fresh: readonly EngineRecord[]): string[] {
  const norm = (s: string | undefined) => (s ?? "").trim().toLocaleLowerCase();
  return fresh
    .filter((f) =>
      existing.some(
        (e) =>
          e.id !== f.id &&
          e.builtin &&
          e.kind === f.kind &&
          norm(e.name) === norm(f.name) &&
          deepEqual(e.files ?? null, f.files ?? null) &&
          deepEqual(e.blocks ?? null, f.blocks ?? null),
      ),
    )
    .map((f) => f.id);
}

/**
 * A copy of `source`: a deep clone with a new id and name, not built-in, `parentId` pointing at the
 * original and fresh timestamps. Files, blocks, the uploaded module, the network and the build are
 * kept, so the copy plays exactly like the original right away. A copy is not a starter engine,
 * so it does not inherit the "starter" tag (other tags are kept).
 */
export function duplicateEngineRecord(source: EngineRecord, ctx: { id: string; now: number; name: string }): EngineRecord {
  const copy = structuredClone(source);
  return {
    ...copy,
    id: ctx.id,
    name: ctx.name,
    builtin: false,
    tags: Array.isArray(copy.tags) ? copy.tags.filter((t) => t !== STARTER_TAG) : [],
    parentId: source.id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/**
 * The record of a new engine (docs/ARCHITECTURE.md §4): which files it stores depends on the
 * approach. Throws (with a user-facing message) when required input is missing.
 */
export function createEngineRecord(details: NewEngineDetails, ctx: RecordContext): EngineRecord {
  const name = details.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new Error("Give your engine a name.");
  const description = details.description.trim();
  const color = isHexColor(details.color) ? details.color.trim() : pickDefaultColor([]);

  if (details.approach === "copy") {
    if (!details.source) throw new Error("Choose the engine to copy.");
    return { ...duplicateEngineRecord(details.source, { id: ctx.id, now: ctx.now, name }), description, color };
  }

  const common = {
    id: ctx.id,
    name,
    description,
    color,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    options: { hashMb: ctx.hashMb },
    builtin: false,
    tags: [] as string[],
    build: null,
    networkId: null as string | null,
    parentId: null,
  } satisfies Partial<EngineRecord>;

  switch (details.approach) {
    case "blocks": {
      // DEFAULT_WORKSPACE is deep-frozen; the engine gets its own editable copy.
      const blocks = structuredClone(DEFAULT_WORKSPACE);
      return {
        ...common,
        kind: "blocks",
        blocks,
        files: { "eval.ts": generateEvalSource(blocks).code },
        generatorVersion: GENERATOR_VERSION,
        entry: "main.ts",
        templateVersion: TEMPLATE_VERSION,
      };
    }
    case "eval":
    case "full":
      // eval stores only eval.ts (the rest comes from the live template); full stores the whole tree.
      return { ...common, kind: details.approach, files: defaultFilesFor(details.approach), entry: "main.ts", templateVersion: TEMPLATE_VERSION };
    case "nnue":
      return {
        ...common,
        kind: "nnue",
        files: defaultFilesFor("nnue"),
        entry: "main.ts",
        templateVersion: TEMPLATE_VERSION,
        networkId: details.networkId || null,
      };
    case "scratch":
      return { ...common, kind: "scratch", files: scratchFiles(details.scratchVariant ?? "minimal"), entry: "main.ts" };
    case "wasm": {
      const wasm = details.wasm;
      if (!wasm || wasm.byteLength === 0) throw new Error("Choose a .wasm file first.");
      return {
        ...common,
        kind: "wasm",
        wasm,
        networkId: details.wasmSupportsNnue && details.networkId ? details.networkId : null,
      };
    }
  }
}
