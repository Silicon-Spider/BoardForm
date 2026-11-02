// =====================================================================================
// eval.ts (NNUE variant) — evaluation by the engine's neural network
// =====================================================================================
//
// This evaluation hands the position to the NNUE network attached to the engine (see
// nnue.ts and docs/NNUE_FORMAT.md). The network scores the position from the point of view
// of the side to move; the search wants White's point of view, so the sign is flipped when
// Black is to move.
//
// Without a network (none attached yet, or the file was rejected) a small classical
// evaluation takes over, so the engine still plays sensibly: material plus piece-square
// tables. The editor's test panel shows which of the two is in use ("NNUE" or
// "Fallback (no network)").
//
// You can add your own terms on top of the network. For example, to make the engine like
// the bishop pair a little more than the network does, add `bishopPair` to the "./evalkit"
// import below and replace the last line of evaluate() ("return white;") with:
//
//     const pairW = bishopPair(pos, WHITE) ? 20 : 0;
//     const pairB = bishopPair(pos, BLACK) ? 20 : 0;
//     if (tracing) traceTerm("bishop pair", pairW, pairB);
//     return white + pairW - pairB;

import { Position } from "./position";
import { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING } from "./types";
import { taper, material, pstSum, pstFromDiagram } from "./evalkit";
import { nnueReady, nnueEvaluate } from "./nnue";
import { tracing, traceTerm } from "./trace";

/** Static evaluation in centipawns from WHITE's point of view (positive = good for White). */
export function evaluate(pos: Position): i32 {
  if (!nnueReady()) return fallbackEvaluate(pos);

  const stm = nnueEvaluate(pos); // side to move's point of view
  const white = pos.side == WHITE ? stm : -stm;
  // One term: shown on the side the network favours.
  if (tracing) traceTerm("NNUE", white > 0 ? white : 0, white < 0 ? -white : 0);
  return white;
}

// ======================================================================= fallback
// Material and piece-square tables from Tomasz Michniewski's "Simplified Evaluation
// Function" (chessprogramming.org). The king has a middlegame table (stay sheltered) and an
// endgame table (come to the centre), blended by the game phase.

const PAWN_VALUE: i32 = 100, KNIGHT_VALUE: i32 = 320, BISHOP_VALUE: i32 = 330;
const ROOK_VALUE: i32 = 500, QUEEN_VALUE: i32 = 900;

// Board diagrams from White's point of view: rank 8 on the first line, rank 1 on the last.
const PAWN_PST = pstFromDiagram([
   0,   0,   0,   0,   0,   0,   0,   0,
  50,  50,  50,  50,  50,  50,  50,  50,
  10,  10,  20,  30,  30,  20,  10,  10,
   5,   5,  10,  25,  25,  10,   5,   5,
   0,   0,   0,  20,  20,   0,   0,   0,
   5,  -5, -10,   0,   0, -10,  -5,   5,
   5,  10,  10, -20, -20,  10,  10,   5,
   0,   0,   0,   0,   0,   0,   0,   0,
]);
const KNIGHT_PST = pstFromDiagram([
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
]);
const BISHOP_PST = pstFromDiagram([
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
]);
const ROOK_PST = pstFromDiagram([
   0,   0,   0,   0,   0,   0,   0,   0,
   5,  10,  10,  10,  10,  10,  10,   5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
  -5,   0,   0,   0,   0,   0,   0,  -5,
   0,   0,   0,   5,   5,   0,   0,   0,
]);
const QUEEN_PST = pstFromDiagram([
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,   5,   5,   5,   0, -10,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   5,   5,   5,   5,   5,   0, -10,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
]);
const KING_MG_PST = pstFromDiagram([
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
]);
const KING_EG_PST = pstFromDiagram([
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
]);

/** Material + piece-square tables of one side (positive = good for that side). */
function fallbackSide(pos: Position, color: i32, phase: i32): i32 {
  return material(pos, color, PAWN_VALUE, KNIGHT_VALUE, BISHOP_VALUE, ROOK_VALUE, QUEEN_VALUE) +
    pstSum(pos, color, PAWN, PAWN_PST) + pstSum(pos, color, KNIGHT, KNIGHT_PST) +
    pstSum(pos, color, BISHOP, BISHOP_PST) + pstSum(pos, color, ROOK, ROOK_PST) +
    pstSum(pos, color, QUEEN, QUEEN_PST) +
    taper(pstSum(pos, color, KING, KING_MG_PST), pstSum(pos, color, KING, KING_EG_PST), phase);
}

/** The evaluation used while no network is loaded (White's point of view). */
function fallbackEvaluate(pos: Position): i32 {
  const phase = pos.phase();
  const white = fallbackSide(pos, WHITE, phase);
  const black = fallbackSide(pos, BLACK, phase);
  if (tracing) traceTerm("Fallback (no network)", white, black);
  return white - black;
}
