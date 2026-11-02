// Engine template sources bundled as raw strings (see docs/ENGINE_TEMPLATE.md).
import type { EngineKind } from "@/types";

const templateGlob = import.meta.glob("/engine/template/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const variantGlob = import.meta.glob("/engine/variants/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function stripPrefix(map: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const idx = k.indexOf(prefix);
    out[idx >= 0 ? k.slice(idx + prefix.length) : k] = v;
  }
  return out;
}

/** Bump whenever engine/template changes in a way that should rebuild eval-only engines. */
export const TEMPLATE_VERSION = 1;

/** Canonical template files keyed by file name, e.g. "main.ts", "eval.ts". */
export const templateFiles: Readonly<Record<string, string>> = Object.freeze(stripPrefix(templateGlob, "/engine/template/"));

/** Variant files keyed by path under engine/variants, e.g. "eval-nnue.ts", "scratch-empty/main.ts". */
export const variantFiles: Readonly<Record<string, string>> = Object.freeze(stripPrefix(variantGlob, "/engine/variants/"));

/** Files that a scratch engine starts with. */
export function scratchFiles(variant: "empty" | "minimal"): Record<string, string> {
  const prefix = variant === "empty" ? "scratch-empty/" : "scratch-minimal/";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variantFiles)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/**
 * The `files` a freshly created engine of the given kind stores.
 * (blocks: the caller must add the generated "eval.ts" from @/blocks.)
 */
export function defaultFilesFor(kind: EngineKind): Record<string, string> {
  switch (kind) {
    case "eval":
      return { "eval.ts": templateFiles["eval.ts"] ?? "" };
    case "nnue":
      return { "eval.ts": variantFiles["eval-nnue.ts"] ?? templateFiles["eval.ts"] ?? "" };
    case "full":
      return { ...templateFiles };
    case "scratch":
      return scratchFiles("minimal");
    case "blocks":
    case "wasm":
      return {};
  }
}

/** True for kinds whose non-overridden files come from the live template. */
export function usesTemplate(kind: EngineKind): boolean {
  return kind === "blocks" || kind === "eval" || kind === "nnue";
}
