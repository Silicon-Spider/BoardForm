// Workspaces used by the tests: a hand-built "kitchen sink" that nests every block type, and a
// systematic sweep that instantiates every dropdown option of every custom block. Pure data.

import { block, num, numBlock, rankZone, shadow, stack, term, workspace } from "../builder";
import { BLOCK_DEFINITIONS, BLOCK_INFO, LOOP_VALUE_TYPES } from "../definitions";
import { pestoTable, presetValues } from "../pst";
import { RECIPES } from "../toolbox";
import type { BlockState, ConnectionState, WorkspaceState } from "../workspace-json";

const add = (value: BlockState | ConnectionState) => block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: value } });
const ifThen = (cond: BlockState, body: BlockState) => block("controls_if", { inputs: { IF0: cond, DO0: body } });
const zoneCount = (zone: BlockState) =>
  block("cb_count_on", { fields: { SIDE: "US", PIECE: "ANY" }, inputs: { ZONE: zone } });

/** Every block type, nested the way a user would combine them. */
export function kitchenSinkWorkspace(): WorkspaceState {
  const vars = [
    { name: "bonus", id: "var-bonus" },
    { name: "count of things", id: "var-count" },
  ];
  const getVar = (id: string) => block("variables_get", { fields: { VAR: { id } } });

  const everything = term("Everything \"quoted\" ✓", [
    add(
      block("cb_arith", {
        fields: { OP: "ADD" },
        inputs: {
          A: num(1),
          B: block("cb_minmax", {
            fields: { OP: "MIN" },
            inputs: {
              A: block("cb_count", { fields: { SIDE: "THEM", PIECE: "KNIGHT" } }),
              B: block("cb_count_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: rankZone(5, "THEM") } }),
            },
          }),
        },
      }),
    ),
    block("cb_add_tapered", {
      fields: { OP: "SUB" },
      inputs: {
        MG: block("cb_unary", { fields: { OP: "ABS" }, inputs: { A: block("cb_material_diff") } }),
        EG: block("cb_clamp", {
          inputs: { X: block("cb_material_value", { fields: { SIDE: "THEM" } }), LO: num(-100), HI: num(100) },
        }),
      },
    }),
    block("cb_add_each", {
      fields: { OP: "ADD" },
      inputs: { VALUE: num(3), COUNT: block("cb_mobility", { fields: { SIDE: "US", PIECE: "ALL" } }) },
    }),
    block("cb_add_each_tapered", {
      fields: { OP: "SUB" },
      inputs: { MG: num(7), EG: num(-3), COUNT: block("cb_pawn_structure", { fields: { SIDE: "THEM", KIND: "BACKWARD" } }) },
    }),
    block("cb_material"),
    block("cb_material_tapered"),
    block("cb_pst", { fields: { PIECE: "KNIGHT", TABLE: presetValues("CENTER") } }),
    block("cb_pst_tapered", { fields: { PIECE: "KING", MG: pestoTable("KING_MG"), EG: pestoTable("KING_EG") } }),
    block("controls_if", {
      extraState: { elseIfCount: 1, hasElse: true },
      inputs: {
        IF0: block("logic_operation", {
          fields: { OP: "AND" },
          inputs: {
            A: block("cb_any_on", {
              fields: { SIDE: "US", PIECE: "ROOK" },
              inputs: {
                ZONE: block("cb_zone_combine", {
                  fields: { OP: "OR" },
                  inputs: {
                    A: block("cb_zone_rank", { fields: { WHOSE: "US", RANK: "7" } }),
                    B: block("cb_zone_ranks", { fields: { WHOSE: "THEM", FROM: "1", TO: "2" } }),
                  },
                }),
              },
            }),
            B: block("logic_negate", { inputs: { BOOL: block("cb_bishop_pair", { fields: { SIDE: "THEM" } }) } }),
          },
        }),
        DO0: add(num(15)),
        IF1: block("logic_compare", { fields: { OP: "LTE" }, inputs: { A: block("cb_phase"), B: num(12) } }),
        DO1: add(block("cb_king_distance")),
        ELSE: add(block("cb_halfmove")),
      },
    }),
    block("controls_ifelse", {
      inputs: {
        IF0: block("logic_operation", {
          fields: { OP: "OR" },
          inputs: { A: block("logic_boolean", { fields: { BOOL: "FALSE" } }), B: block("cb_is_endgame", { fields: { PHASE: 6 } }) },
        }),
        DO0: add(block("cb_passed_rank", { fields: { SIDE: "US", RANK: "6" } })),
        ELSE: add(block("cb_rooks_files", { fields: { SIDE: "US", KIND: "HALF" } })),
      },
    }),
    block("variables_set", {
      fields: { VAR: { id: "var-bonus" } },
      inputs: {
        VALUE: block("logic_ternary", {
          inputs: { IF: block("cb_our_turn"), THEN: num(10), ELSE: numBlock(-10) },
        }),
      },
    }),
    block("math_change", {
      fields: { VAR: { id: "var-count" } },
      inputs: { DELTA: block("cb_by_rank", { inputs: { RANK: getVar("var-bonus") } }) },
    }),
    add(
      block("cb_arith", {
        fields: { OP: "DIV" },
        inputs: {
          A: getVar("var-count"),
          B: block("cb_arith", { fields: { OP: "MOD" }, inputs: { A: getVar("var-bonus"), B: num(3) } }),
        },
      }),
    ),
    add(
      block("cb_arith", {
        fields: { OP: "SUB" },
        inputs: {
          A: block("cb_arith", { fields: { OP: "MUL" }, inputs: { A: block("cb_king_shield", { fields: { SIDE: "US" } }), B: num(-2) } }),
          B: block("cb_unary", { fields: { OP: "NEG" }, inputs: { A: block("cb_king_attacks", { fields: { SIDE: "THEM" } }) } }),
        },
      }),
    ),
    add(block("cb_minmax", { fields: { OP: "MAX" }, inputs: { A: block("cb_king_center", { fields: { SIDE: "THEM" } }), B: block("cb_hanging", { fields: { SIDE: "US" } }) } })),
    ifThen(
      block("logic_operation", {
        fields: { OP: "OR" },
        inputs: {
          A: block("cb_in_check", { fields: { WHO: "THEM" } }),
          B: block("cb_can_castle", { fields: { WHO: "US", WAY: "QUEEN" } }),
        },
      }),
      add(zoneCount(block("cb_zone_area", { fields: { AREA: "EDGE" } }))),
    ),
    add(zoneCount(block("cb_zone_attacked", { fields: { WHOSE: "THEM", BY: "BISHOP" } }))),
    add(zoneCount(block("cb_zone_king", { fields: { WHOSE: "US" } }))),
    add(zoneCount(block("cb_zone_pieces", { fields: { WHOSE: "THEM", PIECE: "PAWN" } }))),
    add(zoneCount(block("cb_zone_files", { fields: { KIND: "HALF_THEM" } }))),
    add(zoneCount(block("cb_zone_file", { fields: { FILE: "H" } }))),
    add(zoneCount(block("cb_zone_square", { fields: { FILE: "D", RANK: "5" } }))),
    block("cb_for_each", {
      fields: { PIECE: "PAWN" },
      inputs: {
        DO: stack(
          ifThen(
            block("logic_operation", {
              fields: { OP: "AND" },
              inputs: {
                A: block("cb_it_passed"),
                B: block("logic_operation", {
                  fields: { OP: "OR" },
                  inputs: { A: block("cb_it_attacked"), B: block("logic_negate", { inputs: { BOOL: block("cb_it_defended") } }) },
                }),
              },
            }),
            add(block("cb_arith", { fields: { OP: "MUL" }, inputs: { A: block("cb_it_rank"), B: block("cb_it_file") } })),
          ),
          block("cb_add_each", { fields: { OP: "ADD" }, inputs: { VALUE: num(2), COUNT: block("cb_it_mobility") } }),
          add(block("cb_it_king_distance", { fields: { WHOSE: "US" } })),
          add(block("cb_it_center_distance")),
          ifThen(block("cb_it_open_file", { fields: { KIND: "HALF" } }), add(num(5))),
          ifThen(block("cb_it_on", { inputs: { ZONE: block("cb_zone_file", { fields: { FILE: "A" } }) } }), add(num(-5))),
          add(block("cb_it_attacks_in", { inputs: { ZONE: shadow(block("cb_zone_king", { fields: { WHOSE: "THEM" } })) } })),
          add(block("cb_it_pst", { fields: { TABLE: presetValues("ADVANCE") } })),
          block("cb_for_each", {
            fields: { PIECE: "KNIGHT" },
            inputs: { DO: add(block("cb_it_king_distance", { fields: { WHOSE: "THEM" } })) },
          }),
        )!,
      },
    }),
    add(getVar("var-bonus")),
  ]);

  const second = term("Second term", [
    add(block("logic_ternary", { inputs: { IF: block("logic_boolean", { fields: { BOOL: "TRUE" } }), THEN: num(1), ELSE: num(2) } })),
    add(
      block("logic_ternary", {
        inputs: {
          IF: block("logic_compare", {
            fields: { OP: "NEQ" },
            inputs: { A: block("cb_our_turn"), B: block("cb_in_check", { fields: { WHO: "US" } }) },
          }),
          THEN: num(4),
          ELSE: num(-4),
        },
      }),
    ),
  ]);

  const root = block("cb_evaluation", { id: "root", x: 0, y: 0, inputs: { TERMS: stack(everything, second, ...RECIPES.map((r) => JSON.parse(JSON.stringify(r)) as BlockState))! } });
  return workspace([root], vars);
}

/** Consumes a value of the given output type as an action. */
function consume(b: BlockState, output: string | null): BlockState {
  if (output === "Boolean") return ifThen(b, add(num(1)));
  if (output === "Zone") return add(zoneCount(b));
  return add(b);
}

/** Default inputs so that swept blocks have every slot filled. */
function fillInputs(type: string): Record<string, BlockState> {
  const info = BLOCK_INFO.get(type)!;
  const inputs: Record<string, BlockState> = {};
  for (const [name, arg] of info.inputs) {
    if (arg.type !== "input_value") continue;
    const check = Array.isArray(arg.check) ? arg.check[0] : arg.check;
    if (check === "Zone") inputs[name] = block("cb_zone_area", { fields: { AREA: "CENTER" } });
    else if (check === "Boolean") inputs[name] = block("logic_boolean", { fields: { BOOL: "TRUE" } });
    else inputs[name] = numBlock(2);
  }
  return inputs;
}

/**
 * One block per dropdown option of every custom block (other fields at their defaults), each
 * plugged into something that uses it. Loop-only blocks are swept inside a loop over every piece.
 */
export function optionSweepWorkspace(): WorkspaceState {
  const actions: BlockState[] = [];
  const loopValues: BlockState[] = [];
  for (const def of BLOCK_DEFINITIONS) {
    const info = BLOCK_INFO.get(def.type)!;
    if (def.type === "cb_evaluation" || def.type === "cb_term") continue;
    const variants: Record<string, unknown>[] = [{}];
    for (const [name, arg] of info.fields) {
      if (arg.type !== "field_dropdown") continue;
      for (const [, value] of arg.options.slice(1)) variants.push({ [name]: value });
    }
    for (const fields of variants) {
      const inputs = fillInputs(def.type);
      if (def.type === "cb_for_each") {
        inputs.DO = add(block("cb_it_rank"));
      }
      const b = block(def.type, { fields, inputs: Object.keys(inputs).length ? inputs : undefined });
      if (info.statement) actions.push(b);
      else if (LOOP_VALUE_TYPES.has(def.type)) loopValues.push(consume(b, info.output));
      else actions.push(consume(b, info.output));
    }
  }
  const loops = ["PAWN", "KNIGHT", "BISHOP", "ROOK", "QUEEN", "KING"].map((piece) =>
    block("cb_for_each", {
      fields: { PIECE: piece },
      inputs: { DO: stack(...(JSON.parse(JSON.stringify(loopValues)) as BlockState[]))! },
    }),
  );
  // Built-in operators with every option.
  for (const op of ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"]) {
    actions.push(consume(block("logic_compare", { fields: { OP: op }, inputs: { A: numBlock(1), B: numBlock(2) } }), "Boolean"));
  }
  const terms = [term("Sweep", actions), term("Sweep loops", loops)];
  const root = block("cb_evaluation", { x: 0, y: 0, inputs: { TERMS: stack(...terms)! } });
  return workspace([root]);
}

/**
 * The kitchen sink and the option sweep in one Evaluation block: every block type nested the way
 * users combine them, and every dropdown option of every block at least once.
 */
export function everythingWorkspace(): WorkspaceState {
  const parts = [kitchenSinkWorkspace(), optionSweepWorkspace()];
  const terms: BlockState[] = [];
  for (const ws of parts) {
    for (let t = ws.blocks?.blocks?.[0]?.inputs?.TERMS?.block; t; t = t.next?.block) terms.push(t);
  }
  const root = block("cb_evaluation", { x: 0, y: 0, inputs: { TERMS: stack(...terms.map((t) => ({ ...t, next: undefined })))! } });
  return workspace([root], parts.flatMap((ws) => ws.variables ?? []));
}

/** Every block type used anywhere in a workspace. */
export function blockTypesIn(ws: WorkspaceState): Set<string> {
  const types = new Set<string>();
  const visit = (x: unknown): void => {
    if (typeof x !== "object" || x === null) return;
    const rec = x as Record<string, unknown>;
    if (typeof rec.type === "string") types.add(rec.type);
    for (const v of Object.values(rec)) visit(v);
  };
  visit(ws.blocks);
  return types;
}

/**
 * Every "type.FIELD=value" dropdown choice used in a workspace (built-in dropdowns included). A
 * dropdown field that is left out of the JSON counts as its first option, as in the generator.
 */
export function dropdownChoicesIn(ws: WorkspaceState): Set<string> {
  const out = new Set<string>();
  const visit = (x: unknown): void => {
    if (typeof x !== "object" || x === null) return;
    const rec = x as Record<string, unknown>;
    if (typeof rec.type === "string") {
      const fields = typeof rec.fields === "object" && rec.fields !== null ? (rec.fields as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(fields)) if (typeof v === "string") out.add(`${rec.type}.${k}=${v}`);
      for (const [k, f] of BLOCK_INFO.get(rec.type)?.fields ?? []) {
        if (f.type === "field_dropdown" && fields[k] === undefined) out.add(`${rec.type}.${k}=${f.options[0]![1]}`);
      }
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(ws.blocks);
  return out;
}
