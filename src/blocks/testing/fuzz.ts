// Seeded random blocks workspaces for differential testing (compile.test.ts): every value block
// is nested at random into the slots of the others — respecting the connection checks Blockly
// enforces, so every workspace is one a user could build — with random field values, inside random
// statements, loops and if / else-if chains. Pure data, deterministic for a seed.

import { block, workspace } from "../builder";
import { BLOCK_DEFINITIONS, BLOCK_INFO, LOOP_VALUE_TYPES } from "../definitions";
import { pestoTable, presetValues } from "../pst";
import type { BlockState, ConnectionState, WorkspaceState } from "../workspace-json";

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Slot = "Number" | "Boolean" | "Zone";

const VARIABLES = [
  { name: "bonus", id: "fz-var-1" },
  { name: "count of things", id: "fz-var-2" },
  { name: "x", id: "fz-var-3" },
];

/** Custom value blocks by output type. */
const CUSTOM_VALUES: Record<Slot, string[]> = { Number: [], Boolean: [], Zone: [] };
for (const def of BLOCK_DEFINITIONS) {
  if (def.output === "Number" || def.output === "Boolean" || def.output === "Zone") CUSTOM_VALUES[def.output].push(def.type);
}
/** Blocks with an untyped output (Blockly lets them into any slot). */
const ANY_OUTPUT = ["logic_ternary", "variables_get"];
const BUILTIN_VALUES: Record<Slot, string[]> = {
  Number: ["math_number", ...ANY_OUTPUT],
  Boolean: ["logic_boolean", "logic_compare", "logic_operation", "logic_negate", ...ANY_OUTPUT],
  // A variable holds a number, which is not a set of squares; only a ternary of zones fits.
  Zone: ["logic_ternary"],
};
const ACTIONS = [
  "cb_add",
  "cb_add_tapered",
  "cb_add_each",
  "cb_add_each_tapered",
  "cb_material",
  "cb_material_tapered",
  "cb_pst",
  "cb_pst_tapered",
  "cb_for_each",
  "controls_if",
  "controls_ifelse",
  "variables_set",
  "math_change",
];

export interface FuzzOptions {
  terms: number;
  /** Maximum nesting depth of value blocks. */
  maxDepth: number;
  /** Probability that a value slot is left empty (the generator then uses a neutral value). */
  emptySlots: number;
  /**
   * Allow "light squares" / "dark squares". They are the real square colours, which a colour flip
   * swaps, so workspaces using them are not mirror-symmetric (by design).
   */
  squareColours: boolean;
}

class Fuzzer {
  private readonly rand: () => number;
  constructor(
    seed: number,
    private readonly opts: FuzzOptions,
  ) {
    this.rand = makeRng(seed);
  }

  private chance(p: number): boolean {
    return this.rand() < p;
  }
  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)]!;
  }

  /** Mostly small numbers, sometimes 0 / ±1 (constant folding) and sometimes the field limits. */
  private numberIn(min: number, max: number): number {
    const r = this.rand();
    if (r < 0.15) return Math.max(min, Math.min(max, this.pick([0, 1, -1])));
    if (r < 0.8) return Math.max(min, Math.min(max, this.int(-30, 30)));
    if (r < 0.95) return Math.max(min, Math.min(max, this.int(-600, 600)));
    return this.pick([min, max]);
  }

  private table(): number[] {
    const r = this.rand();
    if (r < 0.2) return presetValues(this.pick(["CENTER", "ADVANCE", "EDGE", "SHELTER", "ZERO"]));
    if (r < 0.35) return pestoTable(this.pick(["PAWN_MG", "KNIGHT_EG", "KING_MG", "QUEEN_EG"] as const));
    return Array.from({ length: 64 }, () => this.int(-40, 40));
  }

  private fields(type: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, f] of BLOCK_INFO.get(type)?.fields ?? []) {
      if (f.type === "field_dropdown") {
        const colours = new Set(["LIGHT", "DARK"]);
        const options = type === "cb_zone_area" && !this.opts.squareColours ? f.options.filter((o) => !colours.has(o[1])) : f.options;
        out[name] = this.pick(options)[1];
      }
      else if (f.type === "field_number") out[name] = this.numberIn(f.min ?? -1000, f.max ?? 1000);
      else if (f.type === "field_pst") out[name] = this.table();
    }
    return out;
  }

  private slot(slot: Slot, depth: number, inLoop: boolean): ConnectionState | undefined {
    if (this.chance(this.opts.emptySlots)) return undefined;
    const b = this.expr(slot, depth, inLoop);
    // Toolbox defaults are shadow blocks (only simple blocks can be shadows); a block dragged
    // onto a slot covers its shadow. Use all three shapes.
    const isLeaf = !b.inputs || Object.keys(b.inputs).length === 0;
    if (isLeaf && this.chance(0.3)) return { shadow: b };
    if (slot === "Number" && this.chance(0.15)) return { block: b, shadow: block("math_number", { fields: { NUM: 7 } }) };
    return { block: b };
  }

  expr(slot: Slot, depth: number, inLoop: boolean): BlockState {
    const leafOnly = depth >= this.opts.maxDepth;
    let types = [...CUSTOM_VALUES[slot], ...BUILTIN_VALUES[slot]].filter((t) => inLoop || !LOOP_VALUE_TYPES.has(t));
    if (leafOnly) {
      types = types.filter((t) => {
        const info = BLOCK_INFO.get(t);
        return info ? ![...info.inputs.values()].some((i) => i.type === "input_value") : t === "math_number" || t === "logic_boolean" || t === "variables_get";
      });
    }
    const type = this.pick(types);
    const d = depth + 1;
    const inputs: Record<string, ConnectionState> = {};
    const put = (name: string, c: ConnectionState | undefined) => {
      if (c) inputs[name] = c;
    };
    switch (type) {
      case "math_number":
        return block(type, { fields: { NUM: this.numberIn(-1000, 1000) } });
      case "variables_get":
        return block(type, { fields: { VAR: { id: this.pick(VARIABLES).id } } });
      case "logic_boolean":
        return block(type, { fields: { BOOL: this.pick(["TRUE", "FALSE"]) } });
      case "logic_negate":
        put("BOOL", this.slot("Boolean", d, inLoop));
        return block(type, { inputs });
      case "logic_operation":
        put("A", this.slot("Boolean", d, inLoop));
        put("B", this.slot("Boolean", d, inLoop));
        return block(type, { fields: { OP: this.pick(["AND", "OR"]) }, inputs });
      case "logic_compare": {
        // No connection checks on a comparison: mostly numbers, sometimes booleans or squares.
        const kind: Slot = this.chance(0.75) ? "Number" : this.chance(0.5) ? "Boolean" : "Zone";
        put("A", this.slot(kind, d, inLoop));
        put("B", this.slot(this.chance(0.85) ? kind : "Number", d, inLoop));
        return block(type, { fields: { OP: this.pick(["EQ", "NEQ", "LT", "LTE", "GT", "GTE"]) }, inputs });
      }
      case "logic_ternary": {
        put("IF", this.slot("Boolean", d, inLoop));
        // In a number slot the two branches may even be a number and a true/false (it is converted).
        const other: Slot = slot === "Number" && this.chance(0.2) ? "Boolean" : slot;
        put("THEN", this.slot(slot, d, inLoop));
        put("ELSE", this.slot(other, d, inLoop));
        return block(type, { inputs });
      }
    }
    const info = BLOCK_INFO.get(type)!;
    for (const [name, arg] of info.inputs) {
      if (arg.type !== "input_value") continue;
      const check = (Array.isArray(arg.check) ? arg.check[0] : arg.check) as Slot;
      put(name, this.slot(check, d, inLoop));
    }
    return block(type, { fields: this.fields(type), inputs });
  }

  private body(count: number, depth: number, loops: number): BlockState | undefined {
    const items = Array.from({ length: count }, () => {
      const s = this.statement(depth, loops);
      if (this.chance(0.03)) s.disabledReasons = ["MANUALLY_DISABLED"]; // skipped, with its contents
      return s;
    });
    for (let i = 0; i < items.length - 1; i++) items[i]!.next = { block: items[i + 1]! };
    return items[0];
  }

  statement(depth: number, loops: number): BlockState {
    const inLoop = loops > 0;
    // Nested control flow is kept shallow so that terms stay readable when a test fails.
    const allowed = ACTIONS.filter((t) => (t === "cb_for_each" ? loops < 2 && depth < 3 : t.startsWith("controls_") ? depth < 3 : true));
    const type = this.pick(allowed);
    const inputs: Record<string, BlockState | ConnectionState> = {};
    const put = (name: string, c: BlockState | ConnectionState | undefined) => {
      if (c) inputs[name] = c;
    };
    switch (type) {
      case "cb_for_each":
        put("DO", this.body(this.int(1, 3), depth + 1, loops + 1));
        return block(type, { fields: this.fields(type), inputs });
      case "controls_if": {
        const elseIfCount = this.int(0, 2);
        const hasElse = this.chance(0.5);
        for (let i = 0; i <= elseIfCount; i++) {
          put(`IF${i}`, this.slot("Boolean", 1, inLoop));
          put(`DO${i}`, this.body(this.int(1, 2), depth + 1, loops));
        }
        if (hasElse) put("ELSE", this.body(this.int(1, 2), depth + 1, loops));
        return block(type, { extraState: elseIfCount || hasElse ? { elseIfCount, hasElse } : undefined, inputs });
      }
      case "controls_ifelse":
        put("IF0", this.slot("Boolean", 1, inLoop));
        put("DO0", this.body(1, depth + 1, loops));
        put("ELSE", this.body(1, depth + 1, loops));
        return block(type, { inputs });
      case "variables_set":
        put("VALUE", this.slot(this.chance(0.85) ? "Number" : "Boolean", 1, inLoop));
        return block(type, { fields: { VAR: { id: this.pick(VARIABLES).id } }, inputs });
      case "math_change":
        put("DELTA", this.slot("Number", 1, inLoop));
        return block(type, { fields: { VAR: { id: this.pick(VARIABLES).id } }, inputs });
    }
    const info = BLOCK_INFO.get(type)!;
    for (const [name, arg] of info.inputs) {
      if (arg.type === "input_value") put(name, this.slot("Number", 1, inLoop));
    }
    return block(type, { fields: this.fields(type), inputs });
  }

  workspace(): WorkspaceState {
    const terms: BlockState[] = [];
    for (let i = 0; i < this.opts.terms; i++) {
      const body = this.body(this.int(1, 4), 0, 0);
      terms.push(block("cb_term", { fields: { NAME: `Random term ${i + 1}` }, inputs: body ? { DO: body } : undefined }));
    }
    for (let i = 0; i < terms.length - 1; i++) terms[i]!.next = { block: terms[i + 1]! };
    const root = block("cb_evaluation", { x: 0, y: 0, inputs: terms[0] ? { TERMS: terms[0] } : undefined });
    return workspace([root], VARIABLES);
  }
}

/** A random workspace a user could have built in the editor (deterministic for a seed). */
export function randomWorkspace(seed: number, opts: Partial<FuzzOptions> = {}): WorkspaceState {
  return new Fuzzer(seed, { terms: 24, maxDepth: 4, emptySlots: 0.04, squareColours: true, ...opts }).workspace();
}
