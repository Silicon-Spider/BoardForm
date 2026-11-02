// Converts AssemblyScript diagnostics into the app's structured CompileDiagnostic.
import type { CompileDiagnostic, DiagnosticSeverity } from "@/types";
import { DiagnosticCategory, type AscDiagnosticMessage, type AscRange } from "./asc-types";

const LIB_PREFIX = "~lib/";

export function severityOf(category: number): DiagnosticSeverity {
  if (category === DiagnosticCategory.Error) return "error";
  if (category === DiagnosticCategory.Warning) return "warning";
  return "info"; // Info and Pedantic
}

/** Path relative to the virtual root as shown to users: "./eval.ts" → "eval.ts". */
export function displayPath(normalizedPath: string): string {
  return normalizedPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

/** Start offsets of every line (index 0 = line 1). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line/column of a UTF-16 offset (columns count code units, like CodeMirror). */
export function offsetToLineColumn(starts: number[], textLength: number, offset: number): { line: number; column: number } {
  const pos = Math.max(0, Math.min(offset, textLength));
  // Binary search for the last line start <= pos.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: pos - starts[lo] + 1 };
}

/** Looks up source text for a diagnostic's file (user file or bundled ~lib file). */
export type SourceLookup = (path: string) => string | null;

/** Caches line tables per file during one compilation. */
export class LineMapper {
  private readonly cache = new Map<string, { starts: number[]; length: number } | null>();
  constructor(private readonly lookup: SourceLookup) {}

  locate(path: string, offset: number): { line: number; column: number } | null {
    let entry = this.cache.get(path);
    if (entry === undefined) {
      const text = this.lookup(path);
      entry = text == null ? null : { starts: lineStarts(text), length: text.length };
      this.cache.set(path, entry);
    }
    return entry ? offsetToLineColumn(entry.starts, entry.length, offset) : null;
  }
}

function rangeLabel(range: AscRange, mapper: LineMapper): string | null {
  if (!range.source) return null;
  const file = displayPath(range.source.normalizedPath);
  const at = mapper.locate(file, range.start);
  return at ? `${file}:${at.line}:${at.column}` : file;
}

/**
 * Converts one asc diagnostic. Returns null for noise we drop: non-error diagnostics inside the
 * standard library (~lib/...), which users cannot act on.
 */
export function convertDiagnostic(d: AscDiagnosticMessage, mapper: LineMapper): CompileDiagnostic | null {
  const severity = severityOf(d.category);
  const range = d.range && d.range.source ? d.range : null;
  const file = range ? displayPath(range.source!.normalizedPath) : null;
  if (file && file.startsWith(LIB_PREFIX) && severity !== "error") return null;

  let message = d.message;
  if (d.relatedRange) {
    const related = rangeLabel(d.relatedRange, mapper);
    if (related) message += ` (see ${related})`;
  }

  const diag: CompileDiagnostic = { severity, code: d.code | 0, message, file, line: null, column: null };
  if (range && file) {
    const start = mapper.locate(file, range.start);
    const end = mapper.locate(file, Math.max(range.start, range.end));
    if (start) {
      diag.line = start.line;
      diag.column = start.column;
    }
    if (end) {
      diag.endLine = end.line;
      diag.endColumn = end.column;
    }
  }
  return diag;
}

/**
 * One-line human-readable form, e.g. `eval.ts:12:5 error TS2304: Cannot find name 'x'.`
 * (Like asc: codes below 1000 are AssemblyScript-specific "AS" codes, the rest mirror TypeScript.)
 */
export function formatDiagnostic(d: CompileDiagnostic): string {
  let where = "";
  if (d.file) {
    where = d.file;
    if (d.line != null) where += `:${d.line}${d.column != null ? `:${d.column}` : ""}`;
    where += " ";
  }
  const code = d.code ? ` ${d.code < 1000 ? "AS" : "TS"}${d.code}` : "";
  return `${where}${d.severity}${code}: ${d.message}`;
}

/** Library file text for "~lib/rt/itcms.ts" style paths (asc keys them as "rt/itcms"). */
export function libraryLookup(libraryFiles: Readonly<Record<string, string>> | undefined, path: string): string | null {
  if (!libraryFiles || !path.startsWith(LIB_PREFIX)) return null;
  const key = path.slice(LIB_PREFIX.length).replace(/\.ts$/, "");
  return libraryFiles[key] ?? null;
}
