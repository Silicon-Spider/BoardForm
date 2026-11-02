// Tiny FEN board parser for the NNUE modules.
//
// Deliberately independent of chess.js: it runs inside the trainer worker and in Node tests,
// and only needs the piece placement and the side to move (castling / en passant / clocks do
// not influence the network inputs).

/** Standard starting position. `"startpos"` is accepted wherever a FEN is expected. */
export const NNUE_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Piece code = `color * 6 + type` (white P..K = 0..5, black P..K = 6..11), the encoding used
 * by PackedPosition (docs/NNUE_FORMAT.md). `PIECE_CHARS[code]` is the FEN letter.
 */
export const PIECE_CHARS = "PNBRQKpnbrqk";

/** Piece types (docs/NNUE_FORMAT.md). */
export const PAWN = 0;
export const KNIGHT = 1;
export const BISHOP = 2;
export const ROOK = 3;
export const QUEEN = 4;
export const KING = 5;

export interface BoardPiece {
  /** Square 0..63, LERF: a1 = 0, b1 = 1, …, h8 = 63. */
  sq: number;
  /** Piece code `color * 6 + type` (0..11). */
  piece: number;
}

export interface FenBoard {
  /** Pieces in FEN reading order (rank 8 → rank 1, file a → h). */
  pieces: BoardPiece[];
  /** Side to move: 0 = White, 1 = Black. */
  stm: 0 | 1;
}

export class FenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FenError";
  }
}

/** Parses the board and side-to-move fields of a FEN (or `"startpos"`). Throws FenError. */
export function parseFenBoard(fen: string): FenBoard {
  const text = fen.trim();
  const source = text === "startpos" ? NNUE_START_FEN : text;
  const fields = source.split(/\s+/);
  const placement = fields[0] ?? "";
  if (placement === "") throw new FenError("Empty FEN");
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new FenError(`FEN board must have 8 ranks, got ${ranks.length}`);

  const pieces: BoardPiece[] = [];
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r; // FEN lists rank 8 first
    const row = ranks[r] ?? "";
    let file = 0;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i] ?? "";
      const code = ch.charCodeAt(0);
      if (code >= 49 && code <= 56) {
        // digits 1..8 = run of empty squares
        file += code - 48;
      } else {
        const piece = PIECE_CHARS.indexOf(ch);
        if (piece < 0) throw new FenError(`Invalid character "${ch}" in FEN rank ${rank + 1}`);
        if (file > 7) throw new FenError(`FEN rank ${rank + 1} has more than 8 squares`);
        pieces.push({ sq: rank * 8 + file, piece });
        file++;
      }
      if (file > 8) throw new FenError(`FEN rank ${rank + 1} has more than 8 squares`);
    }
    if (file !== 8) throw new FenError(`FEN rank ${rank + 1} has ${file} squares, expected 8`);
  }

  const side = fields[1] ?? "w";
  if (side !== "w" && side !== "b") throw new FenError(`Invalid side to move "${side}" (expected "w" or "b")`);
  return { pieces, stm: side === "w" ? 0 : 1 };
}

/**
 * Builds a FEN from a piece list. Castling rights and en passant are unknown in this
 * representation, so they are written as "-" (the network ignores them anyway).
 */
export function boardToFen(pieces: readonly BoardPiece[], stm: 0 | 1, fullmove = 1): string {
  const board = new Array<string>(64).fill("");
  for (const p of pieces) board[p.sq] = PIECE_CHARS[p.piece] ?? "?";
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const ch = board[rank * 8 + file] ?? "";
      if (ch === "") {
        empty++;
      } else {
        if (empty > 0) row += String(empty);
        empty = 0;
        row += ch;
      }
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return `${rows.join("/")} ${stm === 0 ? "w" : "b"} - - 0 ${fullmove}`;
}

/** "e4" → 28. Returns -1 for an invalid name. */
export function squareFromName(name: string): number {
  if (name.length !== 2) return -1;
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

/** 28 → "e4". */
export function squareName(sq: number): string {
  return String.fromCharCode(97 + (sq & 7)) + String(1 + (sq >> 3));
}
