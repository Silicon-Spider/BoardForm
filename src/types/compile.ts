// Compiler service types (src/compiler/).

export interface CompileRequest {
  /** Virtual source tree, paths relative to the root, e.g. { "main.ts": "...", "eval.ts": "..." }. */
  files: Record<string, string>;
  /** Entry file, e.g. "main.ts". */
  entry: string;
  /** Default 3. */
  optimizeLevel?: 0 | 1 | 2 | 3;
  /** Default 0. */
  shrinkLevel?: 0 | 1 | 2;
  /** Emit debug info / keep names (slower). Default false. */
  debug?: boolean;
  /** AssemblyScript runtime. Default "incremental". */
  runtime?: "incremental" | "minimal" | "stub";
  /** Extra raw asc CLI arguments. */
  extraArgs?: string[];
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface CompileDiagnostic {
  severity: DiagnosticSeverity;
  /** AssemblyScript diagnostic code (e.g. 2304), 0 if unknown. */
  code: number;
  message: string;
  /** Path relative to the virtual root (e.g. "eval.ts"); null for global diagnostics. */
  file: string | null;
  /** 1-based. */
  line: number | null;
  /** 1-based. */
  column: number | null;
  endLine?: number | null;
  endColumn?: number | null;
}

export interface CompileResult {
  ok: boolean;
  wasm: Uint8Array | null;
  diagnostics: CompileDiagnostic[];
  /** Human-readable compiler output (stderr + stdout). */
  log: string;
  timeMs: number;
  /** e.g. "assemblyscript 0.28.20" */
  compilerVersion: string;
}
