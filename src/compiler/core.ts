// Worker-agnostic AssemblyScript compilation: virtual file system in, wasm bytes + structured
// diagnostics out. Used by compiler.worker.ts in the browser and directly by Node tests.
import type { CompileDiagnostic, CompileRequest, CompileResult } from "@/types";
import type { AscDiagnosticMessage, AscModule, AscOutputStream } from "./asc-types";
import { LineMapper, convertDiagnostic, formatDiagnostic, libraryLookup } from "./diagnostics";
import { VirtualFs, normalizePath } from "./vfs";

/** Used when the loaded compiler does not report a version. */
export const COMPILER_VERSION_FALLBACK = "assemblyscript 0.28.20";

/** Name of the output file inside the virtual file system. */
export const OUTPUT_FILE = "engine.wasm";

export function compilerVersionOf(asc: Pick<AscModule, "version"> | null | undefined): string {
  return asc && typeof asc.version === "string" && asc.version ? `assemblyscript ${asc.version}` : COMPILER_VERSION_FALLBACK;
}

/** Effective option values of a request (the defaults documented on CompileRequest). */
export function resolveOptions(req: CompileRequest): Required<Omit<CompileRequest, "files" | "entry">> {
  return {
    optimizeLevel: req.optimizeLevel ?? 3,
    shrinkLevel: req.shrinkLevel ?? 0,
    debug: req.debug ?? false,
    runtime: req.runtime ?? "incremental",
    extraArgs: req.extraArgs ?? [],
  };
}

/** The asc command line for a request (entry first, like the CLI). */
export function buildAscArgs(req: CompileRequest): string[] {
  const o = resolveOptions(req);
  const args = [
    normalizePath(req.entry || "main.ts"),
    "--outFile",
    OUTPUT_FILE,
    "--optimizeLevel",
    String(o.optimizeLevel),
    "--shrinkLevel",
    String(o.shrinkLevel),
    "--runtime",
    o.runtime,
    "--enable",
    "simd",
    "--noColors",
  ];
  if (o.debug) args.push("--debug");
  args.push(...o.extraArgs);
  return args;
}

/** Collects everything asc writes to stdout/stderr. */
function memoryStream(): AscOutputStream {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  return {
    write(chunk: Uint8Array | string) {
      chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    },
    toString() {
      return chunks.join("");
    },
  };
}

function globalError(message: string): CompileDiagnostic {
  return { severity: "error", code: 0, message, file: null, line: null, column: null };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A failed result for problems outside the compiler proper (crash, worker failure, timeout...). */
export function failedResult(message: string, extra?: { log?: string; timeMs?: number; compilerVersion?: string }): CompileResult {
  return {
    ok: false,
    wasm: null,
    diagnostics: [globalError(message)],
    log: extra?.log ?? `${message}\n`,
    timeMs: extra?.timeMs ?? 0,
    compilerVersion: extra?.compilerVersion ?? COMPILER_VERSION_FALLBACK,
  };
}

/**
 * Compiles `req.files` with the given asc module. Never throws: compiler crashes become a failed
 * result with a global diagnostic.
 */
export async function compileWithAsc(asc: AscModule, req: CompileRequest): Promise<CompileResult> {
  const t0 = performance.now();
  const compilerVersion = compilerVersionOf(asc);
  const fs = new VirtualFs(req.files ?? {});
  const entry = normalizePath(req.entry || "main.ts");
  const args = buildAscArgs(req);
  const header = `$ asc ${args.join(" ")}\n`;
  const elapsed = () => Math.round((performance.now() - t0) * 10) / 10;

  if (!fs.has(entry)) {
    const names = Object.keys(req.files ?? {});
    return failedResult(`Entry file "${entry}" not found${names.length ? ` (files: ${names.join(", ")})` : " (no source files)"}.`, {
      log: header,
      timeMs: elapsed(),
      compilerVersion,
    });
  }

  const diagnostics: CompileDiagnostic[] = [];
  const mapper = new LineMapper((path) => fs.get(path) ?? libraryLookup(asc.libraryFiles, path));
  const stdout = memoryStream();
  const stderr = memoryStream();
  let error: Error | null = null;

  try {
    const result = await asc.main(args, {
      stdout,
      stderr,
      readFile: (name, baseDir) => fs.readFile(name, baseDir),
      writeFile: (name, contents, baseDir) => fs.writeFile(name, contents, baseDir),
      listFiles: (dirname, baseDir) => fs.listFiles(dirname, baseDir),
      reportDiagnostic: (d: AscDiagnosticMessage) => {
        const converted = convertDiagnostic(d, mapper);
        if (converted) diagnostics.push(converted);
      },
    });
    error = result.error;
  } catch (e) {
    // asc itself crashed (internal compiler error). The browser build turns its exit() into a throw.
    const err = e instanceof Error ? e : new Error(String(e));
    diagnostics.push(globalError(`The AssemblyScript compiler crashed: ${err.message}`));
    stderr.write(`${err.stack ?? err.message}\n`);
  }

  const errText = stderr.toString();
  // asc reports unknown command-line options only as text; surface them as warnings.
  for (const m of errText.matchAll(/^WARNING Unknown option '([^']+)'/gm)) {
    diagnostics.push({ severity: "warning", code: 0, message: `Unknown compiler option '${m[1]}' (ignored).`, file: null, line: null, column: null });
  }

  const output = fs.outputs.get(OUTPUT_FILE);
  let wasm: Uint8Array | null = null;
  if (output instanceof Uint8Array && output.byteLength > 0) {
    // Copy into a standalone buffer: asc may hand us a view into Binaryen's heap, and the
    // worker transfers this buffer to the main thread.
    wasm = new Uint8Array(output);
  }

  let errors = diagnostics.filter((d) => d.severity === "error").length;
  if (error && errors === 0) {
    // Failures without a structured diagnostic, e.g. "Feature 'x' is unknown" or "validate error".
    diagnostics.push(globalError(error.message));
    errors++;
  }
  if (!error && errors === 0 && !wasm) {
    diagnostics.push(globalError("The compiler finished without producing a WebAssembly module."));
    errors++;
  }

  const ok = errors === 0 && wasm !== null;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const timeMs = elapsed();
  const parts = [header];
  if (errText.trim()) parts.push(errText.endsWith("\n") ? errText : `${errText}\n`);
  const outText = stdout.toString();
  if (outText.trim()) parts.push(outText.endsWith("\n") ? outText : `${outText}\n`);
  // Problems that asc did not print itself (e.g. our own checks).
  for (const d of diagnostics) if (d.file === null && d.severity === "error" && !errText.includes(d.message)) parts.push(`${formatDiagnostic(d)}\n`);
  parts.push(
    ok
      ? `Compiled ${entry} in ${Math.round(timeMs)} ms: ${wasm!.byteLength.toLocaleString("en-US")} bytes${warnings ? `, ${plural(warnings, "warning")}` : ""}.\n`
      : `Compilation failed: ${plural(errors, "error")}${warnings ? `, ${plural(warnings, "warning")}` : ""} (${Math.round(timeMs)} ms).\n`,
  );

  return { ok, wasm: ok ? wasm : null, diagnostics, log: parts.join(""), timeMs, compilerVersion };
}
