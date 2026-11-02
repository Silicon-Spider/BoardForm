// Blocks → AssemblyScript generator. Produces a complete engine/template/eval.ts that satisfies
// "The evaluation contract" in docs/ENGINE_TEMPLATE.md, using only the documented APIs of
// types.ts, bitboard.ts, position.ts, evalkit.ts and trace.ts.
//
// It walks Blockly's JSON serialization directly, so it needs no Blockly instance and runs in
// Node, workers and the main thread alike. It never throws: problems are reported as
// diagnostics (with block ids, so the editor can show them on the blocks).
//
// Semantics: the Evaluation block holds Term blocks. Each term becomes a function
//   term_N(pos, us, phase): i32
// that accumulates a middlegame (mg) and an endgame (eg) score for side `us` and returns
// taper(mg, eg, phase). evaluate() calls every term for White and for Black and sums
// (white − black), so every rule is colour-symmetric by construction.

import {
  AREA_OPTIONS,
  optionLabel,
  PIECE_OPTIONS,
  PIECE_TYPES,
  type PieceType,
} from "./catalog";
import { BLOCK_INFO, BUILTIN_BLOCK_TYPES, LOOP_VALUE_TYPES, blockDisplayName, type FieldArg } from "./definitions";
import { normalizePst, presetValues } from "./pst";
import {
  blockComment,
  inputBlock,
  isBlockState,
  isDisabled,
  isRecord,
  nextBlock,
  topBlocks,
  type BlockState,
} from "./workspace-json";

/**
 * Bumped whenever the generated code changes for the same workspace.
 * 2: "its mobility" uses evalkit's pieceMobility (a pawn counts its moves, not its attacks);
 *    "for each" visits pieces from our own back rank (relativeBB), so it is symmetric;
 *    an empty branch of "choose" takes the other branch's kind.
 */
export const GENERATOR_VERSION = 2;

export interface EvalDiagnostic {
  severity: "error" | "warning";
  /** Message about the block itself (shown on the block). */
  message: string;
  /** Self-contained message, prefixed with the block's name (used in `errors` / `warnings`). */
  text: string;
  blockId: string | null;
  blockType: string | null;
}

export interface EvalGeneration {
  /** A complete eval.ts. Always compilable; when there are errors, broken blocks are replaced by neutral values. */
  code: string;
  errors: string[];
  warnings: string[];
  diagnostics: EvalDiagnostic[];
  /** Labels of the terms that were generated, in order. */
  terms: string[];
}

// ───────────────────────────── expressions ─────────────────────────────

type VType = "number" | "boolean" | "zone";

interface Expr {
  code: string;
  /** Operator precedence of the outermost operator (higher binds tighter). */
  prec: number;
  type: VType;
}

const P_ATOM = 20;
const P_UNARY = 15;
const P_MUL = 13;
const P_ADD = 12;
const P_REL = 10;
const P_EQ = 9;
const P_BAND = 8;
const P_BOR = 6;
const P_LAND = 5;
const P_LOR = 4;
const P_COND = 3;

const atom = (code: string, type: VType): Expr => ({ code, prec: P_ATOM, type });
const NUM_ZERO: Expr = atom("0", "number");
const FALSE: Expr = atom("false", "boolean");
const TRUE: Expr = atom("true", "boolean");
const NO_SQUARES: Expr = atom("<u64>0", "zone");

function fallbackFor(type: VType): Expr {
  return type === "number" ? NUM_ZERO : type === "boolean" ? FALSE : NO_SQUARES;
}

/** How the neutral value of each kind is described in warnings. */
const NEUTRAL_TEXT: Record<VType, string> = { number: "0", boolean: "false", zone: "no squares" };

/** Code of `e`, parenthesised if it binds looser than `prec`. */
function at(e: Expr, prec: number): string {
  return e.prec >= prec ? e.code : `(${e.code})`;
}

function bin(a: Expr, op: string, b: Expr, prec: number, type: VType): Expr {
  return { code: `${at(a, prec)} ${op} ${at(b, prec + 1)}`, prec, type };
}

function call(name: string, args: (string | Expr)[], type: VType): Expr {
  return atom(`${name}(${args.map((a) => (typeof a === "string" ? a : a.code)).join(", ")})`, type);
}

function negate(e: Expr): Expr {
  if (e.code === "0") return e;
  const inner = e.code.startsWith("-") ? `(${e.code})` : at(e, P_UNARY);
  return { code: `-${inner}`, prec: P_UNARY, type: "number" };
}

function isSimple(e: Expr): boolean {
  return /^-?\d+$/.test(e.code) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.code);
}

/** Cheap enough to repeat instead of storing in a temporary: no calls, short. */
function isCheap(e: Expr): boolean {
  return e.code.length <= 40 && !/[A-Za-z_][\w<>]*\s*\(/.test(e.code);
}

const isZero = (e: Expr): boolean => e.code === "0";
const isOne = (e: Expr): boolean => e.code === "1";

/** a × b with the trivial cases (× 0, × 1) folded away. */
function mul(a: Expr, b: Expr): Expr {
  if (isZero(a) || isZero(b)) return NUM_ZERO;
  if (isOne(a)) return b;
  if (isOne(b)) return a;
  return bin(a, "*", b, P_MUL, "number");
}

// ───────────────────────────── template symbols ─────────────────────────────

type Module = "types" | "bitboard" | "evalkit" | "trace";
const MODULE_ORDER: Module[] = ["types", "bitboard", "evalkit", "trace"];

const SYMBOL_MODULE: Record<string, Module> = {};
for (const s of ["WHITE", "BLACK", ...PIECE_TYPES, "CASTLE_WK", "CASTLE_WQ", "CASTLE_BK", "CASTLE_BQ"]) SYMBOL_MODULE[s] = "types";
for (const f of "ABCDEFGH") for (let r = 1; r <= 8; r++) SYMBOL_MODULE[`${f}${r}`] = "types";
for (const s of [
  ..."ABCDEFGH".split("").map((f) => `FILE_${f}`),
  ..."12345678".split("").map((r) => `RANK_${r}`),
  "LIGHT_SQUARES",
  "DARK_SQUARES",
  "CENTER",
  "BIG_CENTER",
  "ALL_SQUARES",
  "sqBB",
  "popcount",
  "lsb",
  "fileOf",
  "relativeRank",
  "relativeSquare",
  "squareDistance",
  "kingAttacks",
  "attacksOf",
  "passedPawnSpan",
])
  SYMBOL_MODULE[s] = "bitboard";
for (const s of [
  "taper",
  "material",
  "countOn",
  "relativeRankMask",
  "relativeBB",
  "passedPawns",
  "isolatedPawns",
  "doubledPawns",
  "connectedPawns",
  "backwardPawns",
  "pawnAttacks",
  "attackedSquares",
  "pieceAttacks",
  "mobility",
  "pieceMobility",
  "openFiles",
  "halfOpenFiles",
  "rooksOnOpenFiles",
  "rooksOnHalfOpenFiles",
  "kingShield",
  "kingZoneAttacks",
  "kingDistance",
  "centerDistance",
  "bishopPair",
  "hanging",
  "pst",
  "pstSum",
])
  SYMBOL_MODULE[s] = "evalkit";
SYMBOL_MODULE.tracing = "trace";
SYMBOL_MODULE.traceTerm = "trace";

// ───────────────────────────── helpers emitted into eval.ts ─────────────────────────────

type HelperName = "cbDiv" | "cbMod" | "cbClamp" | "cbPick8";

const HELPER_SOURCE: Record<HelperName, string> = {
  cbDiv: `/** a ÷ b rounded toward zero. Dividing by zero gives 0 instead of crashing the engine. */
// @ts-ignore: decorator
@inline function cbDiv(a: i32, b: i32): i32 {
  if (b == 0) return 0;
  if (b == -1) return -a; // i32.MIN_VALUE / -1 would trap
  return a / b;
}`,
  cbMod: `/** Remainder of a ÷ b (sign of a). The remainder of a division by zero is 0. */
// @ts-ignore: decorator
@inline function cbMod(a: i32, b: i32): i32 {
  if (b == 0) return 0;
  return a % b;
}`,
  cbClamp: `/** x limited to the range lo … hi. */
// @ts-ignore: decorator
@inline function cbClamp(x: i32, lo: i32, hi: i32): i32 {
  return x < lo ? lo : x > hi ? hi : x;
}`,
  cbPick8: `/** One of eight table entries, chosen by a rank 1 … 8 (out-of-range ranks are clamped). */
// @ts-ignore: decorator
@inline function cbPick8(table: StaticArray<i32>, rank: i32): i32 {
  if (rank < 1) rank = 1;
  if (rank > 8) rank = 8;
  return unchecked(table[rank - 1]);
}`,
};

// ───────────────────────────── misc utilities ─────────────────────────────

/** AssemblyScript string literal (pure ASCII, everything else escaped). */
function asString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else if (c <= 0xffff) out += "\\u" + c.toString(16).padStart(4, "0");
    else {
      const v = c - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16) + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16);
    }
  }
  return out + '"';
}

function slug(s: string, fallback = "term"): string {
  const x = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  return x || fallback;
}

/** Line comment(s) for user text. */
function commentLines(text: string, indent: string): string[] {
  return text
    .split(/\r?\n/)
    // Control characters and U+2028/2029 would end a line comment early.
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ").trimEnd())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && i < arr.length - 1))
    .flatMap((l) => wrapText(l, 96 - indent.length))
    .map((l) => `${indent}// ${l}`.trimEnd());
}

/** Greedy word wrap (long words are kept whole). */
function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let lineText = "";
  for (const word of text.split(/ +/)) {
    if (lineText && lineText.length + 1 + word.length > width) {
      out.push(lineText);
      lineText = word;
    } else {
      lineText = lineText ? `${lineText} ${word}` : word;
    }
  }
  if (lineText) out.push(lineText);
  return out;
}

function u64Hex(v: bigint): string {
  return "0x" + v.toString(16).padStart(16, "0");
}

/** Mask of ranks `from`..`to` (1-based, from White's side). */
function rankRangeMask(from: number, to: number): bigint {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let m = 0n;
  for (let r = lo; r <= hi; r++) m |= 0xffn << BigInt((r - 1) * 8);
  return m;
}

function mirrorMask(m: bigint): bigint {
  let out = 0n;
  for (let r = 0; r < 8; r++) out |= ((m >> BigInt(r * 8)) & 0xffn) << BigInt((7 - r) * 8);
  return out;
}

const PIECE_LABEL: Record<string, string> = Object.fromEntries(PIECE_OPTIONS.map(([label, v]) => [v, label]));

// ───────────────────────────── generator state ─────────────────────────────

interface LoopCtx {
  piece: PieceType;
  sq: string;
}

class FnCtx {
  lines: string[] = [];
  indent = 1;
  temps = 0;
  loops: LoopCtx[] = [];
  loopCount = 0;
  vars = new Set<string>();
  usesThem = false;
}

class Generator {
  readonly diagnostics: EvalDiagnostic[] = [];
  private readonly diagKeys = new Set<string>();
  private readonly imports = new Map<Module, Set<string>>();
  private readonly helpers = new Set<HelperName>();
  private readonly constants: string[] = [];
  private readonly constantByKey = new Map<string, string>();
  private constantCounter = 0;
  private readonly variableNames = new Map<string, string>(); // variable id → name
  private readonly variableIdents = new Map<string, string>(); // variable name → identifier
  /** The function (term) currently being generated. */
  fn = new FnCtx();
  private currentTerm = "";

  constructor(private readonly workspace: Record<string, unknown>) {
    const vars = workspace.variables;
    if (Array.isArray(vars)) {
      for (const v of vars) {
        if (isRecord(v) && typeof v.id === "string" && typeof v.name === "string") this.variableNames.set(v.id, v.name);
      }
    }
  }

  // ── diagnostics ──

  diag(severity: "error" | "warning", block: BlockState | null, message: string): void {
    const id = block && typeof block.id === "string" ? block.id : null;
    const key = `${severity}|${id}|${message}`;
    if (this.diagKeys.has(key)) return;
    this.diagKeys.add(key);
    const type = block ? block.type : null;
    let text = message;
    if (block?.type === "cb_term") {
      const name = this.text(block, "NAME").trim();
      text = `Term “${name || "unnamed"}”: ${message}`;
    } else if (block) {
      const where = this.currentTerm ? `Term “${this.currentTerm}” › ` : "";
      text = `${where}“${blockDisplayName(block.type)}”: ${message}`;
    }
    this.diagnostics.push({ severity, message, text, blockId: id, blockType: type });
  }
  error(block: BlockState | null, message: string): void {
    this.diag("error", block, message);
  }
  warn(block: BlockState | null, message: string): void {
    this.diag("warning", block, message);
  }

  // ── symbols, helpers, constants ──

  sym(name: string): string {
    const mod = SYMBOL_MODULE[name];
    if (!mod) throw new Error(`internal: unknown template symbol ${name}`);
    let set = this.imports.get(mod);
    if (!set) this.imports.set(mod, (set = new Set()));
    set.add(name);
    return name;
  }

  helper(name: HelperName): string {
    this.helpers.add(name);
    return name;
  }

  /** Declares (or reuses) a module-level constant; returns its name. */
  constant(key: string, makeName: (n: number) => string, makeSource: (name: string) => string): string {
    const existing = this.constantByKey.get(key);
    if (existing) return existing;
    const name = makeName(++this.constantCounter);
    this.constantByKey.set(key, name);
    this.constants.push(makeSource(name));
    return name;
  }

  pstConstant(values: number[], description: string): string {
    const rows: string[] = [];
    for (let r = 0; r < 8; r++) {
      const cells = values.slice(r * 8, r * 8 + 8).map((v) => String(v).padStart(5)).join(",");
      rows.push(`  ${cells}, // rank ${r + 1}`);
    }
    return this.constant(
      `pst:${values.join(",")}`,
      (n) => `PST_${n}`,
      (name) =>
        `// ${description}\n// LERF order: first line = rank 1 (a1 … h1), last line = rank 8. Black reads it mirrored.\nconst ${name}: StaticArray<i32> = [\n${rows.join("\n")}\n];`,
    );
  }

  /** A colour-dependent square set: `white` is the mask when White is `us`. */
  zonePair(white: bigint, black: bigint, description: string): Expr {
    const base = this.constant(
      `zone:${white}:${black}`,
      (n) => `ZONE_${n}`,
      (name) =>
        `// ${description}\nconst ${name}_WHITE: u64 = ${u64Hex(white)};\nconst ${name}_BLACK: u64 = ${u64Hex(black)};`,
    );
    return { code: `us == ${this.sym("WHITE")} ? ${base}_WHITE : ${base}_BLACK`, prec: P_COND, type: "zone" };
  }

  // ── function context ──

  line(text: string): void {
    this.fn.lines.push("  ".repeat(this.fn.indent) + text);
  }
  temp(prefix = "t"): string {
    return `${prefix}${++this.fn.temps}`;
  }
  side(value: string): string {
    if (value === "THEM") {
      this.fn.usesThem = true;
      return "them";
    }
    return "us";
  }
  // ── field access (validated, with defaults from the block definition) ──

  private fieldDef(block: BlockState, name: string): FieldArg | undefined {
    return BLOCK_INFO.get(block.type)?.fields.get(name);
  }

  private rawField(block: BlockState, name: string): unknown {
    return isRecord(block.fields) ? block.fields[name] : undefined;
  }

  dropdown(block: BlockState, name: string, allowed?: string[]): string {
    const def = this.fieldDef(block, name);
    const options = allowed ?? (def?.type === "field_dropdown" ? def.options.map((o) => o[1]) : []);
    const fallback = options[0] ?? "";
    const raw = this.rawField(block, name);
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && options.includes(raw)) return raw;
    this.error(block, `has an invalid choice ${JSON.stringify(raw)} in ${name}; using “${fallback}”.`);
    return fallback;
  }

  number(block: BlockState, name: string): number {
    const def = this.fieldDef(block, name);
    const fallback = def?.type === "field_number" ? def.value : 0;
    const min = def?.type === "field_number" && def.min !== undefined ? def.min : -1_000_000;
    const max = def?.type === "field_number" && def.max !== undefined ? def.max : 1_000_000;
    const raw = this.rawField(block, name);
    if (raw === undefined) return fallback;
    let n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
      this.error(block, `has an invalid number ${JSON.stringify(raw)} in ${name}; using ${fallback}.`);
      return fallback;
    }
    if (!Number.isInteger(n)) {
      n = Math.round(n);
      this.warn(block, `uses whole numbers only, so ${raw} was rounded to ${n}.`);
    }
    if (n < min || n > max) {
      const c = Math.max(min, Math.min(max, n));
      this.warn(block, `${n} is outside ${min} … ${max}, so ${c} is used.`);
      n = c;
    }
    return n;
  }

  text(block: BlockState, name: string): string {
    const def = this.fieldDef(block, name);
    const raw = this.rawField(block, name);
    if (typeof raw === "string") return raw;
    return def?.type === "field_input" ? def.text : "";
  }

  table(block: BlockState, name: string): number[] {
    const def = this.fieldDef(block, name);
    const fallback = presetValues(def?.type === "field_pst" ? def.preset : "ZERO");
    const raw = this.rawField(block, name);
    if (raw === undefined) return fallback;
    const t = normalizePst(raw);
    if (t) return t;
    this.error(block, `has a piece-square table that is not a list of 64 numbers; using the default table.`);
    return fallback;
  }

  /** Reports fields / inputs that the block definition does not know (corrupted or hand-edited JSON). */
  checkShape(block: BlockState): void {
    const info = BLOCK_INFO.get(block.type);
    if (!info) return;
    if (isRecord(block.fields)) {
      for (const k of Object.keys(block.fields)) if (!info.fields.has(k)) this.warn(block, `has an unknown field “${k}”, which is ignored.`);
    }
    if (isRecord(block.inputs)) {
      for (const k of Object.keys(block.inputs)) if (!info.inputs.has(k)) this.warn(block, `has an unknown input “${k}”, which is ignored.`);
    }
  }

  // ── values ──

  /** Generates the block plugged into `input`, converted to `type`; empty slots give a neutral value. */
  value(block: BlockState, input: string, type: VType): Expr {
    const child = inputBlock(block, input);
    if (!child || isDisabled(child)) {
      const what = NEUTRAL_TEXT[type];
      this.warn(block, child ? `the block in one of its slots is disabled, so it counts as ${what}.` : `has an empty slot, which counts as ${what}.`);
      return fallbackFor(type);
    }
    return this.coerce(this.expr(child, type), type, child);
  }

  /**
   * The raw expression in `input` (no conversion), or null when the slot is empty. `expected` is
   * the kind of value the surrounding slot finally needs, if known (see logic_ternary).
   */
  rawValue(block: BlockState, input: string, expected?: VType): Expr | null {
    const child = inputBlock(block, input);
    if (!child || isDisabled(child)) return null;
    return this.expr(child, expected);
  }

  coerce(e: Expr, to: VType, source: BlockState): Expr {
    if (e.type === to) return e;
    if (to === "boolean") {
      if (e.type === "number" || e.type === "zone") return { code: `${at(e, P_EQ + 1)} != 0`, prec: P_EQ, type: "boolean" };
    }
    if (to === "number") {
      if (e.type === "boolean") return { code: `<i32>(${e.code})`, prec: P_UNARY, type: "number" };
      if (e.type === "zone") return call(this.sym("popcount"), [e], "number");
    }
    this.error(source, `gives ${e.type === "zone" ? "squares" : `a ${e.type}`} where ${to === "zone" ? "squares are" : `a ${to} is`} needed.`);
    return fallbackFor(to);
  }

  expr(block: BlockState, expected?: VType): Expr {
    this.checkShape(block);
    const gen = VALUE_GENERATORS[block.type];
    if (!gen) {
      if (STATEMENT_GENERATORS[block.type] || block.type === "cb_term" || block.type === "cb_evaluation") {
        this.error(block, "is not a value and cannot be plugged into a slot.");
      } else {
        this.error(block, `is an unknown block type (${block.type}).`);
      }
      return NUM_ZERO;
    }
    if (LOOP_VALUE_TYPES.has(block.type) && this.fn.loops.length === 0) {
      this.error(block, "only works inside a “for each of our …” block. Move it inside one.");
      const out = BLOCK_INFO.get(block.type)?.output;
      return fallbackFor(out === "Boolean" ? "boolean" : out === "Zone" ? "zone" : "number");
    }
    return gen(block, this, expected);
  }

  loop(): LoopCtx {
    return this.fn.loops[this.fn.loops.length - 1]!;
  }

  // ── statements ──

  statements(first: BlockState | null, owner: BlockState): number {
    let count = 0;
    let guard = 0;
    for (let b = first; b; b = nextBlock(b)) {
      if (++guard > 100_000) {
        this.error(owner, "contains too many blocks.");
        break;
      }
      if (isDisabled(b)) continue;
      count++;
      this.statement(b);
    }
    return count;
  }

  private statement(block: BlockState): void {
    this.checkShape(block);
    if (block.type === "cb_term") {
      this.error(block, "can't go inside another block — put Term blocks directly inside the Evaluation block.");
      return;
    }
    if (block.type === "cb_evaluation") {
      this.error(block, "can't be nested.");
      return;
    }
    const gen = STATEMENT_GENERATORS[block.type];
    if (!gen) {
      if (VALUE_GENERATORS[block.type]) this.error(block, "is a value, not an action — plug it into a slot of another block.");
      else this.error(block, `is an unknown block type (${block.type}).`);
      return;
    }
    const comment = blockComment(block);
    if (comment) this.fn.lines.push(...commentLines(comment, "  ".repeat(this.fn.indent)));
    gen(block, this);
  }

  /** Adds `amount` to the middlegame and/or endgame accumulators. */
  addPoints(sub: boolean, mg: Expr | null, eg: Expr | null): void {
    if (mg && isZero(mg)) mg = null;
    if (eg && isZero(eg)) eg = null;
    // "add -5" reads better as "subtract 5".
    const negLiteral = (e: Expr | null): boolean => !!e && /^-\d+$/.test(e.code);
    if ((mg || eg) && (!mg || negLiteral(mg)) && (!eg || negLiteral(eg))) {
      sub = !sub;
      if (mg) mg = atom(mg.code.slice(1), "number");
      if (eg) eg = atom(eg.code.slice(1), "number");
    }
    const op = sub ? "-=" : "+=";
    if (mg && eg && mg.code === eg.code && !isSimple(mg) && !isCheap(mg)) {
      const t = this.temp();
      this.line(`const ${t}: i32 = ${mg.code};`);
      this.line(`mg ${op} ${t};`);
      this.line(`eg ${op} ${t};`);
      return;
    }
    if (mg) this.line(`mg ${op} ${mg.code};`);
    if (eg) this.line(`eg ${op} ${eg.code};`);
  }

  // ── variables ──

  variable(block: BlockState): string {
    const raw = isRecord(block.fields) ? block.fields.VAR : undefined;
    let name: string | null = null;
    if (isRecord(raw)) {
      if (typeof raw.id === "string") name = this.variableNames.get(raw.id) ?? (typeof raw.name === "string" ? raw.name : null);
      else if (typeof raw.name === "string") name = raw.name;
    } else if (typeof raw === "string") {
      name = this.variableNames.get(raw) ?? raw;
    }
    if (!name) {
      this.error(block, "refers to a variable that does not exist.");
      name = "unnamed";
    }
    let ident = this.variableIdents.get(name);
    if (!ident) {
      const base = `v_${slug(name, "var")}`;
      ident = base;
      let i = 2;
      const taken = new Set(this.variableIdents.values());
      while (taken.has(ident)) ident = `${base}_${i++}`;
      this.variableIdents.set(name, ident);
    }
    this.fn.vars.add(ident);
    return ident;
  }

  // ── top level ──

  run(): EvalGeneration {
    const tops = topBlocks(this.workspace);
    const roots = tops.filter((b) => b.type === "cb_evaluation" && !isDisabled(b));
    const root = roots[0] ?? null;
    if (!root) {
      this.warn(
        null,
        tops.some((b) => b.type === "cb_evaluation")
          ? "The Evaluation block is disabled, so every position is scored 0."
          : "There is no Evaluation block, so every position is scored 0. Drag one in from the Structure category and put your terms inside it.",
      );
    }
    for (const extra of roots.slice(1)) {
      this.warn(extra, "Only one Evaluation block is used (the first one). This one is ignored.");
    }
    for (const b of tops) {
      if (b.type === "cb_evaluation") continue;
      if (isDisabled(b)) continue;
      this.warn(
        b,
        b.type === "cb_term"
          ? "This term is not inside the Evaluation block, so it does not count."
          : "This block is not connected to the Evaluation block, so it has no effect.",
      );
    }

    const termSources: string[] = [];
    const evalLines: string[] = [];
    const labels: string[] = [];
    if (root) {
      this.checkShape(root);
      let index = 0;
      let guard = 0;
      for (let t = inputBlock(root, "TERMS"); t; t = nextBlock(t)) {
        if (++guard > 10_000) break;
        if (isDisabled(t)) continue;
        if (t.type !== "cb_term") {
          this.checkShape(t);
          this.error(t, "can't go directly inside the Evaluation block — put it inside a Term block.");
          continue;
        }
        index++;
        const term = this.term(t, index, labels);
        termSources.push(term.source);
        evalLines.push(...term.evalLines);
        labels.push(term.label);
      }
      if (index === 0) this.warn(root, "has no terms yet, so every position is scored 0. Drag Term blocks inside it.");
    }

    return this.finish(termSources, evalLines, labels);
  }

  private term(block: BlockState, index: number, previous: string[]): { source: string; evalLines: string[]; label: string } {
    this.checkShape(block);
    let label = this.text(block, "NAME").replace(/\s+/g, " ").trim();
    if (!label) label = `Term ${index}`;
    // Cut by code points, so an emoji is never split into half a surrogate pair.
    if ([...label].length > 60) label = [...label].slice(0, 60).join("");
    // cb_eval_trace ends with a "total" line (docs/ENGINE_ABI.md); a term may not look like it.
    if (/^total$/i.test(label)) {
      this.warn(block, `“${label}” is the name of the sum in the evaluation breakdown, so this term is shown as “${label} (term)”.`);
      label = `${label} (term)`;
    }
    if (previous.includes(label)) this.warn(block, `Another term is also called “${label}”. Give terms different names so the breakdown is clear.`);
    this.currentTerm = label;
    const ident = `term_${index}_${slug(label)}`;

    this.fn = new FnCtx();
    const count = this.statements(inputBlock(block, "DO"), block);
    if (count === 0) this.warn(block, "This term is empty, so it adds nothing.");
    const fn = this.fn;

    const out: string[] = [];
    out.push(`// ── Term ${index}: ${label.replace(/[\r\n]/g, " ")} ${"─".repeat(Math.max(3, 60 - label.length))}`);
    const comment = blockComment(block);
    if (comment) out.push(...commentLines(comment, ""));
    out.push(`function ${ident}(pos: Position, us: i32, phase: i32): i32 {`);
    if (fn.usesThem) out.push("  const them: i32 = us ^ 1;");
    out.push("  let mg: i32 = 0; // middlegame points for us");
    out.push("  let eg: i32 = 0; // endgame points for us");
    for (const v of [...fn.vars].sort()) out.push(`  let ${v}: i32 = 0;`);
    if (fn.lines.length) out.push("", ...fn.lines);
    out.push(`  return ${this.sym("taper")}(mg, eg, phase);`);
    out.push("}");

    const evalLines = [
      `  // ${label.replace(/[\r\n]/g, " ")}`,
      `  white = ${ident}(pos, ${this.sym("WHITE")}, phase);`,
      `  black = ${ident}(pos, ${this.sym("BLACK")}, phase);`,
      "  score += white - black;",
      `  if (${this.sym("tracing")}) ${this.sym("traceTerm")}(${asString(label)}, white, black);`,
    ];
    this.currentTerm = "";
    return { source: out.join("\n"), evalLines, label };
  }

  private finish(termSources: string[], evalLines: string[], labels: string[]): EvalGeneration {
    const header = [
      "// eval.ts — generated by BoardForm from your blocks. Don't edit this file by hand: it is",
      "// rewritten every time the blocks change. (Duplicate the engine as a code engine to hand-edit it.)",
      "//",
      "// How it works: every term below is worked out twice, once with White as `us` and once with",
      "// Black as `us`. The evaluation is the sum over all terms of (White's points − Black's points),",
      "// in centipawns from White's point of view (100 = one pawn). Each term keeps separate middlegame",
      "// (mg) and endgame (eg) points and blends them by the game phase (24 = opening … 0 = endgame):",
      "//   taper(mg, eg, phase) = (mg × phase + eg × (24 − phase)) / 24",
    ];

    const body: string[] = [];
    if (termSources.length) {
      body.push(
        "/** Scores are kept well inside the mate range used by the search (MATE_BOUND = 31000). */",
        "const EVAL_LIMIT: i32 = 30000;",
        "",
        ...termSources.flatMap((s) => [s, ""]),
        "/** Static evaluation in centipawns from White's point of view (positive = good for White). */",
        "export function evaluate(pos: Position): i32 {",
        "  const phase: i32 = pos.phase();",
        "  let score: i32 = 0;",
        "  let white: i32 = 0;",
        "  let black: i32 = 0;",
        "",
        ...evalLines.flatMap((l, i) => (i > 0 && l.startsWith("  // ") ? ["", l] : [l])),
        "",
        "  if (score > EVAL_LIMIT) score = EVAL_LIMIT;",
        "  if (score < -EVAL_LIMIT) score = -EVAL_LIMIT;",
        "  return score;",
        "}",
      );
    } else {
      body.push(
        "/** Static evaluation in centipawns from White's point of view (positive = good for White). */",
        "export function evaluate(pos: Position): i32 {",
        "  // No terms yet: every position looks equal.",
        "  return 0;",
        "}",
      );
    }

    const importLines = ['import { Position } from "./position";'];
    for (const mod of MODULE_ORDER) {
      const names = this.imports.get(mod);
      if (!names || !names.size) continue;
      const sorted = [...names].sort();
      const oneLine = `import { ${sorted.join(", ")} } from "./${mod}";`;
      if (oneLine.length <= 100) importLines.push(oneLine);
      else importLines.push("import {", ...wrapText(sorted.join(", "), 94).map((l) => `  ${l}`), `} from "./${mod}";`);
    }

    const parts = [header.join("\n"), importLines.join("\n")];
    const helpers = (["cbDiv", "cbMod", "cbClamp", "cbPick8"] as HelperName[]).filter((h) => this.helpers.has(h));
    if (helpers.length) parts.push(helpers.map((h) => HELPER_SOURCE[h]).join("\n\n"));
    if (this.constants.length) parts.push(this.constants.join("\n\n"));
    parts.push(body.join("\n"));
    const code = parts.join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";

    const errors = this.diagnostics.filter((d) => d.severity === "error").map((d) => d.text);
    const warnings = this.diagnostics.filter((d) => d.severity === "warning").map((d) => d.text);
    return { code, errors, warnings, diagnostics: this.diagnostics, terms: labels };
  }

  /** Name of the term currently being generated (for constant comments). */
  termName(): string {
    return this.currentTerm;
  }
}

// ───────────────────────────── block generators ─────────────────────────────

/** `expected` is the kind of value the slot the block sits in needs, when known. */
type ValueGen = (b: BlockState, g: Generator, expected?: VType) => Expr;
type StatementGen = (b: BlockState, g: Generator) => void;

function pieceConst(g: Generator, piece: string): string {
  return g.sym((PIECE_TYPES as readonly string[]).includes(piece) ? piece : "PAWN");
}

/** Bitboard of a side's pieces of one kind (or all of them for "ANY"). */
function piecesBB(g: Generator, sideValue: string, piece: string): Expr {
  const s = g.side(sideValue);
  return piece === "ANY" ? atom(`pos.colorBB(${s})`, "zone") : atom(`pos.pieces(${s}, ${pieceConst(g, piece)})`, "zone");
}

function nonEmpty(e: Expr): Expr {
  return { code: `${at(e, P_EQ + 1)} != 0`, prec: P_EQ, type: "boolean" };
}

function and(a: Expr, b: Expr): Expr {
  return bin(a, "&", b, P_BAND, "zone");
}

function materialCall(g: Generator, b: BlockState, sideCode: string, prefix: string): Expr {
  const v = ["P", "N", "B", "R", "Q"].map((k) => String(g.number(b, prefix + k)));
  return call(g.sym("material"), ["pos", sideCode, ...v], "number");
}

const VALUE_GENERATORS: Record<string, ValueGen> = {
  // ── built-in logic ──
  logic_boolean: (b, g) => (g.dropdown(b, "BOOL", ["TRUE", "FALSE"]) === "TRUE" ? TRUE : FALSE),
  logic_negate: (b, g) => {
    const x = inputBlock(b, "BOOL") ? g.value(b, "BOOL", "boolean") : (g.warn(b, "has an empty slot, which counts as true."), TRUE);
    return { code: `!${at(x, P_UNARY)}`, prec: P_UNARY, type: "boolean" };
  },
  logic_operation: (b, g) => {
    const op = g.dropdown(b, "OP", ["AND", "OR"]);
    const dflt = op === "AND" ? TRUE : FALSE;
    const side = (name: string): Expr => {
      const raw = g.rawValue(b, name);
      if (!raw) {
        g.warn(b, `has an empty slot, which counts as ${dflt.code}.`);
        return dflt;
      }
      return g.coerce(raw, "boolean", b);
    };
    const l = side("A");
    const r = side("B");
    return op === "AND" ? bin(l, "&&", r, P_LAND, "boolean") : bin(l, "||", r, P_LOR, "boolean");
  },
  logic_compare: (b, g) => {
    const OPS: Record<string, [string, number]> = {
      EQ: ["==", P_EQ],
      NEQ: ["!=", P_EQ],
      LT: ["<", P_REL],
      LTE: ["<=", P_REL],
      GT: [">", P_REL],
      GTE: [">=", P_REL],
    };
    const opKey = g.dropdown(b, "OP", Object.keys(OPS));
    const [op, prec] = OPS[opKey]!;
    let l = g.rawValue(b, "A");
    let r = g.rawValue(b, "B");
    if (!l || !r) g.warn(b, "has an empty slot, which counts as 0.");
    l ??= NUM_ZERO;
    r ??= NUM_ZERO;
    const sameKind = l.type === r.type && l.type !== "number";
    if (!(sameKind && prec === P_EQ)) {
      l = g.coerce(l, "number", b);
      r = g.coerce(r, "number", b);
    }
    return bin(l, op, r, prec, "boolean");
  },
  logic_ternary: (b, g, expected) => {
    const cond = g.value(b, "IF", "boolean");
    let t = g.rawValue(b, "THEN", expected);
    let e = g.rawValue(b, "ELSE", expected);
    if (!t || !e) {
      // An empty branch counts as the neutral value of the other branch's kind (or of the slot),
      // so "choose … else (empty)" in a squares slot means "… or no squares", not an error.
      const kind: VType = (t ?? e)?.type ?? expected ?? "number";
      g.warn(b, `has an empty slot, which counts as ${NEUTRAL_TEXT[kind]}.`);
      t ??= fallbackFor(kind);
      e ??= fallbackFor(kind);
    }
    const type: VType = t.type === e.type ? t.type : "number";
    t = g.coerce(t, type, b);
    e = g.coerce(e, type, b);
    return { code: `${at(cond, P_COND + 1)} ? ${at(t, P_COND + 1)} : ${at(e, P_COND)}`, prec: P_COND, type };
  },

  // ── built-in math & variables ──
  math_number: (b, g) => {
    const raw = isRecord(b.fields) ? b.fields.NUM : undefined;
    let n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw === undefined ? 0 : NaN;
    if (!Number.isFinite(n)) {
      g.error(b, `is not a valid number (${JSON.stringify(raw)}); using 0.`);
      n = 0;
    }
    if (!Number.isInteger(n)) {
      const r = Math.trunc(n);
      g.warn(b, `The engine only uses whole numbers, so ${n} is used as ${r}.`);
      n = r;
    }
    if (Math.abs(n) > 1_000_000) {
      const c = Math.sign(n) * 1_000_000;
      g.warn(b, `${n} is too large; ${c} is used instead.`);
      n = c;
    }
    return { code: String(n), prec: n < 0 ? P_UNARY : P_ATOM, type: "number" };
  },
  variables_get: (b, g) => atom(g.variable(b), "number"),

  // ── math ──
  cb_arith: (b, g) => {
    const op = g.dropdown(b, "OP");
    const l = g.value(b, "A", "number");
    const r = g.value(b, "B", "number");
    switch (op) {
      case "ADD":
        return bin(l, "+", r, P_ADD, "number");
      case "SUB":
        return bin(l, "-", r, P_ADD, "number");
      case "MUL":
        return bin(l, "*", r, P_MUL, "number");
      case "DIV":
        return call(g.helper("cbDiv"), [l, r], "number");
      default:
        return call(g.helper("cbMod"), [l, r], "number");
    }
  },
  cb_minmax: (b, g) => {
    const fn = g.dropdown(b, "OP") === "MIN" ? "min<i32>" : "max<i32>";
    return call(fn, [g.value(b, "A", "number"), g.value(b, "B", "number")], "number");
  },
  cb_unary: (b, g) => {
    const x = g.value(b, "A", "number");
    return g.dropdown(b, "OP") === "ABS" ? call("abs<i32>", [x], "number") : negate(x);
  },
  cb_clamp: (b, g) =>
    call(g.helper("cbClamp"), [g.value(b, "X", "number"), g.value(b, "LO", "number"), g.value(b, "HI", "number")], "number"),
  cb_by_rank: (b, g) => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => g.number(b, `R${r}`));
    const name = g.constant(
      `rank:${values.join(",")}`,
      (n) => `BY_RANK_${n}`,
      (nm) => `// Values for ranks 1 … 8 (term “${g.termName()}”)\nconst ${nm}: StaticArray<i32> = [${values.join(", ")}];`,
    );
    return call(g.helper("cbPick8"), [name, g.value(b, "RANK", "number")], "number");
  },

  // ── pieces ──
  cb_any_on: (b, g) => {
    const bb = piecesBB(g, g.dropdown(b, "SIDE"), g.dropdown(b, "PIECE"));
    return nonEmpty(and(bb, g.value(b, "ZONE", "zone")));
  },
  cb_count_on: (b, g) => {
    const side = g.dropdown(b, "SIDE");
    const piece = g.dropdown(b, "PIECE");
    const zone = g.value(b, "ZONE", "zone");
    if (piece === "ANY") return call(g.sym("popcount"), [and(piecesBB(g, side, piece), zone)], "number");
    return call(g.sym("countOn"), ["pos", g.side(side), pieceConst(g, piece), zone], "number");
  },
  cb_count: (b, g) => {
    const side = g.dropdown(b, "SIDE");
    const piece = g.dropdown(b, "PIECE");
    if (piece === "ANY") return call(g.sym("popcount"), [piecesBB(g, side, piece)], "number");
    return atom(`pos.count(${g.side(side)}, ${pieceConst(g, piece)})`, "number");
  },
  cb_material_value: (b, g) => materialCall(g, b, g.side(g.dropdown(b, "SIDE")), ""),
  cb_material_diff: (b, g) => bin(materialCall(g, b, "us", ""), "-", materialCall(g, b, g.side("THEM"), ""), P_ADD, "number"),

  // ── squares ──
  cb_zone_rank: (b, g) => {
    const rank = Number(g.dropdown(b, "RANK"));
    return call(g.sym("relativeRankMask"), [g.side(g.dropdown(b, "WHOSE")), String(rank - 1)], "zone");
  },
  cb_zone_ranks: (b, g) => {
    const whose = g.dropdown(b, "WHOSE");
    const from = Number(g.dropdown(b, "FROM"));
    const to = Number(g.dropdown(b, "TO"));
    const white = rankRangeMask(from, to);
    const forUs = whose === "US" ? white : mirrorMask(white);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return g.zonePair(forUs, mirrorMask(forUs), `${whose === "US" ? "our" : "their"} ranks ${lo} … ${hi}`);
  },
  cb_zone_file: (b, g) => atom(g.sym(`FILE_${g.dropdown(b, "FILE")}`), "zone"),
  cb_zone_square: (b, g) => {
    const sq = `${g.dropdown(b, "FILE")}${g.dropdown(b, "RANK")}`;
    return call(g.sym("sqBB"), [call(g.sym("relativeSquare"), ["us", g.sym(sq)], "number")], "zone");
  },
  cb_zone_area: (b, g) => {
    const area = g.dropdown(b, "AREA");
    const files = (fs: string): Expr => ({ code: fs.split("").map((f) => g.sym(`FILE_${f}`)).join(" | "), prec: P_BOR, type: "zone" });
    switch (area) {
      case "CENTER":
        return atom(g.sym("CENTER"), "zone");
      case "BIG_CENTER":
        return atom(g.sym("BIG_CENTER"), "zone");
      case "OUR_HALF":
      case "THEIR_HALF": {
        const lower = rankRangeMask(1, 4);
        const forWhite = area === "OUR_HALF" ? lower : mirrorMask(lower);
        return g.zonePair(forWhite, mirrorMask(forWhite), optionLabel(AREA_OPTIONS, area));
      }
      case "LIGHT":
        return atom(g.sym("LIGHT_SQUARES"), "zone");
      case "DARK":
        return atom(g.sym("DARK_SQUARES"), "zone");
      case "EDGE":
        return { code: [g.sym("FILE_A"), g.sym("FILE_H"), g.sym("RANK_1"), g.sym("RANK_8")].join(" | "), prec: P_BOR, type: "zone" };
      case "QUEENSIDE":
        return files("ABCD");
      case "KINGSIDE":
        return files("EFGH");
      case "EMPTY":
        return { code: "~pos.occupied()", prec: P_UNARY, type: "zone" };
      default:
        return atom(g.sym("ALL_SQUARES"), "zone");
    }
  },
  cb_zone_attacked: (b, g) => {
    const s = g.side(g.dropdown(b, "WHOSE"));
    const by = g.dropdown(b, "BY");
    if (by === "ANY") return call(g.sym("attackedSquares"), ["pos", s], "zone");
    if (by === "PAWN") return call(g.sym("pawnAttacks"), ["pos", s], "zone");
    return call(g.sym("pieceAttacks"), ["pos", s, pieceConst(g, by)], "zone");
  },
  cb_zone_king: (b, g) => {
    const s = g.side(g.dropdown(b, "WHOSE"));
    const ksq = `pos.kingSquare(${s})`;
    return { code: `${g.sym("kingAttacks")}(${ksq}) | ${g.sym("sqBB")}(${ksq})`, prec: P_BOR, type: "zone" };
  },
  cb_zone_pieces: (b, g) => piecesBB(g, g.dropdown(b, "WHOSE"), g.dropdown(b, "PIECE")),
  cb_zone_files: (b, g) => {
    const kind = g.dropdown(b, "KIND");
    if (kind === "OPEN") return call(g.sym("openFiles"), ["pos"], "zone");
    return call(g.sym("halfOpenFiles"), ["pos", g.side(kind === "HALF_US" ? "US" : "THEM")], "zone");
  },
  cb_zone_combine: (b, g) => {
    const op = g.dropdown(b, "OP");
    const l = g.value(b, "A", "zone");
    const r = g.value(b, "B", "zone");
    if (op === "OR") return bin(l, "|", r, P_BOR, "zone");
    if (op === "AND") return bin(l, "&", r, P_BAND, "zone");
    return bin(l, "&", { code: `~${at(r, P_UNARY)}`, prec: P_UNARY, type: "zone" }, P_BAND, "zone");
  },

  // ── classic evaluation ──
  cb_mobility: (b, g) => {
    const s = g.side(g.dropdown(b, "SIDE"));
    const piece = g.dropdown(b, "PIECE");
    const mob = (p: string): Expr => call(g.sym("mobility"), ["pos", s, g.sym(p)], "number");
    if (piece !== "ALL") return mob(piece);
    const parts = ["KNIGHT", "BISHOP", "ROOK", "QUEEN"].map(mob);
    return parts.slice(1).reduce((acc, p) => bin(acc, "+", p, P_ADD, "number"), parts[0]!);
  },
  cb_pawn_structure: (b, g) => {
    const s = g.side(g.dropdown(b, "SIDE"));
    const fn: Record<string, string> = {
      PASSED: "passedPawns",
      ISOLATED: "isolatedPawns",
      DOUBLED: "doubledPawns",
      CONNECTED: "connectedPawns",
      BACKWARD: "backwardPawns",
    };
    const kind = g.dropdown(b, "KIND");
    return call(g.sym("popcount"), [call(g.sym(fn[kind] ?? "passedPawns"), ["pos", s], "zone")], "number");
  },
  cb_passed_rank: (b, g) => {
    const sideValue = g.dropdown(b, "SIDE");
    const s = g.side(sideValue);
    const rank = Number(g.dropdown(b, "RANK"));
    // Ranks `rank`..8 counted from the pawns' owner's side.
    const fromWhite = rankRangeMask(rank, 8);
    const forUs = sideValue === "US" ? fromWhite : mirrorMask(fromWhite);
    const zone = g.zonePair(forUs, mirrorMask(forUs), `${sideValue === "US" ? "our" : "their"} ranks ${rank} … 8`);
    return call(g.sym("popcount"), [and(call(g.sym("passedPawns"), ["pos", s], "zone"), zone)], "number");
  },
  cb_rooks_files: (b, g) => {
    const s = g.side(g.dropdown(b, "SIDE"));
    return call(g.sym(g.dropdown(b, "KIND") === "OPEN" ? "rooksOnOpenFiles" : "rooksOnHalfOpenFiles"), ["pos", s], "number");
  },
  cb_bishop_pair: (b, g) => call(g.sym("bishopPair"), ["pos", g.side(g.dropdown(b, "SIDE"))], "boolean"),
  cb_king_shield: (b, g) => call(g.sym("kingShield"), ["pos", g.side(g.dropdown(b, "SIDE"))], "number"),
  cb_king_attacks: (b, g) => call(g.sym("kingZoneAttacks"), ["pos", g.side(g.dropdown(b, "SIDE"))], "number"),
  cb_king_distance: (_b, g) => call(g.sym("kingDistance"), ["pos"], "number"),
  cb_king_center: (b, g) =>
    call(g.sym("centerDistance"), [`pos.kingSquare(${g.side(g.dropdown(b, "SIDE"))})`], "number"),
  cb_hanging: (b, g) => call(g.sym("hanging"), ["pos", g.side(g.dropdown(b, "SIDE"))], "number"),

  // ── game state ──
  cb_phase: () => atom("phase", "number"),
  cb_is_endgame: (b, g) => ({ code: `phase <= ${g.number(b, "PHASE")}`, prec: P_REL, type: "boolean" }),
  cb_our_turn: () => ({ code: "pos.side == us", prec: P_EQ, type: "boolean" }),
  cb_in_check: (b, g) => {
    const who = g.dropdown(b, "WHO");
    const s = g.side(who);
    const other = g.side(who === "US" ? "THEM" : "US");
    return atom(`pos.isAttacked(pos.kingSquare(${s}), ${other})`, "boolean");
  },
  cb_can_castle: (b, g) => {
    const s = g.side(g.dropdown(b, "WHO"));
    const way = g.dropdown(b, "WAY");
    const flags = (k: string, q: string): string =>
      way === "KING" ? g.sym(k) : way === "QUEEN" ? g.sym(q) : `(${g.sym(k)} | ${g.sym(q)})`;
    const mask = `${s} == ${g.sym("WHITE")} ? ${flags("CASTLE_WK", "CASTLE_WQ")} : ${flags("CASTLE_BK", "CASTLE_BQ")}`;
    return { code: `(pos.castling & (${mask})) != 0`, prec: P_EQ, type: "boolean" };
  },
  cb_halfmove: () => atom("pos.halfmove", "number"),

  // ── for each: values about the current piece ──
  cb_it_rank: (_b, g) => bin(call(g.sym("relativeRank"), ["us", g.loop().sq], "number"), "+", atom("1", "number"), P_ADD, "number"),
  cb_it_file: (_b, g) => bin(call(g.sym("fileOf"), [g.loop().sq], "number"), "+", atom("1", "number"), P_ADD, "number"),
  cb_it_attacked: (_b, g) => atom(`pos.isAttacked(${g.loop().sq}, ${g.side("THEM")})`, "boolean"),
  cb_it_defended: (_b, g) => atom(`pos.isAttacked(${g.loop().sq}, us)`, "boolean"),
  // Squares the piece can move to (for a pawn: its forward moves and captures, not its attacks).
  cb_it_mobility: (_b, g) => {
    const l = g.loop();
    return call(g.sym("pieceMobility"), ["pos", "us", g.sym(l.piece), l.sq], "number");
  },
  cb_it_passed: (b, g) => {
    const l = g.loop();
    if (l.piece !== "PAWN") {
      g.warn(b, `is always false here: the loop goes over our ${PIECE_LABEL[l.piece] ?? "pieces"}, and only pawns can be passed pawns.`);
      return FALSE;
    }
    const span = call(g.sym("passedPawnSpan"), ["us", l.sq], "zone");
    const enemyPawns = atom(`pos.pieces(${g.side("THEM")}, ${g.sym("PAWN")})`, "zone");
    return { code: `${at(and(span, enemyPawns), P_EQ + 1)} == 0`, prec: P_EQ, type: "boolean" };
  },
  cb_it_king_distance: (b, g) =>
    call(g.sym("squareDistance"), [g.loop().sq, `pos.kingSquare(${g.side(g.dropdown(b, "WHOSE"))})`], "number"),
  cb_it_center_distance: (_b, g) => call(g.sym("centerDistance"), [g.loop().sq], "number"),
  cb_it_open_file: (b, g) => {
    const files =
      g.dropdown(b, "KIND") === "OPEN"
        ? call(g.sym("openFiles"), ["pos"], "zone")
        : call(g.sym("halfOpenFiles"), ["pos", "us"], "zone");
    return nonEmpty(and(files, call(g.sym("sqBB"), [g.loop().sq], "zone")));
  },
  cb_it_on: (b, g) => {
    const sq = g.loop().sq;
    return nonEmpty(and(call(g.sym("sqBB"), [sq], "zone"), g.value(b, "ZONE", "zone")));
  },
  cb_it_attacks_in: (b, g) => {
    const l = g.loop();
    const attacks = call(g.sym("attacksOf"), [g.sym(l.piece), "us", l.sq, "pos.occupied()"], "zone");
    return call(g.sym("popcount"), [and(attacks, g.value(b, "ZONE", "zone"))], "number");
  },
  cb_it_pst: (b, g) => {
    const l = g.loop();
    const table = g.pstConstant(g.table(b, "TABLE"), `Square values for our ${PIECE_LABEL[l.piece]} (term “${g.termName()}”)`);
    return call(g.sym("pst"), [table, "us", l.sq], "number");
  },
};

function opIsSub(g: Generator, b: BlockState): boolean {
  return g.dropdown(b, "OP") === "SUB";
}

const STATEMENT_GENERATORS: Record<string, StatementGen> = {
  cb_add: (b, g) => {
    const v = g.value(b, "VALUE", "number");
    g.addPoints(opIsSub(g, b), v, v);
  },
  cb_add_tapered: (b, g) => {
    const sub = opIsSub(g, b);
    g.addPoints(sub, g.value(b, "MG", "number"), g.value(b, "EG", "number"));
  },
  cb_add_each: (b, g) => {
    const sub = opIsSub(g, b);
    const amount = g.value(b, "VALUE", "number");
    const count = g.value(b, "COUNT", "number");
    const total = mul(amount, count);
    if (isZero(total)) return;
    g.addPoints(sub, total, total);
  },
  cb_add_each_tapered: (b, g) => {
    const sub = opIsSub(g, b);
    const mg = g.value(b, "MG", "number");
    const eg = g.value(b, "EG", "number");
    const count = g.value(b, "COUNT", "number");
    if (isZero(count) || (isZero(mg) && isZero(eg))) return;
    let n = count;
    if (!isSimple(count) && !(isZero(mg) || isZero(eg))) {
      const t = g.temp("n");
      g.line(`const ${t}: i32 = ${count.code};`);
      n = atom(t, "number");
    }
    g.addPoints(sub, mul(mg, n), mul(eg, n));
  },
  cb_material: (b, g) => {
    const m = materialCall(g, b, "us", "");
    const t = g.temp("mat");
    g.line(`const ${t}: i32 = ${m.code}; // material: pawn, knight, bishop, rook, queen`);
    g.addPoints(false, atom(t, "number"), atom(t, "number"));
  },
  cb_material_tapered: (b, g) => {
    g.line("// material, middlegame and endgame values: pawn, knight, bishop, rook, queen");
    g.addPoints(false, materialCall(g, b, "us", "MG_"), materialCall(g, b, "us", "EG_"));
  },
  cb_pst: (b, g) => {
    const piece = g.dropdown(b, "PIECE");
    const table = g.pstConstant(g.table(b, "TABLE"), `Piece-square table for our ${PIECE_LABEL[piece]} (term “${g.termName()}”)`);
    const t = g.temp("pst");
    g.line(`const ${t}: i32 = ${g.sym("pstSum")}(pos, us, ${pieceConst(g, piece)}, ${table}); // our ${PIECE_LABEL[piece]}`);
    g.addPoints(false, atom(t, "number"), atom(t, "number"));
  },
  cb_pst_tapered: (b, g) => {
    const piece = g.dropdown(b, "PIECE");
    const label = PIECE_LABEL[piece];
    const mgTable = g.pstConstant(g.table(b, "MG"), `Piece-square table for our ${label}, middlegame (term “${g.termName()}”)`);
    const egTable = g.pstConstant(g.table(b, "EG"), `Piece-square table for our ${label}, endgame (term “${g.termName()}”)`);
    const p = pieceConst(g, piece);
    g.line(`// piece-square tables for our ${label}`);
    g.addPoints(
      false,
      call(g.sym("pstSum"), ["pos", "us", p, mgTable], "number"),
      call(g.sym("pstSum"), ["pos", "us", p, egTable], "number"),
    );
  },
  cb_for_each: (b, g) => {
    const piece = g.dropdown(b, "PIECE") as PieceType;
    const ctx = g.fn;
    const k = ++ctx.loopCount;
    const bb = `bb${k}`;
    const sq = `sq${k}`;
    // The pieces are visited from our own back rank forward, so White and Black see theirs in the
    // same (mirrored) order and blocks that depend on the order, like "set variable", stay symmetric.
    g.line(`// for each of our ${PIECE_LABEL[piece]}, starting from our own back rank`);
    g.line(`let ${bb}: u64 = ${g.sym("relativeBB")}(us, pos.pieces(us, ${pieceConst(g, piece)})); // seen from our side`);
    g.line(`while (${bb} != 0) {`);
    ctx.indent++;
    g.line(`const ${sq}: i32 = ${g.sym("relativeSquare")}(us, ${g.sym("lsb")}(${bb})); // the square of this piece`);
    g.line(`${bb} &= ${bb} - 1; // remove it from the set`);
    ctx.loops.push({ piece, sq });
    const n = g.statements(inputBlock(b, "DO"), b);
    ctx.loops.pop();
    ctx.indent--;
    g.line("}");
    if (n === 0) g.warn(b, "has nothing inside, so it does nothing.");
  },
  controls_if: (b, g) => {
    let elseIfs = 0;
    let hasElse = false;
    const es = b.extraState;
    if (isRecord(es)) {
      elseIfs = typeof es.elseIfCount === "number" ? Math.max(0, Math.floor(es.elseIfCount)) : 0;
      hasElse = es.hasElse === true;
    } else if (typeof es === "string") {
      elseIfs = Number(/elseif="(\d+)"/.exec(es)?.[1] ?? 0);
      hasElse = /else="1"/.test(es);
    }
    // Inputs that exist win over a missing/odd extraState.
    if (isRecord(b.inputs)) {
      for (const k of Object.keys(b.inputs)) {
        const m = /^(?:IF|DO)(\d+)$/.exec(k);
        if (m) elseIfs = Math.max(elseIfs, Number(m[1]));
        if (k === "ELSE") hasElse = true;
      }
    }
    emitIf(b, g, elseIfs, hasElse);
  },
  controls_ifelse: (b, g) => emitIf(b, g, 0, true),
  variables_set: (b, g) => {
    const v = g.variable(b);
    g.line(`${v} = ${g.value(b, "VALUE", "number").code};`);
  },
  math_change: (b, g) => {
    const v = g.variable(b);
    g.line(`${v} += ${g.value(b, "DELTA", "number").code};`);
  },
};

function emitIf(b: BlockState, g: Generator, elseIfs: number, hasElse: boolean): void {
  const ctx = g.fn;
  let anyBody = false;
  for (let i = 0; i <= elseIfs; i++) {
    const cond = g.value(b, `IF${i}`, "boolean");
    g.line(`${i === 0 ? "if" : "} else if"} (${cond.code}) {`);
    ctx.indent++;
    if (g.statements(inputBlock(b, `DO${i}`), b) > 0) anyBody = true;
    ctx.indent--;
  }
  if (hasElse) {
    g.line("} else {");
    ctx.indent++;
    if (g.statements(inputBlock(b, "ELSE"), b) > 0) anyBody = true;
    ctx.indent--;
  }
  g.line("}");
  if (!anyBody) g.warn(b, "has nothing inside, so it does nothing.");
}

// Every built-in type the toolbox offers must have a generator.
for (const t of BUILTIN_BLOCK_TYPES) {
  if (!VALUE_GENERATORS[t] && !STATEMENT_GENERATORS[t]) throw new Error(`internal: no generator for ${t}`);
}

/** The list of block types the generator understands (custom + built-in). */
export const SUPPORTED_BLOCK_TYPES: readonly string[] = [...Object.keys(VALUE_GENERATORS), ...Object.keys(STATEMENT_GENERATORS)];

const EMPTY_EVAL = `// eval.ts — generated by BoardForm from your blocks.
import { Position } from "./position";

/** Static evaluation in centipawns from White's point of view (positive = good for White). */
export function evaluate(pos: Position): i32 {
  // The blocks could not be read, so every position looks equal.
  return 0;
}
`;

/** Full result including per-block diagnostics (used by the editor). Never throws. */
export function generateEval(workspace: unknown): EvalGeneration {
  const fail = (message: string): EvalGeneration => {
    const d: EvalDiagnostic = { severity: "error", message, text: message, blockId: null, blockType: null };
    return { code: EMPTY_EVAL, errors: [message], warnings: [], diagnostics: [d], terms: [] };
  };
  if (!isRecord(workspace)) return fail("The blocks workspace is missing or is not an object.");
  if (workspace.blocks !== undefined) {
    if (!isRecord(workspace.blocks) || (workspace.blocks.blocks !== undefined && !Array.isArray(workspace.blocks.blocks))) {
      return fail("The blocks workspace data is damaged (its “blocks” list is not valid).");
    }
    if (Array.isArray(workspace.blocks.blocks) && workspace.blocks.blocks.some((b) => !isBlockState(b))) {
      return fail("The blocks workspace data is damaged (a top-level block has no type).");
    }
  }
  try {
    return new Generator(workspace).run();
  } catch (e) {
    const msg = e instanceof RangeError ? "The blocks are nested too deeply to read." : `Internal generator error: ${e instanceof Error ? e.message : String(e)}`;
    return fail(msg);
  }
}

/**
 * Generates engine/template/eval.ts (AssemblyScript) from a Blockly workspace serialization.
 * Headless: needs no rendered workspace and no Blockly. Never throws.
 */
export function generateEvalSource(workspace: object): { code: string; errors: string[]; warnings: string[] } {
  const r = generateEval(workspace);
  return { code: r.code, errors: r.errors, warnings: r.warnings };
}
