// =====================================================================================
// eval.ts — the evaluation function
// =====================================================================================
//
// evaluate(pos) looks at a position *without searching* and returns a score in centipawns
// from WHITE's point of view (positive = good for White, 100 = one pawn). The search calls
// it at the leaves of its tree, so it has to be fast and must not allocate memory.
//
// This default evaluation is a classical "tapered hand-crafted evaluation":
//
//   * Every term has a middlegame (mg) and an endgame (eg) value. They are blended by the
//     game phase (24 = all pieces on the board ... 0 = only pawns left), see taper().
//   * Material and piece-square tables (PSTs) use the well-known "PeSTO" values by Ronald
//     Friederich, tuned for exactly this kind of evaluation.
//   * On top of that: mobility, passed / isolated / doubled pawns, the bishop pair, rooks on
//     open files, the pawn shield in front of the king, attacks on the king zone and a small
//     bonus for the side to move (tempo).
//
// Symmetry: every term is computed with the same code for White and for Black and then
// subtracted, so a colour-flipped position gets exactly the negated score. Each side's value
// is tapered separately (integer division rounds toward zero, which is symmetric).
//
// Breakdown: when `tracing` is on (cb_eval_trace), each term is reported with traceTerm so
// the editor can show a table "term / White / Black". The terms add up exactly to the result.
//
// Feel free to change anything here: weights, tables, or whole terms. The helpers come from
// evalkit.ts.

import { Position } from "./position";
import { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from "./types";
import { popcount, lsb, relativeRank } from "./bitboard";
import {
  taper, material, pstSum, pstFromDiagram, mobility, passedPawns, isolatedPawns, doubledPawns,
  bishopPair, rooksOnOpenFiles, rooksOnHalfOpenFiles, kingShield, kingZoneAttacks,
} from "./evalkit";
import { tracing, traceTerm } from "./trace";

// ------------------------------------------------------------------ material values

const PAWN_MG: i32 = 82, KNIGHT_MG: i32 = 337, BISHOP_MG: i32 = 365, ROOK_MG: i32 = 477, QUEEN_MG: i32 = 1025;
const PAWN_EG: i32 = 94, KNIGHT_EG: i32 = 281, BISHOP_EG: i32 = 297, ROOK_EG: i32 = 512, QUEEN_EG: i32 = 936;

// ------------------------------------------------------------- piece-square tables
// Written as board diagrams from White's point of view: rank 8 on the first line, rank 1 on
// the last. pstFromDiagram() turns them into LERF tables once, when the module loads.

const PAWN_PST_MG = pstFromDiagram([
     0,   0,   0,   0,   0,   0,   0,   0,
    98, 134,  61,  95,  68, 126,  34, -11,
    -6,   7,  26,  31,  65,  56,  25, -20,
   -14,  13,   6,  21,  23,  12,  17, -23,
   -27,  -2,  -5,  12,  17,   6,  10, -25,
   -26,  -4,  -4, -10,   3,   3,  33, -12,
   -35,  -1, -20, -23, -15,  24,  38, -22,
     0,   0,   0,   0,   0,   0,   0,   0,
]);
const PAWN_PST_EG = pstFromDiagram([
     0,   0,   0,   0,   0,   0,   0,   0,
   178, 173, 158, 134, 147, 132, 165, 187,
    94, 100,  85,  67,  56,  53,  82,  84,
    32,  24,  13,   5,  -2,   4,  17,  17,
    13,   9,  -3,  -7,  -7,  -8,   3,  -1,
     4,   7,  -6,   1,   0,  -5,  -1,  -8,
    13,   8,   8,  10,  13,   0,   2,  -7,
     0,   0,   0,   0,   0,   0,   0,   0,
]);
const KNIGHT_PST_MG = pstFromDiagram([
  -167, -89, -34, -49,  61, -97, -15, -107,
   -73, -41,  72,  36,  23,  62,   7,  -17,
   -47,  60,  37,  65,  84, 129,  73,   44,
    -9,  17,  19,  53,  37,  69,  18,   22,
   -13,   4,  16,  13,  28,  19,  21,   -8,
   -23,  -9,  12,  10,  19,  17,  25,  -16,
   -29, -53, -12,  -3,  -1,  18, -14,  -19,
  -105, -21, -58, -33, -17, -28, -19,  -23,
]);
const KNIGHT_PST_EG = pstFromDiagram([
   -58, -38, -13, -28, -31, -27, -63, -99,
   -25,  -8, -25,  -2,  -9, -25, -24, -52,
   -24, -20,  10,   9,  -1,  -9, -19, -41,
   -17,   3,  22,  22,  22,  11,   8, -18,
   -18,  -6,  16,  25,  16,  17,   4, -18,
   -23,  -3,  -1,  15,  10,  -3, -20, -22,
   -42, -20, -10,  -5,  -2, -20, -23, -44,
   -29, -51, -23, -15, -22, -18, -50, -64,
]);
const BISHOP_PST_MG = pstFromDiagram([
   -29,   4, -82, -37, -25, -42,   7,  -8,
   -26,  16, -18, -13,  30,  59,  18, -47,
   -16,  37,  43,  40,  35,  50,  37,  -2,
    -4,   5,  19,  50,  37,  37,   7,  -2,
    -6,  13,  13,  26,  34,  12,  10,   4,
     0,  15,  15,  15,  14,  27,  18,  10,
     4,  15,  16,   0,   7,  21,  33,   1,
   -33,  -3, -14, -21, -13, -12, -39, -21,
]);
const BISHOP_PST_EG = pstFromDiagram([
   -14, -21, -11,  -8,  -7,  -9, -17, -24,
    -8,  -4,   7, -12,  -3, -13,  -4, -14,
     2,  -8,   0,  -1,  -2,   6,   0,   4,
    -3,   9,  12,   9,  14,  10,   3,   2,
    -6,   3,  13,  19,   7,  10,  -3,  -9,
   -12,  -3,   8,  10,  13,   3,  -7, -15,
   -14, -18,  -7,  -1,   4,  -9, -15, -27,
   -23,  -9, -23,  -5,  -9, -16,  -5, -17,
]);
const ROOK_PST_MG = pstFromDiagram([
    32,  42,  32,  51,  63,   9,  31,  43,
    27,  32,  58,  62,  80,  67,  26,  44,
    -5,  19,  26,  36,  17,  45,  61,  16,
   -24, -11,   7,  26,  24,  35,  -8, -20,
   -36, -26, -12,  -1,   9,  -7,   6, -23,
   -45, -25, -16, -17,   3,   0,  -5, -33,
   -44, -16, -20,  -9,  -1,  11,  -6, -71,
   -19, -13,   1,  17,  16,   7, -37, -26,
]);
const ROOK_PST_EG = pstFromDiagram([
    13,  10,  18,  15,  12,  12,   8,   5,
    11,  13,  13,  11,  -3,   3,   8,   3,
     7,   7,   7,   5,   4,  -3,  -5,  -3,
     4,   3,  13,   1,   2,   1,  -1,   2,
     3,   5,   8,   4,  -5,  -6,  -8, -11,
    -4,   0,  -5,  -1,  -7, -12,  -8, -16,
    -6,  -6,   0,   2,  -9,  -9, -11,  -3,
    -9,   2,   3,  -1,  -5, -13,   4, -20,
]);
const QUEEN_PST_MG = pstFromDiagram([
   -28,   0,  29,  12,  59,  44,  43,  45,
   -24, -39,  -5,   1, -16,  57,  28,  54,
   -13, -17,   7,   8,  29,  56,  47,  57,
   -27, -27, -16, -16,  -1,  17,  -2,   1,
    -9, -26,  -9, -10,  -2,  -4,   3,  -3,
   -14,   2, -11,  -2,  -5,   2,  14,   5,
   -35,  -8,  11,   2,   8,  15,  -3,   1,
    -1, -18,  -9,  10, -15, -25, -31, -50,
]);
const QUEEN_PST_EG = pstFromDiagram([
    -9,  22,  22,  27,  27,  19,  10,  20,
   -17,  20,  32,  41,  58,  25,  30,   0,
   -20,   6,   9,  49,  47,  35,  19,   9,
     3,  22,  24,  45,  57,  40,  57,  36,
   -18,  28,  19,  47,  31,  34,  39,  23,
   -16, -27,  15,   6,   9,  17,  10,   5,
   -22, -23, -30, -16, -16, -23, -36, -32,
   -33, -28, -22, -43,  -5, -32, -20, -41,
]);
const KING_PST_MG = pstFromDiagram([
   -65,  23,  16, -15, -56, -34,   2,  13,
    29,  -1, -20,  -7,  -8,  -4, -38, -29,
    -9,  24,   2, -16, -20,   6,  22, -22,
   -17, -20, -12, -27, -30, -25, -14, -36,
   -49,  -1, -27, -39, -46, -44, -33, -51,
   -14, -14, -22, -46, -44, -30, -15, -27,
     1,   7,  -8, -64, -43, -16,   9,   8,
   -15,  36,  12, -54,   8, -28,  24,  14,
]);
const KING_PST_EG = pstFromDiagram([
   -74, -35, -18, -18, -11,  15,   4, -17,
   -12,  17,  14,  17,  17,  38,  23,  11,
    10,  17,  23,  15,  20,  45,  44,  13,
    -8,  22,  24,  27,  26,  33,  26,   3,
   -18,  -4,  21,  24,  27,  23,   9, -11,
   -19,  -3,  11,  21,  23,  16,   7,  -9,
   -27, -11,   4,  13,  14,   4,  -5, -17,
   -53, -34, -21, -11, -28, -14, -24, -43,
]);

// ---------------------------------------------------------------------- other weights

// Mobility: bonus per safe square, minus a typical number of squares per piece, so an
// "average" piece adds nothing on top of its material value.
const KNIGHT_MOB_MG: i32 = 4, KNIGHT_MOB_EG: i32 = 4, KNIGHT_MOB_BASE: i32 = 4;
const BISHOP_MOB_MG: i32 = 5, BISHOP_MOB_EG: i32 = 5, BISHOP_MOB_BASE: i32 = 6;
const ROOK_MOB_MG: i32 = 2, ROOK_MOB_EG: i32 = 4, ROOK_MOB_BASE: i32 = 6;
const QUEEN_MOB_MG: i32 = 1, QUEEN_MOB_EG: i32 = 2, QUEEN_MOB_BASE: i32 = 12;

// Passed pawns: bonus by relative rank (index 1 = 2nd rank ... 6 = 7th rank).
const PASSED_MG: StaticArray<i32> = [0, 0, 5, 10, 20, 35, 55, 0];
const PASSED_EG: StaticArray<i32> = [0, 10, 15, 25, 45, 75, 110, 0];

const ISOLATED_MG: i32 = -8, ISOLATED_EG: i32 = -12; // per isolated pawn
const DOUBLED_MG: i32 = -8, DOUBLED_EG: i32 = -20; // per pawn with a friendly pawn in front
const BISHOP_PAIR_MG: i32 = 30, BISHOP_PAIR_EG: i32 = 45;
const ROOK_OPEN_MG: i32 = 25, ROOK_OPEN_EG: i32 = 10; // per rook on an open file
const ROOK_HALF_OPEN_MG: i32 = 12, ROOK_HALF_OPEN_EG: i32 = 6; // per rook on a half-open file
const SHIELD_MG: i32 = 10; // per pawn in front of the king (middlegame only)
const TEMPO: i32 = 12; // bonus for the side to move

// Penalty for enemy attacks on the king zone, by number of attacks (grows quadratically:
// many attackers are much more dangerous than a single one). Halved without an enemy queen.
const KING_DANGER: StaticArray<i32> = [
  0, 0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78, 91, 105, 120, 136, 153, 171, 190, 210, 231, 253, 276,
];

// ------------------------------------------------------------------------- helpers

/**
 * Tapers one term for both sides, reports it to the trace and returns its White-POV value.
 * mgW/egW are White's middlegame/endgame values, mgB/egB Black's (positive = good for that side).
 */
@inline
function term(label: string, mgW: i32, egW: i32, mgB: i32, egB: i32, phase: i32): i32 {
  const white = taper(mgW, egW, phase);
  const black = taper(mgB, egB, phase);
  if (tracing) traceTerm(label, white, black);
  return white - black;
}

/** Σ of the piece-square table values (middlegame) of all pieces of one colour. */
function pstMg(pos: Position, color: i32): i32 {
  return pstSum(pos, color, PAWN, PAWN_PST_MG) + pstSum(pos, color, KNIGHT, KNIGHT_PST_MG) +
    pstSum(pos, color, BISHOP, BISHOP_PST_MG) + pstSum(pos, color, ROOK, ROOK_PST_MG) +
    pstSum(pos, color, QUEEN, QUEEN_PST_MG) + pstSum(pos, color, KING, KING_PST_MG);
}

/** Σ of the piece-square table values (endgame) of all pieces of one colour. */
function pstEg(pos: Position, color: i32): i32 {
  return pstSum(pos, color, PAWN, PAWN_PST_EG) + pstSum(pos, color, KNIGHT, KNIGHT_PST_EG) +
    pstSum(pos, color, BISHOP, BISHOP_PST_EG) + pstSum(pos, color, ROOK, ROOK_PST_EG) +
    pstSum(pos, color, QUEEN, QUEEN_PST_EG) + pstSum(pos, color, KING, KING_PST_EG);
}

// Mobility of one colour, relative to the typical number of squares per piece. Filled by
// computeMobility() so that the middlegame and endgame weights can share one computation.
let knightMobility = 0, bishopMobility = 0, rookMobility = 0, queenMobility = 0;

/** Counts the safe squares of each piece type of `color` (see evalkit's mobility()). */
function computeMobility(pos: Position, color: i32): void {
  knightMobility = mobility(pos, color, KNIGHT) - KNIGHT_MOB_BASE * pos.count(color, KNIGHT);
  bishopMobility = mobility(pos, color, BISHOP) - BISHOP_MOB_BASE * pos.count(color, BISHOP);
  rookMobility = mobility(pos, color, ROOK) - ROOK_MOB_BASE * pos.count(color, ROOK);
  queenMobility = mobility(pos, color, QUEEN) - QUEEN_MOB_BASE * pos.count(color, QUEEN);
}

/** Middlegame mobility score of the colour last passed to computeMobility(). */
@inline
function mobilityMg(): i32 {
  return knightMobility * KNIGHT_MOB_MG + bishopMobility * BISHOP_MOB_MG + rookMobility * ROOK_MOB_MG + queenMobility * QUEEN_MOB_MG;
}

/** Endgame mobility score of the colour last passed to computeMobility(). */
@inline
function mobilityEg(): i32 {
  return knightMobility * KNIGHT_MOB_EG + bishopMobility * BISHOP_MOB_EG + rookMobility * ROOK_MOB_EG + queenMobility * QUEEN_MOB_EG;
}

/** Σ table[relative rank] over a set of pawns of one colour (e.g. its passed pawns). */
function rankBonus(pawns: u64, color: i32, table: StaticArray<i32>): i32 {
  let total = 0;
  while (pawns != 0) {
    const sq = lsb(pawns);
    pawns &= pawns - 1;
    total += unchecked(table[relativeRank(color, sq)]);
  }
  return total;
}

/** Middlegame penalty (negative) for attacks on the king zone of `color`. */
function kingDanger(pos: Position, color: i32): i32 {
  let attacks = kingZoneAttacks(pos, color);
  if (attacks > 24) attacks = 24;
  let penalty = unchecked(KING_DANGER[attacks]);
  if (pos.count(color ^ 1, QUEEN) == 0) penalty /= 2;
  return -penalty;
}

// -------------------------------------------------------------------------- evaluate

/** Static evaluation in centipawns from WHITE's point of view (positive = good for White). */
export function evaluate(pos: Position): i32 {
  const phase = pos.phase();
  let score = 0;

  // Material and piece-square tables.
  score += term("material",
    material(pos, WHITE, PAWN_MG, KNIGHT_MG, BISHOP_MG, ROOK_MG, QUEEN_MG),
    material(pos, WHITE, PAWN_EG, KNIGHT_EG, BISHOP_EG, ROOK_EG, QUEEN_EG),
    material(pos, BLACK, PAWN_MG, KNIGHT_MG, BISHOP_MG, ROOK_MG, QUEEN_MG),
    material(pos, BLACK, PAWN_EG, KNIGHT_EG, BISHOP_EG, ROOK_EG, QUEEN_EG), phase);
  score += term("piece-square tables", pstMg(pos, WHITE), pstEg(pos, WHITE), pstMg(pos, BLACK), pstEg(pos, BLACK), phase);

  // Mobility.
  computeMobility(pos, WHITE);
  const mobilityMgW = mobilityMg();
  const mobilityEgW = mobilityEg();
  computeMobility(pos, BLACK);
  score += term("mobility", mobilityMgW, mobilityEgW, mobilityMg(), mobilityEg(), phase);

  // Pawn structure.
  const passedW = passedPawns(pos, WHITE);
  const passedB = passedPawns(pos, BLACK);
  score += term("passed pawns",
    rankBonus(passedW, WHITE, PASSED_MG), rankBonus(passedW, WHITE, PASSED_EG),
    rankBonus(passedB, BLACK, PASSED_MG), rankBonus(passedB, BLACK, PASSED_EG), phase);
  const isolatedW = popcount(isolatedPawns(pos, WHITE));
  const isolatedB = popcount(isolatedPawns(pos, BLACK));
  score += term("isolated pawns",
    isolatedW * ISOLATED_MG, isolatedW * ISOLATED_EG, isolatedB * ISOLATED_MG, isolatedB * ISOLATED_EG, phase);
  const doubledW = popcount(doubledPawns(pos, WHITE));
  const doubledB = popcount(doubledPawns(pos, BLACK));
  score += term("doubled pawns",
    doubledW * DOUBLED_MG, doubledW * DOUBLED_EG, doubledB * DOUBLED_MG, doubledB * DOUBLED_EG, phase);

  // Pieces.
  const pairW = bishopPair(pos, WHITE) ? 1 : 0;
  const pairB = bishopPair(pos, BLACK) ? 1 : 0;
  score += term("bishop pair",
    pairW * BISHOP_PAIR_MG, pairW * BISHOP_PAIR_EG, pairB * BISHOP_PAIR_MG, pairB * BISHOP_PAIR_EG, phase);
  const openW = rooksOnOpenFiles(pos, WHITE);
  const openB = rooksOnOpenFiles(pos, BLACK);
  const halfW = rooksOnHalfOpenFiles(pos, WHITE);
  const halfB = rooksOnHalfOpenFiles(pos, BLACK);
  score += term("rooks on open files",
    openW * ROOK_OPEN_MG + halfW * ROOK_HALF_OPEN_MG, openW * ROOK_OPEN_EG + halfW * ROOK_HALF_OPEN_EG,
    openB * ROOK_OPEN_MG + halfB * ROOK_HALF_OPEN_MG, openB * ROOK_OPEN_EG + halfB * ROOK_HALF_OPEN_EG, phase);

  // King safety (middlegame terms; the endgame value is 0).
  score += term("king shield", kingShield(pos, WHITE) * SHIELD_MG, 0, kingShield(pos, BLACK) * SHIELD_MG, 0, phase);
  score += term("king attacks", kingDanger(pos, WHITE), 0, kingDanger(pos, BLACK), 0, phase);

  // Tempo: a small bonus for the side to move.
  const tempoW = pos.side == WHITE ? TEMPO : 0;
  const tempoB = pos.side == BLACK ? TEMPO : 0;
  score += term("tempo", tempoW, tempoW, tempoB, tempoB, phase);

  return score;
}
