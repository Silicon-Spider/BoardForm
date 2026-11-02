// =====================================================================================
// bitboard.ts — 64-bit sets of squares and precomputed attack tables
// =====================================================================================
//
// A bitboard is a `u64` in which bit `sq` is set when square `sq` belongs to the set
// (LERF numbering: a1 = bit 0, h8 = bit 63). Set operations become single machine
// instructions: union `a | b`, intersection `a & b`, complement `~a`, "is empty" `a == 0`.
//
// This file provides:
//   * file / rank / colour masks,
//   * small helpers (popcount, lowest / highest set bit, shifts, distances),
//   * precomputed attack tables for knights, kings and pawns,
//   * sliding-piece attacks (bishop, rook, queen) using *magic bitboards*,
//   * geometry tables: squares between two squares, full lines, pawn spans.
//
// `initBitboards()` must run once before anything else uses the tables (main.ts does it in
// `cb_init`).
//
// Iterating over a bitboard is done with this idiom (used everywhere in the engine):
//
//     let b = someSet;
//     while (b != 0) {
//       const sq = lsb(b);   // index of the lowest set bit
//       b &= b - 1;          // clear that bit
//       ...
//     }

import { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from "./types";

// ------------------------------------------------------------------- files and ranks

export const FILE_A: u64 = 0x0101010101010101;
export const FILE_B: u64 = 0x0202020202020202;
export const FILE_C: u64 = 0x0404040404040404;
export const FILE_D: u64 = 0x0808080808080808;
export const FILE_E: u64 = 0x1010101010101010;
export const FILE_F: u64 = 0x2020202020202020;
export const FILE_G: u64 = 0x4040404040404040;
export const FILE_H: u64 = 0x8080808080808080;

export const RANK_1: u64 = 0x00000000000000FF;
export const RANK_2: u64 = 0x000000000000FF00;
export const RANK_3: u64 = 0x0000000000FF0000;
export const RANK_4: u64 = 0x00000000FF000000;
export const RANK_5: u64 = 0x000000FF00000000;
export const RANK_6: u64 = 0x0000FF0000000000;
export const RANK_7: u64 = 0x00FF000000000000;
export const RANK_8: u64 = 0xFF00000000000000;

/** FILE_BB[f] = mask of file f (0 = a-file). */
export const FILE_BB: StaticArray<u64> = [FILE_A, FILE_B, FILE_C, FILE_D, FILE_E, FILE_F, FILE_G, FILE_H];
/** RANK_BB[r] = mask of rank r (0 = 1st rank). */
export const RANK_BB: StaticArray<u64> = [RANK_1, RANK_2, RANK_3, RANK_4, RANK_5, RANK_6, RANK_7, RANK_8];

/** The 32 light squares (b1, d1, ..., a2, ...). a1 is a dark square. */
export const LIGHT_SQUARES: u64 = 0x55AA55AA55AA55AA;
/** The 32 dark squares. */
export const DARK_SQUARES: u64 = 0xAA55AA55AA55AA55;
/** d4, e4, d5, e5. */
export const CENTER: u64 = 0x0000001818000000;
/** The 16 squares c3 - f6. */
export const BIG_CENTER: u64 = 0x00003C3C3C3C0000;
/** Every square. */
export const ALL_SQUARES: u64 = 0xFFFFFFFFFFFFFFFF;

// ------------------------------------------------------------------------ basic helpers

/** Bitboard containing only square `sq`. */
@inline
export function sqBB(sq: i32): u64 {
  return (<u64>1) << (<u64>sq);
}

/** Number of set bits (number of squares in the set). */
@inline
export function popcount(b: u64): i32 {
  return <i32>popcnt<u64>(b);
}

/** Index of the lowest set bit; 64 for an empty set. */
@inline
export function lsb(b: u64): i32 {
  return <i32>ctz<u64>(b);
}

/** Index of the highest set bit; 64 for an empty set. */
@inline
export function msb(b: u64): i32 {
  return b == 0 ? 64 : 63 - <i32>clz<u64>(b);
}

/** File of a square, 0 (a) .. 7 (h). */
@inline
export function fileOf(sq: i32): i32 {
  return sq & 7;
}

/** Rank of a square, 0 (1st rank) .. 7 (8th rank). */
@inline
export function rankOf(sq: i32): i32 {
  return sq >> 3;
}

/** Square from a file (0..7) and a rank (0..7). */
@inline
export function makeSquare(file: i32, rank: i32): i32 {
  return (rank << 3) | file;
}

/**
 * Rank of `sq` counted from `color`'s own side, 0..7.
 * relativeRank(WHITE, E7) == 6 and relativeRank(BLACK, E2) == 6 ("the 7th rank").
 */
@inline
export function relativeRank(color: i32, sq: i32): i32 {
  return (sq >> 3) ^ (color * 7);
}

/** The square as seen from `color`'s side: unchanged for White, mirrored vertically for Black. */
@inline
export function relativeSquare(color: i32, sq: i32): i32 {
  return sq ^ (color * 56);
}

/** Mask of the rank that is `rank` (0..7) as seen from `color`'s side. */
@inline
export function relativeRankBB(color: i32, rank: i32): u64 {
  return unchecked(RANK_BB[(rank ^ (color * 7)) & 7]);
}

/** King-move (Chebyshev) distance between two squares, 0..7. */
export function squareDistance(a: i32, b: i32): i32 {
  const df = abs<i32>((a & 7) - (b & 7));
  const dr = abs<i32>((a >> 3) - (b >> 3));
  return df > dr ? df : dr;
}

/** Manhattan distance between two squares (files + ranks apart), 0..14. */
export function manhattanDistance(a: i32, b: i32): i32 {
  return abs<i32>((a & 7) - (b & 7)) + abs<i32>((a >> 3) - (b >> 3));
}

// ------------------------------------------------------------------------------ shifts
// Shifting a whole set one step in a direction. East/west shifts mask out the squares
// that would otherwise wrap around from the h-file to the a-file (or vice versa).

/** Every square one rank up (towards rank 8). */
@inline export function shiftNorth(b: u64): u64 { return b << 8; }
/** Every square one rank down (towards rank 1). */
@inline export function shiftSouth(b: u64): u64 { return b >> 8; }
/** Every square one file right (towards the h-file). */
@inline export function shiftEast(b: u64): u64 { return (b & ~FILE_H) << 1; }
/** Every square one file left (towards the a-file). */
@inline export function shiftWest(b: u64): u64 { return (b & ~FILE_A) >> 1; }
/** Every square one step up and right. */
@inline export function shiftNorthEast(b: u64): u64 { return (b & ~FILE_H) << 9; }
/** Every square one step up and left. */
@inline export function shiftNorthWest(b: u64): u64 { return (b & ~FILE_A) << 7; }
/** Every square one step down and right. */
@inline export function shiftSouthEast(b: u64): u64 { return (b & ~FILE_H) >> 7; }
/** Every square one step down and left. */
@inline export function shiftSouthWest(b: u64): u64 { return (b & ~FILE_A) >> 9; }

/** Every square of `b` moved one step forward for `color` (north for White, south for Black). */
@inline
export function pawnPushBB(color: i32, b: u64): u64 {
  return color == WHITE ? b << 8 : b >> 8;
}

/** All squares attacked by a set of pawns of `color`. */
@inline
export function pawnAttacksBB(color: i32, pawns: u64): u64 {
  return color == WHITE
    ? shiftNorthEast(pawns) | shiftNorthWest(pawns)
    : shiftSouthEast(pawns) | shiftSouthWest(pawns);
}

// ------------------------------------------------------------------- attack tables
// Filled by initBitboards().

const KNIGHT_ATTACKS = new StaticArray<u64>(64);
const KING_ATTACKS = new StaticArray<u64>(64);
const PAWN_ATTACKS = new StaticArray<u64>(128); // [color * 64 + sq]
const BETWEEN = new StaticArray<u64>(64 * 64); // [a * 64 + b]
const LINE = new StaticArray<u64>(64 * 64); // [a * 64 + b]
const FORWARD_FILE = new StaticArray<u64>(128); // [color * 64 + sq]
const PASSED_SPAN = new StaticArray<u64>(128); // [color * 64 + sq]
const ADJACENT_FILES = new StaticArray<u64>(8);

/** Squares a knight on `sq` attacks. */
@inline
export function knightAttacks(sq: i32): u64 {
  return unchecked(KNIGHT_ATTACKS[sq]);
}

/** Squares a king on `sq` attacks. */
@inline
export function kingAttacks(sq: i32): u64 {
  return unchecked(KING_ATTACKS[sq]);
}

/** Squares a pawn of `color` on `sq` attacks (diagonally forward). */
@inline
export function pawnAttacks(color: i32, sq: i32): u64 {
  return unchecked(PAWN_ATTACKS[(color << 6) + sq]);
}

/** Squares strictly in front of `sq` on its file, from `color`'s point of view. */
@inline
export function forwardFileBB(color: i32, sq: i32): u64 {
  return unchecked(FORWARD_FILE[(color << 6) + sq]);
}

/** The files next to `file` (not including `file` itself). */
@inline
export function adjacentFilesBB(file: i32): u64 {
  return unchecked(ADJACENT_FILES[file & 7]);
}

/**
 * Squares in front of `sq` on its own file and both adjacent files (from `color`'s point
 * of view). A pawn is passed when no enemy pawn stands on this span.
 */
@inline
export function passedPawnSpan(color: i32, sq: i32): u64 {
  return unchecked(PASSED_SPAN[(color << 6) + sq]);
}

/** Squares strictly between `a` and `b` if they share a rank, file or diagonal, else 0. */
@inline
export function betweenBB(a: i32, b: i32): u64 {
  return unchecked(BETWEEN[(a << 6) + b]);
}

/**
 * The whole line (edge to edge) through `a` and `b` if they share a rank, file or diagonal,
 * else 0. Used to keep pinned pieces on their pin line.
 */
@inline
export function lineBB(a: i32, b: i32): u64 {
  return unchecked(LINE[(a << 6) + b]);
}

// ------------------------------------------------------------- sliding pieces: magics
//
// A rook on d4 attacks along its rank and file until the first blocker in each direction.
// Which squares it attacks therefore depends only on the occupancy of its "relevant"
// squares (the rays without the board edge). "Magic bitboards" turn that occupancy into a
// table index with one multiplication:
//
//     index = ((occupied & mask[sq]) * magic[sq]) >> shift[sq]
//     attacks = table[offset[sq] + index]
//
// A magic number must map every possible blocker configuration of a square to an index that
// never collides with a configuration that has *different* attacks. Such numbers are found by
// trial and error with random candidates (see initSliderTables below). Because that search
// takes a few hundred milliseconds, the numbers it found are stored in ROOK_MAGIC_NUMBERS /
// BISHOP_MAGIC_NUMBERS; at start-up each one is only verified (and searched for again if it
// ever fails, e.g. after an edit).

const ROOK_MASK = new StaticArray<u64>(64);
const ROOK_MAGIC = new StaticArray<u64>(64);
const ROOK_SHIFT = new StaticArray<u64>(64);
const ROOK_OFFSET = new StaticArray<i32>(64);
const ROOK_TABLE = new StaticArray<u64>(102400); // total size for rooks with these masks

const BISHOP_MASK = new StaticArray<u64>(64);
const BISHOP_MAGIC = new StaticArray<u64>(64);
const BISHOP_SHIFT = new StaticArray<u64>(64);
const BISHOP_OFFSET = new StaticArray<i32>(64);
const BISHOP_TABLE = new StaticArray<u64>(5248); // total size for bishops

/** Squares a bishop on `sq` attacks, given all occupied squares `occ`. */
@inline
export function bishopAttacks(sq: i32, occ: u64): u64 {
  const index = <i32>(((occ & unchecked(BISHOP_MASK[sq])) * unchecked(BISHOP_MAGIC[sq])) >> unchecked(BISHOP_SHIFT[sq]));
  return unchecked(BISHOP_TABLE[unchecked(BISHOP_OFFSET[sq]) + index]);
}

/** Squares a rook on `sq` attacks, given all occupied squares `occ`. */
@inline
export function rookAttacks(sq: i32, occ: u64): u64 {
  const index = <i32>(((occ & unchecked(ROOK_MASK[sq])) * unchecked(ROOK_MAGIC[sq])) >> unchecked(ROOK_SHIFT[sq]));
  return unchecked(ROOK_TABLE[unchecked(ROOK_OFFSET[sq]) + index]);
}

/** Squares a queen on `sq` attacks (bishop + rook attacks). */
@inline
export function queenAttacks(sq: i32, occ: u64): u64 {
  return bishopAttacks(sq, occ) | rookAttacks(sq, occ);
}

/** Squares attacked by a piece of the given type and colour standing on `sq`. */
export function attacksOf(type: i32, color: i32, sq: i32, occ: u64): u64 {
  switch (type) {
    case PAWN: return pawnAttacks(color, sq);
    case KNIGHT: return knightAttacks(sq);
    case BISHOP: return bishopAttacks(sq, occ);
    case ROOK: return rookAttacks(sq, occ);
    case QUEEN: return queenAttacks(sq, occ);
    case KING: return kingAttacks(sq);
  }
  return 0;
}

// ---------------------------------------------------------------------- initialisation

// Direction vectors as (file step, rank step).
const KNIGHT_DF: StaticArray<i32> = [1, 2, 2, 1, -1, -2, -2, -1];
const KNIGHT_DR: StaticArray<i32> = [2, 1, -1, -2, -2, -1, 1, 2];
const KING_DF: StaticArray<i32> = [1, 1, 0, -1, -1, -1, 0, 1];
const KING_DR: StaticArray<i32> = [0, 1, 1, 1, 0, -1, -1, -1];
const ROOK_DF: StaticArray<i32> = [1, -1, 0, 0];
const ROOK_DR: StaticArray<i32> = [0, 0, 1, -1];
const BISHOP_DF: StaticArray<i32> = [1, 1, -1, -1];
const BISHOP_DR: StaticArray<i32> = [1, -1, 1, -1];

let initialized = false;

/** Builds all attack and geometry tables. Safe to call more than once. */
export function initBitboards(): void {
  if (initialized) return;
  initialized = true;

  for (let f = 0; f < 8; f++) {
    let adj: u64 = 0;
    if (f > 0) adj |= FILE_BB[f - 1];
    if (f < 7) adj |= FILE_BB[f + 1];
    ADJACENT_FILES[f] = adj;
  }

  for (let sq = 0; sq < 64; sq++) {
    KNIGHT_ATTACKS[sq] = stepAttacks(sq, KNIGHT_DF, KNIGHT_DR, 8);
    KING_ATTACKS[sq] = stepAttacks(sq, KING_DF, KING_DR, 8);

    const f = sq & 7;
    const r = sq >> 3;
    // Pawn captures: White diagonally up, Black diagonally down.
    let w: u64 = 0;
    let b: u64 = 0;
    if (r < 7 && f > 0) w |= sqBB(sq + 7);
    if (r < 7 && f < 7) w |= sqBB(sq + 9);
    if (r > 0 && f > 0) b |= sqBB(sq - 9);
    if (r > 0 && f < 7) b |= sqBB(sq - 7);
    PAWN_ATTACKS[sq] = w;
    PAWN_ATTACKS[64 + sq] = b;

    // Squares in front on the same file.
    let whiteFront: u64 = 0;
    let blackFront: u64 = 0;
    for (let rr = r + 1; rr < 8; rr++) whiteFront |= sqBB(rr * 8 + f);
    for (let rr = r - 1; rr >= 0; rr--) blackFront |= sqBB(rr * 8 + f);
    FORWARD_FILE[sq] = whiteFront;
    FORWARD_FILE[64 + sq] = blackFront;
  }

  for (let sq = 0; sq < 64; sq++) {
    // Passed-pawn span: front squares on the own file plus the same ranks on adjacent files.
    for (let color = WHITE; color <= BLACK; color++) {
      const front = FORWARD_FILE[(color << 6) + sq];
      let span = front;
      if ((sq & 7) > 0) span |= FORWARD_FILE[(color << 6) + sq - 1];
      if ((sq & 7) < 7) span |= FORWARD_FILE[(color << 6) + sq + 1];
      PASSED_SPAN[(color << 6) + sq] = span;
    }
  }

  initSliderTables(true);
  initSliderTables(false);

  // Between / line tables, built from the (now working) slider attacks on an empty board.
  for (let a = 0; a < 64; a++) {
    for (let b = 0; b < 64; b++) {
      if (a == b) continue;
      const bbA = sqBB(a);
      const bbB = sqBB(b);
      if ((rookAttacks(a, 0) & bbB) != 0) {
        BETWEEN[(a << 6) + b] = rookAttacks(a, bbB) & rookAttacks(b, bbA);
        LINE[(a << 6) + b] = (rookAttacks(a, 0) & rookAttacks(b, 0)) | bbA | bbB;
      } else if ((bishopAttacks(a, 0) & bbB) != 0) {
        BETWEEN[(a << 6) + b] = bishopAttacks(a, bbB) & bishopAttacks(b, bbA);
        LINE[(a << 6) + b] = (bishopAttacks(a, 0) & bishopAttacks(b, 0)) | bbA | bbB;
      }
    }
  }
}

/** Attacks of a "stepping" piece (knight, king) on `sq` given its direction vectors. */
function stepAttacks(sq: i32, df: StaticArray<i32>, dr: StaticArray<i32>, count: i32): u64 {
  let attacks: u64 = 0;
  const f = sq & 7;
  const r = sq >> 3;
  for (let i = 0; i < count; i++) {
    const nf = f + df[i];
    const nr = r + dr[i];
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) attacks |= sqBB(nr * 8 + nf);
  }
  return attacks;
}

/**
 * Slow reference implementation of slider attacks: walk each direction until the edge of
 * the board or the first occupied square (which is included: it can be captured).
 * Only used to build the magic tables.
 */
function slidingAttacks(sq: i32, occ: u64, rook: bool): u64 {
  let attacks: u64 = 0;
  for (let d = 0; d < 4; d++) {
    const df = rook ? ROOK_DF[d] : BISHOP_DF[d];
    const dr = rook ? ROOK_DR[d] : BISHOP_DR[d];
    let f = (sq & 7) + df;
    let r = (sq >> 3) + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const s = sqBB(r * 8 + f);
      attacks |= s;
      if ((occ & s) != 0) break;
      f += df;
      r += dr;
    }
  }
  return attacks;
}

// A small, fast pseudo-random generator (xorshift64*) used to propose magic candidates.
let prngState: u64 = 1;

function prngNext(): u64 {
  prngState ^= prngState >> 12;
  prngState ^= prngState << 25;
  prngState ^= prngState >> 27;
  return prngState * 2685821657736338717;
}

/** Random number with few set bits: good magic candidates tend to be sparse. */
function sparseRandom(): u64 {
  return prngNext() & prngNext() & prngNext();
}

// Magic numbers found by the random search below (square a1 first). Any number that passes
// verification works; these are simply the first ones the search found.
const ROOK_MAGIC_NUMBERS: StaticArray<u64> = [
  0x0A80004000801220, 0x8040004010002008, 0x2080200010008008, 0x1100100008210004,
  0xC200209084020008, 0x2100010004000208, 0x0400081000822421, 0x0200010422048844,
  0x0800800080400024, 0x0001402000401000, 0x3000801000802001, 0x4400800800100083,
  0x0904802402480080, 0x4040800400020080, 0x0018808042000100, 0x4040800080004100,
  0x0040048001458024, 0x00A0004000205000, 0x3100808010002000, 0x4825010010000820,
  0x5004808008000401, 0x2024818004000A00, 0x0005808002000100, 0x2100060004806104,
  0x0080400880008421, 0x4062220600410280, 0x010A004A00108022, 0x0000100080080080,
  0x0021000500080010, 0x0044000202001008, 0x0000100400080102, 0xC020128200040545,
  0x0080002000400040, 0x0000804000802004, 0x0000120022004080, 0x010A386103001001,
  0x9010080080800400, 0x8440020080800400, 0x0004228824001001, 0x000000490A000084,
  0x0080002000504000, 0x200020005000C000, 0x0012088020420010, 0x0010010080080800,
  0x0085001008010004, 0x0002000204008080, 0x0040413002040008, 0x0000304081020004,
  0x0080204000800080, 0x3008804000290100, 0x1010100080200080, 0x2008100208028080,
  0x5000850800910100, 0x8402019004680200, 0x0120911028020400, 0x0000008044010200,
  0x0020850200244012, 0x0020850200244012, 0x0000102001040841, 0x140900040A100021,
  0x000200282410A102, 0x000200282410A102, 0x000200282410A102, 0x4048240043802106,
];
const BISHOP_MAGIC_NUMBERS: StaticArray<u64> = [
  0x40106000A1160020, 0x0020010250810120, 0x2010010220280081, 0x002806004050C040,
  0x0002021018000000, 0x2001112010000400, 0x0881010120218080, 0x1030820110010500,
  0x0000120222042400, 0x2000020404040044, 0x8000480094208000, 0x0003422A02000001,
  0x000A220210100040, 0x8004820202226000, 0x0018234854100800, 0x0100004042101040,
  0x0004001004082820, 0x0010000810010048, 0x1014004208081300, 0x2080818802044202,
  0x0040880C00A00100, 0x0080400200522010, 0x0001000188180B04, 0x0080249202020204,
  0x1004400004100410, 0x00013100A0022206, 0x2148500001040080, 0x4241080011004300,
  0x4020848004002000, 0x10101380D1004100, 0x0008004422020284, 0x01010A1041008080,
  0x0808080400082121, 0x0808080400082121, 0x0091128200100C00, 0x0202200802010104,
  0x8C0A020200440085, 0x01A0008080B10040, 0x0889520080122800, 0x100902022202010A,
  0x04081A0816002000, 0x0000681208005000, 0x8170840041008802, 0x0A00004200810805,
  0x0830404408210100, 0x2602208106006102, 0x1048300680802628, 0x2602208106006102,
  0x0602010120110040, 0x0941010801043000, 0x000040440A210428, 0x0008240020880021,
  0x0400002012048200, 0x00AC102001210220, 0x0220021002009900, 0x84440C080A013080,
  0x0001008044200440, 0x0004C04410841000, 0x2000500104011130, 0x1A0C010011C20229,
  0x0044800112202200, 0x0434804908100424, 0x0300404822C08200, 0x48081010008A2A80,
];

// Seeds for the random search, one per rank.
const MAGIC_SEEDS: StaticArray<u64> = [728, 10316, 55013, 32803, 12281, 15100, 16645, 255];

// Scratch space for the table set-up: every blocker subset of one square, its true attacks,
// and the attempt number that last wrote each table slot (avoids clearing between attempts).
const SUBSETS = new StaticArray<u64>(4096);
const REFERENCE = new StaticArray<u64>(4096);
const EPOCH = new StaticArray<i32>(4096);
let attempt = 0;

/** Sets up mask, magic, shift, offset and the attack table of every square for rooks or bishops. */
function initSliderTables(rook: bool): void {
  const masks = rook ? ROOK_MASK : BISHOP_MASK;
  const magics = rook ? ROOK_MAGIC : BISHOP_MAGIC;
  const shifts = rook ? ROOK_SHIFT : BISHOP_SHIFT;
  const offsets = rook ? ROOK_OFFSET : BISHOP_OFFSET;
  const table = rook ? ROOK_TABLE : BISHOP_TABLE;
  const known = rook ? ROOK_MAGIC_NUMBERS : BISHOP_MAGIC_NUMBERS;
  let offset = 0;

  for (let sq = 0; sq < 64; sq++) {
    // Relevant blockers: the attack rays on an empty board, minus the board edges (a piece
    // on the edge never blocks anything behind it), but keeping edges along the piece's own
    // rank/file when the piece itself stands on that edge.
    const edges = ((RANK_1 | RANK_8) & ~RANK_BB[sq >> 3]) | ((FILE_A | FILE_H) & ~FILE_BB[sq & 7]);
    const mask = slidingAttacks(sq, 0, rook) & ~edges;
    const bits = popcount(mask);
    const shift = <u64>(64 - bits);
    masks[sq] = mask;
    shifts[sq] = shift;
    offsets[sq] = offset;

    // Enumerate every subset of the mask ("carry-rippler" trick) with its true attacks.
    let size = 0;
    let subset: u64 = 0;
    do {
      SUBSETS[size] = subset;
      REFERENCE[size] = slidingAttacks(sq, subset, rook);
      size++;
      subset = (subset - mask) & mask;
    } while (subset != 0);

    // Use the stored magic; search for a new one only if it does not work.
    let magic = known[sq];
    if (!tryMagic(magic, shift, size, table, offset)) {
      prngState = MAGIC_SEEDS[sq >> 3];
      do {
        do {
          magic = sparseRandom();
        } while (popcount((magic * mask) >> 56) < 6); // needs enough bits in the index
      } while (!tryMagic(magic, shift, size, table, offset));
    }
    magics[sq] = magic;
    offset += size;
  }
}

/**
 * Fills one square's slice of the attack table using `magic` and reports whether it worked,
 * i.e. no two blocker subsets with different attacks landed on the same index.
 */
function tryMagic(magic: u64, shift: u64, size: i32, table: StaticArray<u64>, offset: i32): bool {
  attempt++;
  for (let i = 0; i < size; i++) {
    const index = <i32>((SUBSETS[i] * magic) >> shift);
    if (EPOCH[index] < attempt) {
      EPOCH[index] = attempt;
      table[offset + index] = REFERENCE[i];
    } else if (table[offset + index] != REFERENCE[i]) {
      return false; // harmful collision
    }
  }
  return true;
}
