// Independent JavaScript reference for the blocks, used by compile.test.ts:
//
//   * RefPosition — a tiny chess board (parsed from a FEN) with the evaluation features the blocks
//     describe (attacks, mobility, pawn structure, king safety …), written from the block tooltips
//     and docs/ENGINE_TEMPLATE.md, not from evalkit.ts.
//   * interpretWorkspace — evaluates a blocks workspace directly on such a board: no generator,
//     no AssemblyScript. The compiled engine's per-term trace must match it exactly, which also
//     catches generator bugs that are colour-symmetric but wrong (e.g. using their 7th rank where
//     ours is meant), something a mirror test cannot see.
//
// Arithmetic follows the engine exactly: every number is an i32 that wraps on overflow, division
// rounds toward zero, and the block-specific rules (÷0 = 0, clamped field values …) are applied.

import { BLOCK_INFO } from "../definitions";
import { normalizePst, presetValues } from "../pst";
import { inputBlock, isDisabled, isRecord, nextBlock, topBlocks, type BlockState } from "../workspace-json";

export const WHITE = 0;
export const BLACK = 1;
export type Color = 0 | 1;
export const PAWN = 0;
export const KNIGHT = 1;
export const BISHOP = 2;
export const ROOK = 3;
export const QUEEN = 4;
export const KING = 5;
const TYPE_BY_NAME: Record<string, number> = { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING };

// ───────────────────────────── i32 arithmetic ─────────────────────────────

const add = (a: number, b: number): number => (a + b) | 0;
const sub = (a: number, b: number): number => (a - b) | 0;
const mul = (a: number, b: number): number => Math.imul(a, b);
const neg = (a: number): number => -a | 0;
/** The generated cbDiv: ÷0 = 0 and MIN ÷ −1 wraps instead of trapping. */
const div = (a: number, b: number): number => (b === 0 ? 0 : b === -1 ? neg(a) : (a / b) | 0);
const mod = (a: number, b: number): number => (b === 0 ? 0 : a % b | 0);
const abs = (a: number): number => (a < 0 ? neg(a) : a);
export const taper = (mg: number, eg: number, phase: number): number => (add(mul(mg, phase), mul(eg, 24 - phase)) / 24) | 0;

// ───────────────────────────── board ─────────────────────────────

const FULL = (1n << 64n) - 1n;
const bit = (sq: number): bigint => 1n << BigInt(sq);
const fileOf = (sq: number): number => sq & 7;
const rankOf = (sq: number): number => sq >> 3;
const onBoard = (f: number, r: number): boolean => f >= 0 && f < 8 && r >= 0 && r < 8;
/** Rank counted from `color`'s own side, 0 … 7. */
const relRank = (color: number, sq: number): number => (color === WHITE ? rankOf(sq) : 7 - rankOf(sq));
const isLight = (sq: number): boolean => (fileOf(sq) + rankOf(sq)) % 2 === 1; // a1 is dark

export function popcount(x: bigint): number {
  let n = 0;
  for (let v = x & FULL; v; v &= v - 1n) n++;
  return n;
}

function squaresOf(x: bigint): number[] {
  const out: number[] = [];
  for (let sq = 0; sq < 64; sq++) if ((x >> BigInt(sq)) & 1n) out.push(sq);
  return out;
}

function maskWhere(pred: (sq: number) => boolean): bigint {
  let m = 0n;
  for (let sq = 0; sq < 64; sq++) if (pred(sq)) m |= bit(sq);
  return m;
}

const FILE_MASK = Array.from({ length: 8 }, (_, f) => maskWhere((sq) => fileOf(sq) === f));

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const;
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** A position with memoised evaluation features. Squares are LERF (a1 = 0, h8 = 63). */
export class RefPosition {
  /** Piece code (color × 6 + type) per square, −1 when empty. */
  readonly board: number[] = new Array<number>(64).fill(-1);
  readonly side: Color;
  /** CASTLE bits WK 1, WQ 2, BK 4, BQ 8 — only rights that match the pieces (like the engine). */
  readonly castling: number;
  readonly halfmove: number;
  private readonly cache = new Map<string, bigint | number>();

  constructor(fen: string) {
    const [placement = "", side = "w", rights = "-", , half = "0"] = fen.trim().split(/\s+/);
    let rank = 7;
    let file = 0;
    for (const ch of placement) {
      if (ch === "/") {
        rank--;
        file = 0;
      } else if (ch >= "1" && ch <= "8") {
        file += Number(ch);
      } else {
        const type = "pnbrqk".indexOf(ch.toLowerCase());
        if (type < 0) throw new Error(`bad FEN ${fen}`);
        this.board[rank * 8 + file] = (ch === ch.toUpperCase() ? WHITE : BLACK) * 6 + type;
        file++;
      }
    }
    this.side = side === "b" ? BLACK : WHITE;
    let c = 0;
    const at = (sq: number, color: number, type: number) => this.board[sq] === color * 6 + type;
    if (rights.includes("K") && at(4, WHITE, KING) && at(7, WHITE, ROOK)) c |= 1;
    if (rights.includes("Q") && at(4, WHITE, KING) && at(0, WHITE, ROOK)) c |= 2;
    if (rights.includes("k") && at(60, BLACK, KING) && at(63, BLACK, ROOK)) c |= 4;
    if (rights.includes("q") && at(60, BLACK, KING) && at(56, BLACK, ROOK)) c |= 8;
    this.castling = c;
    this.halfmove = Number(half) || 0;
  }

  private memo<T extends bigint | number>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  pieces(color: number, type: number): bigint {
    return this.memo(`p${color}${type}`, () => maskWhere((sq) => this.board[sq] === color * 6 + type));
  }
  colorBB(color: number): bigint {
    return this.memo(`c${color}`, () => maskWhere((sq) => this.board[sq]! >= 0 && Math.floor(this.board[sq]! / 6) === color));
  }
  occupied(): bigint {
    return this.colorBB(WHITE) | this.colorBB(BLACK);
  }
  count(color: number, type: number): number {
    return popcount(this.pieces(color, type));
  }
  kingSquare(color: number): number {
    return squaresOf(this.pieces(color, KING))[0] ?? 64;
  }
  /** N, B = 1, R = 2, Q = 4 for both colours, at most 24. */
  phase(): number {
    let p = 0;
    for (const c of [WHITE, BLACK]) p += this.count(c, KNIGHT) + this.count(c, BISHOP) + 2 * this.count(c, ROOK) + 4 * this.count(c, QUEEN);
    return Math.min(24, p);
  }

  /** Squares a `color` piece of `type` on `sq` attacks (sliders stop at the first piece). */
  attacksFrom(type: number, color: number, sq: number): bigint {
    const f = fileOf(sq);
    const r = rankOf(sq);
    let m = 0n;
    const step = (df: number, dr: number) => {
      if (onBoard(f + df, r + dr)) m |= bit((r + dr) * 8 + f + df);
    };
    const ray = (df: number, dr: number) => {
      for (let x = f + df, y = r + dr; onBoard(x, y); x += df, y += dr) {
        m |= bit(y * 8 + x);
        if (this.board[y * 8 + x] !== -1) break;
      }
    };
    if (type === PAWN) {
      const dr = color === WHITE ? 1 : -1;
      step(-1, dr);
      step(1, dr);
    } else if (type === KNIGHT) for (const [df, dr] of KNIGHT_STEPS) step(df, dr);
    else if (type === KING) for (const [df, dr] of KING_STEPS) step(df, dr);
    else {
      if (type === BISHOP || type === QUEEN) for (const [df, dr] of BISHOP_DIRS) ray(df, dr);
      if (type === ROOK || type === QUEEN) for (const [df, dr] of ROOK_DIRS) ray(df, dr);
    }
    return m;
  }

  /** Union of the attacks of all `color` pieces of one type. */
  pieceAttacks(color: number, type: number): bigint {
    return this.memo(`a${color}${type}`, () => {
      let m = 0n;
      for (const sq of squaresOf(this.pieces(color, type))) m |= this.attacksFrom(type, color, sq);
      return m;
    });
  }
  attackedSquares(color: number): bigint {
    let m = 0n;
    for (let t = PAWN; t <= KING; t++) m |= this.pieceAttacks(color, t);
    return m;
  }
  isAttacked(sq: number, by: number): boolean {
    return ((this.attackedSquares(by) >> BigInt(sq)) & 1n) === 1n;
  }

  /** Σ over the pieces of the squares they attack that hold no own piece and no enemy pawn attack. */
  mobility(color: number, type: number): number {
    const safe = ~this.colorBB(color) & ~this.pieceAttacks(color ^ 1, PAWN) & FULL;
    let n = 0;
    for (const sq of squaresOf(this.pieces(color, type))) n += popcount(this.attacksFrom(type, color, sq) & safe);
    return n;
  }

  /** Enemy pawns on the squares in front of `sq` (own and adjacent files). */
  private frontSpanHasEnemyPawn(color: number, sq: number): boolean {
    return squaresOf(this.pieces(color ^ 1, PAWN)).some(
      (e) => Math.abs(fileOf(e) - fileOf(sq)) <= 1 && relRank(color, e) > relRank(color, sq),
    );
  }

  passedPawns(color: number): bigint {
    return this.memo(`passed${color}`, () => {
      let m = 0n;
      for (const sq of squaresOf(this.pieces(color, PAWN))) if (!this.frontSpanHasEnemyPawn(color, sq)) m |= bit(sq);
      return m;
    });
  }
  isolatedPawns(color: number): bigint {
    const own = squaresOf(this.pieces(color, PAWN));
    let m = 0n;
    for (const sq of own) if (!own.some((o) => Math.abs(fileOf(o) - fileOf(sq)) === 1)) m |= bit(sq);
    return m;
  }
  doubledPawns(color: number): bigint {
    const own = squaresOf(this.pieces(color, PAWN));
    let m = 0n;
    for (const sq of own) if (own.some((o) => fileOf(o) === fileOf(sq) && relRank(color, o) > relRank(color, sq))) m |= bit(sq);
    return m;
  }
  connectedPawns(color: number): bigint {
    const own = this.pieces(color, PAWN);
    let m = 0n;
    for (const sq of squaresOf(own)) {
      const defended = (this.pieceAttacks(color, PAWN) >> BigInt(sq)) & 1n;
      const beside = squaresOf(own).some((o) => rankOf(o) === rankOf(sq) && Math.abs(fileOf(o) - fileOf(sq)) === 1);
      if (defended || beside) m |= bit(sq);
    }
    return m;
  }
  /** Not isolated, no own pawn on an adjacent file level with or behind it, and its push square is hit by an enemy pawn. */
  backwardPawns(color: number): bigint {
    const own = squaresOf(this.pieces(color, PAWN));
    let m = 0n;
    for (const sq of own) {
      const neighbours = own.filter((o) => Math.abs(fileOf(o) - fileOf(sq)) === 1);
      if (neighbours.length === 0) continue;
      if (neighbours.some((o) => relRank(color, o) <= relRank(color, sq))) continue;
      const push = sq + (color === WHITE ? 8 : -8);
      if (push >= 0 && push < 64 && (this.pieceAttacks(color ^ 1, PAWN) >> BigInt(push)) & 1n) m |= bit(sq);
    }
    return m;
  }

  /** Union of the files without any pawn. */
  openFiles(): bigint {
    const pawns = this.pieces(WHITE, PAWN) | this.pieces(BLACK, PAWN);
    return FILE_MASK.filter((f) => (f & pawns) === 0n).reduce((a, f) => a | f, 0n);
  }
  /** Union of the files with no `color` pawn but at least one enemy pawn. */
  halfOpenFiles(color: number): bigint {
    const own = this.pieces(color, PAWN);
    const enemy = this.pieces(color ^ 1, PAWN);
    return FILE_MASK.filter((f) => (f & own) === 0n && (f & enemy) !== 0n).reduce((a, f) => a | f, 0n);
  }

  /** Own pawns on the king's file and the files next to it, one or two ranks in front of the king. */
  kingShield(color: number): number {
    const k = this.kingSquare(color);
    return squaresOf(this.pieces(color, PAWN)).filter((p) => {
      const ahead = relRank(color, p) - relRank(color, k);
      return Math.abs(fileOf(p) - fileOf(k)) <= 1 && (ahead === 1 || ahead === 2);
    }).length;
  }
  /** Σ over enemy pawns (each capture direction), knights, bishops, rooks, queens of their attacks on the king and its neighbours. */
  kingZoneAttacks(color: number): number {
    const zone = this.kingZone(color);
    const enemy = color ^ 1;
    let n = 0;
    for (const sq of squaresOf(this.pieces(enemy, PAWN))) n += popcount(this.attacksFrom(PAWN, enemy, sq) & zone);
    for (const t of [KNIGHT, BISHOP, ROOK, QUEEN]) {
      for (const sq of squaresOf(this.pieces(enemy, t))) n += popcount(this.attacksFrom(t, enemy, sq) & zone);
    }
    return n;
  }
  kingZone(color: number): bigint {
    const k = this.kingSquare(color);
    return this.attacksFrom(KING, color, k) | bit(k);
  }
  bishopPair(color: number): boolean {
    const b = squaresOf(this.pieces(color, BISHOP));
    return b.some(isLight) && b.some((sq) => !isLight(sq));
  }
  /** Own knights, bishops, rooks and queens attacked by the enemy and not defended. */
  hanging(color: number): number {
    const attacked = this.attackedSquares(color ^ 1);
    const defended = this.attackedSquares(color);
    let n = 0;
    for (const t of [KNIGHT, BISHOP, ROOK, QUEEN]) n += popcount(this.pieces(color, t) & attacked & ~defended);
    return n;
  }
}

export const squareDistance = (a: number, b: number): number =>
  Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
/** 0 on d4 e4 d5 e5 … 3 on the edge. */
export const centerDistance = (sq: number): number => {
  const f = fileOf(sq);
  const r = rankOf(sq);
  return Math.max(f < 4 ? 3 - f : f - 4, r < 4 ? 3 - r : r - 4);
};

// ───────────────────────────── interpreter ─────────────────────────────

type Value = { t: "number"; v: number } | { t: "boolean"; v: boolean } | { t: "zone"; v: bigint };
type VType = Value["t"];
const NUM = (v: number): Value => ({ t: "number", v: v | 0 });
const BOOL = (v: boolean): Value => ({ t: "boolean", v });
const ZONE = (v: bigint): Value => ({ t: "zone", v: v & FULL });

export interface TermValue {
  /** The term's name as the generator labels it (before the trace's ASCII-only output). */
  label: string;
  white: number;
  black: number;
}

interface Side {
  us: number;
  them: number;
  mg: number;
  eg: number;
  vars: Map<string, number>;
  loops: { type: number; sq: number }[];
}

class Interpreter {
  private readonly varNames = new Map<string, string>();
  private s: Side = { us: WHITE, them: BLACK, mg: 0, eg: 0, vars: new Map(), loops: [] };
  private readonly phase: number;

  constructor(
    private readonly ws: Record<string, unknown>,
    private readonly p: RefPosition,
  ) {
    if (Array.isArray(ws.variables)) {
      for (const v of ws.variables) if (isRecord(v) && typeof v.id === "string" && typeof v.name === "string") this.varNames.set(v.id, v.name);
    }
    this.phase = p.phase();
  }

  run(): TermValue[] {
    const root = topBlocks(this.ws).find((b) => b.type === "cb_evaluation" && !isDisabled(b));
    const out: TermValue[] = [];
    let index = 0;
    for (let t = root ? inputBlock(root, "TERMS") : null; t; t = nextBlock(t)) {
      if (isDisabled(t) || t.type !== "cb_term") continue;
      index++;
      let label = this.text(t, "NAME").replace(/\s+/g, " ").trim() || `Term ${index}`;
      if ([...label].length > 60) label = [...label].slice(0, 60).join("");
      if (/^total$/i.test(label)) label += " (term)"; // the trace's own last line is "total"
      const [white, black] = [WHITE, BLACK].map((us) => {
        this.s = { us, them: us ^ 1, mg: 0, eg: 0, vars: new Map(), loops: [] };
        this.chain(inputBlock(t, "DO"));
        return taper(this.s.mg, this.s.eg, this.phase);
      }) as [number, number];
      out.push({ label, white, black });
    }
    return out;
  }

  // ── fields (defaults and validation as documented by the block definitions) ──

  private raw(b: BlockState, name: string): unknown {
    return isRecord(b.fields) ? b.fields[name] : undefined;
  }
  private dropdown(b: BlockState, name: string, allowed?: string[]): string {
    const def = BLOCK_INFO.get(b.type)?.fields.get(name);
    const options = allowed ?? (def?.type === "field_dropdown" ? def.options.map((o) => o[1]) : []);
    const raw = this.raw(b, name);
    return typeof raw === "string" && options.includes(raw) ? raw : options[0]!;
  }
  private number(b: BlockState, name: string): number {
    const def = BLOCK_INFO.get(b.type)?.fields.get(name);
    const dflt = def?.type === "field_number" ? def.value : 0;
    const min = def?.type === "field_number" && def.min !== undefined ? def.min : -1_000_000;
    const max = def?.type === "field_number" && def.max !== undefined ? def.max : 1_000_000;
    const raw = this.raw(b, name);
    if (raw === undefined) return dflt;
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
  }
  private text(b: BlockState, name: string): string {
    const raw = this.raw(b, name);
    if (typeof raw === "string") return raw;
    const def = BLOCK_INFO.get(b.type)?.fields.get(name);
    return def?.type === "field_input" ? def.text : "";
  }
  private table(b: BlockState, name: string): number[] {
    const def = BLOCK_INFO.get(b.type)?.fields.get(name);
    return normalizePst(this.raw(b, name)) ?? presetValues(def?.type === "field_pst" ? def.preset : "ZERO");
  }
  private side(b: BlockState, name = "SIDE"): number {
    return this.dropdown(b, name) === "THEM" ? this.s.them : this.s.us;
  }
  private piece(b: BlockState, name = "PIECE"): string {
    return this.dropdown(b, name);
  }
  private variable(b: BlockState): string {
    const raw = this.raw(b, "VAR");
    if (isRecord(raw)) {
      if (typeof raw.id === "string") return this.varNames.get(raw.id) ?? (typeof raw.name === "string" ? raw.name : "unnamed");
      if (typeof raw.name === "string") return raw.name;
    }
    if (typeof raw === "string") return this.varNames.get(raw) ?? raw;
    return "unnamed";
  }

  // ── values ──

  private coerce(x: Value, to: VType): Value {
    if (x.t === to) return x;
    if (to === "boolean") return BOOL(x.t === "number" ? x.v !== 0 : (x.v as bigint) !== 0n);
    if (to === "number") return NUM(x.t === "boolean" ? (x.v ? 1 : 0) : popcount(x.v as bigint));
    return ZONE(0n); // the generator reports this as an error and uses "no squares"
  }
  private fallback(t: VType): Value {
    return t === "number" ? NUM(0) : t === "boolean" ? BOOL(false) : ZONE(0n);
  }
  private value(b: BlockState, input: string, t: VType): Value {
    const child = inputBlock(b, input);
    if (!child || isDisabled(child)) return this.fallback(t);
    return this.coerce(this.expr(child, t), t);
  }
  /** `expected`: the kind the surrounding slot finally needs, if known. */
  private rawValue(b: BlockState, input: string, expected?: VType): Value | null {
    const child = inputBlock(b, input);
    return !child || isDisabled(child) ? null : this.expr(child, expected);
  }
  private num(b: BlockState, input: string): number {
    return this.value(b, input, "number").v as number;
  }
  private bool(b: BlockState, input: string): boolean {
    return this.value(b, input, "boolean").v as boolean;
  }
  private zone(b: BlockState, input: string): bigint {
    return this.value(b, input, "zone").v as bigint;
  }

  private piecesOf(color: number, piece: string): bigint {
    return piece === "ANY" ? this.p.colorBB(color) : this.p.pieces(color, TYPE_BY_NAME[piece] ?? PAWN);
  }
  private material(color: number, b: BlockState, prefix: string): number {
    const values = ["P", "N", "B", "R", "Q"].map((k) => this.number(b, prefix + k));
    let m = 0;
    for (let t = PAWN; t <= QUEEN; t++) m = add(m, mul(this.p.count(color, t), values[t]!));
    return m;
  }
  private loop(): { type: number; sq: number } {
    return this.s.loops[this.s.loops.length - 1]!;
  }
  /** Mask of the (1-based) ranks lo … hi as seen from `color`'s side. */
  private relRanks(color: number, lo: number, hi: number): bigint {
    return maskWhere((sq) => relRank(color, sq) >= lo - 1 && relRank(color, sq) <= hi - 1);
  }

  private expr(b: BlockState, expected?: VType): Value {
    const { p, s } = this;
    switch (b.type) {
      // built-in logic & math
      case "logic_boolean":
        return BOOL(this.dropdown(b, "BOOL", ["TRUE", "FALSE"]) === "TRUE");
      case "logic_negate":
        return BOOL(!(inputBlock(b, "BOOL") ? this.bool(b, "BOOL") : true));
      case "logic_operation": {
        const and = this.dropdown(b, "OP", ["AND", "OR"]) === "AND";
        const part = (n: string): boolean => {
          const x = this.rawValue(b, n);
          return x ? (this.coerce(x, "boolean").v as boolean) : and;
        };
        const l = part("A");
        const r = part("B");
        return BOOL(and ? l && r : l || r);
      }
      case "logic_compare": {
        const op = this.dropdown(b, "OP", ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"]);
        let l = this.rawValue(b, "A") ?? NUM(0);
        let r = this.rawValue(b, "B") ?? NUM(0);
        if (!(l.t === r.t && l.t !== "number" && (op === "EQ" || op === "NEQ"))) {
          l = this.coerce(l, "number");
          r = this.coerce(r, "number");
        }
        const [x, y] = [l.v, r.v];
        const res = { EQ: x === y, NEQ: x !== y, LT: x < y, LTE: x <= y, GT: x > y, GTE: x >= y }[op];
        return BOOL(res!);
      }
      case "logic_ternary": {
        const cond = this.bool(b, "IF");
        let t = this.rawValue(b, "THEN", expected);
        let e = this.rawValue(b, "ELSE", expected);
        // An empty branch is the neutral value of the other branch's kind (or of the slot's).
        const kind: VType = (t ?? e)?.t ?? expected ?? "number";
        t ??= this.fallback(kind);
        e ??= this.fallback(kind);
        const type: VType = t.t === e.t ? t.t : "number";
        return this.coerce(cond ? t : e, type);
      }
      case "math_number": {
        const raw = this.raw(b, "NUM");
        let n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw === undefined ? 0 : NaN;
        if (!Number.isFinite(n)) n = 0;
        n = Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(n)));
        return NUM(n);
      }
      case "variables_get":
        return NUM(s.vars.get(this.variable(b)) ?? 0);
      case "cb_arith": {
        const op = this.dropdown(b, "OP");
        const l = this.num(b, "A");
        const r = this.num(b, "B");
        return NUM({ ADD: add, SUB: sub, MUL: mul, DIV: div, MOD: mod }[op as "ADD"](l, r));
      }
      case "cb_minmax":
        return NUM((this.dropdown(b, "OP") === "MIN" ? Math.min : Math.max)(this.num(b, "A"), this.num(b, "B")));
      case "cb_unary": {
        const x = this.num(b, "A");
        return NUM(this.dropdown(b, "OP") === "ABS" ? abs(x) : neg(x));
      }
      case "cb_clamp": {
        const [x, lo, hi] = [this.num(b, "X"), this.num(b, "LO"), this.num(b, "HI")];
        return NUM(x < lo ? lo : x > hi ? hi : x);
      }
      case "cb_by_rank": {
        const values = [1, 2, 3, 4, 5, 6, 7, 8].map((r) => this.number(b, `R${r}`));
        const rank = Math.max(1, Math.min(8, this.num(b, "RANK")));
        return NUM(values[rank - 1]!);
      }

      // pieces
      case "cb_any_on":
        return BOOL((this.piecesOf(this.side(b), this.piece(b)) & this.zone(b, "ZONE")) !== 0n);
      case "cb_count_on":
        return NUM(popcount(this.piecesOf(this.side(b), this.piece(b)) & this.zone(b, "ZONE")));
      case "cb_count":
        return NUM(popcount(this.piecesOf(this.side(b), this.piece(b))));
      case "cb_material_value":
        return NUM(this.material(this.side(b), b, ""));
      case "cb_material_diff":
        return NUM(sub(this.material(s.us, b, ""), this.material(s.them, b, "")));

      // squares
      case "cb_zone_rank": {
        const r = Number(this.dropdown(b, "RANK"));
        return ZONE(this.relRanks(this.side(b, "WHOSE"), r, r));
      }
      case "cb_zone_ranks": {
        const [from, to] = [Number(this.dropdown(b, "FROM")), Number(this.dropdown(b, "TO"))];
        return ZONE(this.relRanks(this.side(b, "WHOSE"), Math.min(from, to), Math.max(from, to)));
      }
      case "cb_zone_file":
        return ZONE(FILE_MASK["ABCDEFGH".indexOf(this.dropdown(b, "FILE"))]!);
      case "cb_zone_square": {
        const sq = "ABCDEFGH".indexOf(this.dropdown(b, "FILE")) + 8 * (Number(this.dropdown(b, "RANK")) - 1);
        return ZONE(bit(s.us === WHITE ? sq : sq ^ 56)); // mirrored when Black is "us"
      }
      case "cb_zone_area": {
        const f = (sq: number) => fileOf(sq);
        const r = (sq: number) => rankOf(sq);
        const areas: Record<string, (sq: number) => boolean> = {
          CENTER: (sq) => f(sq) >= 3 && f(sq) <= 4 && r(sq) >= 3 && r(sq) <= 4,
          BIG_CENTER: (sq) => f(sq) >= 2 && f(sq) <= 5 && r(sq) >= 2 && r(sq) <= 5,
          OUR_HALF: (sq) => relRank(s.us, sq) <= 3,
          THEIR_HALF: (sq) => relRank(s.us, sq) >= 4,
          LIGHT: isLight, // real square colours, the same for both sides
          DARK: (sq) => !isLight(sq),
          EDGE: (sq) => f(sq) === 0 || f(sq) === 7 || r(sq) === 0 || r(sq) === 7,
          QUEENSIDE: (sq) => f(sq) <= 3,
          KINGSIDE: (sq) => f(sq) >= 4,
          EMPTY: (sq) => p.board[sq] === -1,
          ALL: () => true,
        };
        return ZONE(maskWhere(areas[this.dropdown(b, "AREA")]!));
      }
      case "cb_zone_attacked": {
        const who = this.side(b, "WHOSE");
        const by = this.dropdown(b, "BY");
        return ZONE(by === "ANY" ? p.attackedSquares(who) : p.pieceAttacks(who, TYPE_BY_NAME[by]!));
      }
      case "cb_zone_king":
        return ZONE(p.kingZone(this.side(b, "WHOSE")));
      case "cb_zone_pieces":
        return ZONE(this.piecesOf(this.side(b, "WHOSE"), this.piece(b)));
      case "cb_zone_files": {
        const kind = this.dropdown(b, "KIND");
        return ZONE(kind === "OPEN" ? p.openFiles() : p.halfOpenFiles(kind === "HALF_US" ? s.us : s.them));
      }
      case "cb_zone_combine": {
        const op = this.dropdown(b, "OP");
        const [l, r] = [this.zone(b, "A"), this.zone(b, "B")];
        return ZONE(op === "OR" ? l | r : op === "AND" ? l & r : l & ~r);
      }

      // classic evaluation
      case "cb_mobility": {
        const who = this.side(b);
        const piece = this.piece(b);
        const types = piece === "ALL" ? [KNIGHT, BISHOP, ROOK, QUEEN] : [TYPE_BY_NAME[piece]!];
        return NUM(types.reduce((acc, t) => add(acc, p.mobility(who, t)), 0));
      }
      case "cb_pawn_structure": {
        const who = this.side(b);
        const kind = this.dropdown(b, "KIND");
        const set = {
          PASSED: () => p.passedPawns(who),
          ISOLATED: () => p.isolatedPawns(who),
          DOUBLED: () => p.doubledPawns(who),
          CONNECTED: () => p.connectedPawns(who),
          BACKWARD: () => p.backwardPawns(who),
        }[kind as "PASSED"]();
        return NUM(popcount(set));
      }
      case "cb_passed_rank": {
        const who = this.side(b);
        const rank = Number(this.dropdown(b, "RANK"));
        return NUM(popcount(p.passedPawns(who) & this.relRanks(who, rank, 8)));
      }
      case "cb_rooks_files": {
        const who = this.side(b);
        const files = this.dropdown(b, "KIND") === "OPEN" ? p.openFiles() : p.halfOpenFiles(who);
        return NUM(popcount(p.pieces(who, ROOK) & files));
      }
      case "cb_bishop_pair":
        return BOOL(p.bishopPair(this.side(b)));
      case "cb_king_shield":
        return NUM(p.kingShield(this.side(b)));
      case "cb_king_attacks":
        return NUM(p.kingZoneAttacks(this.side(b)));
      case "cb_king_distance":
        return NUM(squareDistance(p.kingSquare(WHITE), p.kingSquare(BLACK)));
      case "cb_king_center":
        return NUM(centerDistance(p.kingSquare(this.side(b))));
      case "cb_hanging":
        return NUM(p.hanging(this.side(b)));

      // game state
      case "cb_phase":
        return NUM(this.phase);
      case "cb_is_endgame":
        return BOOL(this.phase <= this.number(b, "PHASE"));
      case "cb_our_turn":
        return BOOL(p.side === s.us);
      case "cb_in_check": {
        const who = this.side(b, "WHO");
        return BOOL(p.isAttacked(p.kingSquare(who), who ^ 1));
      }
      case "cb_can_castle": {
        const who = this.side(b, "WHO");
        const way = this.dropdown(b, "WAY");
        const k = who === WHITE ? 1 : 4;
        const q = who === WHITE ? 2 : 8;
        return BOOL((p.castling & (way === "KING" ? k : way === "QUEEN" ? q : k | q)) !== 0);
      }
      case "cb_halfmove":
        return NUM(p.halfmove);

      // the current piece of a "for each" loop
      case "cb_it_rank":
        return NUM(relRank(s.us, this.loop().sq) + 1);
      case "cb_it_file":
        return NUM(fileOf(this.loop().sq) + 1);
      case "cb_it_attacked":
        return BOOL(p.isAttacked(this.loop().sq, s.them));
      case "cb_it_defended":
        return BOOL(p.isAttacked(this.loop().sq, s.us));
      case "cb_it_mobility": {
        const { type, sq } = this.loop();
        const safe = ~p.colorBB(s.us) & ~p.pieceAttacks(s.them, PAWN);
        if (type !== PAWN) return NUM(popcount(p.attacksFrom(type, s.us, sq) & safe));
        // A pawn moves forward onto empty squares (two from its start rank) and captures diagonally.
        const step = s.us === WHITE ? 8 : -8;
        const empty = (x: number) => x >= 0 && x < 64 && p.board[x] === -1;
        let moves = p.attacksFrom(PAWN, s.us, sq) & p.colorBB(s.them);
        if (empty(sq + step)) {
          moves |= bit(sq + step);
          if (relRank(s.us, sq) === 1 && empty(sq + 2 * step)) moves |= bit(sq + 2 * step);
        }
        return NUM(popcount(moves & safe));
      }
      case "cb_it_passed": {
        const { type, sq } = this.loop();
        return BOOL(type === PAWN && ((p.passedPawns(s.us) >> BigInt(sq)) & 1n) === 1n);
      }
      case "cb_it_king_distance":
        return NUM(squareDistance(this.loop().sq, p.kingSquare(this.side(b, "WHOSE"))));
      case "cb_it_center_distance":
        return NUM(centerDistance(this.loop().sq));
      case "cb_it_open_file": {
        const files = this.dropdown(b, "KIND") === "OPEN" ? p.openFiles() : p.halfOpenFiles(s.us);
        return BOOL(((files >> BigInt(this.loop().sq)) & 1n) === 1n);
      }
      case "cb_it_on":
        return BOOL(((this.zone(b, "ZONE") >> BigInt(this.loop().sq)) & 1n) === 1n);
      case "cb_it_attacks_in": {
        const { type, sq } = this.loop();
        return NUM(popcount(p.attacksFrom(type, s.us, sq) & this.zone(b, "ZONE")));
      }
      case "cb_it_pst": {
        const sq = this.loop().sq;
        return NUM(this.table(b, "TABLE")[s.us === WHITE ? sq : sq ^ 56]!);
      }
    }
    throw new Error(`reference interpreter: no value semantics for ${b.type}`);
  }

  // ── statements ──

  private chain(first: BlockState | null): void {
    for (let b = first; b; b = nextBlock(b)) if (!isDisabled(b)) this.statement(b);
  }

  private points(subtract: boolean, mg: number, eg: number): void {
    const s = this.s;
    s.mg = subtract ? sub(s.mg, mg) : add(s.mg, mg);
    s.eg = subtract ? sub(s.eg, eg) : add(s.eg, eg);
  }

  private pstSum(type: number, table: number[]): number {
    let n = 0;
    for (const sq of squaresOf(this.p.pieces(this.s.us, type))) n = add(n, table[this.s.us === WHITE ? sq : sq ^ 56]!);
    return n;
  }

  private statement(b: BlockState): void {
    const s = this.s;
    const isSub = () => this.dropdown(b, "OP") === "SUB";
    switch (b.type) {
      case "cb_add": {
        const v = this.num(b, "VALUE");
        return this.points(isSub(), v, v);
      }
      case "cb_add_tapered":
        return this.points(isSub(), this.num(b, "MG"), this.num(b, "EG"));
      case "cb_add_each": {
        const v = mul(this.num(b, "VALUE"), this.num(b, "COUNT"));
        return this.points(isSub(), v, v);
      }
      case "cb_add_each_tapered": {
        const [mg, eg, n] = [this.num(b, "MG"), this.num(b, "EG"), this.num(b, "COUNT")];
        return this.points(isSub(), mul(mg, n), mul(eg, n));
      }
      case "cb_material": {
        const m = this.material(s.us, b, "");
        return this.points(false, m, m);
      }
      case "cb_material_tapered":
        return this.points(false, this.material(s.us, b, "MG_"), this.material(s.us, b, "EG_"));
      case "cb_pst": {
        const v = this.pstSum(TYPE_BY_NAME[this.piece(b)]!, this.table(b, "TABLE"));
        return this.points(false, v, v);
      }
      case "cb_pst_tapered": {
        const t = TYPE_BY_NAME[this.piece(b)]!;
        return this.points(false, this.pstSum(t, this.table(b, "MG")), this.pstSum(t, this.table(b, "EG")));
      }
      case "cb_for_each": {
        const type = TYPE_BY_NAME[this.piece(b)]!;
        // From our own back rank forward (files a … h within a rank), for White and Black alike.
        const rel = (sq: number) => (s.us === WHITE ? sq : sq ^ 56);
        for (const sq of squaresOf(this.p.pieces(s.us, type)).sort((a, c) => rel(a) - rel(c))) {
          s.loops.push({ type, sq });
          this.chain(inputBlock(b, "DO"));
          s.loops.pop();
        }
        return;
      }
      case "controls_if":
      case "controls_ifelse": {
        let elseIfs = 0;
        let hasElse = b.type === "controls_ifelse";
        if (b.type === "controls_if") {
          const es = b.extraState;
          if (isRecord(es)) {
            elseIfs = typeof es.elseIfCount === "number" ? Math.max(0, Math.floor(es.elseIfCount)) : 0;
            hasElse = es.hasElse === true;
          } else if (typeof es === "string") {
            // Legacy XML mutation, e.g. <mutation elseif="1" else="1"></mutation>
            elseIfs = Number(/elseif="(\d+)"/.exec(es)?.[1] ?? 0);
            hasElse = /else="1"/.test(es);
          }
          for (const k of Object.keys(isRecord(b.inputs) ? b.inputs : {})) {
            const m = /^(?:IF|DO)(\d+)$/.exec(k);
            if (m) elseIfs = Math.max(elseIfs, Number(m[1]));
            if (k === "ELSE") hasElse = true;
          }
        }
        for (let i = 0; i <= elseIfs; i++) {
          if (this.bool(b, `IF${i}`)) return this.chain(inputBlock(b, `DO${i}`));
        }
        if (hasElse) this.chain(inputBlock(b, "ELSE"));
        return;
      }
      case "variables_set":
        s.vars.set(this.variable(b), this.num(b, "VALUE"));
        return;
      case "math_change": {
        const v = this.variable(b);
        s.vars.set(v, add(s.vars.get(v) ?? 0, this.num(b, "DELTA")));
        return;
      }
    }
    throw new Error(`reference interpreter: no statement semantics for ${b.type}`);
  }
}

/** Per-term (White, Black) values of a blocks workspace on a position, computed without the generator. */
export function interpretWorkspace(ws: object, fen: string): TermValue[] {
  return new Interpreter(ws as Record<string, unknown>, new RefPosition(fen)).run();
}

/** What cb_eval_trace prints for a label: tabs/line breaks become spaces, non-ASCII UTF-16 units "?". */
export function traceLabel(label: string): string {
  // cb_eval_trace writes labels as UTF-8, with tabs and line breaks turned into spaces.
  return label.replace(/[\t\n\r]/g, " ");
}
