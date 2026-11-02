import { describe, expect, it } from "vitest";
import templateDoc from "/docs/ENGINE_TEMPLATE.md?raw";
import { ENGINE_API, ENGINE_API_MODULES, MODULE_ORDER, apiSnippet, buildEngineApi, memberOf, moduleName, moduleSummary, parseModuleApi } from "./api";
import type { ApiEntry } from "./types";

/** The ```ts block that follows the heading "## `file`" in docs/ENGINE_TEMPLATE.md. */
function docBlock(file: string): string {
  const at = templateDoc.indexOf("## `" + file + "`");
  if (at < 0) throw new Error(`docs/ENGINE_TEMPLATE.md has no section for ${file}`);
  const start = templateDoc.indexOf("```ts", at);
  const end = templateDoc.indexOf("```", start + 5);
  return templateDoc.slice(start + 5, end);
}

/** Lines of a doc block without their `// comments`. */
function codeLines(block: string): string[] {
  return block.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
}

/**
 * Function names listed in a doc block: identifiers directly followed by "(", with the
 * shorthand "shiftNorth/South/East(b)" expanded to shiftNorth, shiftSouth, shiftEast.
 */
function listedFunctions(block: string): string[] {
  const names = new Set<string>();
  for (const line of codeLines(block)) {
    const rest = line.replace(/\b([a-z][A-Za-z0-9_]*)((?:\/[A-Za-z0-9_]+)+)\(/g, (_m, first: string, more: string) => {
      const prefix = first.replace(/[A-Z][a-z0-9]*$/, "");
      names.add(first);
      for (const suffix of more.split("/").filter(Boolean)) names.add(prefix + suffix);
      return "(";
    });
    for (const m of rest.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g)) names.add(m[1]);
  }
  return [...names];
}

function find(name: string, module: string): ApiEntry | undefined {
  return ENGINE_API.find((e) => e.name === name && e.module === module);
}

describe("ENGINE_API covers docs/ENGINE_TEMPLATE.md", () => {
  const cases: Array<[file: string, module: string, min: number]> = [
    ["bitboard.ts", "bitboard", 30],
    ["evalkit.ts", "evalkit", 28],
    ["trace.ts", "trace", 3],
    ["nnue.ts", "nnue", 4],
    ["types.ts", "types", 10],
  ];
  for (const [file, module, min] of cases) {
    it(`lists every ${file} function with module "${module}"`, () => {
      const names = listedFunctions(docBlock(file));
      expect(names.length).toBeGreaterThanOrEqual(min);
      const missing = names.filter((n) => find(n, module)?.kind !== "function");
      expect(missing).toEqual([]);
    });
  }

  it("lists every Position method and field with module \"position\"", () => {
    const block = docBlock("position.ts");
    const methods = listedFunctions(block);
    expect(methods.length).toBeGreaterThanOrEqual(20);
    const missingMethods = methods.filter((n) => find(`Position.${n}`, "position")?.kind !== "method");
    expect(missingMethods).toEqual([]);

    const fields = codeLines(block)
      .map((l) => /^\s+([a-z][A-Za-z0-9_]*):\s/.exec(l)?.[1])
      .filter((x): x is string => !!x);
    expect(fields).toEqual(["side", "castling", "epSquare", "halfmove", "fullmove", "key", "ply"]);
    const missingFields = fields.filter((n) => find(`Position.${n}`, "position")?.kind !== "variable");
    expect(missingFields).toEqual([]);
    expect(find("Position", "position")?.kind).toBe("class");
  });

  it("includes constants and variables with their types and values", () => {
    expect(find("PHASE_MAX", "evalkit")).toMatchObject({ kind: "constant", signature: "PHASE_MAX: i32 = 24" });
    expect(find("tracing", "trace")).toMatchObject({ kind: "variable", signature: "tracing: bool" });
    expect(find("FILE_A", "bitboard")?.signature).toBe("FILE_A: u64 = 0x0101010101010101");
    expect(find("E4", "types")?.signature).toBe("E4: i32 = 28");
    expect(find("MATE", "types")?.doc).toMatch(/checkmate right now/);
  });

  it("keeps signatures and docs readable", () => {
    expect(find("popcount", "bitboard")).toMatchObject({ signature: "popcount(b: u64): i32", doc: "Number of set bits (number of squares in the set)." });
    expect(find("Position.pieces", "position")).toMatchObject({ signature: "pieces(color: i32, type: i32): u64" });
    expect(find("taper", "evalkit")?.doc).toContain("Phase 24 gives `mg`");
    // A signature split over two lines in the source is joined.
    expect(find("think", "search")?.signature).toBe(
      "think(pos: Position, depth: i32, nodesLimit: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32",
    );
    for (const e of ENGINE_API) {
      expect(e.signature, e.name).not.toBe("");
      expect(e.signature, e.name).not.toMatch(/\n|\s{2}/);
    }
  });

  it("never lists private members or non-exported helpers", () => {
    expect(ENGINE_API.some((e) => e.name === "Position.addPiece" || e.name === "Position.sp")).toBe(false);
    expect(ENGINE_API.some((e) => e.name === "mix64" || e.name === "stepAttacks" || e.name === "term")).toBe(false);
  });

  it("groups modules in reference order with summaries", () => {
    expect(ENGINE_API_MODULES.slice(0, 6).map((m) => m.module)).toEqual(["evalkit", "position", "bitboard", "types", "trace", "nnue"]);
    expect(ENGINE_API_MODULES.find((m) => m.module === "evalkit")?.summary).toBe("building blocks for evaluation functions");
    // Entries follow the module order.
    const ranks = ENGINE_API.map((e) => ENGINE_API_MODULES.findIndex((m) => m.module === e.module));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(MODULE_ORDER[0]).toBe("evalkit");
    // Names are unique within a module.
    const keys = ENGINE_API.map((e) => `${e.module}:${e.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ENGINE_API)).toBe(true);
    expect(Object.isFrozen(ENGINE_API[0])).toBe(true);
  });
});

describe("parseModuleApi", () => {
  it("handles decorators, multi-declarator constants and generic commas", () => {
    const src = `
// header
/** Doc of f. */
@inline export function f(a: i32): i32 { return a; }

/**
 * Doc of g,
 * on two lines.
 *
 * Second paragraph.
 */
@inline
@external("env", "x")
export declare function g(): void;

export const A: i32 = 0,  B: i32 = 1;
export const M: Map<i32, i32> = new Map<i32, i32>(), N = 2;
export let counter: i32 = 0; // how many
`;
    const api = parseModuleApi(src, "m");
    expect(api.map((e) => [e.name, e.kind, e.signature])).toEqual([
      ["f", "function", "f(a: i32): i32"],
      ["g", "function", "g(): void"],
      ["A", "constant", "A: i32 = 0"],
      ["B", "constant", "B: i32 = 1"],
      ["M", "constant", "M: Map<i32, i32> = new Map<i32, i32>()"],
      ["N", "constant", "N = 2"],
      ["counter", "variable", "counter: i32"],
    ]);
    expect(api[0].doc).toBe("Doc of f.");
    expect(api[1].doc).toBe("Doc of g, on two lines.\n\nSecond paragraph.");
    expect(api[6].doc).toBe("how many");
    expect(api.every((e) => e.module === "m")).toBe(true);
  });

  it("is not confused by braces in strings and comments", () => {
    const src = `
function hidden(): string { return "}}}"; } // }
/* { */
const S = "{";
export function after(x: string = "(", y: i32 = 1): string { /* } */ return \`\${x}}\`; }
export const LAST: i32 = 3;
`;
    expect(parseModuleApi(src, "m").map((e) => e.signature)).toEqual(['after(x: string = "(", y: i32 = 1): string', "LAST: i32 = 3"]);
  });

  it("extracts public class members, enums and type aliases", () => {
    const src = `
/** A thing. */
export class Thing extends Base {
  /** The value. */
  value: i32 = 0;
  private secret: i32 = 1;
  protected hidden(): void {}
  static count: i32 = 0;
  readonly name: string = "}";

  constructor(v: i32) { super(); this.value = v; }

  /** Doubles. */
  @inline
  double(): i32 { if (this.value > 0) { return this.value * 2; } return 0; }

  get size(): i32 { return 1; }
  set size(v: i32) {}

  static make<T>(x: T): Thing { return new Thing(0); }
}

export enum Dir { North = 8, South = -8, East }
export type Score = i32;
export interface Shape { area(): f64; }
`;
    const api = parseModuleApi(src, "m");
    expect(api.map((e) => [e.name, e.kind, e.signature])).toEqual([
      ["Thing", "class", "class Thing extends Base"],
      ["Thing.value", "variable", "value: i32"],
      ["Thing.count", "variable", "static count: i32"],
      ["Thing.name", "variable", "readonly name: string"],
      ["Thing.double", "method", "double(): i32"],
      ["Thing.size", "variable", "size: i32"],
      ["Thing.make", "method", "static make<T>(x: T): Thing"],
      ["Dir", "type", "enum Dir"],
      ["Dir.North", "constant", "Dir.North = 8"],
      ["Dir.South", "constant", "Dir.South = -8"],
      ["Dir.East", "constant", "Dir.East"],
      ["Score", "type", "type Score = i32"],
      ["Shape", "type", "interface Shape"],
    ]);
    expect(api[0].doc).toBe("A thing.");
    expect(api[1].doc).toBe("The value.");
    expect(api[4].doc).toBe("Doubles.");
  });

  it("builds snippets and module names", () => {
    const fn = find("popcount", "bitboard")!;
    const method = find("Position.phase", "position")!;
    const field = find("Position.side", "position")!;
    const constant = find("PAWN", "types")!;
    expect([fn, method, field, constant].map(apiSnippet)).toEqual(["popcount()", "pos.phase()", "pos.side", "PAWN"]);
    expect(memberOf(method)).toEqual({ owner: "Position", member: "phase" });
    expect(memberOf(fn)).toBeNull();
    expect(moduleName("./evalkit")).toBe("evalkit");
    expect(moduleName("evalkit.ts")).toBe("evalkit");
    expect(moduleSummary("// ====\n// io.ts — talking to the host\n// ====")).toBe("talking to the host");
  });

  it("orders known modules first, then the rest alphabetically", () => {
    const { entries, modules } = buildEngineApi({
      "zeta.ts": "export const Z = 1;",
      "alpha.ts": "export function a(): void {}",
      "evalkit.ts": "// evalkit.ts — helpers\nexport function taper(): i32 { return 0; }",
      "notes.md": "ignored",
    });
    expect(modules.map((m) => [m.module, m.count, m.summary])).toEqual([
      ["evalkit", 1, "helpers"],
      ["alpha", 1, ""],
      ["zeta", 1, ""],
    ]);
    expect(entries.map((e) => e.name)).toEqual(["taper", "a", "Z"]);
  });
});
