import { beforeAll, describe, expect, it } from "vitest";
import type { AscDiagnosticMessage, AscModule } from "./asc-types";
import { buildAscArgs, compileWithAsc, compilerVersionOf, COMPILER_VERSION_FALLBACK } from "./core";
import { LineMapper, convertDiagnostic, formatDiagnostic, lineStarts, offsetToLineColumn } from "./diagnostics";
import { loadAsc } from "./load-asc.js";
import { COMPILER_VERSION } from "./version";
import { VirtualFs, normalizePath } from "./vfs";

let asc: AscModule;
beforeAll(async () => {
  asc = await loadAsc();
});

const UTIL = `export function triple(x: i32): i32 {\n  return x * 3;\n}\n`;
const MAIN = `import { triple } from "./util";\n\nexport function answer(): i32 {\n  return triple(14);\n}\n`;

/** asc's own formatted location, e.g. "in util.ts(2,13)" → { line: 2, column: 13 } */
function ascLocation(log: string, file: string): { line: number; column: number } | null {
  const m = new RegExp(`in ${file.replace(".", "\\.")}\\((\\d+),(\\d+)\\)`).exec(log);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
}

describe("compileWithAsc", () => {
  it("compiles a multi-file program to a valid module", async () => {
    const r = await compileWithAsc(asc, { files: { "main.ts": MAIN, "util.ts": UTIL }, entry: "main.ts" });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.wasm).toBeInstanceOf(Uint8Array);
    const bytes = r.wasm! as Uint8Array<ArrayBuffer>;
    expect(WebAssembly.validate(bytes)).toBe(true);
    // Standalone buffer (safe to transfer).
    expect(r.wasm!.byteOffset).toBe(0);
    expect(r.wasm!.buffer.byteLength).toBe(r.wasm!.byteLength);
    const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => {} } });
    expect((instance.exports.answer as () => number)()).toBe(42);
    expect(r.timeMs).toBeGreaterThan(0);
    expect(r.log).toContain("$ asc main.ts --outFile engine.wasm --optimizeLevel 3 --shrinkLevel 0 --runtime incremental --enable simd --noColors");
    expect(r.log).toMatch(/Compiled main\.ts in \d+ ms: [\d,]+ bytes\./);
  });

  it("reports the compiler version consistently with the main-thread constant", () => {
    expect(compilerVersionOf(asc)).toBe(`assemblyscript ${asc.version}`);
    expect(COMPILER_VERSION).toBe(`assemblyscript ${asc.version}`);
    expect(compilerVersionOf(null)).toBe(COMPILER_VERSION_FALLBACK);
  });

  it("normalizes './' and leading '/' in file names and the entry", async () => {
    const r = await compileWithAsc(asc, { files: { "./main.ts": MAIN, "/util.ts": UTIL }, entry: "./main.ts" });
    expect(r.ok).toBe(true);
  });

  it("supports files in sub-directories with relative imports", async () => {
    const r = await compileWithAsc(asc, {
      files: {
        "main.ts": `import { twice } from "./lib/math";\nexport function f(): i32 { return twice(21); }\n`,
        "lib/math.ts": `import { one } from "../one";\nexport function twice(x: i32): i32 { return x * 2 * one(); }\n`,
        "one.ts": `export function one(): i32 { return 1; }\n`,
      },
      entry: "main.ts",
    });
    expect(r.ok).toBe(true);
  });

  it("gives exact file/line/column for a syntax error", async () => {
    const util = `export function triple(x: i32): i32 {\n  return x *;\n}\n`;
    const r = await compileWithAsc(asc, { files: { "main.ts": MAIN, "util.ts": util }, entry: "main.ts" });
    expect(r.ok).toBe(false);
    expect(r.wasm).toBeNull();
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const e = errors[0];
    expect(e.file).toBe("util.ts");
    expect(e.code).toBe(1109); // "Expression expected."
    // `  return x *;` — the ';' is the 13th character of line 2.
    expect(e.line).toBe(2);
    expect(e.column).toBe(13);
    expect(ascLocation(r.log, "util.ts")).toEqual({ line: 2, column: 13 });
    expect(r.log).toContain("Compilation failed: ");
  });

  it("gives exact file/line/column (and end) for a type error", async () => {
    const main = `export function f(): i32 {\n  let x: i32 = 1;\n  let s: i32 = "text";\n  return x + s;\n}\n`;
    const r = await compileWithAsc(asc, { files: { "main.ts": main }, entry: "main.ts" });
    expect(r.ok).toBe(false);
    const e = r.diagnostics.find((d) => d.severity === "error")!;
    expect(e).toMatchObject({ file: "main.ts", code: 2322, line: 3, column: 16, endLine: 3, endColumn: 22 });
    expect(e.message).toContain("is not assignable to type 'i32'");
    expect(ascLocation(r.log, "main.ts")).toEqual({ line: 3, column: 16 });
    expect(formatDiagnostic(e)).toMatch(/^main\.ts:3:16 error TS2322: /);
  });

  it("handles CRLF line endings", async () => {
    const main = `export function f(): i32 {\r\n  return nope;\r\n}\r\n`;
    const r = await compileWithAsc(asc, { files: { "main.ts": main }, entry: "main.ts" });
    const e = r.diagnostics.find((d) => d.code === 2304)!;
    expect(e).toMatchObject({ file: "main.ts", line: 2, column: 10 });
  });

  it("reports a missing import", async () => {
    const r = await compileWithAsc(asc, { files: { "main.ts": `import { x } from "./missing";\nexport function f(): i32 { return x; }\n` }, entry: "main.ts" });
    expect(r.ok).toBe(false);
    const e = r.diagnostics.find((d) => d.severity === "error")!;
    expect(e.file).toBe("main.ts");
    expect(e.line).toBe(1);
    expect(e.message).toMatch(/missing/);
  });

  it("fails cleanly when the entry file does not exist", async () => {
    const r = await compileWithAsc(asc, { files: { "util.ts": UTIL }, entry: "main.ts" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: "error", file: null, line: null });
    expect(r.diagnostics[0].message).toContain('Entry file "main.ts" not found');
  });

  it("keeps user warnings and turns unknown options into warnings", async () => {
    const r = await compileWithAsc(asc, {
      files: { "main.ts": MAIN, "util.ts": UTIL },
      entry: "main.ts",
      extraArgs: ["--definitelyNotAnOption"],
    });
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining("definitelyNotAnOption") }));
  });

  it("reports option errors that have no structured diagnostic", async () => {
    const r = await compileWithAsc(asc, { files: { "main.ts": MAIN, "util.ts": UTIL }, entry: "main.ts", extraArgs: ["--enable", "warp-drive"] });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].message).toMatch(/warp-drive/);
  });

  it("passes optimisation, runtime and debug flags through", async () => {
    expect(buildAscArgs({ files: {}, entry: "./main.ts", optimizeLevel: 1, shrinkLevel: 2, runtime: "stub", debug: true, extraArgs: ["--noAssert"] })).toEqual([
      "main.ts", "--outFile", "engine.wasm", "--optimizeLevel", "1", "--shrinkLevel", "2", "--runtime", "stub", "--enable", "simd", "--noColors", "--debug", "--noAssert",
    ]);
    const r = await compileWithAsc(asc, { files: { "main.ts": MAIN, "util.ts": UTIL }, entry: "main.ts", optimizeLevel: 0, runtime: "stub", debug: true });
    expect(r.ok).toBe(true);
  });
});

describe("diagnostic conversion", () => {
  const files = new VirtualFs({ "eval.ts": "line one\nline two\n" });
  const mapper = () => new LineMapper((p) => files.get(p));
  const diag = (over: Partial<AscDiagnosticMessage>): AscDiagnosticMessage => ({
    code: 100, category: 2, message: "m", range: null, relatedRange: null, ...over,
  });

  it("maps categories to severities", () => {
    expect(convertDiagnostic(diag({ category: 3 }), mapper())!.severity).toBe("error");
    expect(convertDiagnostic(diag({ category: 2 }), mapper())!.severity).toBe("warning");
    expect(convertDiagnostic(diag({ category: 1 }), mapper())!.severity).toBe("info");
    expect(convertDiagnostic(diag({ category: 0 }), mapper())!.severity).toBe("info");
  });

  it("drops non-error ~lib diagnostics but keeps ~lib errors", () => {
    const range = { start: 0, end: 1, source: { normalizedPath: "~lib/rt/itcms.ts" } };
    expect(convertDiagnostic(diag({ category: 2, range }), mapper())).toBeNull();
    expect(convertDiagnostic(diag({ category: 1, range }), mapper())).toBeNull();
    expect(convertDiagnostic(diag({ category: 3, range }), mapper())).toMatchObject({ severity: "error", file: "~lib/rt/itcms.ts" });
  });

  it("strips './' from paths and computes 1-based positions", () => {
    const d = convertDiagnostic(diag({ range: { start: 14, end: 17, source: { normalizedPath: "./eval.ts" } } }), mapper())!;
    expect(d).toMatchObject({ file: "eval.ts", line: 2, column: 6, endLine: 2, endColumn: 9 });
  });

  it("mentions the related range", () => {
    const d = convertDiagnostic(
      diag({ range: { start: 0, end: 1, source: { normalizedPath: "eval.ts" } }, relatedRange: { start: 9, end: 10, source: { normalizedPath: "eval.ts" } } }),
      mapper(),
    )!;
    expect(d.message).toBe("m (see eval.ts:2:1)");
  });

  it("offsetToLineColumn clamps and handles line starts", () => {
    const text = "ab\ncd\n";
    const starts = lineStarts(text);
    expect(offsetToLineColumn(starts, text.length, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineColumn(starts, text.length, 2)).toEqual({ line: 1, column: 3 });
    expect(offsetToLineColumn(starts, text.length, 3)).toEqual({ line: 2, column: 1 });
    expect(offsetToLineColumn(starts, text.length, 99)).toEqual({ line: 3, column: 1 });
  });
});

describe("virtual fs", () => {
  it("normalizes paths", () => {
    expect(normalizePath("./a/./b/../c.ts")).toBe("a/c.ts");
    expect(normalizePath("/main.ts")).toBe("main.ts");
    expect(normalizePath("a\\b.ts")).toBe("a/b.ts");
  });

  it("reads relative to baseDir and lists .ts files", () => {
    const fs = new VirtualFs({ "lib/a.ts": "A", "lib/b.d.ts": "B", "lib/sub/c.ts": "C", "main.ts": "M" });
    expect(fs.readFile("main.ts", ".")).toBe("M");
    expect(fs.readFile("a.ts", "lib")).toBe("A");
    expect(fs.readFile("nope.ts", ".")).toBeNull();
    expect(fs.listFiles("lib", ".").sort()).toEqual(["a.ts"]);
  });
});
