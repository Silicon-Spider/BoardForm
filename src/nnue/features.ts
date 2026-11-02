// Network input features (docs/NNUE_FORMAT.md):
//
//   feature(persp, color, type, sq) =
//     persp == WHITE: (color == WHITE ? 0 : 384) + type*64 + sq
//     persp == BLACK: (color == BLACK ? 0 : 384) + type*64 + (sq ^ 56)
//
// i.e. "own pieces first, then enemy pieces", board flipped vertically for Black.
import { parseFenBoard, type BoardPiece } from "./fen";
import { decodePackedFeatures } from "./pack";

export const WHITE = 0;
export const BLACK = 1;
/** Capacity of a FeatureSet: one feature per occupied square at most. */
export const MAX_FEATURES = 64;

/** Feature index of a piece seen from one perspective. */
export function featureIndex(persp: 0 | 1, color: 0 | 1, type: number, sq: number): number {
  return persp === WHITE ? (color === WHITE ? 0 : 384) + type * 64 + sq : (color === BLACK ? 0 : 384) + type * 64 + (sq ^ 56);
}

/** Active features of a position for both perspectives. Only the first `count` entries are valid. */
export interface FeatureSet {
  count: number;
  /** Feature indices from White's perspective. */
  white: Uint16Array;
  /** Feature indices from Black's perspective (same piece order as `white`). */
  black: Uint16Array;
  /** Side to move: 0 = White, 1 = Black. */
  stm: 0 | 1;
}

export function createFeatureSet(): FeatureSet {
  return { count: 0, white: new Uint16Array(MAX_FEATURES), black: new Uint16Array(MAX_FEATURES), stm: 0 };
}

/** Features from a piece list (`piece` = color·6 + type). */
export function featuresFromPieces(pieces: readonly BoardPiece[], stm: 0 | 1, out: FeatureSet = createFeatureSet()): FeatureSet {
  if (pieces.length > out.white.length) throw new RangeError(`Too many pieces (${pieces.length})`);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as BoardPiece;
    const color = p.piece >= 6 ? 1 : 0;
    const type = p.piece - 6 * color;
    out.white[i] = featureIndex(WHITE, color, type, p.sq);
    out.black[i] = featureIndex(BLACK, color, type, p.sq);
  }
  out.count = pieces.length;
  out.stm = stm;
  return out;
}

/** Active features of a FEN (or `"startpos"`). Throws FenError for malformed input. */
export function extractFeatures(fen: string, out?: FeatureSet): FeatureSet {
  const board = parseFenBoard(fen);
  return featuresFromPieces(board.pieces, board.stm, out);
}

/** Active features of a packed 32-byte record (see pack.ts). */
export function extractPackedFeatures(buf: Uint8Array, offset = 0, out: FeatureSet = createFeatureSet()): FeatureSet {
  out.count = decodePackedFeatures(buf, offset, out.white, out.black);
  out.stm = (buf[offset + 27] as number) === 1 ? 1 : 0;
  return out;
}
