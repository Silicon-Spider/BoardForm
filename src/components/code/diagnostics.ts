// Diagnostics: compiler output -> editor diagnostics -> document ranges. Headless (works on any
// object with CodeMirror's Text line API), so it is unit-tested without a DOM.
import type { CompileDiagnostic } from "@/types";
import type { CodeEditorDiagnostic } from "./types";

/** The part of CodeMirror's `Text` used here (1-based line access). */
export interface LineSource {
  readonly lines: number;
  readonly length: number;
  line(n: number): { readonly from: number; readonly to: number; readonly text: string };
}

/** "./eval.ts", "/eval.ts", "eval.ts" all name the same file. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  return norm(a) === norm(b);
}

/**
 * Converts compiler diagnostics for one file into editor diagnostics. Diagnostics without a
 * position (global ones) are left out: show them in a problems list instead. The code is
 * appended like asc prints it: "AS…" below 1000, "TS…" otherwise.
 */
export function diagnosticsForFile(diags: CompileDiagnostic[], file: string): CodeEditorDiagnostic[] {
  const out: CodeEditorDiagnostic[] = [];
  for (const d of diags) {
    if (d.file == null || d.line == null || !samePath(d.file, file)) continue;
    const diag: CodeEditorDiagnostic = {
      line: d.line,
      column: d.column ?? 1,
      severity: d.severity,
      message: d.code ? `${d.message} (${d.code < 1000 ? "AS" : "TS"}${d.code})` : d.message,
    };
    if (d.endLine != null) diag.endLine = d.endLine;
    if (d.endColumn != null) diag.endColumn = d.endColumn;
    out.push(diag);
  }
  return out;
}

function clampInt(value: number | undefined, lo: number, hi: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(value)));
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * Range [from, to) of the token at `offset` in a line of text: the identifier / number around
 * it, else the single character there; whitespace moves to the next token on the line, and
 * the end of a line falls back to the last character before it. Returns null for blank lines.
 */
export function tokenRange(text: string, offset: number): { from: number; to: number } | null {
  let at = Math.min(Math.max(0, offset), text.length);
  if (at >= text.length || /\s/.test(text[at])) {
    // Prefer the next token on the line, else the last one before the position.
    let next = at;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next < text.length) at = next;
    else {
      let prev = Math.min(at, text.length) - 1;
      while (prev >= 0 && /\s/.test(text[prev])) prev--;
      if (prev < 0) return null;
      at = prev;
    }
  }
  if (!WORD.test(text[at])) return { from: at, to: at + 1 };
  let from = at;
  let to = at + 1;
  while (from > 0 && WORD.test(text[from - 1])) from--;
  while (to < text.length && WORD.test(text[to])) to++;
  return { from, to };
}

/**
 * Document range of a diagnostic. Line / column are 1-based; out-of-range values are clamped
 * to the document (a diagnostic from a longer, older version of the file lands on the last
 * line). endColumn is exclusive. Without an end, the token at the position is covered.
 */
export function diagnosticRange(doc: LineSource, d: Pick<CodeEditorDiagnostic, "line" | "column" | "endLine" | "endColumn">): { from: number; to: number } {
  const lineNo = clampInt(d.line, 1, doc.lines, 1);
  const line = doc.line(lineNo);
  const lineLength = line.to - line.from;
  const column = clampInt(d.column, 1, lineLength + 1, 1);
  const from = line.from + column - 1;
  let to = from;

  if (d.endLine != null || d.endColumn != null) {
    const endLineNo = clampInt(d.endLine ?? lineNo, lineNo, doc.lines, lineNo);
    const endLine = doc.line(endLineNo);
    const endLength = endLine.to - endLine.from;
    // Without endColumn the range runs to the end of endLine.
    const endColumn = d.endColumn == null ? endLength + 1 : clampInt(d.endColumn, 1, endLength + 1, endLength + 1);
    to = Math.max(from, endLine.from + endColumn - 1);
  }

  if (to === from) {
    const token = tokenRange(line.text, from - line.from);
    if (token) return { from: line.from + token.from, to: line.from + token.to };
  }
  return { from, to };
}
