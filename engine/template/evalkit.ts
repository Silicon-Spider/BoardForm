// =====================================================================================
// evalkit.ts — building blocks for evaluation functions
// =====================================================================================
//
// Helpers that answer the questions an evaluation function asks: how much material does a
// side have, which pawns are passed / isolated / doubled, how mobile are the pieces, how
// safe is the king, ... They are used by the default eval.ts, by code generated from the
// drag-and-drop blocks, and by your own evaluation code.
//
// THIS API IS STABLE: the Blocks code generator emits calls to these functions by name, so
// do not rename them or change their parameters (adding new helpers is fine).
//
// Conventions
//   * `color` is WHITE (0) or BLACK (1); `type` is PAWN .. KING (0..5).
//   * Functions returning u64 return a bitboard (set of squares); use popcount() to count.
//   * Everything is computed the same way for both colours, so an evaluation written as
//     "term(WHITE) - term(BLACK)" is exactly symmetric.
//   * Nothing here allocates memory, so these helpers are safe to call from evaluate().
//   * Piece-square tables are StaticArray<i32> with 64 entries, indexed by LERF square from
//     White's point of view (index 0 = a1, 63 = h8). Black uses the vertically mirrored
//     square (`sq ^ 56`), which is what pst() does for you.

import { Position } from "./position";
import { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from "./types";
import {
  sqBB, popcount, lsb, fileOf, rankOf, relativeRankBB, squareDistance,
  knightAttacks, kingAttacks, bishopAttacks, rookAttacks, attacksOf,
  pawnAttacksBB, pawnPushBB, forwardFileBB, adjacentFilesBB, passedPawnSpan,
  shiftEast, shiftWest, shiftNorthEast, shiftNorthWest, shiftSouthEast, shiftSouthWest,
  FILE_BB, RANK_BB, LIGHT_SQUARES, DARK_SQUARES,
} from "./bitboard";

// ----------------------------------------------------------------------- tapering

/** Maximum game phase: all minor and major pieces still on the board. */
export const PHASE_MAX: i32 = 24;

/**
 * Blends a middlegame and an endgame value by game phase (pos.phase(), 0..24):
 * `(mg * phase + eg * (24 - phase)) / 24`. Phase 24 gives `mg`, phase 0 gives `eg`.
 */
export function taper(mg: i32, eg: i32, phase: i32): i32 {
  return (mg * phase + eg * (PHASE_MAX - phase)) / PHASE_MAX;
}

// ----------------------------------------------------------------------- material

/** Σ count × value over the five piece types (kings are not counted). */
export function material(pos: Position, color: i32, pawn: i32, knight: i32, bishop: i32, rook: i32, queen: i32): i32 {
  return pos.count(color, PAWN) * pawn + pos.count(color, KNIGHT) * knight + pos.count(color, BISHOP) * bishop +
    pos.count(color, ROOK) * rook + pos.count(color, QUEEN) * queen;
}

/** Number of `color` pieces of `type` standing on the squares of `mask`. */
export function countOn(pos: Position, color: i32, type: i32, mask: u64): i32 {
  return popcount(pos.pieces(color, type) & mask);
}

/** Mask of one rank (0..7) counted from `color`'s side: relativeRankMask(BLACK, 6) is the 2nd rank. */
export function relativeRankMask(color: i32, rank0to7: i32): u64 {
  return relativeRankBB(color, rank0to7);
}

/**
 * The set `b` seen from `color`'s side: unchanged for White, mirrored vertically for Black
 * (rank 1 <-> rank 8). Walking relativeBB(color, pieces) with lsb() and turning each square back
 * with relativeSquare(color, sq) visits the pieces from the colour's own back rank forward, so
 * White and Black see their pieces in mirror-image order.
 */
export function relativeBB(color: i32, b: u64): u64 {
  return color == WHITE ? b : bswap<u64>(b);
}

// ------------------------------------------------------------------ pawn structure

/** Pawns of `color` with no enemy pawn in front of them on their own or an adjacent file. */
export function passedPawns(pos: Position, color: i32): u64 {
  const enemyPawns = pos.pieces(color ^ 1, PAWN);
  let result: u64 = 0;
  let pawns = pos.pieces(color, PAWN);
  while (pawns != 0) {
    const sq = lsb(pawns);
    pawns &= pawns - 1;
    if ((passedPawnSpan(color, sq) & enemyPawns) == 0) result |= sqBB(sq);
  }
  return result;
}

/** Pawns of `color` with no friendly pawn on either adjacent file. */
export function isolatedPawns(pos: Position, color: i32): u64 {
  const own = pos.pieces(color, PAWN);
  let result: u64 = 0;
  let pawns = own;
  while (pawns != 0) {
    const sq = lsb(pawns);
    pawns &= pawns - 1;
    if ((adjacentFilesBB(fileOf(sq)) & own) == 0) result |= sqBB(sq);
  }
  return result;
}

/** Pawns of `color` that have another friendly pawn in front of them on the same file. */
export function doubledPawns(pos: Position, color: i32): u64 {
  const own = pos.pieces(color, PAWN);
  let result: u64 = 0;
  let pawns = own;
  while (pawns != 0) {
    const sq = lsb(pawns);
    pawns &= pawns - 1;
    if ((forwardFileBB(color, sq) & own) != 0) result |= sqBB(sq);
  }
  return result;
}

/** Pawns of `color` defended by a friendly pawn, or with a friendly pawn right beside them. */
export function connectedPawns(pos: Position, color: i32): u64 {
  const own = pos.pieces(color, PAWN);
  const defended = pawnAttacksBB(color, own) & own;
  const phalanx = (shiftEast(own) | shiftWest(own)) & own;
  return defended | phalanx;
}

/**
 * Backward pawns of `color`: pawns whose neighbours on the adjacent files have all advanced
 * past them (so no pawn can come to defend them) and whose square in front is controlled by
 * an enemy pawn (so they cannot safely advance either). Isolated pawns are not included.
 */
export function backwardPawns(pos: Position, color: i32): u64 {
  const own = pos.pieces(color, PAWN);
  const enemyAttacks = pawnAttacksBB(color ^ 1, pos.pieces(color ^ 1, PAWN));
  let result: u64 = 0;
  let pawns = own;
  while (pawns != 0) {
    const sq = lsb(pawns);
    pawns &= pawns - 1;
    const neighbours = adjacentFilesBB(fileOf(sq));
    if ((neighbours & own) == 0) continue; // isolated, not backward
    const ahead = passedPawnSpan(color, sq) & neighbours; // adjacent-file squares in front
    const supporters = neighbours & ~ahead & own; // neighbours level with or behind the pawn
    if (supporters != 0) continue;
    if ((pawnPushBB(color, sqBB(sq)) & enemyAttacks) != 0) result |= sqBB(sq);
  }
  return result;
}

// ------------------------------------------------------------------------ attacks

/** All squares attacked by the pawns of `color`. */
export function pawnAttacks(pos: Position, color: i32): u64 {
  return pawnAttacksBB(color, pos.pieces(color, PAWN));
}

/** Union of the attacks of all `color` pieces of one type (sliders blocked by all pieces). */
export function pieceAttacks(pos: Position, color: i32, type: i32): u64 {
  if (type == PAWN) return pawnAttacksBB(color, pos.pieces(color, PAWN));
  const occ = pos.occupied();
  let result: u64 = 0;
  let pieces = pos.pieces(color, type);
  while (pieces != 0) {
    const sq = lsb(pieces);
    pieces &= pieces - 1;
    result |= attacksOf(type, color, sq, occ);
  }
  return result;
}

/** All squares attacked by any piece of `color` (including the king). */
export function attackedSquares(pos: Position, color: i32): u64 {
  return pieceAttacks(pos, color, PAWN) | pieceAttacks(pos, color, KNIGHT) | pieceAttacks(pos, color, BISHOP) |
    pieceAttacks(pos, color, ROOK) | pieceAttacks(pos, color, QUEEN) | pieceAttacks(pos, color, KING);
}

/**
 * Mobility of the `color` pieces of one type: Σ over those pieces of the number of attacked
 * squares that are neither occupied by own pieces nor attacked by enemy pawns.
 */
export function mobility(pos: Position, color: i32, type: i32): i32 {
  const safe = ~pos.colorBB(color) & ~pawnAttacksBB(color ^ 1, pos.pieces(color ^ 1, PAWN));
  const occ = pos.occupied();
  let total = 0;
  let pieces = pos.pieces(color, type);
  while (pieces != 0) {
    const sq = lsb(pieces);
    pieces &= pieces - 1;
    total += popcount(attacksOf(type, color, sq, occ) & safe);
  }
  return total;
}

/**
 * Squares the `color` pawn on `sq` can move to: one step forward onto an empty square, two steps
 * from its starting rank when both squares are empty, and diagonally onto enemy pieces.
 * (En passant is not included.)
 */
export function pawnMoves(pos: Position, color: i32, sq: i32): u64 {
  const empty = ~pos.occupied();
  const one = pawnPushBB(color, sqBB(sq)) & empty;
  const two = pawnPushBB(color, one) & empty & relativeRankBB(color, 3); // lands on the 4th rank
  return one | two | (attacksOf(PAWN, color, sq, 0) & pos.colorBB(color ^ 1));
}

/**
 * Mobility of the single `color` piece of `type` on `sq`: the squares it can move to that hold no
 * own piece and are not attacked by an enemy pawn. For knights, bishops, rooks, queens and the
 * king this is exactly what mobility() adds up per piece; a pawn counts pawnMoves() (its forward
 * moves and captures), not the squares it attacks.
 */
export function pieceMobility(pos: Position, color: i32, type: i32, sq: i32): i32 {
  const safe = ~pos.colorBB(color) & ~pawnAttacksBB(color ^ 1, pos.pieces(color ^ 1, PAWN));
  const moves = type == PAWN ? pawnMoves(pos, color, sq) : attacksOf(type, color, sq, pos.occupied());
  return popcount(moves & safe);
}

// -------------------------------------------------------------------------- files

/** Mask of all files without any pawn (union of whole files). */
export function openFiles(pos: Position): u64 {
  const pawns = pos.pieces(WHITE, PAWN) | pos.pieces(BLACK, PAWN);
  let result: u64 = 0;
  for (let f = 0; f < 8; f++) {
    const file = unchecked(FILE_BB[f]);
    if ((file & pawns) == 0) result |= file;
  }
  return result;
}

/** Mask of the files with no `color` pawn but at least one enemy pawn (union of whole files). */
export function halfOpenFiles(pos: Position, color: i32): u64 {
  const own = pos.pieces(color, PAWN);
  const enemy = pos.pieces(color ^ 1, PAWN);
  let result: u64 = 0;
  for (let f = 0; f < 8; f++) {
    const file = unchecked(FILE_BB[f]);
    if ((file & own) == 0 && (file & enemy) != 0) result |= file;
  }
  return result;
}

/** Number of `color` rooks on open files. */
export function rooksOnOpenFiles(pos: Position, color: i32): i32 {
  return popcount(pos.pieces(color, ROOK) & openFiles(pos));
}

/** Number of `color` rooks on half-open files (no own pawn, but an enemy pawn). */
export function rooksOnHalfOpenFiles(pos: Position, color: i32): i32 {
  return popcount(pos.pieces(color, ROOK) & halfOpenFiles(pos, color));
}

// --------------------------------------------------------------------- king safety

/** Own pawns on the king's file and the adjacent files, one or two ranks in front of the king. */
export function kingShield(pos: Position, color: i32): i32 {
  const ksq = pos.kingSquare(color);
  const file = fileOf(ksq);
  const rank = rankOf(ksq);
  const files = unchecked(FILE_BB[file]) | adjacentFilesBB(file);
  let ranks: u64 = 0;
  if (color == WHITE) {
    if (rank + 1 <= 7) ranks |= unchecked(RANK_BB[rank + 1]);
    if (rank + 2 <= 7) ranks |= unchecked(RANK_BB[rank + 2]);
  } else {
    if (rank - 1 >= 0) ranks |= unchecked(RANK_BB[rank - 1]);
    if (rank - 2 >= 0) ranks |= unchecked(RANK_BB[rank - 2]);
  }
  return popcount(pos.pieces(color, PAWN) & files & ranks);
}

/**
 * Enemy pressure on `color`'s king: for every enemy pawn, knight, bishop, rook and queen,
 * the number of squares of the king zone (the king's square and its neighbours) it attacks,
 * summed up ("piece × square" attack count).
 */
export function kingZoneAttacks(pos: Position, color: i32): i32 {
  const ksq = pos.kingSquare(color);
  const zone = kingAttacks(ksq) | sqBB(ksq);
  const enemy = color ^ 1;
  const occ = pos.occupied();
  let count = 0;

  // Pawns: count each capture direction separately, so a pawn hitting two zone squares counts 2.
  const enemyPawns = pos.pieces(enemy, PAWN);
  const westAttacks = enemy == WHITE ? shiftNorthWest(enemyPawns) : shiftSouthWest(enemyPawns);
  const eastAttacks = enemy == WHITE ? shiftNorthEast(enemyPawns) : shiftSouthEast(enemyPawns);
  count += popcount(westAttacks & zone) + popcount(eastAttacks & zone);

  let knights = pos.pieces(enemy, KNIGHT);
  while (knights != 0) {
    const sq = lsb(knights);
    knights &= knights - 1;
    count += popcount(knightAttacks(sq) & zone);
  }
  let bishops = pos.pieces(enemy, BISHOP);
  while (bishops != 0) {
    const sq = lsb(bishops);
    bishops &= bishops - 1;
    count += popcount(bishopAttacks(sq, occ) & zone);
  }
  let rooks = pos.pieces(enemy, ROOK);
  while (rooks != 0) {
    const sq = lsb(rooks);
    rooks &= rooks - 1;
    count += popcount(rookAttacks(sq, occ) & zone);
  }
  let queens = pos.pieces(enemy, QUEEN);
  while (queens != 0) {
    const sq = lsb(queens);
    queens &= queens - 1;
    count += popcount((bishopAttacks(sq, occ) | rookAttacks(sq, occ)) & zone);
  }
  return count;
}

/** King-move distance between the two kings (1..7). */
export function kingDistance(pos: Position): i32 {
  return squareDistance(pos.kingSquare(WHITE), pos.kingSquare(BLACK));
}

/** Distance of a square from the centre: 0 on d4/e4/d5/e5, 1 on the ring around, ... 3 on the edge. */
export function centerDistance(sq: i32): i32 {
  const f = fileOf(sq);
  const r = rankOf(sq);
  const df = f < 4 ? 3 - f : f - 4;
  const dr = r < 4 ? 3 - r : r - 4;
  return df > dr ? df : dr;
}

// ------------------------------------------------------------------- piece features

/** True if `color` has bishops on both light and dark squares. */
export function bishopPair(pos: Position, color: i32): bool {
  const bishops = pos.pieces(color, BISHOP);
  return (bishops & LIGHT_SQUARES) != 0 && (bishops & DARK_SQUARES) != 0;
}

/** Number of `color` knights, bishops, rooks and queens attacked by the enemy and not defended. */
export function hanging(pos: Position, color: i32): i32 {
  const attacked = attackedSquares(pos, color ^ 1);
  const defended = attackedSquares(pos, color);
  const pieces = pos.colorBB(color) & ~pos.pieces(color, PAWN) & ~pos.pieces(color, KING);
  return popcount(pieces & attacked & ~defended);
}

// --------------------------------------------------------------- piece-square tables

/** Value of `table` for a `color` piece on `sq` (Black reads the vertically mirrored square). */
export function pst(table: StaticArray<i32>, color: i32, sq: i32): i32 {
  return table[color == WHITE ? sq : sq ^ 56];
}

/** Σ pst(table, color, sq) over all `color` pieces of `type`. */
export function pstSum(pos: Position, color: i32, type: i32, table: StaticArray<i32>): i32 {
  assert(table.length >= 64, "piece-square tables need 64 entries");
  const flip = color == WHITE ? 0 : 56;
  let total = 0;
  let pieces = pos.pieces(color, type);
  while (pieces != 0) {
    const sq = lsb(pieces);
    pieces &= pieces - 1;
    total += unchecked(table[sq ^ flip]); // safe: sq ^ flip is 0..63 and the length was checked
  }
  return total;
}

/**
 * Converts 64 values written as a board diagram — rank 8 first (a8 ... h8 on the first line,
 * a1 ... h1 on the last), the way tables are easiest to read in source code — into a LERF
 * piece-square table for pst() / pstSum(). Call it once at module level, never in evaluate().
 */
export function pstFromDiagram(diagram: StaticArray<i32>): StaticArray<i32> {
  const table = new StaticArray<i32>(64);
  for (let sq = 0; sq < 64; sq++) table[sq] = diagram[sq ^ 56];
  return table;
}
