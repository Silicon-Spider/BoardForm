// Validates an uploaded .wasm against the Engine ABI (docs/ENGINE_ABI.md) before it becomes an
// engine. Instantiates the module with stub imports and calls cb_abi_version() only, so it is cheap
// enough for the main thread (a module whose start function never returns would still block it).
import { ABI_VERSION, HOST_IMPORTS, OPTIONAL_FUNCTIONS, REQUIRED_FUNCTIONS, checkExportSignatures } from "./abi";
import { buildImports } from "./imports";
import { describeEngineError } from "./instance";
import { WasmMemoryAccess } from "./memory";
import { readModuleInfo } from "./module-info";
import { WASI_MODULES, createWasiShim } from "./wasi";

export interface WasmInspection {
  /** True when the module can be used as an engine (no errors). */
  ok: boolean;
  errors: string[];
  /** Missing optional features and anything the host has to work around. */
  warnings: string[];
  /** Export names. */
  exports: string[];
  /** Imports as "module.name". */
  imports: string[];
}

const SUPPORTED_WASI = new Set(Object.keys(createWasiShim(new WasmMemoryAccess(), () => {}).functions));

export async function inspectWasm(bytes: ArrayBuffer): Promise<WasmInspection> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const view = new Uint8Array(bytes);

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(view as BufferSource);
  } catch (err) {
    return { ok: false, errors: [`Not a valid WebAssembly module: ${describeEngineError(err)}`], warnings, exports: [], imports: [] };
  }

  const exps = WebAssembly.Module.exports(module);
  const imps = WebAssembly.Module.imports(module);
  const exported = (name: string) => exps.find((e) => e.name === name);
  const hasFunction = (name: string) => exported(name)?.kind === "function";

  // Required exports.
  for (const name of REQUIRED_FUNCTIONS) {
    const e = exported(name);
    if (!e) errors.push(`Missing required export ${name}.`);
    else if (e.kind !== "function") errors.push(`${name} must be a function, but the module exports a ${e.kind}.`);
  }
  const memory = exported("memory");
  const importsMemory = imps.some((i) => i.kind === "memory");
  if (!memory) {
    if (importsMemory) warnings.push('The module imports its memory instead of exporting it as "memory"; the host creates it, but the ABI asks for an export.');
    else errors.push('Missing required export "memory" (the engine\'s linear memory).');
  } else if (memory.kind !== "memory") {
    errors.push(`"memory" must be a memory, but the module exports a ${memory.kind}.`);
  }

  // Optional exports.
  const alloc = hasFunction("cb_nnue_alloc");
  const load = hasFunction("cb_nnue_load");
  if (alloc !== load) warnings.push(`The module exports ${alloc ? "cb_nnue_alloc" : "cb_nnue_load"} but not ${alloc ? "cb_nnue_load" : "cb_nnue_alloc"}: NNUE networks cannot be loaded.`);
  else if (!alloc) warnings.push(`No cb_nnue_alloc / cb_nnue_load exports: ${OPTIONAL_FUNCTIONS.cb_nnue_load} is unavailable.`);
  for (const [name, feature] of Object.entries(OPTIONAL_FUNCTIONS)) {
    if (name === "cb_nnue_alloc" || name === "cb_nnue_load") continue;
    if (!hasFunction(name)) warnings.push(`No ${name} export: ${feature} is unavailable.`);
  }
  if (hasFunction("_start") && !hasFunction("_initialize")) {
    warnings.push("The module exports _start (a WASI command); the host never runs it. Build it as a library/reactor if its globals need initialising.");
  }

  // Signatures.
  const info = readModuleInfo(view);
  if (info) {
    const checked = checkExportSignatures(info);
    errors.push(...checked.errors);
    warnings.push(...checked.warnings);
  } else {
    warnings.push("The module's type section could not be read, so function signatures were not checked.");
  }

  // Imports.
  let usesWasi = false;
  for (const imp of imps) {
    const label = `${imp.module}.${imp.name}`;
    if (imp.kind !== "function") {
      if (imp.kind === "memory") continue; // handled above
      if (imp.kind === "tag") errors.push(`The module imports the exception tag ${label}, which the host cannot provide.`);
      else warnings.push(`The module imports the ${imp.kind} ${label}; the host provides an empty one.`);
      continue;
    }
    if (imp.module === "env") {
      if (!(imp.name in HOST_IMPORTS)) warnings.push(`Unknown import ${label}: the host provides a stub that returns 0.`);
    } else if (WASI_MODULES.has(imp.module)) {
      usesWasi = true;
      if (!SUPPORTED_WASI.has(imp.name)) warnings.push(`WASI function ${label} is not supported: it will return ENOSYS.`);
    } else {
      warnings.push(`Import ${label} is not part of the ABI: the host provides a stub that returns 0.`);
    }
  }
  if (usesWasi) warnings.push("The module uses WASI: stdout/stderr go to the engine log; files, arguments and environment variables are unavailable.");

  // Instantiate with stub imports and ask for the ABI version (without running cb_init).
  try {
    const mem = new WasmMemoryAccess();
    const built = buildImports(module, info, mem, {
      now: () => performance.now(),
      shouldStop: () => 1,
      info: () => {},
      log: () => {},
      output: () => {},
      note: () => {},
    });
    if (built.importedMemory) mem.attach(built.importedMemory);
    const instance = await WebAssembly.instantiate(module, built.imports);
    const exportedMemory = instance.exports.memory;
    if (exportedMemory instanceof WebAssembly.Memory) mem.attach(exportedMemory);
    const versionFn = instance.exports.cb_abi_version;
    if (typeof versionFn === "function") {
      try {
        const raw: unknown = (versionFn as () => unknown)();
        const version = typeof raw === "bigint" ? Number(raw) : Number(raw);
        if (version !== ABI_VERSION) errors.push(`cb_abi_version() returned ${version}; this app implements ABI version ${ABI_VERSION}.`);
      } catch (err) {
        errors.push(`cb_abi_version() failed: ${describeEngineError(err)}`);
      }
    }
  } catch (err) {
    errors.push(`The module could not be instantiated: ${describeEngineError(err)}`);
  }

  return { ok: errors.length === 0, errors, warnings, exports: exps.map((e) => e.name), imports: imps.map((i) => `${i.module}.${i.name}`) };
}
