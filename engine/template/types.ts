// =====================================================================================
// types.ts — the engine's basic vocabulary
// =====================================================================================
//
// Everything else in the engine builds on the definitions in this file:
//
//   * colours and piece types, and how they combine into a "piece code",
//   * square numbering (and named constants A1 ... H8),
//   * the 16-bit move encoding and its helper functions,
//   * the special score values used by the search (mate scores, infinity).
//
// They are plain `i32` constants and tiny inline functions, so using them costs nothing
// at run time.
//
// Square numbering is "LERF" (Little-Endian Rank-File):
//
//      8 | 56 57 58 59 60 61 62 63
//      7 | 48 49 50 51 52 53 54 55
//      6 | 40 41 42 43 44 45 46 47
//      5 | 32 33 34 35 36 37 38 39
//      4 | 24 25 26 27 28 29 30 31
//      3 | 16 17 18 19 20 21 22 23
//      2 |  8  9 10 11 12 13 14 15
//      1 |  0  1  2  3  4  5  6  7
//        +------------------------
//           a  b  c  d  e  f  g  h
//
// so `file = sq & 7` (0 = a-file) and `rank = sq >> 3` (0 = 1st rank).

// ---------------------------------------------------------------------------- colours

/** The side that moves first. Flip a colour with `color ^ 1`. */
export const WHITE: i32 = 0;
/** The side that moves second. */
export const BLACK: i32 = 1;

// ------------------------------------------------------------------------ piece types

export const PAWN: i32 = 0;
export const KNIGHT: i32 = 1;
export const BISHOP: i32 = 2;
export const ROOK: i32 = 3;
export const QUEEN: i32 = 4;
export const KING: i32 = 5;

/**
 * Marker for "no piece": stored on empty squares of the mailbox board and used as
 * "nothing was captured". Piece codes 0..11 are real pieces (see `makePiece`).
 */
export const NO_PIECE: i32 = 12;

/** Marker for "no square" (for example: no en-passant square). */
export const NO_SQUARE: i32 = 64;

/**
 * Combines a colour and a piece type into a piece code:
 * white pawn .. white king = 0..5, black pawn .. black king = 6..11.
 */
@inline
export function makePiece(color: i32, type: i32): i32 {
  return color * 6 + type;
}

/** Colour (WHITE / BLACK) of a piece code 0..11. Not meaningful for NO_PIECE. */
@inline
export function pieceColor(piece: i32): i32 {
  return piece >= 6 ? BLACK : WHITE;
}

/** Piece type (PAWN .. KING) of a piece code 0..11. Returns 6 for NO_PIECE. */
@inline
export function pieceType(piece: i32): i32 {
  return piece >= 6 ? piece - 6 : piece;
}

/** Piece letters indexed by piece code (upper case = White), as used in FEN. */
export const PIECE_CHARS: string = "PNBRQKpnbrqk";

// ---------------------------------------------------------------------------- squares

export const A1: i32 = 0,  B1: i32 = 1,  C1: i32 = 2,  D1: i32 = 3,  E1: i32 = 4,  F1: i32 = 5,  G1: i32 = 6,  H1: i32 = 7;
export const A2: i32 = 8,  B2: i32 = 9,  C2: i32 = 10, D2: i32 = 11, E2: i32 = 12, F2: i32 = 13, G2: i32 = 14, H2: i32 = 15;
export const A3: i32 = 16, B3: i32 = 17, C3: i32 = 18, D3: i32 = 19, E3: i32 = 20, F3: i32 = 21, G3: i32 = 22, H3: i32 = 23;
export const A4: i32 = 24, B4: i32 = 25, C4: i32 = 26, D4: i32 = 27, E4: i32 = 28, F4: i32 = 29, G4: i32 = 30, H4: i32 = 31;
export const A5: i32 = 32, B5: i32 = 33, C5: i32 = 34, D5: i32 = 35, E5: i32 = 36, F5: i32 = 37, G5: i32 = 38, H5: i32 = 39;
export const A6: i32 = 40, B6: i32 = 41, C6: i32 = 42, D6: i32 = 43, E6: i32 = 44, F6: i32 = 45, G6: i32 = 46, H6: i32 = 47;
export const A7: i32 = 48, B7: i32 = 49, C7: i32 = 50, D7: i32 = 51, E7: i32 = 52, F7: i32 = 53, G7: i32 = 54, H7: i32 = 55;
export const A8: i32 = 56, B8: i32 = 57, C8: i32 = 58, D8: i32 = 59, E8: i32 = 60, F8: i32 = 61, G8: i32 = 62, H8: i32 = 63;

/** UCI name of a square, e.g. `squareName(E4) == "e4"`. Allocates a string (not for hot paths). */
export function squareName(sq: i32): string {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 3));
}

// --------------------------------------------------------------------- castling rights

/** White may castle king-side (e1g1). */
export const CASTLE_WK: i32 = 1;
/** White may castle queen-side (e1c1). */
export const CASTLE_WQ: i32 = 2;
/** Black may castle king-side (e8g8). */
export const CASTLE_BK: i32 = 4;
/** Black may castle queen-side (e8c8). */
export const CASTLE_BQ: i32 = 8;

// ---------------------------------------------------------------------- score values

/** Score of "checkmate right now". A mate found `ply` plies from the root scores ±(MATE - ply). */
export const MATE: i32 = 32000;
/** Any score with |score| > MATE_BOUND is a mate score. Normal evaluations stay below it. */
export const MATE_BOUND: i32 = 31000;
/** Larger than any real score; used for the initial alpha-beta window. */
export const INFINITE: i32 = 32001;
/** Maximum search depth in plies (array sizes in the search depend on it). */
export const MAX_PLY: i32 = 128;

// ------------------------------------------------------------------------------ moves
//
// A move is an i32 holding 16 bits:
//
//     bits  0..5   from square
//     bits  6..11  to square
//     bits 12..15  flag
//
// Flags:  0 quiet move            1 double pawn push
//         2 king-side castle      3 queen-side castle
//         4 capture               5 en-passant capture
//         8..11  promotion to N/B/R/Q
//        12..15  capture + promotion to N/B/R/Q
//
// Bit 2 of the flag (value 4) means "capture", bit 3 (value 8) means "promotion"; for
// promotions the low two bits select the piece (0 = knight ... 3 = queen).
// Castling is encoded as the king's move (e1g1, e1c1, e8g8, e8c8).

/** "No move". Never a legal move (it would be a1a1). */
export const MOVE_NONE: i32 = 0;

export const FLAG_QUIET: i32 = 0;
export const FLAG_DOUBLE_PUSH: i32 = 1;
export const FLAG_KING_CASTLE: i32 = 2;
export const FLAG_QUEEN_CASTLE: i32 = 3;
export const FLAG_CAPTURE: i32 = 4;
export const FLAG_EN_PASSANT: i32 = 5;
/** Promotion flags are FLAG_PROMOTION + (pieceType - KNIGHT), i.e. 8..11. */
export const FLAG_PROMOTION: i32 = 8;
/** Capture-promotion flags are FLAG_PROMOTION_CAPTURE + (pieceType - KNIGHT), i.e. 12..15. */
export const FLAG_PROMOTION_CAPTURE: i32 = 12;

/** Builds a move from its parts. */
@inline
export function encodeMove(from: i32, to: i32, flag: i32): i32 {
  return from | (to << 6) | (flag << 12);
}

/**
 * Same as `encodeMove` (the name used in the "Conventions" section of
 * docs/ENGINE_TEMPLATE.md). Not to be confused with `Position.makeMove`, which plays a move.
 */
@inline
export function makeMove(from: i32, to: i32, flag: i32): i32 {
  return encodeMove(from, to, flag);
}

/** Square the move starts from. */
@inline
export function moveFrom(m: i32): i32 {
  return m & 63;
}

/** Square the move goes to (for castling: the king's destination). */
@inline
export function moveTo(m: i32): i32 {
  return (m >> 6) & 63;
}

/** The 4-bit flag (see the table above). */
@inline
export function moveFlag(m: i32): i32 {
  return (m >> 12) & 15;
}

/** True for captures, en-passant captures and capture-promotions. */
@inline
export function isCapture(m: i32): bool {
  return (m & (FLAG_CAPTURE << 12)) != 0;
}

/** True for promotions (with or without capture). */
@inline
export function isPromotion(m: i32): bool {
  return (m & (FLAG_PROMOTION << 12)) != 0;
}

/** Piece type a pawn promotes to (KNIGHT..QUEEN). Only meaningful when `isPromotion(m)`. */
@inline
export function promotionType(m: i32): i32 {
  return ((m >> 12) & 3) + KNIGHT;
}

/** True for both castling moves. */
@inline
export function isCastle(m: i32): bool {
  const flag = moveFlag(m);
  return flag == FLAG_KING_CASTLE || flag == FLAG_QUEEN_CASTLE;
}

/** UCI text of a move, e.g. "e2e4", "e7e8q", "e1g1"; "0000" for MOVE_NONE. Allocates. */
export function moveToUci(m: i32): string {
  if (m == MOVE_NONE) return "0000";
  let s = squareName(moveFrom(m)) + squareName(moveTo(m));
  if (isPromotion(m)) s += "nbrq".charAt(promotionType(m) - KNIGHT);
  return s;
}
