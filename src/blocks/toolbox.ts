// The categorised toolbox (Blockly JSON toolbox definition). Pure data.
// Blocks in the toolbox carry shadow blocks so every number / square has an editable default.
// No block ids here: Blockly creates fresh blocks (with fresh ids) when one is dragged out.

import { block, num, rankZone, shadow, term } from "./builder";
import type { BlockState, ConnectionState } from "./workspace-json";

export interface ToolboxItem {
  kind: "block" | "label" | "sep" | "category";
  [key: string]: unknown;
}

export interface ToolboxCategory {
  kind: "category";
  name: string;
  categorystyle: string;
  contents?: ToolboxItem[];
  custom?: string;
}

export interface ToolboxDefinition {
  kind: "categoryToolbox";
  contents: (ToolboxCategory | ToolboxItem)[];
}

const item = (b: BlockState): ToolboxItem => ({ kind: "block", ...b });
const label = (text: string): ToolboxItem => ({ kind: "label", text });
const sep = (gap = 20): ToolboxItem => ({ kind: "sep", gap: String(gap) });

const zoneShadow = (b: BlockState): ConnectionState => shadow(b);
const area = (a: string): ConnectionState => zoneShadow(block("cb_zone_area", { fields: { AREA: a } }));

const add = (n: number, sub = false) => block("cb_add", { fields: { OP: sub ? "SUB" : "ADD" }, inputs: { VALUE: num(n) } });
const addTapered = (mg: number, eg: number) => block("cb_add_tapered", { fields: { OP: "ADD" }, inputs: { MG: num(mg), EG: num(eg) } });
const addEach = (n: number, count: BlockState, sub = false) =>
  block("cb_add_each", { fields: { OP: sub ? "SUB" : "ADD" }, inputs: { VALUE: num(n), COUNT: count } });
const addEachTapered = (mg: number, eg: number, count: BlockState, sub = false) =>
  block("cb_add_each_tapered", { fields: { OP: sub ? "SUB" : "ADD" }, inputs: { MG: num(mg), EG: num(eg), COUNT: count } });
const ifThen = (cond: BlockState, body: BlockState) => block("controls_if", { inputs: { IF0: cond, DO0: body } });
const compare = (op: string, a: number, b: number) =>
  block("logic_compare", { fields: { OP: op }, inputs: { A: num(a), B: num(b) } });

/** Complete terms users can drop straight into the Evaluation block. */
export const RECIPES: BlockState[] = [
  term("Pawn on our 7th rank", [
    ifThen(block("cb_any_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: rankZone(7) } }), add(20)),
  ]),
  term("Bishop pair", [ifThen(block("cb_bishop_pair", { fields: { SIDE: "US" } }), addTapered(30, 50))]),
  term("Rook on the 7th", [
    addEach(20, block("cb_count_on", { fields: { SIDE: "US", PIECE: "ROOK" }, inputs: { ZONE: rankZone(7) } })),
  ]),
  term("Knight outposts", [
    block("cb_for_each", {
      fields: { PIECE: "KNIGHT" },
      inputs: {
        DO: ifThen(
          block("logic_operation", {
            fields: { OP: "AND" },
            inputs: {
              A: block("cb_it_on", { inputs: { ZONE: area("THEIR_HALF") } }),
              B: block("cb_it_on", {
                inputs: { ZONE: zoneShadow(block("cb_zone_attacked", { fields: { WHOSE: "US", BY: "PAWN" } })) },
              }),
            },
          }),
          addTapered(20, 10),
        ),
      },
    }),
  ]),
  term("Centralize the king in the endgame", [
    addEachTapered(0, 10, block("cb_king_center", { fields: { SIDE: "US" } }), true),
  ]),
  term("Push the enemy king to the edge", [
    ifThen(
      block("logic_compare", {
        fields: { OP: "GT" },
        inputs: { A: block("cb_material_diff"), B: num(300) },
      }),
      addEachTapered(0, 10, block("cb_king_center", { fields: { SIDE: "THEM" } })),
    ),
  ]),
  term("Don't leave pieces hanging", [
    ifThen(
      block("logic_negate", { inputs: { BOOL: block("cb_our_turn") } }),
      addEach(30, block("cb_hanging", { fields: { SIDE: "US" } }), true),
    ),
  ]),
  term("Attack the enemy king", [
    block("cb_for_each", {
      fields: { PIECE: "QUEEN" },
      inputs: {
        DO: addEachTapered(
          6,
          0,
          block("cb_it_attacks_in", { inputs: { ZONE: zoneShadow(block("cb_zone_king", { fields: { WHOSE: "THEM" } })) } }),
        ),
      },
    }),
  ]),
];

const category = (name: string, style: string, contents: ToolboxItem[]): ToolboxCategory => ({
  kind: "category",
  name,
  categorystyle: style,
  contents,
});

/** Builds a fresh toolbox definition (Blockly may annotate the objects it is given). */
export function buildToolbox(): ToolboxDefinition {
  return {
    kind: "categoryToolbox",
    contents: [
      category("Structure", "cat_structure", [
        label("The root — one per engine"),
        item(block("cb_evaluation")),
        label("A named part of the evaluation"),
        item(block("cb_term", { fields: { NAME: "My term" } })),
      ]),
      category("Add points", "cat_points", [
        label("100 points = one pawn"),
        item(add(10)),
        item(addTapered(10, 20)),
        item(addEach(10, block("cb_count", { fields: { SIDE: "US", PIECE: "PAWN" } }))),
        item(addEachTapered(5, 10, block("cb_pawn_structure", { fields: { SIDE: "US", KIND: "PASSED" } }))),
      ]),
      category("Ready-made terms", "cat_recipes", [
        label("Drop these into the Evaluation block and tweak them · 100 points = one pawn"),
        ...RECIPES.map((r) => item(r)),
      ]),
      category("Classic eval", "cat_classic", [
        label("Material & piece-square tables"),
        item(block("cb_material")),
        item(block("cb_material_tapered")),
        item(block("cb_pst", { fields: { PIECE: "KNIGHT" } })),
        item(block("cb_pst_tapered", { fields: { PIECE: "KING" } })),
        sep(),
        label("Pieces & pawns"),
        item(block("cb_mobility", { fields: { SIDE: "US", PIECE: "KNIGHT" } })),
        item(block("cb_pawn_structure", { fields: { SIDE: "US", KIND: "PASSED" } })),
        item(block("cb_passed_rank", { fields: { SIDE: "US", RANK: "5" } })),
        item(block("cb_rooks_files", { fields: { SIDE: "US", KIND: "OPEN" } })),
        item(block("cb_bishop_pair", { fields: { SIDE: "US" } })),
        item(block("cb_hanging", { fields: { SIDE: "US" } })),
        sep(),
        label("Kings"),
        item(block("cb_king_shield", { fields: { SIDE: "US" } })),
        item(block("cb_king_attacks", { fields: { SIDE: "US" } })),
        item(block("cb_king_distance")),
        item(block("cb_king_center", { fields: { SIDE: "US" } })),
      ]),
      category("Pieces", "cat_pieces", [
        label("Is a piece somewhere? Change the squares in the slot."),
        item(block("cb_any_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: rankZone(7) } })),
        item(block("cb_any_on", { fields: { SIDE: "US", PIECE: "KNIGHT" }, inputs: { ZONE: area("CENTER") } })),
        item(block("cb_count_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: area("BIG_CENTER") } })),
        item(
          block("cb_count_on", {
            fields: { SIDE: "THEM", PIECE: "ANY" },
            inputs: { ZONE: zoneShadow(block("cb_zone_square", { fields: { FILE: "E", RANK: "4" } })) },
          }),
        ),
        sep(),
        label("Counting"),
        item(block("cb_count", { fields: { SIDE: "US", PIECE: "QUEEN" } })),
        item(block("cb_material_value", { fields: { SIDE: "US" } })),
        item(block("cb_material_diff")),
      ]),
      category("Squares", "cat_zone", [
        label("Groups of squares, seen from our side"),
        item(block("cb_zone_rank", { fields: { WHOSE: "US", RANK: "7" } })),
        item(block("cb_zone_ranks", { fields: { WHOSE: "US", FROM: "5", TO: "7" } })),
        item(block("cb_zone_file", { fields: { FILE: "D" } })),
        item(block("cb_zone_square", { fields: { FILE: "E", RANK: "4" } })),
        item(block("cb_zone_area", { fields: { AREA: "CENTER" } })),
        item(block("cb_zone_area", { fields: { AREA: "THEIR_HALF" } })),
        sep(),
        label("Squares that depend on the position"),
        item(block("cb_zone_attacked", { fields: { WHOSE: "THEM", BY: "PAWN" } })),
        item(block("cb_zone_king", { fields: { WHOSE: "THEM" } })),
        item(block("cb_zone_pieces", { fields: { WHOSE: "US", PIECE: "PAWN" } })),
        item(block("cb_zone_files", { fields: { KIND: "OPEN" } })),
        sep(),
        label("Combine two groups"),
        item(
          block("cb_zone_combine", {
            fields: { OP: "MINUS" },
            inputs: {
              A: area("THEIR_HALF"),
              B: zoneShadow(block("cb_zone_attacked", { fields: { WHOSE: "THEM", BY: "PAWN" } })),
            },
          }),
        ),
      ]),
      category("Game state", "cat_state", [
        item(block("cb_phase")),
        item(block("cb_is_endgame", { fields: { PHASE: 8 } })),
        item(block("cb_our_turn")),
        item(block("cb_in_check", { fields: { WHO: "US" } })),
        item(block("cb_can_castle", { fields: { WHO: "US", WAY: "EITHER" } })),
        item(block("cb_halfmove")),
      ]),
      category("For each piece", "cat_loop", [
        label("Look at our pieces one by one"),
        item(block("cb_for_each", { fields: { PIECE: "KNIGHT" } })),
        label("Use these inside “for each”"),
        item(block("cb_it_rank")),
        item(block("cb_it_file")),
        item(block("cb_it_attacked")),
        item(block("cb_it_defended")),
        item(block("cb_it_mobility")),
        item(block("cb_it_passed")),
        item(block("cb_it_king_distance", { fields: { WHOSE: "THEM" } })),
        item(block("cb_it_center_distance")),
        item(block("cb_it_open_file", { fields: { KIND: "OPEN" } })),
        item(block("cb_it_on", { inputs: { ZONE: area("CENTER") } })),
        item(
          block("cb_it_attacks_in", {
            inputs: { ZONE: zoneShadow(block("cb_zone_king", { fields: { WHOSE: "THEM" } })) },
          }),
        ),
        item(block("cb_it_pst")),
      ]),
      category("Logic", "cat_logic", [
        item(block("controls_if")),
        item(block("controls_if", { extraState: { hasElse: true } })),
        item(block("controls_if", { extraState: { elseIfCount: 1, hasElse: true } })),
        sep(),
        item(compare("GT", 0, 0)),
        item(block("logic_operation", { fields: { OP: "AND" } })),
        item(block("logic_negate")),
        item(block("logic_boolean", { fields: { BOOL: "TRUE" } })),
        item(block("logic_ternary", { inputs: { THEN: num(10), ELSE: num(0) } })),
      ]),
      category("Math", "cat_math", [
        item(block("math_number", { fields: { NUM: 10 } })),
        item(block("cb_arith", { fields: { OP: "ADD" }, inputs: { A: num(1), B: num(1) } })),
        item(block("cb_arith", { fields: { OP: "MUL" }, inputs: { A: num(2), B: num(5) } })),
        item(block("cb_minmax", { fields: { OP: "MIN" }, inputs: { A: num(0), B: num(100) } })),
        item(block("cb_unary", { fields: { OP: "ABS" }, inputs: { A: num(-5) } })),
        item(block("cb_clamp", { inputs: { X: num(0), LO: num(-50), HI: num(50) } })),
        item(block("cb_by_rank", { inputs: { RANK: shadow(block("math_number", { fields: { NUM: 7 } })) } })),
      ]),
      { kind: "category", name: "Variables", categorystyle: "cat_variables", custom: "VARIABLE" },
    ],
  };
}

/** Every block type that appears somewhere in the toolbox (excluding the dynamic Variables category). */
export function toolboxBlockTypes(): Set<string> {
  const types = new Set<string>();
  const visit = (b: unknown): void => {
    if (typeof b !== "object" || b === null) return;
    const rec = b as Record<string, unknown>;
    if (typeof rec.type === "string") types.add(rec.type);
    for (const v of Object.values(rec)) if (typeof v === "object") visit(v);
  };
  for (const c of buildToolbox().contents) visit(c);
  return types;
}
