// The header's build status pill ("Up to date · 74 KB", "Needs build", "Building…", "3 errors"),
// worked out from the engine, the build store and the hash of the current sources. Pure (types
// only), so it is unit-tested.
import type { CompileDiagnostic, CompileResult, EngineRecord } from "@/types";
import { formatBytes } from "@/utils/format";
import type { EngineBuildState } from "./build-store";

export interface BuildPillInfo {
  tone: "ok" | "warn" | "danger" | "accent" | "neutral";
  text: string;
  title?: string;
  spinner?: boolean;
}

export interface SourceHash {
  /** Hash of the current sources (null while it is being computed or cannot be). */
  hash: string | null;
  /** The sources cannot be assembled (e.g. missing entry file). */
  problem: string | null;
  /** Sequence number of the last build when this was worked out (see useSourceHash). */
  seq?: number;
}

/** Errors of a compile result. */
export function errorsOf(result: CompileResult | null | undefined): CompileDiagnostic[] {
  return result ? result.diagnostics.filter((d) => d.severity === "error") : [];
}

export function buildPillFor(view: EngineRecord, build: EngineBuildState, source: SourceHash): BuildPillInfo {
  if (view.kind === "wasm") return { tone: "neutral", text: view.wasm?.byteLength ? `Module · ${formatBytes(view.wasm.byteLength)}` : "No module" };
  if (build.running > 0) return { tone: "accent", text: build.statusText ?? "Building…", spinner: true };
  if (source.problem) return { tone: "danger", text: "Can't build", title: source.problem };
  const last = build.last;
  // The last build failed for exactly these sources (or we cannot tell which sources it built).
  if (last && !last.ok && (last.sourceHash === null || last.sourceHash === source.hash)) {
    const errors = errorsOf(last.result);
    return {
      tone: "danger",
      text: errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"}` : "Build failed",
      title: last.problem ?? errors[0]?.message ?? "Open the build log",
    };
  }
  if (!source.hash) return { tone: "neutral", text: "Checking…" };
  // It compiled, but the module lacks required ABI exports (wrong entry file, exports removed…).
  if (last?.ok && last.missingExports?.length && last.sourceHash === source.hash) {
    return { tone: "warn", text: "Not a working engine", title: `Built, but the module does not export ${last.missingExports.join(", ")}` };
  }
  if (view.build && view.build.sourceHash === source.hash) {
    return { tone: "ok", text: `Up to date · ${formatBytes(view.build.sizeBytes)}`, title: `Built ${new Date(view.build.builtAt).toLocaleString()} with ${view.build.compiler}` };
  }
  return { tone: "warn", text: view.build ? "Needs build" : "Not built yet", title: "The code changed since the last build" };
}
