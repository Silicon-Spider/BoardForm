// FEN helpers: normalisation, validation (stricter than chess.js), mirroring and a fast,
// dependency-free board parser used by the board components.
import { Chess, validateFen as chessJsValidateFen } from "chess.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Color = "w" | "b";
/** Piece code as used by the piece images: colour + upper-case piece letter, e.g. "wK", "bP". */
export type PieceCode = `${Color}${"K" | "Q" | "R" | "B" | "N" | "P"}`;

export const FILES = "abcdefgh";

/** "e4" → 28 (a1 = 0, b1 = 1, ..., h8 = 63); -1 for anything else. */
export function squareIndex(square: string): number {
  if (square.length !== 2) return -1;
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

/** 28 → "e4". */
export function squareName(index: number): string {
  return FILES[index & 7] + String((index >> 3) + 1);
}

/** All 64 square names, a1..h8. */
export const SQUARES: readonly string[] = Array.from({ length: 64 }, (_, i) => squareName(i));

/**
 * Normalises user/engine input into a 6-field FEN: trims, collapses whitespace, maps
 * "startpos" to the standard position and fills omitted trailing fields
 * (side "w", castling "-", en passant "-", halfmove "0", fullmove "1").
 * Does not validate.
 */
export function normalizeFen(fen: string): string {
  const trimmed = fen.trim();
  if (trimmed === "" || trimmed === "startpos") return START_FEN;
  const fields = trimmed.split(/\s+/);
  const defaults = ["", "w", "-", "-", "0", "1"];
  for (let i = fields.length; i < 6; i++) fields.push(defaults[i]);
  return fields.join(" ");
}

/**
 * Piece placement of a FEN as 64 entries (index = squareIndex). Tolerant: never throws,
 * ignores junk, so the board can always render something.
 */
export function parseFenBoard(fen: string): Array<PieceCode | null> {
  const board: Array<PieceCode | null> = new Array(64).fill(null);
  const placement = normalizeFen(fen).split(" ")[0];
  let rank = 7;
  let file = 0;
  for (const ch of placement) {
    if (ch === "/") {
      rank--;
      file = 0;
      if (rank < 0) break;
    } else if (ch >= "1" && ch <= "8") {
      file += ch.charCodeAt(0) - 48;
    } else {
      const lower = ch.toLowerCase();
      if ("pnbrqk".includes(lower) && file < 8 && rank >= 0) {
        const color: Color = ch === lower ? "b" : "w";
        board[rank * 8 + file] = `${color}${lower.toUpperCase()}` as PieceCode;
      }
      file++;
    }
  }
  return board;
}

/** Side to move of a FEN ("w" when missing/garbled). */
export function fenTurn(fen: string): Color {
  return normalizeFen(fen).split(" ")[1] === "b" ? "b" : "w";
}

function friendly(error: string | undefined): string {
  const msg = (error ?? "Invalid FEN").replace(/^Invalid FEN:\s*/i, "");
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

const COLOR_NAME: Record<Color, string> = { w: "White", b: "Black" };

/** Castling right → [king square, rook square, colour]. */
export const CASTLING_SQUARES: Record<"K" | "Q" | "k" | "q", [string, string, Color]> = {
  K: ["e1", "h1", "w"],
  Q: ["e1", "a1", "w"],
  k: ["e8", "h8", "b"],
  q: ["e8", "a8", "b"],
};

/** True when the king and rook needed for a castling right stand on their original squares. */
export function castlingPossible(board: ReadonlyArray<PieceCode | null>, right: "K" | "Q" | "k" | "q"): boolean {
  const [kingSq, rookSq, color] = CASTLING_SQUARES[right];
  return board[squareIndex(kingSq)] === `${color}K` && board[squareIndex(rookSq)] === `${color}R`;
}

/**
 * En-passant target squares that make sense for the side to move: the square behind an enemy
 * pawn that could just have advanced two squares, with an own pawn ready to capture.
 */
export function enPassantCandidates(board: ReadonlyArray<PieceCode | null>, turn: Color): string[] {
  const out: string[] = [];
  // White to move: black pawn on rank 5 that came from rank 7, target on rank 6.
  const pawnRank = turn === "w" ? 4 : 3;
  const targetRank = turn === "w" ? 5 : 2;
  const originRank = turn === "w" ? 6 : 1;
  const enemyPawn: PieceCode = turn === "w" ? "bP" : "wP";
  const ownPawn: PieceCode = turn === "w" ? "wP" : "bP";
  for (let file = 0; file < 8; file++) {
    if (board[pawnRank * 8 + file] !== enemyPawn) continue;
    if (board[targetRank * 8 + file] !== null || board[originRank * 8 + file] !== null) continue;
    const left = file > 0 && board[pawnRank * 8 + file - 1] === ownPawn;
    const right = file < 7 && board[pawnRank * 8 + file + 1] === ownPawn;
    if (left || right) out.push(squareName(targetRank * 8 + file));
  }
  return out;
}

interface FenCheck {
  ok: boolean;
  error?: string;
  /** Normalised FEN that was checked. */
  fen: string;
  /** chess.js instance loaded with the FEN (only when ok). */
  chess?: Chess;
}

/** Validation shared by validateFen and ChessGame (returns the loaded chess.js instance). */
export function checkFen(input: string): FenCheck {
  const fen = normalizeFen(input);
  const fields = fen.split(" ");
  if (fields.length !== 6) {
    return { ok: false, fen, error: "A FEN has six fields: pieces, side to move, castling, en passant, halfmove clock, move number" };
  }
  const base = chessJsValidateFen(fen);
  if (!base.ok) return { ok: false, fen, error: friendly(base.error) };

  const board = parseFenBoard(fen);
  const turn: Color = fields[1] === "b" ? "b" : "w";

  // Castling rights must match the pieces (chess.js trusts them blindly and would move a
  // non-existent rook).
  if (fields[2] !== "-") {
    if (/[^KQkq]/.test(fields[2])) return { ok: false, fen, error: "Castling availability is invalid" };
    if (new Set(fields[2]).size !== fields[2].length) return { ok: false, fen, error: "Castling field repeats a right" };
    for (const right of fields[2].split("") as Array<"K" | "Q" | "k" | "q">) {
      if (!castlingPossible(board, right)) {
        const [kingSq, rookSq, color] = CASTLING_SQUARES[right];
        return {
          ok: false,
          fen,
          error: `Castling right "${right}" needs the ${COLOR_NAME[color].toLowerCase()} king on ${kingSq} and a rook on ${rookSq}`,
        };
      }
    }
  }

  // En-passant square must sit behind a pawn that just advanced two squares.
  if (fields[3] !== "-") {
    const ep = squareIndex(fields[3]);
    const dir = turn === "w" ? -8 : 8; // from the target square towards the pawn
    const pawn: PieceCode = turn === "w" ? "bP" : "wP";
    const origin = ep - dir;
    if (ep < 0 || board[ep] !== null || board[ep + dir] !== pawn || board[origin] !== null) {
      return {
        ok: false,
        fen,
        error: `En-passant square ${fields[3]} needs a ${turn === "w" ? "black" : "white"} pawn on ${squareName(ep + dir)} that just moved two squares`,
      };
    }
  }

  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch (e) {
    return { ok: false, fen, error: friendly(e instanceof Error ? e.message : String(e)) };
  }

  // The side that just moved may not have left its king in check.
  const other: Color = turn === "w" ? "b" : "w";
  const kingSquare = chess.findPiece({ type: "k", color: other })[0];
  if (kingSquare && chess.isAttacked(kingSquare, turn)) {
    return {
      ok: false,
      fen,
      error: `${COLOR_NAME[other]} is in check but it is ${COLOR_NAME[turn]}'s turn`,
    };
  }
  return { ok: true, fen, chess };
}

/**
 * Validates a FEN (also accepts "startpos" and FENs with omitted trailing fields).
 * On top of chess.js' checks it rejects castling rights without king/rook on their squares,
 * impossible en-passant squares and positions where the side not to move is in check.
 */
export function validateFen(fen: string): { ok: boolean; error?: string } {
  const r = checkFen(fen);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

function swapCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += ch === lower ? ch.toUpperCase() : lower;
  }
  return out;
}

/**
 * Colour-flipped equivalent position: ranks reversed, piece colours swapped, side to move,
 * castling rights and en-passant square mirrored. Evaluations of the result should be the
 * negation (White POV) of the original. mirrorFen(mirrorFen(f)) === f for canonical FENs.
 */
export function mirrorFen(fen: string): string {
  const f = normalizeFen(fen).split(" ");
  const placement = f[0].split("/").reverse().map(swapCase).join("/");
  const turn = f[1] === "b" ? "w" : "b";
  let castling = "-";
  if (f[2] !== "-") {
    const rights = new Set(swapCase(f[2]).split(""));
    castling = ["K", "Q", "k", "q"].filter((c) => rights.has(c)).join("") || "-";
  }
  const ep = f[3] === "-" || f[3].length !== 2 ? "-" : f[3][0] + String(9 - Number(f[3][1]));
  return [placement, turn, castling, ep, f[4], f[5]].join(" ");
}
