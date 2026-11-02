// Builds the import object for an engine module (ENGINE_ABI.md "Required imports").
//
// Every import the module declares gets something, so user engines never fail to instantiate
// because of a stray import: the ABI functions under "env", AssemblyScript's runtime helpers, a
// WASI shim, and harmless stubs (return zero, logged once) for anything else.
import type { WasmMemoryAccess } from "./memory";
import type { WasmFuncType, WasmImportInfo, WasmModuleInfo, WasmValType } from "./module-info";
import { WASI_ERRNO, WASI_MODULES, createWasiShim, type WasiShim } from "./wasi";

/** Raw ABI callbacks implemented by EngineInstance (arguments as the engine passed them). */
export interface EngineHostCallbacks {
  now(): number;
  shouldStop(): number;
  info(depth: number, seldepth: number, score: number, mate: number, nodes: number, timeMs: number, pvLen: number): void;
  log(len: number): void;
  /** Text the engine printed some other way (trace(), WASI stdout/stderr). */
  output(text: string): void;
  /** Messages from the host about the engine (stubbed imports...). */
  note(text: string): void;
}

export interface BuiltImports {
  imports: WebAssembly.Imports;
  /** Memory we created for a module that imports its memory instead of exporting it. */
  importedMemory: WebAssembly.Memory | null;
  /** "module.name" of every import satisfied by a stub. */
  stubbed: string[];
  wasi: WasiShim | null;
}

/** Thrown by the `abort` import (AssemblyScript assertion / runtime error). */
export class EngineAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineAbort";
  }
}

const toNumber = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

type ImportFn = (...args: never[]) => unknown;

function zeroOf(t: WasmValType): number | bigint | null {
  if (t === "i64") return 0n;
  if (t === "i32" || t === "f32" || t === "f64") return 0;
  return null; // references / vectors: JS null works for refs; v128 cannot cross the boundary at all
}

/** Zero value matching a function's results (undefined for void, an array for multi-value). */
function zeroResult(type: WasmFuncType | null): unknown {
  if (!type) return 0;
  if (type.results.length === 0) return undefined;
  if (type.results.length === 1) return zeroOf(type.results[0]);
  return type.results.map(zeroOf);
}

/** Converts a host function's Number result to the declared type (i64 results need a BigInt). */
function adaptResult(fn: (...args: never[]) => number, type: WasmFuncType | null): ImportFn {
  if (type?.results[0] !== "i64") return fn;
  return (...args: never[]) => BigInt(Math.trunc(fn(...args)));
}

export function buildImports(module: WebAssembly.Module, info: WasmModuleInfo | null, mem: WasmMemoryAccess, host: EngineHostCallbacks): BuiltImports {
  const declared = WebAssembly.Module.imports(module);
  const details = new Map<string, WasmImportInfo>();
  for (const imp of info?.imports ?? []) details.set(`${imp.module}\u0000${imp.name}`, imp);
  const detailOf = (moduleName: string, name: string) => details.get(`${moduleName}\u0000${name}`) ?? null;
  const funcType = (moduleName: string, name: string): WasmFuncType | null => {
    const d = detailOf(moduleName, name);
    return d && d.kind === "function" ? d.type : null;
  };

  const usesWasi = declared.some((d) => WASI_MODULES.has(d.module));
  const wasi = usesWasi ? createWasiShim(mem, (fd, line) => host.output(fd === 2 ? `[stderr] ${line}` : line)) : null;

  const env: Record<string, ImportFn> = {
    cb_now: () => host.now(),
    cb_should_stop: () => host.shouldStop(),
    cb_info: (depth: number, seldepth: number, score: number, mate: number, nodes: number, timeMs: number, pvLen: number) =>
      host.info(toNumber(depth), toNumber(seldepth), toNumber(score), toNumber(mate), toNumber(nodes), toNumber(timeMs), toNumber(pvLen)),
    cb_log: (len: number) => host.log(toNumber(len)),
    abort: (msg: number, file: number, line: number, col: number) => {
      // An exported memory is unreachable until instantiation finishes, so an abort inside the
      // module's start function (top-level code) cannot be decoded.
      const text = mem.attached ? (mem.readAsString(toNumber(msg)) ?? "(no message)") : "(message unavailable: the engine aborted while starting up)";
      const where = mem.attached ? mem.readAsString(toNumber(file)) : null;
      throw new EngineAbort(where != null || line !== undefined ? `abort: ${text} at ${where ?? "?"}:${toNumber(line)}:${toNumber(col)}` : `abort: ${text}`);
    },
    // AssemblyScript's Math.random seed (same as the official loader).
    seed: () => Date.now() * Math.random(),
    trace: (msg: number, n: number, ...args: number[]) => {
      const count = Math.max(0, Math.min(5, toNumber(n)));
      const values = args.slice(0, count).map(toNumber);
      host.output(`trace: ${mem.readAsString(toNumber(msg)) ?? ""}${values.length ? ` ${values.join(", ")}` : ""}`);
    },
  };

  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  const stubbed: string[] = [];
  let importedMemory: WebAssembly.Memory | null = null;

  const stub = (moduleName: string, name: string, result: unknown): ImportFn => {
    let reported = false;
    stubbed.push(`${moduleName}.${name}`);
    return () => {
      if (!reported) {
        reported = true;
        host.note(`The engine called ${moduleName}.${name}, which the host does not provide; a stub returned ${result === undefined ? "nothing" : String(result)}.`);
      }
      return result;
    };
  };

  for (const d of declared) {
    const target = (imports[d.module] ??= {});
    if (d.name in target) continue;
    const detail = detailOf(d.module, d.name);

    if (d.kind === "function") {
      const type = funcType(d.module, d.name);
      if (d.module === "env" && d.name in env) {
        const fn = env[d.name];
        target[d.name] = (d.name === "cb_now" || d.name === "cb_should_stop" || d.name === "seed" ? adaptResult(fn as (...args: never[]) => number, type) : fn) as WebAssembly.ImportValue;
      } else if (WASI_MODULES.has(d.module) && wasi) {
        target[d.name] = (wasi.functions[d.name] ?? stub(d.module, d.name, WASI_ERRNO.NOSYS)) as WebAssembly.ImportValue;
      } else {
        target[d.name] = stub(d.module, d.name, zeroResult(type)) as WebAssembly.ImportValue;
      }
    } else if (d.kind === "memory") {
      // Engines should export their memory; if one imports it instead, create it to its declared size.
      const limits = detail?.kind === "memory" ? detail.limits : null;
      const descriptor: WebAssembly.MemoryDescriptor = { initial: limits?.initial ?? 256 };
      if (limits?.maximum != null) descriptor.maximum = limits.maximum;
      if (limits?.shared) descriptor.shared = true;
      importedMemory = new WebAssembly.Memory(descriptor);
      target[d.name] = importedMemory;
    } else if (d.kind === "table") {
      const t = detail?.kind === "table" ? detail : null;
      const descriptor: WebAssembly.TableDescriptor = { element: t?.element === "externref" ? "externref" : "anyfunc", initial: t?.limits.initial ?? 1024 };
      if (t?.limits.maximum != null) descriptor.maximum = t.limits.maximum;
      target[d.name] = new WebAssembly.Table(descriptor);
    } else if (d.kind === "global" && detail?.kind === "global" && (detail.valueType === "i32" || detail.valueType === "i64" || detail.valueType === "f32" || detail.valueType === "f64")) {
      const value = detail.valueType === "i64" ? 0n : 0;
      target[d.name] = new WebAssembly.Global({ value: detail.valueType, mutable: detail.mutable }, value);
      stubbed.push(`${d.module}.${d.name}`);
    }
    // Tags and globals of unknown type cannot be faked; instantiation reports them (LinkError).
  }

  return { imports: imports as WebAssembly.Imports, importedMemory, stubbed, wasi };
}
