// PackedPosition: the 32-byte training-data record (docs/NNUE_FORMAT.md, little-endian).
//
//   0  u64     occupancy bitboard (bit sq set if any piece on sq)
//   8  u8[16]  piece codes, 4 bits each, in ascending square order (nibble k = k-th set bit)
//   24 i16     search score, centipawns, White's POV, clamped to ±32000
//   26 u8      game result, White's POV: 0 Black won, 1 draw, 2 White won
//   27 u8      side to move: 0 White, 1 Black
//   28 u32     reserved (0)
import { boardToFen, parseFenBoard, type BoardPiece } from "./fen";

export const PACKED_SIZE = 32;
/** A packed record has room for 32 piece nibbles. */
export const MAX_PACKED_PIECES = 32;
export const PACKED_SCORE_LIMIT = 32000;
/** Positions per dataset chunk (DatasetChunkRecord). */
export const POSITIONS_PER_CHUNK = 16384;

/** Game result from White's point of view: 0 = Black won, 1 = draw, 2 = White won. */
export type PackedResult = 0 | 1 | 2;

const scratchBoard = new Int8Array(64);

function writePacked(
  board: Int8Array,
  stm: 0 | 1,
  scoreWhiteCp: number,
  result: PackedResult,
  out: Uint8Array,
  offset: number,
): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + PACKED_SIZE > out.length) {
    throw new RangeError(`packPosition: offset ${offset} does not leave ${PACKED_SIZE} bytes in a ${out.length}-byte buffer`);
  }
  if (result !== 0 && result !== 1 && result !== 2) throw new RangeError(`packPosition: invalid result ${String(result)}`);
  if (Number.isNaN(scoreWhiteCp)) throw new RangeError("packPosition: score is NaN");
  out.fill(0, offset, offset + PACKED_SIZE);
  let lo = 0;
  let hi = 0;
  let k = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq] as number;
    if (piece < 0) continue;
    if (k >= MAX_PACKED_PIECES) throw new RangeError(`packPosition: more than ${MAX_PACKED_PIECES} pieces`);
    if (sq < 32) lo |= 1 << sq;
    else hi |= 1 << (sq - 32);
    const idx = offset + 8 + (k >> 1);
    out[idx] = (out[idx] as number) | (piece << ((k & 1) * 4));
    k++;
  }
  for (let i = 0; i < 4; i++) {
    out[offset + i] = (lo >>> (8 * i)) & 255;
    out[offset + 4 + i] = (hi >>> (8 * i)) & 255;
  }
  const score = Math.max(-PACKED_SCORE_LIMIT, Math.min(PACKED_SCORE_LIMIT, Math.round(scoreWhiteCp)));
  out[offset + 24] = score & 255;
  out[offset + 25] = (score >> 8) & 255;
  out[offset + 26] = result;
  out[offset + 27] = stm;
}

/**
 * Packs a position into 32 bytes at `out[offset]` (a new 32-byte array when `out` is omitted)
 * and returns the array written to. `scoreWhiteCp` is rounded and clamped to ±32000.
 * Throws for an invalid FEN, more than 32 pieces, or an invalid result.
 */
export function packPosition(
  fen: string,
  scoreWhiteCp: number,
  result: PackedResult,
  out?: Uint8Array,
  offset = 0,
): Uint8Array {
  const board = parseFenBoard(fen);
  return packBoard(board.pieces, board.stm, scoreWhiteCp, result, out, offset);
}

/** Same as packPosition, from a piece list (any order). */
export function packBoard(
  pieces: readonly BoardPiece[],
  stm: 0 | 1,
  scoreWhiteCp: number,
  result: PackedResult,
  out?: Uint8Array,
  offset = 0,
): Uint8Array {
  const target = out ?? new Uint8Array(PACKED_SIZE);
  const board = scratchBoard;
  board.fill(-1);
  for (const p of pieces) {
    if (!Number.isInteger(p.sq) || p.sq < 0 || p.sq > 63) throw new RangeError(`packBoard: invalid square ${p.sq}`);
    if (!Number.isInteger(p.piece) || p.piece < 0 || p.piece > 11) throw new RangeError(`packBoard: invalid piece ${p.piece}`);
    if ((board[p.sq] as number) >= 0) throw new RangeError(`packBoard: two pieces on square ${p.sq}`);
    board[p.sq] = p.piece;
  }
  writePacked(board, stm, scoreWhiteCp, result, target, offset);
  return target;
}

/** Overwrites the result byte of an already packed position (results are known at game end). */
export function setPackedResult(buf: Uint8Array, offset: number, result: PackedResult): void {
  if (result !== 0 && result !== 1 && result !== 2) throw new RangeError(`setPackedResult: invalid result ${String(result)}`);
  buf[offset + 26] = result;
}

export interface UnpackedPosition {
  occupancy: bigint;
  /** Pieces in ascending square order; `piece` = color·6 + type. */
  pieces: BoardPiece[];
  /** Search score, centipawns, White's POV. */
  score: number;
  result: PackedResult;
  /** 0 = White to move, 1 = Black. */
  stm: 0 | 1;
}

function asBytes(buf: Uint8Array | ArrayBufferLike): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** Reads the i16 score (White POV). */
export function packedScore(buf: Uint8Array, offset: number): number {
  return (((buf[offset + 24] as number) | ((buf[offset + 25] as number) << 8)) << 16) >> 16;
}

/** Decodes a packed position. Throws RangeError for corrupt records. */
export function unpackPosition(buf: Uint8Array | ArrayBufferLike, offset = 0): UnpackedPosition {
  const b = asBytes(buf);
  if (offset < 0 || offset + PACKED_SIZE > b.length) throw new RangeError(`unpackPosition: offset ${offset} out of range`);
  const err = validatePacked(b, offset);
  if (err) throw new RangeError(`unpackPosition: ${err}`);
  let occupancy = 0n;
  for (let i = 7; i >= 0; i--) occupancy = (occupancy << 8n) | BigInt(b[offset + i] as number);
  const pieces: BoardPiece[] = [];
  let k = 0;
  for (let sq = 0; sq < 64; sq++) {
    const byte = b[offset + (sq >> 3)] as number;
    if (((byte >> (sq & 7)) & 1) === 0) continue;
    const nib = b[offset + 8 + (k >> 1)] as number;
    pieces.push({ sq, piece: (k & 1) === 0 ? nib & 15 : nib >> 4 });
    k++;
  }
  return {
    occupancy,
    pieces,
    score: packedScore(b, offset),
    result: b[offset + 26] as PackedResult,
    stm: b[offset + 27] as 0 | 1,
  };
}

/** FEN of a packed position (castling / en passant are not stored and written as "-"). */
export function packedToFen(buf: Uint8Array | ArrayBufferLike, offset = 0): string {
  const p = unpackPosition(buf, offset);
  return boardToFen(p.pieces, p.stm);
}

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 63;
}

/**
 * Checks one packed record; returns null when valid, otherwise a short reason. Cheap enough to
 * run over a whole dataset at load time (the trainer's hot loop does no validation).
 */
export function validatePacked(buf: Uint8Array, offset: number): string | null {
  const lo = (buf[offset] as number) | ((buf[offset + 1] as number) << 8) | ((buf[offset + 2] as number) << 16) | ((buf[offset + 3] as number) << 24);
  const hi =
    (buf[offset + 4] as number) | ((buf[offset + 5] as number) << 8) | ((buf[offset + 6] as number) << 16) | ((buf[offset + 7] as number) << 24);
  const n = popcount32(lo) + popcount32(hi);
  if (n > MAX_PACKED_PIECES) return `${n} pieces (max ${MAX_PACKED_PIECES})`;
  for (let k = 0; k < n; k++) {
    const nib = buf[offset + 8 + (k >> 1)] as number;
    const code = (k & 1) === 0 ? nib & 15 : nib >> 4;
    if (code > 11) return `invalid piece code ${code}`;
  }
  const result = buf[offset + 26] as number;
  if (result > 2) return `invalid result ${result}`;
  const stm = buf[offset + 27] as number;
  if (stm > 1) return `invalid side to move ${stm}`;
  return null;
}

/** Index arrays written by decodePackedFeatures (32 entries suffice for packed data). */
export type FeatureIndexArray = Uint16Array | Uint32Array | Int32Array;

/**
 * Hot-loop feature extraction straight from packed bytes (no BigInt, no allocation): writes the
 * active feature indices of both perspectives (docs/NNUE_FORMAT.md) and returns their count.
 * The side to move is `buf[offset + 27]`. Expects a record that passed validatePacked().
 */
export function decodePackedFeatures(
  buf: Uint8Array,
  offset: number,
  white: FeatureIndexArray,
  black: FeatureIndexArray,
): number {
  // Occupancy as two u32 halves; iterate set bits from the least significant one.
  let lo = (buf[offset] as number) | ((buf[offset + 1] as number) << 8) | ((buf[offset + 2] as number) << 16) | ((buf[offset + 3] as number) << 24);
  let hi =
    (buf[offset + 4] as number) | ((buf[offset + 5] as number) << 8) | ((buf[offset + 6] as number) << 16) | ((buf[offset + 7] as number) << 24);
  let k = 0;
  while (lo !== 0) {
    const sq = 31 - Math.clz32(lo & -lo);
    lo &= lo - 1;
    const nib = buf[offset + 8 + (k >> 1)] as number;
    const code = (k & 1) === 0 ? nib & 15 : nib >> 4;
    // White POV: code·64 + sq. Black POV: colours swapped, board flipped vertically.
    white[k] = code * 64 + sq;
    black[k] = (code < 6 ? code + 6 : code - 6) * 64 + (sq ^ 56);
    k++;
  }
  while (hi !== 0) {
    const sq = 63 - Math.clz32(hi & -hi);
    hi &= hi - 1;
    const nib = buf[offset + 8 + (k >> 1)] as number;
    const code = (k & 1) === 0 ? nib & 15 : nib >> 4;
    white[k] = code * 64 + sq;
    black[k] = (code < 6 ? code + 6 : code - 6) * 64 + (sq ^ 56);
    k++;
  }
  return k;
}
