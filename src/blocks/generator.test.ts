import { describe, expect, it } from "vitest";
import { block, num, rankZone, term, workspace } from "./builder";
import { BLOCK_DEFINITIONS, BUILTIN_BLOCK_TYPES } from "./definitions";
import { DEFAULT_WORKSPACE } from "./default-workspace";
import { generateEval, generateEvalSource, SUPPORTED_BLOCK_TYPES } from "./generator";
import { boardViewToLerf, mirrorLeftToRight, normalizePst, PST_PRESETS, presetValues, symmetrize } from "./pst";
import { sanitizeWorkspace } from "./sanitize";
import { blockTypesIn, kitchenSinkWorkspace, optionSweepWorkspace } from "./testing/fixtures";
import { RECIPES, toolboxBlockTypes } from "./toolbox";
import type { BlockState, WorkspaceState } from "./workspace-json";

const evalOf = (...terms: BlockState[]): WorkspaceState => {
  for (let i = 0; i < terms.length - 1; i++) terms[i]!.next = { block: terms[i + 1]! };
  return workspace([block("cb_evaluation", { id: "root", inputs: terms[0] ? { TERMS: terms[0] } : undefined })]);
};

/** Structural checks every generated file must pass. */
function expectWellFormed(code: string): void {
  expect(code).toContain('import { Position } from "./position";');
  expect(code).toContain("export function evaluate(pos: Position): i32");
  // No allocation or closures inside the evaluation.
  expect(code).not.toMatch(/\bnew\s/);
  expect(code).not.toContain("=>");
  // Balanced braces / parentheses.
  const count = (c: string) => code.split(c).length - 1;
  expect(count("{")).toBe(count("}"));
  expect(count("(")).toBe(count(")"));
  expect(count("[")).toBe(count("]"));
}

describe("DEFAULT_WORKSPACE", () => {
  it("generates a clean eval.ts", () => {
    const r = generateEval(DEFAULT_WORKSPACE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expectWellFormed(r.code);
    expect(r.terms).toEqual([
      "Material",
      "Piece-square tables",
      "Mobility",
      "Bishop pair",
      "Passed pawns",
      "Pawn on our 7th rank",
      "Pawn structure",
      "Rooks on open files",
      "King safety",
      "Tempo",
    ]);
  });

  it("calls every term for White and Black and traces it", () => {
    const { code } = generateEvalSource(DEFAULT_WORKSPACE);
    const fns = [...code.matchAll(/^function (term_\d+_\w+)\(pos: Position, us: i32, phase: i32\): i32 \{$/gm)].map((m) => m[1]!);
    expect(fns).toHaveLength(10);
    for (const fn of fns) {
      expect(code).toContain(`white = ${fn}(pos, WHITE, phase);`);
      expect(code).toContain(`black = ${fn}(pos, BLACK, phase);`);
    }
    expect(code).toContain('if (tracing) traceTerm("Pawn on our 7th rank", white, black);');
    expect(code).toContain("return taper(mg, eg, phase);");
    expect(code).toContain("const PST_1: StaticArray<i32> = [");
    // The user's example: any of our pawns on our 7th rank (relative rank index 6).
    expect(code).toContain("if ((pos.pieces(us, PAWN) & relativeRankMask(us, 6)) != 0) {");
    // Only documented template modules are imported.
    const modules = [...code.matchAll(/from "\.\/(\w+)";/g)].map((m) => m[1]);
    for (const m of modules) expect(["position", "types", "bitboard", "evalkit", "trace"]).toContain(m);
  });

  it("is frozen, JSON-serialisable and deterministic", () => {
    expect(Object.isFrozen(DEFAULT_WORKSPACE)).toBe(true);
    const copy = JSON.parse(JSON.stringify(DEFAULT_WORKSPACE)) as object;
    expect(generateEvalSource(copy).code).toBe(generateEvalSource(DEFAULT_WORKSPACE).code);
  });
});

describe("block coverage", () => {
  it("has a generator for every custom and toolbox block", () => {
    for (const def of BLOCK_DEFINITIONS) {
      if (def.type === "cb_evaluation" || def.type === "cb_term") continue;
      expect(SUPPORTED_BLOCK_TYPES, def.type).toContain(def.type);
    }
    for (const t of toolboxBlockTypes()) {
      if (t === "cb_evaluation" || t === "cb_term") continue;
      expect(SUPPORTED_BLOCK_TYPES, t).toContain(t);
    }
    for (const t of BUILTIN_BLOCK_TYPES) expect(SUPPORTED_BLOCK_TYPES, t).toContain(t);
  });

  it("kitchen sink uses every block type and generates without errors or warnings", () => {
    const ws = kitchenSinkWorkspace();
    const used = blockTypesIn(ws);
    for (const def of BLOCK_DEFINITIONS) expect(used, def.type).toContain(def.type);
    for (const t of BUILTIN_BLOCK_TYPES) expect(used, t).toContain(t);
    const r = generateEval(ws);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expectWellFormed(r.code);
    expect(r.code).toContain("let v_bonus: i32 = 0;");
    expect(r.code).toContain("let v_count_of_things: i32 = 0;");
    expect(r.code).toContain("cbDiv(v_count_of_things, cbMod(v_bonus, 3))");
    expect(r.code).toContain("} else if (phase <= 12) {");
    // Escaped trace label.
    expect(r.code).toContain('traceTerm("Everything \\"quoted\\" \\u2713", white, black);');
  });

  it("every dropdown option of every block generates without errors", () => {
    const r = generateEval(optionSweepWorkspace());
    expect(r.errors).toEqual([]);
    expectWellFormed(r.code);
    // Only the documented "always false" warning for passed pawns in non-pawn loops.
    for (const w of r.warnings) expect(w).toContain("only pawns can be passed pawns");
  });

  it("every ready-made term generates cleanly on its own", () => {
    for (const recipe of RECIPES) {
      const r = generateEval(evalOf(JSON.parse(JSON.stringify(recipe)) as BlockState));
      expect(r.errors, JSON.stringify(recipe.fields)).toEqual([]);
      expect(r.warnings, JSON.stringify(recipe.fields)).toEqual([]);
    }
  });
});

describe("semantics", () => {
  it("adds tapered points and folds trivial arithmetic", () => {
    const ws = evalOf(
      term("T", [
        block("cb_add_tapered", { fields: { OP: "ADD" }, inputs: { MG: num(30), EG: num(0) } }),
        block("cb_add_each_tapered", {
          fields: { OP: "ADD" },
          inputs: { MG: num(1), EG: num(2), COUNT: block("cb_count", { fields: { SIDE: "US", PIECE: "ROOK" } }) },
        }),
        block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(-7) } }),
      ]),
    );
    const { code, errors } = generateEvalSource(ws);
    expect(errors).toEqual([]);
    expect(code).toContain("mg += 30;");
    expect(code).not.toContain("eg += 0");
    expect(code).toMatch(/const (n\d+): i32 = pos\.count\(us, ROOK\);\n\s+mg \+= \1;\n\s+eg \+= 2 \* \1;/);
    expect(code).toContain("mg -= 7;");
  });

  it("uses `them` only when needed and mirrors squares for Black", () => {
    const ws = evalOf(
      term("Outpost", [
        block("controls_if", {
          inputs: {
            IF0: block("cb_any_on", {
              fields: { SIDE: "THEM", PIECE: "KNIGHT" },
              inputs: { ZONE: { shadow: { type: "cb_zone_square", fields: { FILE: "E", RANK: "4" } } } },
            }),
            DO0: block("cb_add", { fields: { OP: "SUB" }, inputs: { VALUE: num(9) } }),
          },
        }),
      ]),
      term("Plain", [block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(1) } })]),
    );
    const { code } = generateEvalSource(ws);
    expect(code).toContain("if ((pos.pieces(them, KNIGHT) & sqBB(relativeSquare(us, E4))) != 0) {");
    const plain = code.slice(code.indexOf("function term_2_plain"));
    expect(plain.slice(0, plain.indexOf("}"))).not.toContain("const them");
  });

  it("computes colour-relative rank masks at generation time", () => {
    const ws = evalOf(
      term("Ranks", [
        block("cb_add_each", {
          fields: { OP: "ADD" },
          inputs: {
            VALUE: num(1),
            COUNT: block("cb_count_on", {
              fields: { SIDE: "US", PIECE: "PAWN" },
              inputs: { ZONE: block("cb_zone_ranks", { fields: { WHOSE: "US", FROM: "5", TO: "7" } }) },
            }),
          },
        }),
      ]),
    );
    const { code } = generateEvalSource(ws);
    expect(code).toContain("const ZONE_1_WHITE: u64 = 0x00ffffff00000000;");
    // Black's 5th–7th ranks are White's 4th–2nd ranks.
    expect(code).toContain("const ZONE_1_BLACK: u64 = 0x00000000ffffff00;");
  });

  it("skips disabled blocks", () => {
    const disabled = block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(55) } });
    disabled.disabledReasons = ["MANUALLY_DISABLED"];
    const legacy = block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(66) } });
    legacy.enabled = false;
    const { code, errors } = generateEvalSource(evalOf(term("T", [disabled, legacy, block("cb_add", { inputs: { VALUE: num(77) } })])));
    expect(errors).toEqual([]);
    expect(code).not.toContain("55");
    expect(code).not.toContain("66");
    expect(code).toContain("mg += 77;");
  });

  it("copies block comments into the code", () => {
    const ws = evalOf(term("T", [block("cb_add", { inputs: { VALUE: num(5) }, comment: "Small bonus.\nSecond line." })]));
    const { code } = generateEvalSource(ws);
    expect(code).toContain("  // Small bonus.\n  // Second line.\n  mg += 5;");
  });

  it("visits the pieces of a loop from our own back rank, so White and Black are treated alike", () => {
    const ws = evalOf(term("T", [block("cb_for_each", { fields: { PIECE: "ROOK" }, inputs: { DO: block("cb_add", { inputs: { VALUE: num(1) } }) } })]));
    const { code } = generateEvalSource(ws);
    expect(code).toContain("let bb1: u64 = relativeBB(us, pos.pieces(us, ROOK));");
    expect(code).toContain("const sq1: i32 = relativeSquare(us, lsb(bb1));");
  });

  it("counts a pawn's moves (not its attacks) for “its mobility”", () => {
    const loop = (piece: string) =>
      block("cb_for_each", { fields: { PIECE: piece }, inputs: { DO: block("cb_add", { inputs: { VALUE: block("cb_it_mobility") } }) } });
    const { code, errors } = generateEvalSource(evalOf(term("T", [loop("PAWN"), loop("KNIGHT")])));
    expect(errors).toEqual([]);
    expect(code).toContain("const t1: i32 = pieceMobility(pos, us, PAWN, sq1);");
    expect(code).toContain("const t2: i32 = pieceMobility(pos, us, KNIGHT, sq2);");
    expect(code).not.toContain("attacksOf");
  });

  it("gives an empty branch of “choose” the kind of the other branch", () => {
    // In a squares slot an empty branch means "no squares" (a warning), not a type error.
    const choose = block("logic_ternary", {
      inputs: { IF: block("cb_our_turn"), THEN: block("cb_zone_area", { fields: { AREA: "CENTER" } }) },
    });
    const ws = evalOf(term("T", [block("cb_add", { inputs: { VALUE: block("cb_count_on", { fields: { SIDE: "US", PIECE: "ANY" }, inputs: { ZONE: choose } }) } })]));
    const r = generateEval(ws);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toContain("has an empty slot, which counts as no squares.");
    expect(r.code).toContain("(pos.side == us ? CENTER : <u64>0)");
    // Both branches empty in a squares slot: still "no squares".
    const empty = block("logic_ternary", { inputs: { IF: block("cb_our_turn") } });
    const both = generateEval(evalOf(term("T", [block("cb_add", { inputs: { VALUE: block("cb_count_on", { inputs: { ZONE: empty } }) } })])));
    expect(both.errors).toEqual([]);
  });

  it("never emits “-0”", () => {
    const { code } = generateEvalSource(evalOf(term("T", [block("cb_add", { inputs: { VALUE: block("cb_unary", { fields: { OP: "NEG" }, inputs: { A: num(0) } }) } })])));
    expect(code).not.toMatch(/-0\b/);
  });

  it("keeps term names readable in the breakdown", () => {
    const long = `${"x".repeat(59)}🐎 and more`;
    const r = generateEval(evalOf(term(long, [block("cb_add", { inputs: { VALUE: num(1) } })]), term("Total", [block("cb_add", { inputs: { VALUE: num(2) } })])));
    expect(r.terms).toEqual([`${"x".repeat(59)}🐎`, "Total (term)"]); // cut by code points; "total" is the trace's sum line
    expect(r.warnings.join("\n")).toContain("“Total” is the name of the sum in the evaluation breakdown");
    expect(r.code).toContain(`traceTerm("${"x".repeat(59)}\\ud83d\\udc0e", white, black);`);
  });
});

describe("invalid workspaces produce errors, not exceptions", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["a number", 42],
    ["a string", "blocks"],
    ["an array", []],
    ["blocks is a string", { blocks: "garbage" }],
    ["blocks.blocks is an object", { blocks: { blocks: { a: 1 } } }],
    ["top block without type", { blocks: { blocks: [{}] } }],
  ];
  for (const [name, ws] of cases) {
    it(name, () => {
      const r = generateEvalSource(ws as object);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.code).toContain("export function evaluate(pos: Position): i32");
    });
  }

  it("reports unknown block types", () => {
    const r = generateEval(evalOf(term("T", [{ type: "no_such_block", id: "x1" }])));
    expect(r.errors.join(" ")).toContain("unknown block type");
    expect(r.diagnostics[0]?.blockId).toBe("x1");
    expectWellFormed(r.code);
  });

  it("reports loop blocks used outside a loop", () => {
    const r = generateEval(evalOf(term("T", [block("cb_add", { inputs: { VALUE: block("cb_it_rank", { id: "it" }) } })])));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("for each");
    expect(r.diagnostics.find((d) => d.severity === "error")?.blockId).toBe("it");
    expectWellFormed(r.code);
  });

  it("reports blocks in the wrong place", () => {
    const nestedTerm = term("Inner", [block("cb_add", { inputs: { VALUE: num(1) } })]);
    const ws = evalOf(term("Outer", [block("controls_if", { inputs: { IF0: block("logic_boolean"), DO0: nestedTerm } })]));
    const r = generateEval(ws);
    expect(r.errors.join(" ")).toContain("Term");
    const direct = generateEval(workspace([block("cb_evaluation", { inputs: { TERMS: block("controls_if") } })]));
    expect(direct.errors.join(" ")).toContain("inside a Term block");
  });

  it("reports invalid field values and clamps out-of-range numbers", () => {
    const ws = evalOf(
      term("T", [
        block("cb_material", { fields: { P: 99999 } }),
        block("cb_add", { inputs: { VALUE: block("cb_count", { fields: { SIDE: "SIDEWAYS", PIECE: "PAWN" } }) } }),
        block("cb_add", { inputs: { VALUE: { shadow: { type: "math_number", fields: { NUM: 2.5 } } } } }),
        block("cb_pst", { fields: { TABLE: [1, 2, 3] } }),
      ]),
    );
    const r = generateEval(ws);
    expect(r.errors.some((e) => e.includes("SIDEWAYS"))).toBe(true);
    expect(r.errors.some((e) => e.includes("64 numbers"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("5000"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("2.5"))).toBe(true);
    expect(r.code).toContain("material(pos, us, 5000, 320, 330, 500, 900)");
    expectWellFormed(r.code);
  });

  it("survives cycles and deep nesting", () => {
    const a: BlockState = { type: "cb_add", inputs: {} };
    a.inputs!.VALUE = { block: a };
    const r = generateEval(evalOf(term("T", [a])));
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("warnings", () => {
  it("no Evaluation block", () => {
    const r = generateEvalSource(workspace([]));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toContain("no Evaluation block");
    expect(r.code).toContain("return 0;");
  });

  it("several Evaluation blocks, loose blocks, empty and duplicate terms", () => {
    const ws = workspace([
      block("cb_evaluation", { id: "e1", inputs: { TERMS: term("Same", []) } }),
      block("cb_evaluation", { id: "e2" }),
      block("cb_add", { id: "loose", inputs: { VALUE: num(1) } }),
    ]);
    (ws.blocks!.blocks![0]!.inputs!.TERMS!.block!).next = { block: term("Same", [block("cb_add", { inputs: { VALUE: num(1) } })]) };
    const r = generateEval(ws);
    expect(r.errors).toEqual([]);
    const text = r.warnings.join("\n");
    expect(text).toContain("Only one Evaluation block is used");
    expect(text).toContain("not connected to the Evaluation block");
    expect(text).toContain("This term is empty");
    expect(text).toContain("Another term is also called “Same”");
    expect(r.diagnostics.map((d) => d.blockId)).toEqual(expect.arrayContaining(["e2", "loose"]));
  });

  it("empty slots fall back to neutral values", () => {
    const r = generateEval(evalOf(term("T", [block("cb_add"), block("controls_if", { inputs: { DO0: block("cb_add", { inputs: { VALUE: num(3) } }) } })])));
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    expect(r.code).toContain("if (false) {");
  });
});

describe("piece-square tables", () => {
  it("converts printed boards (rank 8 first) to LERF", () => {
    const printed = Array.from({ length: 64 }, (_, i) => i);
    const lerf = boardViewToLerf(printed);
    expect(lerf[56]).toBe(0); // a8 is the first printed square
    expect(lerf[0]).toBe(56); // a1 is the first square of the last printed row
    expect(lerf[63]).toBe(7);
  });

  it("mirror, symmetrize and presets", () => {
    const t = Array.from({ length: 64 }, (_, i) => (i & 7) * 10);
    const m = mirrorLeftToRight(t);
    expect(m.slice(0, 8)).toEqual([0, 10, 20, 30, 30, 20, 10, 0]);
    expect(symmetrize(t).slice(0, 8)).toEqual([35, 35, 35, 35, 35, 35, 35, 35]);
    for (const p of PST_PRESETS) expect(normalizePst(p.values())).toHaveLength(64);
    expect(presetValues("CENTER")[27]).toBe(20); // d4
    expect(presetValues("CENTER")[0]).toBe(-10); // a1
    expect(normalizePst([1, 2])).toBeNull();
  });
});

describe("sanitizeWorkspace", () => {
  it("drops unknown block types but keeps the rest of the chain", () => {
    const known = new Set(["cb_evaluation", "cb_term", "cb_add", "math_number"]);
    const ws = evalOf(term("T", [block("cb_add", { inputs: { VALUE: num(1) } }), { type: "mystery" }, block("cb_add", { inputs: { VALUE: num(2) } })]));
    const { workspace: clean, removed } = sanitizeWorkspace(ws, (t) => known.has(t));
    expect(removed).toEqual(["mystery"]);
    const r = generateEval(clean);
    expect(r.errors).toEqual([]);
    expect(r.code).toContain("mg += 1;");
    expect(r.code).toContain("mg += 2;");
  });
});

// Keeps the toolbox honest: recipe/toolbox JSON must only use known fields (typos would be silently ignored by Blockly).
describe("toolbox JSON", () => {
  it("recipes reference valid fields", () => {
    const r = generateEval(evalOf(...RECIPES.map((x) => JSON.parse(JSON.stringify(x)) as BlockState)));
    expect(r.warnings.filter((w) => w.includes("unknown"))).toEqual([]);
    expect(rankZone(7).shadow?.fields?.RANK).toBe("7");
  });
});
