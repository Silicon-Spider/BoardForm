// Build state of the engines open in the Workshop: whether a build is running (with its progress
// text) and the result of the last one. Module-level, so the build log survives switching tabs or
// leaving and re-opening the page during a session; the successful build itself is persisted in
// the engine record by buildEngine().
import { create } from "zustand";
import { assembleSources, buildEngine, sourceHashOf } from "@/engine-host";
import { REQUIRED_FUNCTIONS } from "@/engine-host/abi";
import type { CompileResult, EngineRecord } from "@/types";

export interface BuildRun {
  /** Increasing number per page session (lets effects notice a new run). */
  seq: number;
  at: number;
  ok: boolean;
  /** True when the compiler ran (false: the saved build was already up to date). */
  compiled: boolean;
  result: CompileResult | null;
  /** Hash of the sources that were built (null if they could not be assembled). */
  sourceHash: string | null;
  /** Wall-clock duration including loading the compiler. */
  wallMs: number;
  sizeBytes: number | null;
  /** A problem outside the compiler (no entry file, no generated code, ...). */
  problem: string | null;
  /**
   * Required ABI exports a successful build lacks (e.g. the entry file is not the one that
   * exports cb_go): the module compiled but cannot run as an engine. Empty or absent when fine.
   */
  missingExports?: string[];
}

export interface EngineBuildState {
  /** Number of builds running for this engine. */
  running: number;
  statusText: string | null;
  last: BuildRun | null;
}

const IDLE: EngineBuildState = Object.freeze({ running: 0, statusText: null, last: null });

interface Store {
  engines: Record<string, EngineBuildState>;
}

const useStore = create<Store>(() => ({ engines: {} }));

function patchEngine(id: string, patch: (s: EngineBuildState) => Partial<EngineBuildState>): void {
  useStore.setState((s) => {
    const prev = s.engines[id] ?? IDLE;
    return { engines: { ...s.engines, [id]: { ...prev, ...patch(prev) } } };
  });
}

export function useEngineBuild(engineId: string): EngineBuildState {
  return useStore((s) => s.engines[engineId] ?? IDLE);
}

export function getEngineBuild(engineId: string): EngineBuildState {
  return useStore.getState().engines[engineId] ?? IDLE;
}

let seq = 0;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The required ABI exports (docs/ENGINE_ABI.md) a compiled module lacks. Only compiles the module
 * (never instantiates it, so user code never runs on the main thread); [] when it cannot tell.
 */
export async function missingRequiredExports(wasm: ArrayBuffer): Promise<string[]> {
  try {
    const module = await WebAssembly.compile(wasm);
    const exports = WebAssembly.Module.exports(module);
    const has = (name: string, kind: WebAssembly.ImportExportKind) => exports.some((e) => e.name === name && e.kind === kind);
    const missing: string[] = REQUIRED_FUNCTIONS.filter((name) => !has(name, "function"));
    if (!has("memory", "memory") && !WebAssembly.Module.imports(module).some((i) => i.kind === "memory")) missing.push("memory");
    return missing;
  } catch {
    return [];
  }
}

/**
 * Builds the engine (unless its saved build is current and `force` is not set) and records the
 * outcome. The caller saves pending edits first: buildEngine persists the build into the stored
 * record. Never throws.
 */
export async function runBuild(
  engine: EngineRecord,
  opts: { force?: boolean; onStatus?: (s: string) => void } = {},
): Promise<{ run: BuildRun; engine: EngineRecord | null }> {
  const id = engine.id;
  const status = (text: string) => {
    patchEngine(id, () => ({ statusText: text }));
    opts.onStatus?.(text);
  };
  patchEngine(id, (s) => ({ running: s.running + 1, statusText: "Preparing…" }));
  const t0 = performance.now();
  let run: BuildRun;
  let saved: EngineRecord | null = null;
  let sourceHash: string | null = null;
  try {
    try {
      sourceHash = await sourceHashOf(assembleSources(engine));
    } catch {
      // buildEngine reports the same problem with its full message below.
    }
    const out = await buildEngine(engine, { force: opts.force, onStatus: status });
    saved = out.engine;
    const missingExports = out.ok && out.engine.build?.wasm ? await missingRequiredExports(out.engine.build.wasm) : [];
    run = {
      missingExports,
      seq: ++seq,
      at: Date.now(),
      ok: out.ok,
      compiled: !out.fromCache,
      result: out.result,
      sourceHash,
      wallMs: performance.now() - t0,
      sizeBytes: out.ok ? (out.engine.build?.sizeBytes ?? null) : null,
      problem: null,
    };
  } catch (err) {
    run = { seq: ++seq, at: Date.now(), ok: false, compiled: false, result: null, sourceHash, wallMs: performance.now() - t0, sizeBytes: null, problem: messageOf(err) };
  }
  patchEngine(id, (s) => {
    // A cache hit has nothing new to show: keep the previous result of the same sources.
    const keep = run.ok && !run.compiled && s.last?.ok && s.last.sourceHash === run.sourceHash;
    return { running: Math.max(0, s.running - 1), statusText: s.running > 1 ? s.statusText : null, last: keep ? s.last : run };
  });
  return { run, engine: saved };
}

/** Records a failed compilation that happened elsewhere (e.g. a BuildError from loadEngine). */
export async function recordFailedBuild(engine: EngineRecord, result: CompileResult): Promise<void> {
  let sourceHash: string | null = null;
  try {
    sourceHash = await sourceHashOf(assembleSources(engine));
  } catch {
    /* unknown */
  }
  const run: BuildRun = { seq: ++seq, at: Date.now(), ok: false, compiled: true, result, sourceHash, wallMs: result.timeMs, sizeBytes: null, problem: null };
  patchEngine(engine.id, () => ({ last: run }));
}
