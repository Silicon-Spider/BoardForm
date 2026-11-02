// =====================================================================================
// position.ts — the chess position: board state, FEN, making and unmaking moves
// =====================================================================================
//
// The board is stored twice, because different questions are fastest in different forms:
//
//   * bitboards  — one u64 per piece code (12) and per colour (2): "where are the white
//                  knights?", "which squares are occupied?"
//   * a mailbox  — `board[sq]` = piece code on that square (or NO_PIECE): "what is on e4?"
//
// Every move is played with `makeMove(m)` and taken back with `unmakeMove()`. Before a move
// is made, everything that cannot be recomputed cheaply (castling rights, en-passant square,
// fifty-move counter, hash key, the captured piece) is pushed on an *undo stack*; unmaking
// pops it again. The same stack holds the game history set up by cb_position, which is what
// makes repetition detection see positions from before the search started.
//
// The position also maintains a Zobrist hash `key`: a 64-bit fingerprint built by XOR-ing a
// random number for every (piece, square) plus side-to-move, castling rights and the
// en-passant file. XOR is its own inverse, so the key is updated incrementally in makeMove.
//
// Conventions: colours WHITE = 0 / BLACK = 1, piece codes `color * 6 + type`, LERF squares
// (see types.ts). Moves passed to makeMove must be legal (see movegen.ts).

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, NO_PIECE, NO_SQUARE, MAX_PLY, MOVE_NONE,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ, PIECE_CHARS,
  A1, E1, H1, A8, E8, H8,
  FLAG_DOUBLE_PUSH, FLAG_KING_CASTLE, FLAG_QUEEN_CASTLE, FLAG_EN_PASSANT,
  makePiece, pieceColor, pieceType, moveFrom, moveTo, moveFlag, isCapture, isPromotion, promotionType,
  squareName,
} from "./types";
import {
  sqBB, popcount, lsb, pawnAttacks, knightAttacks, kingAttacks, bishopAttacks, rookAttacks,
  LIGHT_SQUARES, DARK_SQUARES,
} from "./bitboard";
import { generateMoves, MAX_MOVES } from "./movegen";

/** The standard starting position. */
export const START_FEN: string = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Number of game plies the undo stack keeps for repetition detection. Longer move lists are
 * compacted (see `compactHistory`); only the part since the last capture or pawn move matters.
 */
export const HISTORY_CAPACITY: i32 = 2048;
const STACK_SIZE: i32 = HISTORY_CAPACITY + MAX_PLY + 64;

// ------------------------------------------------------------------------ Zobrist keys

const PIECE_KEYS = new StaticArray<u64>(12 * 64); // [piece * 64 + sq]
const CASTLE_KEYS = new StaticArray<u64>(16); // [castling rights mask]
const EP_KEYS = new StaticArray<u64>(8); // [file of the en-passant square]
let SIDE_KEY: u64 = 0; // XOR-ed in when Black is to move

/**
 * CASTLE_MASK[sq]: castling rights that survive a move from or to `sq`. Moving the king or a
 * rook (or capturing a rook on its home square) removes the corresponding rights.
 */
const CASTLE_MASK = new StaticArray<i32>(64);

let zobristReady = false;

/** Fills the Zobrist key tables and castling masks. Called once by cb_init. */
export function initPosition(): void {
  if (zobristReady) return;
  zobristReady = true;
  // splitmix64 with a fixed seed: the keys are the same in every run.
  let seed: u64 = 0x9E3779B97F4A7C15;
  for (let i = 0; i < 12 * 64; i++) {
    seed += 0x9E3779B97F4A7C15;
    PIECE_KEYS[i] = mix64(seed);
  }
  for (let i = 0; i < 16; i++) {
    seed += 0x9E3779B97F4A7C15;
    CASTLE_KEYS[i] = mix64(seed);
  }
  for (let i = 0; i < 8; i++) {
    seed += 0x9E3779B97F4A7C15;
    EP_KEYS[i] = mix64(seed);
  }
  seed += 0x9E3779B97F4A7C15;
  SIDE_KEY = mix64(seed);

  for (let sq = 0; sq < 64; sq++) CASTLE_MASK[sq] = 15;
  CASTLE_MASK[A1] = 15 & ~CASTLE_WQ;
  CASTLE_MASK[H1] = 15 & ~CASTLE_WK;
  CASTLE_MASK[E1] = 15 & ~(CASTLE_WK | CASTLE_WQ);
  CASTLE_MASK[A8] = 15 & ~CASTLE_BQ;
  CASTLE_MASK[H8] = 15 & ~CASTLE_BK;
  CASTLE_MASK[E8] = 15 & ~(CASTLE_BK | CASTLE_BQ);
}

function mix64(x: u64): u64 {
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EB;
  return x ^ (x >> 31);
}

@inline
function pieceKey(piece: i32, sq: i32): u64 {
  return unchecked(PIECE_KEYS[(piece << 6) + sq]);
}

// Scratch space for FEN parsing and move lookup (not used by the search).
const PARSE_BOARD = new StaticArray<i32>(64);
const LOOKUP_MOVES = new StaticArray<i32>(MAX_MOVES);

// ============================================================================ Position

export class Position {
  /** Side to move: WHITE or BLACK. */
  side: i32 = WHITE;
  /** Castling rights: a combination of CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ. */
  castling: i32 = 0;
  /**
   * En-passant target square (the square the double-pushed pawn skipped), or NO_SQUARE.
   * It is only set when an enemy pawn could actually capture there, which keeps the hash
   * key identical for positions that only differ by an unusable en-passant square.
   */
  epSquare: i32 = NO_SQUARE;
  /** Fifty-move counter: plies since the last capture or pawn move. */
  halfmove: i32 = 0;
  /** Full-move number (starts at 1, incremented after Black moves). */
  fullmove: i32 = 1;
  /** Zobrist hash of the position. */
  key: u64 = 0;
  /** Plies made since the last setFen (search depth bookkeeping). */
  ply: i32 = 0;

  /** Bitboard of each piece code 0..11 (read through `pieces` / `pieceBB`). */
  byPiece: StaticArray<u64> = new StaticArray<u64>(12);
  /** Bitboard of each colour's pieces (read through `colorBB`). */
  byColor: StaticArray<u64> = new StaticArray<u64>(2);
  /** Mailbox: piece code on each square, NO_PIECE when empty (read through `pieceOn`). */
  board: StaticArray<i32> = new StaticArray<i32>(64);

  // ---- undo stack (one entry per move made, game moves and search moves alike)
  private sp: i32 = 0;
  /** Plies since the last null move or setFen; repetitions cannot reach further back. */
  private pliesFromNull: i32 = 0;
  private stackKey: StaticArray<u64> = new StaticArray<u64>(STACK_SIZE);
  private stackMove: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);
  private stackCaptured: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);
  private stackCastling: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);
  private stackEp: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);
  private stackHalfmove: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);
  private stackPliesFromNull: StaticArray<i32> = new StaticArray<i32>(STACK_SIZE);

  constructor() {
    for (let sq = 0; sq < 64; sq++) this.board[sq] = NO_PIECE;
  }

  // ------------------------------------------------------------------ board queries

  /** Bitboard of the pieces of one colour and type, e.g. `pieces(WHITE, KNIGHT)`. */
  @inline
  pieces(color: i32, type: i32): u64 {
    return unchecked(this.byPiece[color * 6 + type]);
  }

  /** Bitboard of one piece code (0..11). */
  @inline
  pieceBB(piece: i32): u64 {
    return unchecked(this.byPiece[piece]);
  }

  /** Bitboard of all pieces of one colour. */
  @inline
  colorBB(color: i32): u64 {
    return unchecked(this.byColor[color]);
  }

  /** Bitboard of all occupied squares. */
  @inline
  occupied(): u64 {
    return unchecked(this.byColor[0]) | unchecked(this.byColor[1]);
  }

  /** Piece code on a square (0..63), or NO_PIECE if it is empty. */
  @inline
  pieceOn(sq: i32): i32 {
    return unchecked(this.board[sq]);
  }

  /** Square of the king of `color`. */
  @inline
  kingSquare(color: i32): i32 {
    return lsb(unchecked(this.byPiece[color * 6 + KING]));
  }

  /** Number of pieces of one colour and type. */
  @inline
  count(color: i32, type: i32): i32 {
    return popcount(this.pieces(color, type));
  }

  /**
   * Game phase 0..24 for tapered evaluation: knights and bishops count 1, rooks 2, queens 4
   * (both colours), clamped to 24. 24 = opening material, 0 = only kings and pawns left.
   */
  phase(): i32 {
    const p =
      popcount(this.pieces(WHITE, KNIGHT) | this.pieces(BLACK, KNIGHT)) +
      popcount(this.pieces(WHITE, BISHOP) | this.pieces(BLACK, BISHOP)) +
      2 * popcount(this.pieces(WHITE, ROOK) | this.pieces(BLACK, ROOK)) +
      4 * popcount(this.pieces(WHITE, QUEEN) | this.pieces(BLACK, QUEEN));
    return p > 24 ? 24 : p;
  }

  /** Non-pawn material of `color` in "pawn units": N = 3, B = 3, R = 5, Q = 9. */
  nonPawnMaterial(color: i32): i32 {
    return 3 * this.count(color, KNIGHT) + 3 * this.count(color, BISHOP) +
      5 * this.count(color, ROOK) + 9 * this.count(color, QUEEN);
  }

  // ------------------------------------------------------------------------ attacks

  /** All pieces (both colours) attacking `sq`, with sliders blocked by `occ`. */
  attackersTo(sq: i32, occ: u64): u64 {
    const bishopsQueens = this.pieces(WHITE, BISHOP) | this.pieces(BLACK, BISHOP) |
      this.pieces(WHITE, QUEEN) | this.pieces(BLACK, QUEEN);
    const rooksQueens = this.pieces(WHITE, ROOK) | this.pieces(BLACK, ROOK) |
      this.pieces(WHITE, QUEEN) | this.pieces(BLACK, QUEEN);
    return (pawnAttacks(BLACK, sq) & this.pieces(WHITE, PAWN)) |
      (pawnAttacks(WHITE, sq) & this.pieces(BLACK, PAWN)) |
      (knightAttacks(sq) & (this.pieces(WHITE, KNIGHT) | this.pieces(BLACK, KNIGHT))) |
      (kingAttacks(sq) & (this.pieces(WHITE, KING) | this.pieces(BLACK, KING))) |
      (bishopAttacks(sq, occ) & bishopsQueens) |
      (rookAttacks(sq, occ) & rooksQueens);
  }

  /** True if any piece of `byColor` attacks `sq`. */
  isAttacked(sq: i32, byColor: i32): bool {
    const occ = this.occupied();
    // A pawn of `byColor` attacks sq if it stands where a pawn of the other colour on sq would attack.
    if ((pawnAttacks(byColor ^ 1, sq) & this.pieces(byColor, PAWN)) != 0) return true;
    if ((knightAttacks(sq) & this.pieces(byColor, KNIGHT)) != 0) return true;
    if ((kingAttacks(sq) & this.pieces(byColor, KING)) != 0) return true;
    const queens = this.pieces(byColor, QUEEN);
    if ((bishopAttacks(sq, occ) & (this.pieces(byColor, BISHOP) | queens)) != 0) return true;
    return (rookAttacks(sq, occ) & (this.pieces(byColor, ROOK) | queens)) != 0;
  }

  /** True if the side to move is in check. */
  inCheck(): bool {
    return this.isAttacked(this.kingSquare(this.side), this.side ^ 1);
  }

  /** Enemy pieces giving check to the side to move. */
  checkers(): u64 {
    return this.attackersTo(this.kingSquare(this.side), this.occupied()) & this.colorBB(this.side ^ 1);
  }

  // ------------------------------------------------------------- board manipulation
  // Low-level helpers that keep bitboards and mailbox in sync. They do not touch the key.

  @inline
  private addPiece(sq: i32, piece: i32): void {
    const b = sqBB(sq);
    unchecked(this.byPiece[piece] = unchecked(this.byPiece[piece]) | b);
    const c = pieceColor(piece);
    unchecked(this.byColor[c] = unchecked(this.byColor[c]) | b);
    unchecked(this.board[sq] = piece);
  }

  @inline
  private removePiece(sq: i32, piece: i32): void {
    const b = ~sqBB(sq);
    unchecked(this.byPiece[piece] = unchecked(this.byPiece[piece]) & b);
    const c = pieceColor(piece);
    unchecked(this.byColor[c] = unchecked(this.byColor[c]) & b);
    unchecked(this.board[sq] = NO_PIECE);
  }

  @inline
  private movePiece(from: i32, to: i32, piece: i32): void {
    const b = sqBB(from) | sqBB(to);
    unchecked(this.byPiece[piece] = unchecked(this.byPiece[piece]) ^ b);
    const c = pieceColor(piece);
    unchecked(this.byColor[c] = unchecked(this.byColor[c]) ^ b);
    unchecked(this.board[from] = NO_PIECE);
    unchecked(this.board[to] = piece);
  }

  // ---------------------------------------------------------------- making moves

  /** Plays a legal move (see movegen.ts). Undo it with `unmakeMove()`. */
  makeMove(m: i32): void {
    const sp = this.sp;
    unchecked(this.stackKey[sp] = this.key);
    unchecked(this.stackMove[sp] = m);
    unchecked(this.stackCastling[sp] = this.castling);
    unchecked(this.stackEp[sp] = this.epSquare);
    unchecked(this.stackHalfmove[sp] = this.halfmove);
    unchecked(this.stackPliesFromNull[sp] = this.pliesFromNull);

    const us = this.side;
    const them = us ^ 1;
    const from = moveFrom(m);
    const to = moveTo(m);
    const flag = moveFlag(m);
    const piece = unchecked(this.board[from]);
    let key = this.key ^ SIDE_KEY;
    let captured = NO_PIECE;

    // The old en-passant square expires after any move.
    if (this.epSquare != NO_SQUARE) {
      key ^= unchecked(EP_KEYS[this.epSquare & 7]);
      this.epSquare = NO_SQUARE;
    }
    this.halfmove++;
    this.pliesFromNull++;

    // Remove the captured piece. En passant: the captured pawn is behind the target square
    // (to ^ 8 flips between rank 6 and 5, or rank 3 and 4).
    if (flag == FLAG_EN_PASSANT) {
      const capSq = to ^ 8;
      captured = makePiece(them, PAWN);
      this.removePiece(capSq, captured);
      key ^= pieceKey(captured, capSq);
      this.halfmove = 0;
    } else if (isCapture(m)) {
      captured = unchecked(this.board[to]);
      this.removePiece(to, captured);
      key ^= pieceKey(captured, to);
      this.halfmove = 0;
    }

    // Move the piece itself.
    this.movePiece(from, to, piece);
    key ^= pieceKey(piece, from) ^ pieceKey(piece, to);

    if (pieceType(piece) == PAWN) {
      this.halfmove = 0;
      if (flag == FLAG_DOUBLE_PUSH) {
        // Record the en-passant square only if an enemy pawn can capture onto it.
        const ep = (from + to) >> 1;
        if ((pawnAttacks(us, ep) & this.pieces(them, PAWN)) != 0) {
          this.epSquare = ep;
          key ^= unchecked(EP_KEYS[ep & 7]);
        }
      } else if (isPromotion(m)) {
        const promoted = makePiece(us, promotionType(m));
        this.removePiece(to, piece);
        this.addPiece(to, promoted);
        key ^= pieceKey(piece, to) ^ pieceKey(promoted, to);
      }
    } else if (flag == FLAG_KING_CASTLE) {
      // King went e1-g1 (or e8-g8): the rook jumps h1-f1 (h8-f8).
      const rook = makePiece(us, ROOK);
      this.movePiece(to + 1, to - 1, rook);
      key ^= pieceKey(rook, to + 1) ^ pieceKey(rook, to - 1);
    } else if (flag == FLAG_QUEEN_CASTLE) {
      // King went e1-c1 (or e8-c8): the rook jumps a1-d1 (a8-d8).
      const rook = makePiece(us, ROOK);
      this.movePiece(to - 2, to + 1, rook);
      key ^= pieceKey(rook, to - 2) ^ pieceKey(rook, to + 1);
    }

    // Update castling rights (king or rook moved, or a rook was captured at home).
    const rights = this.castling & unchecked(CASTLE_MASK[from]) & unchecked(CASTLE_MASK[to]);
    if (rights != this.castling) {
      key ^= unchecked(CASTLE_KEYS[this.castling]) ^ unchecked(CASTLE_KEYS[rights]);
      this.castling = rights;
    }

    unchecked(this.stackCaptured[sp] = captured);
    this.sp = sp + 1;
    this.ply++;
    if (us == BLACK) this.fullmove++;
    this.side = them;
    this.key = key;
  }

  /** Takes back the last move made with `makeMove`. */
  unmakeMove(): void {
    const sp = this.sp - 1;
    this.sp = sp;
    this.ply--;
    const m = unchecked(this.stackMove[sp]);
    const captured = unchecked(this.stackCaptured[sp]);
    const us = this.side ^ 1; // the side that made the move
    this.side = us;
    if (us == BLACK) this.fullmove--;

    const from = moveFrom(m);
    const to = moveTo(m);
    const flag = moveFlag(m);

    if (isPromotion(m)) {
      this.removePiece(to, unchecked(this.board[to]));
      this.addPiece(from, makePiece(us, PAWN));
    } else {
      this.movePiece(to, from, unchecked(this.board[to]));
    }

    if (flag == FLAG_EN_PASSANT) {
      this.addPiece(to ^ 8, captured);
    } else if (captured != NO_PIECE) {
      this.addPiece(to, captured);
    } else if (flag == FLAG_KING_CASTLE) {
      this.movePiece(to - 1, to + 1, makePiece(us, ROOK));
    } else if (flag == FLAG_QUEEN_CASTLE) {
      this.movePiece(to + 1, to - 2, makePiece(us, ROOK));
    }

    this.castling = unchecked(this.stackCastling[sp]);
    this.epSquare = unchecked(this.stackEp[sp]);
    this.halfmove = unchecked(this.stackHalfmove[sp]);
    this.pliesFromNull = unchecked(this.stackPliesFromNull[sp]);
    this.key = unchecked(this.stackKey[sp]);
  }

  /**
   * "Passes": gives the move to the opponent without moving a piece. Used by null-move
   * pruning in the search. Undo with `unmakeNull()`. Never call it while in check.
   */
  makeNull(): void {
    const sp = this.sp;
    unchecked(this.stackKey[sp] = this.key);
    unchecked(this.stackMove[sp] = MOVE_NONE);
    unchecked(this.stackCaptured[sp] = NO_PIECE);
    unchecked(this.stackCastling[sp] = this.castling);
    unchecked(this.stackEp[sp] = this.epSquare);
    unchecked(this.stackHalfmove[sp] = this.halfmove);
    unchecked(this.stackPliesFromNull[sp] = this.pliesFromNull);

    let key = this.key ^ SIDE_KEY;
    if (this.epSquare != NO_SQUARE) {
      key ^= unchecked(EP_KEYS[this.epSquare & 7]);
      this.epSquare = NO_SQUARE;
    }
    this.key = key;
    this.halfmove++;
    this.pliesFromNull = 0;
    this.side ^= 1;
    this.sp = sp + 1;
    this.ply++;
  }

  /** Takes back a `makeNull()`. */
  unmakeNull(): void {
    const sp = this.sp - 1;
    this.sp = sp;
    this.ply--;
    this.side ^= 1;
    this.epSquare = unchecked(this.stackEp[sp]);
    this.halfmove = unchecked(this.stackHalfmove[sp]);
    this.pliesFromNull = unchecked(this.stackPliesFromNull[sp]);
    this.key = unchecked(this.stackKey[sp]);
  }

  /** The last move made (MOVE_NONE if none, or if it was a null move). */
  lastMove(): i32 {
    return this.sp > 0 ? unchecked(this.stackMove[this.sp - 1]) : MOVE_NONE;
  }

  // -------------------------------------------------------------------------- draws

  /**
   * True if the current position already occurred earlier (game history included) since the
   * last capture, pawn move or null move. The search treats such a repetition as a draw:
   * if repeating once is good for a side, it can repeat again.
   */
  isRepetition(): bool {
    let limit = this.halfmove < this.pliesFromNull ? this.halfmove : this.pliesFromNull;
    if (limit > this.sp) limit = this.sp;
    // Same side to move means an even distance; a repetition needs at least 4 plies.
    for (let i = 4; i <= limit; i += 2) {
      if (unchecked(this.stackKey[this.sp - i]) == this.key) return true;
    }
    return false;
  }

  /** True if neither side can possibly checkmate (K v K, K+minor v K, bishops all on one colour). */
  insufficientMaterial(): bool {
    const heavyOrPawns = this.pieces(WHITE, PAWN) | this.pieces(BLACK, PAWN) |
      this.pieces(WHITE, ROOK) | this.pieces(BLACK, ROOK) |
      this.pieces(WHITE, QUEEN) | this.pieces(BLACK, QUEEN);
    if (heavyOrPawns != 0) return false;
    const knights = this.pieces(WHITE, KNIGHT) | this.pieces(BLACK, KNIGHT);
    const bishops = this.pieces(WHITE, BISHOP) | this.pieces(BLACK, BISHOP);
    if (popcount(knights | bishops) <= 1) return true;
    // Only bishops left and all of them on squares of one colour: no mate is possible.
    return knights == 0 && ((bishops & LIGHT_SQUARES) == 0 || (bishops & DARK_SQUARES) == 0);
  }

  /** Draw by repetition, the fifty-move rule or insufficient material. */
  isDraw(): bool {
    return this.halfmove >= 100 || this.isRepetition() || this.insufficientMaterial();
  }

  // ------------------------------------------------------------------ move lookup

  /** True if `m` is a legal move in this position. */
  isLegal(m: i32): bool {
    if (m == MOVE_NONE) return false;
    const n = generateMoves(this, LOOKUP_MOVES, 0);
    for (let i = 0; i < n; i++) if (LOOKUP_MOVES[i] == m) return true;
    return false;
  }

  /** Finds the legal move with this UCI text ("e2e4", "e7e8q", "e1g1"); MOVE_NONE if none. */
  parseUci(uci: string): i32 {
    if (uci.length < 4 || uci.length > 5) return MOVE_NONE;
    const from = parseSquare(uci, 0);
    const to = parseSquare(uci, 2);
    if (from < 0 || to < 0) return MOVE_NONE;
    let promo = -1;
    if (uci.length == 5) {
      const c = uci.charCodeAt(4) | 32; // lower case
      if (c == 110) promo = KNIGHT; // 'n'
      else if (c == 98) promo = BISHOP; // 'b'
      else if (c == 114) promo = ROOK; // 'r'
      else if (c == 113) promo = QUEEN; // 'q'
      else return MOVE_NONE;
    }
    const n = generateMoves(this, LOOKUP_MOVES, 0);
    for (let i = 0; i < n; i++) {
      const m = LOOKUP_MOVES[i];
      if (moveFrom(m) != from || moveTo(m) != to) continue;
      if (isPromotion(m) ? promotionType(m) == promo : promo < 0) return m;
    }
    return MOVE_NONE;
  }

  // -------------------------------------------------------------------- history

  /** Number of entries on the undo stack (game moves since setFen + moves being searched). */
  historyLength(): i32 {
    return this.sp;
  }

  /**
   * Forgets undo entries that can no longer matter for repetitions (anything before the last
   * capture or pawn move). Those earlier moves can then no longer be unmade. main.ts calls
   * this while applying very long move lists.
   */
  compactHistory(): void {
    let keep = this.halfmove < this.pliesFromNull ? this.halfmove : this.pliesFromNull;
    if (keep > this.sp) keep = this.sp;
    if (keep > HISTORY_CAPACITY / 2) keep = HISTORY_CAPACITY / 2;
    const drop = this.sp - keep;
    if (drop <= 0) return;
    for (let i = 0; i < keep; i++) {
      this.stackKey[i] = this.stackKey[i + drop];
      this.stackMove[i] = this.stackMove[i + drop];
      this.stackCaptured[i] = this.stackCaptured[i + drop];
      this.stackCastling[i] = this.stackCastling[i + drop];
      this.stackEp[i] = this.stackEp[i + drop];
      this.stackHalfmove[i] = this.stackHalfmove[i + drop];
      this.stackPliesFromNull[i] = this.stackPliesFromNull[i + drop];
    }
    this.sp = keep;
    if (this.pliesFromNull > keep) this.pliesFromNull = keep;
  }

  // ------------------------------------------------------------------------- FEN

  /** Sets up the standard starting position. */
  setStartpos(): void {
    this.setFen(START_FEN);
  }

  /**
   * Sets up a position from FEN, e.g. "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1".
   * The half-move and full-move fields may be omitted. Returns false (and leaves the position
   * unchanged) for malformed or impossible positions: wrong board layout, not exactly one king
   * per side, pawns on the first/last rank, too many pieces, or the side not to move in check.
   * Castling rights without the king and rook on their home squares are dropped, and so is an
   * en-passant square that no pawn can use.
   */
  setFen(fen: string): bool {
    const fields = splitWhitespace(fen);
    if (fields.length < 2 || fields.length > 6) return false;

    // 1. Piece placement, rank 8 first.
    for (let sq = 0; sq < 64; sq++) PARSE_BOARD[sq] = NO_PIECE;
    const placement = fields[0];
    let rank = 7;
    let file = 0;
    for (let i = 0; i < placement.length; i++) {
      const c = placement.charCodeAt(i);
      if (c == 47) { // '/'
        if (file != 8 || rank == 0) return false;
        rank--;
        file = 0;
      } else if (c >= 49 && c <= 56) { // '1'..'8'
        file += c - 48;
        if (file > 8) return false;
      } else {
        const piece = pieceFromChar(c);
        if (piece == NO_PIECE || file > 7) return false;
        PARSE_BOARD[rank * 8 + file] = piece;
        file++;
      }
    }
    if (rank != 0 || file != 8) return false;

    // 2. Side to move.
    let side: i32;
    if (fields[1] == "w") side = WHITE;
    else if (fields[1] == "b") side = BLACK;
    else return false;

    // 3. Castling rights.
    let castling = 0;
    if (fields.length > 2 && fields[2] != "-") {
      const s = fields[2];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c == 75) castling |= CASTLE_WK; // 'K'
        else if (c == 81) castling |= CASTLE_WQ; // 'Q'
        else if (c == 107) castling |= CASTLE_BK; // 'k'
        else if (c == 113) castling |= CASTLE_BQ; // 'q'
        else return false;
      }
    }

    // 4. En-passant square.
    let ep = NO_SQUARE;
    if (fields.length > 3 && fields[3] != "-") {
      if (fields[3].length != 2) return false;
      ep = parseSquare(fields[3], 0);
      if (ep < 0) return false;
      // White to move: Black just double-pushed, so the target is on rank 6 (and vice versa).
      if ((ep >> 3) != (side == WHITE ? 5 : 2)) return false;
    }

    // 5./6. Counters.
    let halfmove = 0;
    let fullmove = 1;
    if (fields.length > 4) {
      halfmove = parseNonNegativeInt(fields[4]);
      if (halfmove < 0) return false;
    }
    if (fields.length > 5) {
      fullmove = parseNonNegativeInt(fields[5]);
      if (fullmove < 0) return false;
      if (fullmove == 0) fullmove = 1;
    }

    // ---- validation of the material
    if (!plausibleMaterial(WHITE) || !plausibleMaterial(BLACK)) return false;
    for (let f = 0; f < 8; f++) {
      const p1 = PARSE_BOARD[f];
      const p8 = PARSE_BOARD[56 + f];
      if (p1 == makePiece(WHITE, PAWN) || p1 == makePiece(BLACK, PAWN)) return false;
      if (p8 == makePiece(WHITE, PAWN) || p8 == makePiece(BLACK, PAWN)) return false;
    }
    // The side that just moved may not have left its king in check.
    if (parsedKingAttacked(side ^ 1)) return false;

    // Drop castling rights that do not match the pieces on the board.
    if (PARSE_BOARD[E1] != makePiece(WHITE, KING)) castling &= ~(CASTLE_WK | CASTLE_WQ);
    if (PARSE_BOARD[H1] != makePiece(WHITE, ROOK)) castling &= ~CASTLE_WK;
    if (PARSE_BOARD[A1] != makePiece(WHITE, ROOK)) castling &= ~CASTLE_WQ;
    if (PARSE_BOARD[E8] != makePiece(BLACK, KING)) castling &= ~(CASTLE_BK | CASTLE_BQ);
    if (PARSE_BOARD[H8] != makePiece(BLACK, ROOK)) castling &= ~CASTLE_BK;
    if (PARSE_BOARD[A8] != makePiece(BLACK, ROOK)) castling &= ~CASTLE_BQ;

    // Keep the en-passant square only if it is consistent and usable.
    if (ep != NO_SQUARE) {
      const pushedTo = side == WHITE ? ep - 8 : ep + 8; // square of the pawn that double-pushed
      const origin = side == WHITE ? ep + 8 : ep - 8; // square it came from
      let usable = PARSE_BOARD[pushedTo] == makePiece(side ^ 1, PAWN) &&
        PARSE_BOARD[ep] == NO_PIECE && PARSE_BOARD[origin] == NO_PIECE;
      if (usable) {
        usable = false;
        let candidates = pawnAttacks(side ^ 1, ep);
        while (candidates != 0) {
          const s = lsb(candidates);
          candidates &= candidates - 1;
          if (PARSE_BOARD[s] == makePiece(side, PAWN)) usable = true;
        }
      }
      if (!usable) ep = NO_SQUARE;
    }

    // ---- commit
    for (let i = 0; i < 12; i++) this.byPiece[i] = 0;
    this.byColor[0] = 0;
    this.byColor[1] = 0;
    for (let sq = 0; sq < 64; sq++) {
      this.board[sq] = NO_PIECE;
      const p = PARSE_BOARD[sq];
      if (p != NO_PIECE) this.addPiece(sq, p);
    }
    this.side = side;
    this.castling = castling;
    this.epSquare = ep;
    this.halfmove = halfmove;
    this.fullmove = fullmove;
    this.ply = 0;
    this.sp = 0;
    this.pliesFromNull = 0;
    this.key = this.computeKey();
    return true;
  }

  /** The position as a FEN string. */
  toFen(): string {
    let s = "";
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[rank * 8 + file];
        if (p == NO_PIECE) {
          empty++;
        } else {
          if (empty > 0) s += empty.toString();
          empty = 0;
          s += PIECE_CHARS.charAt(p);
        }
      }
      if (empty > 0) s += empty.toString();
      if (rank > 0) s += "/";
    }
    s += this.side == WHITE ? " w " : " b ";
    let rights = "";
    if ((this.castling & CASTLE_WK) != 0) rights += "K";
    if ((this.castling & CASTLE_WQ) != 0) rights += "Q";
    if ((this.castling & CASTLE_BK) != 0) rights += "k";
    if ((this.castling & CASTLE_BQ) != 0) rights += "q";
    s += rights.length > 0 ? rights : "-";
    s += " ";
    s += this.epSquare == NO_SQUARE ? "-" : squareName(this.epSquare);
    s += " " + this.halfmove.toString() + " " + this.fullmove.toString();
    return s;
  }

  /** Recomputes the Zobrist key from scratch (setFen uses it; handy for debugging). */
  computeKey(): u64 {
    let k: u64 = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.board[sq];
      if (p != NO_PIECE) k ^= pieceKey(p, sq);
    }
    if (this.side == BLACK) k ^= SIDE_KEY;
    k ^= CASTLE_KEYS[this.castling];
    if (this.epSquare != NO_SQUARE) k ^= EP_KEYS[this.epSquare & 7];
    return k;
  }
}

// ------------------------------------------------------------------- parsing helpers

/** Splits on spaces / tabs / newlines, dropping empty pieces. */
export function splitWhitespace(s: string): string[] {
  const out = new Array<string>();
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    const space = c == 32 || c == 9 || c == 10 || c == 13;
    if (space) {
      if (start >= 0) out.push(s.substring(start, i));
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }
  return out;
}

/** Square from two characters at `offset` ("e4" -> 28); -1 if invalid. */
export function parseSquare(s: string, offset: i32): i32 {
  if (s.length < offset + 2) return -1;
  const f = s.charCodeAt(offset) - 97; // 'a'
  const r = s.charCodeAt(offset + 1) - 49; // '1'
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 8 + f;
}

/** Parses a decimal number made only of digits; -1 if invalid. */
function parseNonNegativeInt(s: string): i32 {
  if (s.length == 0 || s.length > 9) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
}

/** Piece code for a FEN letter (PNBRQK / pnbrqk), NO_PIECE otherwise. */
function pieceFromChar(c: i32): i32 {
  for (let i = 0; i < 12; i++) if (PIECE_CHARS.charCodeAt(i) == c) return i;
  return NO_PIECE;
}

/**
 * Checks the parsed board for one colour: exactly one king, at most 8 pawns, and no more
 * extra (promoted) pieces than missing pawns. This also guarantees that no position has
 * more legal moves than fit in a move list.
 */
function plausibleMaterial(color: i32): bool {
  let pawns = 0, knights = 0, bishops = 0, rooks = 0, queens = 0, kings = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = PARSE_BOARD[sq];
    if (p == NO_PIECE || pieceColor(p) != color) continue;
    const t = pieceType(p);
    if (t == PAWN) pawns++;
    else if (t == KNIGHT) knights++;
    else if (t == BISHOP) bishops++;
    else if (t == ROOK) rooks++;
    else if (t == QUEEN) queens++;
    else kings++;
  }
  if (kings != 1 || pawns > 8) return false;
  const extra = max(0, knights - 2) + max(0, bishops - 2) + max(0, rooks - 2) + max(0, queens - 1);
  return extra <= 8 - pawns;
}

/** True if the king of `color` on PARSE_BOARD is attacked by the other side. */
function parsedKingAttacked(color: i32): bool {
  const enemy = color ^ 1;
  let occ: u64 = 0, pawns: u64 = 0, knights: u64 = 0, diagonal: u64 = 0, straight: u64 = 0, kings: u64 = 0;
  let ksq = NO_SQUARE;
  for (let sq = 0; sq < 64; sq++) {
    const p = PARSE_BOARD[sq];
    if (p == NO_PIECE) continue;
    const b = sqBB(sq);
    occ |= b;
    if (p == makePiece(color, KING)) ksq = sq;
    if (pieceColor(p) != enemy) continue;
    const t = pieceType(p);
    if (t == PAWN) pawns |= b;
    else if (t == KNIGHT) knights |= b;
    else if (t == BISHOP) diagonal |= b;
    else if (t == ROOK) straight |= b;
    else if (t == QUEEN) { diagonal |= b; straight |= b; }
    else kings |= b;
  }
  if (ksq == NO_SQUARE) return true;
  return ((pawnAttacks(color, ksq) & pawns) | (knightAttacks(ksq) & knights) | (kingAttacks(ksq) & kings) |
    (bishopAttacks(ksq, occ) & diagonal) | (rookAttacks(ksq, occ) & straight)) != 0;
}
