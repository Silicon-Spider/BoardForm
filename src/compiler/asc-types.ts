// Minimal structural types for the parts of the AssemblyScript compiler API ("assemblyscript/asc")
// that BoardForm uses.
//
// We deliberately never let TypeScript see asc's own declaration files: they declare
// AssemblyScript's globals (`i32`, `abs`, `Array.prototype.at(): T`, ...) at the top level, which would
// silently change type checking for the whole app. The compiler is loaded through `load-asc.js`
// (a plain JS file with a hand-written `.d.ts`) instead.

/** Output stream compatible with asc's `OutputStream`. */
export interface AscOutputStream {
  write(chunk: Uint8Array | string): void;
  toString(): string;
}

export interface AscSource {
  /** Path as the compiler knows it, e.g. "eval.ts" or "~lib/rt/itcms.ts". */
  normalizedPath: string;
}

export interface AscRange {
  /** Start offset (UTF-16 code units) within the source text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  source: AscSource | null;
}

/** What `reportDiagnostic` receives (asc builds this plain object; there is no `source.text`). */
export interface AscDiagnosticMessage {
  code: number;
  /** DiagnosticCategory: 0 pedantic, 1 info, 2 warning, 3 error. */
  category: number;
  message: string;
  range: AscRange | null;
  relatedRange: AscRange | null;
}

export interface AscApiOptions {
  stdout?: AscOutputStream;
  stderr?: AscOutputStream;
  /** Returns the file contents or null when the file does not exist. */
  readFile(filename: string, baseDir: string): string | null | Promise<string | null>;
  writeFile(filename: string, contents: Uint8Array | string, baseDir: string): void | Promise<void>;
  listFiles(dirname: string, baseDir: string): string[] | null | Promise<string[] | null>;
  reportDiagnostic?(diagnostic: AscDiagnosticMessage): void;
}

export interface AscApiResult {
  error: Error | null;
  stdout: AscOutputStream;
  stderr: AscOutputStream;
}

/** The `assemblyscript/asc` module namespace (subset). */
export interface AscModule {
  readonly version: string;
  /** Bundled standard library sources, keyed without "~lib/" prefix and ".ts" extension. */
  readonly libraryFiles?: Readonly<Record<string, string>>;
  main(argv: string[], options?: AscApiOptions): Promise<AscApiResult>;
}

/** asc's DiagnosticCategory numbering (assemblyscript/src/diagnostics.ts). */
export const DiagnosticCategory = {
  Pedantic: 0,
  Info: 1,
  Warning: 2,
  Error: 3,
} as const;
