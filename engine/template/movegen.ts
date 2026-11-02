// =====================================================================================
// movegen.ts — legal move generation and perft
// =====================================================================================
//
// The generator produces only *legal* moves, so the search never has to make a move just to
// find out that it leaves the king in check. It works like this:
//
//   1. Find the `checkers` (enemy pieces attacking our king).
//   2. King moves: any adjacent square that is not ours and not attacked. The attack test
//      removes our king from the board first, so the king cannot "hide" behind itself when
//      stepping away from a slider along the line of attack.
//   3. With two checkers only king moves are legal.
//   4. With one checker, other pieces must capture it or block the line between it and our
//      king: all their destinations are restricted to a `mask`.
//   5. Pinned pieces (the only piece between our king and an enemy slider) may only move
//      along the pin line.
//   6. En passant is checked by simulating the capture on the occupancy bitboard; this covers
//      the famous case where both pawns disappear from a rank and expose the king to a rook.
//   7. Castling: rights present, squares between king and rook empty, king not in check and
//      not passing through or landing on an attacked square.
//
// Moves are written into a caller-provided StaticArray<i32> starting at index `start`; the
// functions return the index after the last move. The search gives every ply its own slice
// of MAX_MOVES entries, so no allocation happens during the search.

import { Position } from "./position";
import {
  WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, NO_SQUARE,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
  B1, C1, D1, E1, F1, G1, B8, C8, D8, E8, F8, G8,
  FLAG_QUIET, FLAG_DOUBLE_PUSH, FLAG_KING_CASTLE, FLAG_QUEEN_CASTLE, FLAG_CAPTURE, FLAG_EN_PASSANT,
  FLAG_PROMOTION, FLAG_PROMOTION_CAPTURE, encodeMove,
} from "./types";
import {
  sqBB, lsb, pawnAttacks, knightAttacks, kingAttacks, bishopAttacks, rookAttacks,
  betweenBB, lineBB, RANK_1, RANK_3, RANK_6, RANK_8,
  shiftNorthEast, shiftNorthWest, shiftSouthEast, shiftSouthWest,
} from "./bitboard";

/** Size of one move-list slice. No legal chess position has more than 218 moves. */
export const MAX_MOVES: i32 = 256;

/** Writes all legal moves of `pos` into `list` from index `start`; returns the end index. */
export function generateMoves(pos: Position, list: StaticArray<i32>, start: i32): i32 {
  return generate(pos, list, start, true);
}

/**
 * "Noisy" moves for quiescence search: legal captures (including en passant) and promotions
 * to a queen (with or without capture). When the side to move is in check this returns all
 * legal moves instead, because every check evasion must be considered.
 */
export function generateNoisy(pos: Position, list: StaticArray<i32>, start: i32): i32 {
  return generate(pos, list, start, pos.inCheck());
}

/** Number of legal moves in the position. */
export function countLegalMoves(pos: Position): i32 {
  return generate(pos, COUNT_BUFFER, 0, true);
}
const COUNT_BUFFER = new StaticArray<i32>(MAX_MOVES);

/** True if the side to move has at least one legal move. */
export function hasLegalMove(pos: Position): bool {
  return countLegalMoves(pos) > 0;
}

/**
 * The generator. `all` = true: every legal move. `all` = false: captures and queen
 * promotions only (only used when not in check).
 */
function generate(pos: Position, list: StaticArray<i32>, start: i32, all: bool): i32 {
  let n = start;
  const us = pos.side;
  const them = us ^ 1;
  const own = pos.colorBB(us);
  const enemy = pos.colorBB(them);
  const occ = own | enemy;
  const ksq = pos.kingSquare(us);

  const enemyPawns = pos.pieces(them, PAWN);
  const enemyKnights = pos.pieces(them, KNIGHT);
  const enemyQueens = pos.pieces(them, QUEEN);
  const enemyDiagonal = pos.pieces(them, BISHOP) | enemyQueens; // bishops + queens
  const enemyStraight = pos.pieces(them, ROOK) | enemyQueens; // rooks + queens
  const enemyKing = pos.pieces(them, KING);

  const checkers = (pawnAttacks(us, ksq) & enemyPawns) | (knightAttacks(ksq) & enemyKnights) |
    (bishopAttacks(ksq, occ) & enemyDiagonal) | (rookAttacks(ksq, occ) & enemyStraight);

  // ---- 1. King moves (tested with the king lifted off the board).
  const occWithoutKing = occ ^ sqBB(ksq);
  let kingTargets = kingAttacks(ksq) & (all ? ~own : enemy);
  while (kingTargets != 0) {
    const to = lsb(kingTargets);
    kingTargets &= kingTargets - 1;
    const attacked = (pawnAttacks(us, to) & enemyPawns) | (knightAttacks(to) & enemyKnights) |
      (kingAttacks(to) & enemyKing) | (bishopAttacks(to, occWithoutKing) & enemyDiagonal) |
      (rookAttacks(to, occWithoutKing) & enemyStraight);
    if (attacked == 0) {
      unchecked(list[n] = encodeMove(ksq, to, (enemy & sqBB(to)) != 0 ? FLAG_CAPTURE : FLAG_QUIET));
      n++;
    }
  }

  // ---- 2. Double check: only the king can move.
  if ((checkers & (checkers - 1)) != 0) return n;

  // ---- 3. Destination mask for all other pieces.
  let mask: u64 = ~own;
  if (checkers != 0) mask = betweenBB(ksq, lsb(checkers)) | checkers; // block or capture
  const pieceMask = all ? mask : mask & enemy;

  // ---- 4. Pinned pieces: our only piece between our king and an enemy slider.
  let pinned: u64 = 0;
  let snipers = (rookAttacks(ksq, 0) & enemyStraight) | (bishopAttacks(ksq, 0) & enemyDiagonal);
  while (snipers != 0) {
    const s = lsb(snipers);
    snipers &= snipers - 1;
    const blockers = betweenBB(ksq, s) & occ;
    if (blockers != 0 && (blockers & (blockers - 1)) == 0) pinned |= blockers & own;
  }

  // ---- 5. Knights (a pinned knight can never move).
  let knights = pos.pieces(us, KNIGHT) & ~pinned;
  while (knights != 0) {
    const from = lsb(knights);
    knights &= knights - 1;
    n = addPieceMoves(list, n, from, knightAttacks(from) & pieceMask, enemy);
  }

  // ---- 6. Bishops, rooks and queens.
  const queens = pos.pieces(us, QUEEN);
  let diagonalMovers = pos.pieces(us, BISHOP) | queens;
  while (diagonalMovers != 0) {
    const from = lsb(diagonalMovers);
    diagonalMovers &= diagonalMovers - 1;
    let targets = bishopAttacks(from, occ) & pieceMask;
    if ((pinned & sqBB(from)) != 0) targets &= lineBB(ksq, from);
    n = addPieceMoves(list, n, from, targets, enemy);
  }
  let straightMovers = pos.pieces(us, ROOK) | queens;
  while (straightMovers != 0) {
    const from = lsb(straightMovers);
    straightMovers &= straightMovers - 1;
    let targets = rookAttacks(from, occ) & pieceMask;
    if ((pinned & sqBB(from)) != 0) targets &= lineBB(ksq, from);
    n = addPieceMoves(list, n, from, targets, enemy);
  }

  // ---- 7. Pawns.
  const pawns = pos.pieces(us, PAWN);
  const white = us == WHITE;
  const up = white ? 8 : -8;
  const promotionRank = white ? RANK_8 : RANK_1;
  const empty = ~occ;
  // Non-promotion pushes are quiet moves, so in "noisy" mode only promotions are pushed.
  const pushMask = all ? mask : mask & promotionRank;
  const captureMask = mask & enemy;

  // Single pushes; double pushes start from the squares a single push reached on rank 3/6.
  const single = (white ? pawns << 8 : pawns >> 8) & empty;
  const thirdRank = white ? RANK_3 : RANK_6;
  let doubles = (white ? (single & thirdRank) << 8 : (single & thirdRank) >> 8) & empty & pushMask;
  let singles = single & pushMask;
  while (singles != 0) {
    const to = lsb(singles);
    singles &= singles - 1;
    const from = to - up;
    if ((pinned & sqBB(from)) != 0 && (lineBB(ksq, from) & sqBB(to)) == 0) continue;
    if ((sqBB(to) & promotionRank) != 0) n = addPromotions(list, n, from, to, FLAG_PROMOTION, all);
    else {
      unchecked(list[n] = encodeMove(from, to, FLAG_QUIET));
      n++;
    }
  }
  while (doubles != 0) {
    const to = lsb(doubles);
    doubles &= doubles - 1;
    const from = to - 2 * up;
    if ((pinned & sqBB(from)) != 0 && (lineBB(ksq, from) & sqBB(to)) == 0) continue;
    unchecked(list[n] = encodeMove(from, to, FLAG_DOUBLE_PUSH));
    n++;
  }

  // Captures towards the a-file side ("west") and the h-file side ("east").
  let westCaptures = (white ? shiftNorthWest(pawns) : shiftSouthWest(pawns)) & captureMask;
  let eastCaptures = (white ? shiftNorthEast(pawns) : shiftSouthEast(pawns)) & captureMask;
  const westDelta = white ? 7 : -9; // to - from
  const eastDelta = white ? 9 : -7;
  while (westCaptures != 0) {
    const to = lsb(westCaptures);
    westCaptures &= westCaptures - 1;
    n = addPawnCapture(list, n, to - westDelta, to, ksq, pinned, promotionRank, all);
  }
  while (eastCaptures != 0) {
    const to = lsb(eastCaptures);
    eastCaptures &= eastCaptures - 1;
    n = addPawnCapture(list, n, to - eastDelta, to, ksq, pinned, promotionRank, all);
  }

  // En passant: simulate the capture and verify our king is not attacked afterwards.
  const ep = pos.epSquare;
  if (ep != NO_SQUARE) {
    const capturedSq = ep ^ 8; // the pawn that double-pushed stands behind the target square
    let candidates = pawnAttacks(them, ep) & pawns;
    while (candidates != 0) {
      const from = lsb(candidates);
      candidates &= candidates - 1;
      const after = (occ ^ sqBB(from) ^ sqBB(capturedSq)) | sqBB(ep);
      const attackers = (rookAttacks(ksq, after) & enemyStraight) | (bishopAttacks(ksq, after) & enemyDiagonal) |
        (knightAttacks(ksq) & enemyKnights) | (pawnAttacks(us, ksq) & enemyPawns & ~sqBB(capturedSq));
      if (attackers == 0) {
        unchecked(list[n] = encodeMove(from, ep, FLAG_EN_PASSANT));
        n++;
      }
    }
  }

  // ---- 8. Castling (never out of, through or into check).
  if (all && checkers == 0) {
    const rights = pos.castling;
    if (white) {
      if ((rights & CASTLE_WK) != 0 && (occ & (sqBB(F1) | sqBB(G1))) == 0 &&
        !pos.isAttacked(F1, them) && !pos.isAttacked(G1, them)) {
        unchecked(list[n] = encodeMove(E1, G1, FLAG_KING_CASTLE));
        n++;
      }
      if ((rights & CASTLE_WQ) != 0 && (occ & (sqBB(B1) | sqBB(C1) | sqBB(D1))) == 0 &&
        !pos.isAttacked(D1, them) && !pos.isAttacked(C1, them)) {
        unchecked(list[n] = encodeMove(E1, C1, FLAG_QUEEN_CASTLE));
        n++;
      }
    } else {
      if ((rights & CASTLE_BK) != 0 && (occ & (sqBB(F8) | sqBB(G8))) == 0 &&
        !pos.isAttacked(F8, them) && !pos.isAttacked(G8, them)) {
        unchecked(list[n] = encodeMove(E8, G8, FLAG_KING_CASTLE));
        n++;
      }
      if ((rights & CASTLE_BQ) != 0 && (occ & (sqBB(B8) | sqBB(C8) | sqBB(D8))) == 0 &&
        !pos.isAttacked(D8, them) && !pos.isAttacked(C8, them)) {
        unchecked(list[n] = encodeMove(E8, C8, FLAG_QUEEN_CASTLE));
        n++;
      }
    }
  }
  return n;
}

/** Adds a move from `from` to every square of `targets` (captures where an enemy piece stands). */
@inline
function addPieceMoves(list: StaticArray<i32>, n: i32, from: i32, targets: u64, enemy: u64): i32 {
  while (targets != 0) {
    const to = lsb(targets);
    targets &= targets - 1;
    unchecked(list[n] = encodeMove(from, to, (enemy & sqBB(to)) != 0 ? FLAG_CAPTURE : FLAG_QUIET));
    n++;
  }
  return n;
}

/** Adds the promotions of one pawn move: queen first, then (if `all`) rook, bishop, knight. */
@inline
function addPromotions(list: StaticArray<i32>, n: i32, from: i32, to: i32, baseFlag: i32, all: bool): i32 {
  unchecked(list[n] = encodeMove(from, to, baseFlag + (QUEEN - KNIGHT)));
  n++;
  if (all) {
    unchecked(list[n] = encodeMove(from, to, baseFlag + (ROOK - KNIGHT)));
    unchecked(list[n + 1] = encodeMove(from, to, baseFlag + (BISHOP - KNIGHT)));
    unchecked(list[n + 2] = encodeMove(from, to, baseFlag));
    n += 3;
  }
  return n;
}

/** Adds a pawn capture (or capture-promotions) after checking the pin restriction. */
@inline
function addPawnCapture(list: StaticArray<i32>, n: i32, from: i32, to: i32, ksq: i32, pinned: u64,
  promotionRank: u64, all: bool): i32 {
  if ((pinned & sqBB(from)) != 0 && (lineBB(ksq, from) & sqBB(to)) == 0) return n;
  if ((sqBB(to) & promotionRank) != 0) return addPromotions(list, n, from, to, FLAG_PROMOTION_CAPTURE, all);
  unchecked(list[n] = encodeMove(from, to, FLAG_CAPTURE));
  return n + 1;
}

// ---------------------------------------------------------------------------- perft
//
// perft(depth) counts the leaf nodes of the legal move tree. Comparing the numbers with known
// values is the standard way to prove a move generator correct. At depth 1 we simply count
// the generated moves ("bulk counting") instead of making each of them.

const PERFT_MAX_DEPTH: i32 = 32;
const PERFT_MOVES = new StaticArray<i32>(MAX_MOVES * PERFT_MAX_DEPTH);

/** Number of leaf nodes of the legal move tree of the given depth (depth is capped at 32). */
export function perft(pos: Position, depth: i32): u64 {
  if (depth > PERFT_MAX_DEPTH) depth = PERFT_MAX_DEPTH;
  return perftRecursive(pos, depth, 0);
}

function perftRecursive(pos: Position, depth: i32, ply: i32): u64 {
  if (depth <= 0) return 1;
  const start = ply * MAX_MOVES;
  const end = generateMoves(pos, PERFT_MOVES, start);
  if (depth == 1) return <u64>(end - start);
  let nodes: u64 = 0;
  for (let i = start; i < end; i++) {
    pos.makeMove(unchecked(PERFT_MOVES[i]));
    nodes += perftRecursive(pos, depth - 1, ply + 1);
    pos.unmakeMove();
  }
  return nodes;
}
