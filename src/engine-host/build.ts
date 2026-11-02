// Building and loading engines (docs/ARCHITECTURE.md §4–5).
//
// Sources are assembled per engine kind, hashed (sources + entry + compiler version + flags) and
// compiled only when the hash differs from the build stored in the engine record. Successful
// builds are saved into the record; a failed build leaves the previous one in place.
import { COMPILER_VERSION, compile } from "@/compiler";
import { failedResult } from "@/compiler/core";
import { formatDiagnostic } from "@/compiler/diagnostics";
import { normalizeFileMap, normalizePath } from "@/compiler/vfs";
import { enginesRepo, networksRepo, settingsRepo } from "@/storage/repos";
import type { CompileRequest, CompileResult, EngineBuildInfo, EngineRecord } from "@/types";
import { sha256Hex } from "@/utils/misc";
// The headless generator only (no Blockly, no React).
import { GENERATOR_VERSION, generateEvalSource } from "@/blocks/generator";
import { EngineClient } from "./client";
import { compileModule } from "./module-info";
import { TEMPLATE_VERSION, templateFiles, usesTemplate, variantFiles } from "./templates";

/** Compiler options of every engine build (part of the source hash). */
export const BUILD_OPTIONS = {
  optimizeLevel: 3,
  shrinkLevel: 0,
  runtime: "incremental",
  debug: false,
} as const satisfies Omit<CompileRequest, "files" | "entry">;

/** Settings key of the cached stock NNUE engine: `{ hash, wasm }`. */
export const STOCK_NNUE_SETTING = "build.stockNnue";

/** A build failed; `result` holds the diagnostics. */
export class BuildError extends Error {
  readonly result: CompileResult;
  constructor(result: CompileResult, what = "The engine") {
    const first = result.diagnostics.find((d) => d.severity === "error");
    super(`${what} failed to compile${first ? `: ${formatDiagnostic(first)}` : "."}`);
    this.name = "BuildError";
    this.result = result;
  }
}

export interface BuildOutcome {
  ok: boolean;
  /** Null when nothing was compiled (cache hit, or an uploaded wasm engine). */
  result: CompileResult | null;
  /** The engine record, with the new build when one was saved. */
  engine: EngineRecord;
  fromCache: boolean;
}

/** The complete source tree to compile for an engine (rules in docs/ARCHITECTURE.md §4). */
export function assembleSources(engine: EngineRecord): { files: Record<string, string>; entry: string } {
  const entry = normalizePath(engine.entry || "main.ts") || "main.ts";
  const own = normalizeFileMap(engine.files ?? {});
  let files: Record<string, string>;
  switch (engine.kind) {
    case "wasm":
      throw new Error(`“${engine.name}” is an uploaded WebAssembly module; it has no sources to compile.`);
    case "blocks": {
      // Generated from the Blockly workspace on every change; building never needs Blockly. Code
      // stored by an older generator is regenerated from the saved blocks (the generator is
      // headless and deterministic), so app updates to the generator reach every blocks engine.
      const stale = engine.blocks != null && (engine.generatorVersion ?? 0) < GENERATOR_VERSION;
      const generated = stale ? generateEvalSource(engine.blocks as object).code : own["eval.ts"];
      if (!generated || !generated.trim()) {
        throw new Error(`“${engine.name}” has no generated evaluation code yet. Open it in the Workshop to regenerate eval.ts from its blocks.`);
      }
      files = { ...templateFiles, "eval.ts": generated };
      break;
    }
    case "eval":
    case "nnue":
      files = { ...templateFiles, ...own };
      break;
    case "full":
    case "scratch":
      files = { ...own };
      break;
    default:
      throw new Error(`“${engine.name}” has an unknown engine kind “${String((engine as { kind: unknown }).kind)}”.`);
  }
  if (!(entry in files)) {
    throw new Error(`“${engine.name}” has no entry file ${entry}${Object.keys(files).length ? "" : " (it has no source files at all)"}.`);
  }
  return { files, entry };
}

/** sha256 of the canonical sources + entry + compiler version + build options. */
export async function sourceHashOf(sources: { files: Record<string, string>; entry: string }): Promise<string> {
  const files = Object.keys(sources.files)
    .sort()
    .map((name) => [name, sources.files[name]]);
  return sha256Hex(JSON.stringify({ files, entry: sources.entry, compiler: COMPILER_VERSION, flags: BUILD_OPTIONS }));
}

/** True when the stored build matches the engine's current sources (always true for "wasm"). */
export async function isBuildCurrent(engine: EngineRecord): Promise<boolean> {
  if (engine.kind === "wasm") return !!engine.wasm && engine.wasm.byteLength > 0;
  if (!engine.build?.wasm?.byteLength) return false;
  try {
    return engine.build.sourceHash === (await sourceHashOf(assembleSources(engine)));
  } catch {
    return false;
  }
}

function standaloneBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function compileStatusText(status: "loading-compiler" | "compiling"): string {
  return status === "loading-compiler" ? "Loading the compiler…" : "Compiling…";
}

interface InFlightBuild {
  promise: Promise<BuildOutcome>;
  listeners: Set<(s: string) => void>;
}
const inFlight = new Map<string, InFlightBuild>();

async function runBuild(engine: EngineRecord, sources: { files: Record<string, string>; entry: string }, hash: string, emit: (s: string) => void): Promise<BuildOutcome> {
  const result = await compile({ ...sources, ...BUILD_OPTIONS }, { onStatus: (s) => emit(compileStatusText(s)) });
  if (!result.ok || !result.wasm) return { ok: false, result, engine, fromCache: false };

  const build: EngineBuildInfo = {
    sourceHash: hash,
    wasm: standaloneBuffer(result.wasm),
    builtAt: Date.now(),
    compiler: result.compilerVersion,
    sizeBytes: result.wasm.byteLength,
    compileMs: Math.round(result.timeMs),
    warnings: result.diagnostics.filter((d) => d.severity === "warning").length,
  };
  const patch: Partial<EngineRecord> = usesTemplate(engine.kind) ? { build, templateVersion: TEMPLATE_VERSION } : { build };
  emit("Saving the build…");
  let saved: EngineRecord;
  try {
    saved = await enginesRepo.update(engine.id, patch);
  } catch (err) {
    // The engine still works this session; it will simply be recompiled next time.
    console.warn(`Could not save the build of "${engine.name}"`, err);
    saved = { ...engine, ...patch };
  }
  return { ok: true, result, engine: saved, fromCache: false };
}

/**
 * Compiles the engine unless its stored build is current (or `force`). Resolves with ok=false and
 * the diagnostics on compile errors; throws only for problems outside the compiler (e.g. a blocks
 * engine without generated code). Concurrent builds of the same sources share one compilation.
 */
export async function buildEngine(engine: EngineRecord, opts: { force?: boolean; onStatus?: (s: string) => void } = {}): Promise<BuildOutcome> {
  if (engine.kind === "wasm") return { ok: !!engine.wasm && engine.wasm.byteLength > 0, result: null, engine, fromCache: true };

  const sources = assembleSources(engine);
  const hash = await sourceHashOf(sources);
  const stored = engine.build;
  if (!opts.force && stored && stored.sourceHash === hash && stored.wasm && stored.wasm.byteLength > 0) {
    return { ok: true, result: null, engine, fromCache: true };
  }

  const key = `${engine.id}\u0000${hash}`;
  const listener = opts.onStatus;
  let job = inFlight.get(key);
  if (job) {
    if (listener) job.listeners.add(listener);
  } else {
    // Register the listener before starting: the first status may be reported synchronously.
    const listeners = new Set<(s: string) => void>(listener ? [listener] : []);
    const emit = (s: string) => {
      for (const l of listeners) {
        try {
          l(s);
        } catch (err) {
          console.error("buildEngine onStatus callback failed", err);
        }
      }
    };
    const promise = runBuild(engine, sources, hash, emit).finally(() => inFlight.delete(key));
    job = { promise, listeners };
    inFlight.set(key, job);
  }
  try {
    return await job.promise;
  } finally {
    if (listener) job.listeners.delete(listener);
  }
}

async function networkBytesFor(engine: EngineRecord): Promise<ArrayBuffer | null> {
  if (!engine.networkId) return null;
  const data = await networksRepo.getData(engine.networkId);
  if (!data || !data.quantized || data.quantized.byteLength === 0) {
    throw new Error(`The NNUE network attached to “${engine.name}” no longer exists. Choose another network for this engine, or remove it.`);
  }
  return data.quantized;
}

/** The engine's record, module bytes (building if needed) and attached network. */
export async function getEngineArtifacts(
  engineId: string,
  opts: { onStatus?: (s: string) => void } = {},
): Promise<{ engine: EngineRecord; wasm: ArrayBuffer; network: ArrayBuffer | null }> {
  const engine = await enginesRepo.get(engineId);
  if (!engine) throw new Error(`Engine not found (it may have been deleted).`);

  let current = engine;
  let wasm: ArrayBuffer;
  if (engine.kind === "wasm") {
    if (!engine.wasm || engine.wasm.byteLength === 0) throw new Error(`“${engine.name}” has no WebAssembly module yet. Open it in the Workshop and choose a .wasm file.`);
    wasm = engine.wasm;
  } else {
    const built = await buildEngine(engine, { onStatus: opts.onStatus });
    if (!built.ok || !built.engine.build) throw new BuildError(built.result ?? failedResult("No build was produced."), `“${engine.name}”`);
    current = built.engine;
    wasm = built.engine.build.wasm;
  }
  return { engine: current, wasm, network: await networkBytesFor(current) };
}

// Compiled modules by content hash, so several clients of one engine (arena games, self-play)
// share one compilation. Small LRU.
const MODULE_CACHE_SIZE = 8;
const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

async function cachedModule(bytes: ArrayBuffer): Promise<WebAssembly.Module> {
  const key = await sha256Hex(bytes);
  const hit = moduleCache.get(key);
  if (hit) {
    moduleCache.delete(key);
    moduleCache.set(key, hit);
    return hit;
  }
  const compiled = compileModule(bytes);
  moduleCache.set(key, compiled);
  compiled.catch(() => moduleCache.delete(key));
  while (moduleCache.size > MODULE_CACHE_SIZE) moduleCache.delete(moduleCache.keys().next().value!);
  return compiled;
}

/** Builds (if needed) and starts an engine in its own worker. */
export async function loadEngine(
  engineId: string,
  opts: { hashMb?: number; onLog?: (s: string) => void; onStatus?: (s: string) => void; label?: string } = {},
): Promise<EngineClient> {
  const { engine, wasm, network } = await getEngineArtifacts(engineId, { onStatus: opts.onStatus });
  opts.onStatus?.("Starting the engine…");
  const module = await cachedModule(wasm);
  return EngineClient.create(module, {
    hashMb: opts.hashMb ?? engine.options?.hashMb,
    network,
    onLog: opts.onLog,
    label: opts.label ?? engine.name,
  });
}

// --- stock NNUE engine ------------------------------------------------------------------------

interface StockBuild {
  hash: string;
  wasm: ArrayBuffer;
}

let stockMemo: StockBuild | null = null;
let stockInFlight: Promise<StockBuild> | null = null;

/** Template + engine/variants/eval-nnue.ts as eval.ts. */
export function stockNnueSources(): { files: Record<string, string>; entry: string } {
  const evalNnue = variantFiles["eval-nnue.ts"];
  if (!evalNnue) throw new Error("The stock NNUE evaluation (engine/variants/eval-nnue.ts) is missing from this build of the app.");
  return { files: { ...templateFiles, "eval.ts": evalNnue }, entry: "main.ts" };
}

/**
 * The stock NNUE engine (used for networks without an engine of their own, e.g. during training).
 * Compiled once and cached in memory and in settings ("build.stockNnue"). Returns a fresh copy
 * that the caller may transfer.
 */
export async function getStockNnueWasm(): Promise<ArrayBuffer> {
  const sources = stockNnueSources();
  const hash = await sourceHashOf(sources);
  if (stockMemo?.hash === hash) return stockMemo.wasm.slice(0);

  if (!stockInFlight) {
    stockInFlight = (async (): Promise<StockBuild> => {
      let stored: StockBuild | null = null;
      try {
        stored = await settingsRepo.get<StockBuild | null>(STOCK_NNUE_SETTING, null);
      } catch (err) {
        console.warn("Could not read the cached stock NNUE engine", err);
      }
      if (stored && stored.hash === hash && stored.wasm && stored.wasm.byteLength > 0) return stored;

      const result = await compile({ ...sources, ...BUILD_OPTIONS });
      if (!result.ok || !result.wasm) throw new BuildError(result, "The stock NNUE engine");
      const fresh: StockBuild = { hash, wasm: standaloneBuffer(result.wasm) };
      try {
        await settingsRepo.set(STOCK_NNUE_SETTING, fresh);
      } catch (err) {
        console.warn("Could not cache the stock NNUE engine", err);
      }
      return fresh;
    })().finally(() => {
      stockInFlight = null;
    });
  }
  const build = await stockInFlight;
  if (build.hash === hash) stockMemo = build;
  return build.wasm.slice(0);
}
