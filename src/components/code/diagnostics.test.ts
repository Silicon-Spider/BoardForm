import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { CompileDiagnostic } from "@/types";
import { diagnosticRange, diagnosticsForFile, tokenRange } from "./diagnostics";

const doc = Text.of(["export function evaluate(pos: Position): i32 {", "  return popcount(x) + 1;", "", "}"]);
const range = (d: { line: number; column: number; endLine?: number; endColumn?: number }) => {
  const r = diagnosticRange(doc, d);
  return [r.from, r.to, doc.sliceString(r.from, r.to)];
};
const lineStart = (n: number) => doc.line(n).from;

describe("diagnosticRange", () => {
  it("uses 1-based line / column with an exclusive end column", () => {
    // "popcount" starts at column 10 of line 2 and ends before column 18.
    expect(range({ line: 2, column: 10, endLine: 2, endColumn: 18 })).toEqual([lineStart(2) + 9, lineStart(2) + 17, "popcount"]);
    // Spanning lines.
    expect(range({ line: 1, column: 46, endLine: 2, endColumn: 9 })[2]).toBe("{\n  return");
  });

  it("underlines the token at the position when there is no end", () => {
    expect(range({ line: 2, column: 10 })[2]).toBe("popcount");
    // Column inside a word: the whole word.
    expect(range({ line: 2, column: 13 })[2]).toBe("popcount");
    // A punctuation character on its own.
    expect(range({ line: 2, column: 20 })[2]).toBe(")");
    // Whitespace: the next token on the line.
    expect(range({ line: 2, column: 1 })[2]).toBe("return");
    // Past the end of the line: the last token before it.
    expect(range({ line: 2, column: 99 })[2]).toBe(";");
    // A zero-length end is treated like no end.
    expect(range({ line: 2, column: 10, endLine: 2, endColumn: 10 })[2]).toBe("popcount");
  });

  it("clamps out-of-range values", () => {
    // Line beyond the document -> last line.
    expect(range({ line: 50, column: 1 })).toEqual([lineStart(4), lineStart(4) + 1, "}"]);
    // Line 0 / negative / NaN -> first line, first column.
    expect(range({ line: 0, column: -4 })[2]).toBe("export");
    expect(range({ line: Number.NaN, column: Number.NaN })[2]).toBe("export");
    // End before start collapses to the token at the start.
    expect(range({ line: 2, column: 10, endLine: 1, endColumn: 1 })[2]).toBe("popcount");
    // End column beyond the end line -> end of that line.
    expect(range({ line: 2, column: 3, endLine: 2, endColumn: 500 })[2]).toBe("return popcount(x) + 1;");
    // endLine without endColumn -> to the end of that line.
    expect(range({ line: 1, column: 1, endLine: 1 })[2]).toBe(doc.line(1).text);
    // A blank line gives an empty range at its start.
    expect(range({ line: 3, column: 5 })).toEqual([lineStart(3), lineStart(3), ""]);
  });

  it("works on an empty document", () => {
    const empty = Text.of([""]);
    expect(diagnosticRange(empty, { line: 3, column: 3 })).toEqual({ from: 0, to: 0 });
  });
});

describe("tokenRange", () => {
  it("finds identifiers, numbers and single characters", () => {
    expect(tokenRange("a + 123;", 4)).toEqual({ from: 4, to: 7 });
    expect(tokenRange("a + 123;", 2)).toEqual({ from: 2, to: 3 });
    expect(tokenRange("   ", 1)).toBeNull();
  });
});

describe("diagnosticsForFile", () => {
  const d = (over: Partial<CompileDiagnostic>): CompileDiagnostic => ({ severity: "error", code: 0, message: "m", file: "eval.ts", line: 1, column: 1, ...over });

  it("keeps only positioned diagnostics of that file and appends the code", () => {
    const diags = [
      d({ code: 2304, message: "Cannot find name 'x'.", line: 3, column: 5, endLine: 3, endColumn: 6 }),
      d({ code: 200, severity: "warning", message: "Conversion from type 'f64' to 'i32' will require an explicit cast.", file: "./eval.ts", line: 7, column: 2 }),
      d({ file: "main.ts" }),
      d({ file: null, line: null, column: null, message: "global" }),
      d({ line: null, column: null, message: "no position" }),
    ];
    expect(diagnosticsForFile(diags, "eval.ts")).toEqual([
      { line: 3, column: 5, endLine: 3, endColumn: 6, severity: "error", message: "Cannot find name 'x'. (TS2304)" },
      { line: 7, column: 2, severity: "warning", message: "Conversion from type 'f64' to 'i32' will require an explicit cast. (AS200)" },
    ]);
    expect(diagnosticsForFile(diags, "main.ts")).toHaveLength(1);
    expect(diagnosticsForFile([d({ column: null, code: 0, message: "plain" })], "eval.ts")).toEqual([{ line: 1, column: 1, severity: "error", message: "plain" }]);
  });
});
