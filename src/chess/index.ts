// @/chess — rules wrapper (chess.js), FEN helpers, PGN, opening book, random openings.
// Pure TypeScript: safe to import from workers.
export {
  START_FEN,
  FILES,
  SQUARES,
  squareIndex,
  squareName,
  normalizeFen,
  parseFenBoard,
  fenTurn,
  validateFen,
  mirrorFen,
  castlingPossible,
  enPassantCandidates,
  CASTLING_SQUARES,
} from "./fen";
export type { Color, PieceCode } from "./fen";
export { ChessGame, uciToSan, sanToUci, uciLineToSan, parseUci } from "./game";
export type { MoveInput, PlayedMove, GameOutcome } from "./game";
export { parsePgn } from "./pgn";
export type { ParsedPgn } from "./pgn";
export { OPENINGS, pickOpenings } from "./openings";
export type { Opening } from "./openings";
export { randomPlies } from "./random";
