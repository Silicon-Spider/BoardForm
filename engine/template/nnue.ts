// =====================================================================================
// nnue.ts — evaluating positions with a neural network (NNUE)
// =====================================================================================
//
// NNUE ("efficiently updatable neural network") is the kind of evaluation the strongest
// engines use today. Chess Builder trains small NNUE networks in its Lab; this file loads
// such a network (a CBNN file, see docs/NNUE_FORMAT.md) and computes its evaluation. It
// follows the integer arithmetic of the format exactly, so the engine's score is always
// identical to the one the app computes in JavaScript.
//
// The network, "(768 -> HL) x 2 -> 1":
//
//   * Inputs: 768 on/off features, one for every (colour, piece type, square), e.g. "white
//     knight on f3". A position switches on one feature per piece on the board.
//
//   * Feature transformer: a weight row W1[f] of HL numbers for every feature f, plus a bias
//     row b1. The *accumulator* is the bias plus the rows of all active features:
//
//         acc[j] = b1[j] + Σ W1[f][j]    (sum over the features f of the pieces on the board)
//
//     It is computed twice, once from each side's point of view ("perspective"). White's
//     perspective numbers the features "white pieces first, board as it is"; Black's numbers
//     them "black pieces first, board flipped vertically". Both sides thus see the board the
//     same way, so they can share the same weights.
//
//   * Activation: CReLU clamps every accumulator value to [0, 1]; SCReLU clamps and squares.
//
//   * Output layer: 2·HL weights W2 and a bias b2. The first HL weights belong to the
//     accumulator of the side to move, the next HL to the opponent's:
//
//         out = Σ act(acc_us[j])·W2[j] + Σ act(acc_them[j])·W2[HL + j] + b2
//
//     out × 400 is the evaluation in centipawns from the side to move's point of view.
//
// Integers ("quantization"): the file stores W1 and b1 multiplied by QA = 255 and W2 by
// QB = 64, rounded to 16-bit integers (b2 multiplied by QA·QB, as a 32-bit integer). So 1.0
// is 255 inside the accumulator, the activation clamps to [0, 255], and the output is scaled
// back at the end. Everything is integer arithmetic: fast and exactly reproducible.
//
// Speed: this engine computes the accumulators from scratch at every evaluation (a "full
// refresh": one weight row per piece and perspective). Strong engines update them
// incrementally in makeMove instead (a move changes only 2 to 4 features), which is a good
// project if you want more speed. To make the refresh fast, the inner loops use WebAssembly
// SIMD: a `v128` value holds eight 16-bit lanes, so one `i16x8.add` adds eight weights.

import { Position } from "./position";
import { WHITE, BLACK, MATE_BOUND, pieceColor, pieceType } from "./types";
import { lsb } from "./bitboard";
import { logMessage } from "./io";
import { ttClear } from "./tt";

// --------------------------------------------------------------------- the format

/** Quantization of the feature transformer (W1, b1): 1.0 is stored as QA. */
const QA: i32 = 255;
/** Quantization of the output weights (W2): 1.0 is stored as QB. */
const QB: i32 = 64;
/** A network output of 1.0 means SCALE centipawns. */
const SCALE: i32 = 400;
/** Number of input features: 2 colours × 6 piece types × 64 squares. */
const INPUTS: i32 = 768;
/** Allowed hidden sizes: multiples of 8 from MIN_HIDDEN to MAX_HIDDEN. */
const MIN_HIDDEN: i32 = 8;
const MAX_HIDDEN: i32 = 2048;
/** Activation ids in the file header. */
const CRELU: i32 = 0;
const SCRELU: i32 = 1;

/** The four bytes "CBNN" read as one little-endian u32. */
const MAGIC: u32 = 0x4E4E4243;
const VERSION: u32 = 1;
/** The header is 64 bytes; the weights follow (docs/NNUE_FORMAT.md, "Network file format"). */
const HEADER_BYTES: i32 = 64;

/**
 * Largest buffer nnueAlloc hands out. A valid file has 68 + 1542·HL bytes, at most about
 * 3 MB (HL = 2048); slightly larger files still get a buffer so nnueLoad can explain the
 * problem instead of failing silently.
 */
const MAX_FILE_BYTES: i32 = 8 << 20;

/** Evaluations are clamped to ±EVAL_LIMIT so they can never be mistaken for mate scores. */
const EVAL_LIMIT: i64 = <i64>(MATE_BOUND - 1);

// --------------------------------------------------------------------------- state

// The buffer the host copies a network file into (cb_nnue_alloc), reused between loads.
let fileBuffer: usize = 0;
let fileCapacity: i32 = 0;
/** Size asked for by the last cb_nnue_alloc: the host promised to copy that many bytes. */
let fileRequested: i32 = 0;

// The active network. nnueLoad copies the weights out of the file buffer into their own
// block of memory, so the host may reuse the file buffer, and a rejected file never
// disturbs the network that is already loaded.
let ready = false;
let hidden: i32 = 0; // HL
let activation: i32 = SCRELU;
let paramsBlock: usize = 0; // heap block holding all weights (kept for heap.free)
let paramsCapacity: usize = 0;
let W1: usize = 0; // i16[768·HL]; the row of feature f starts at W1 + f·rowBytes
let B1: usize = 0; // i16[HL]
let W2: usize = 0; // i16[2·HL], the side to move's half first
let B2: i32 = 0;
let rowBytes: usize = 0; // bytes per W1 row (2·HL)
/** True if every |W2| ≤ 128, which allows the faster SCReLU output loop (see below). */
let smallOutputWeights = false;

// Work space of nnueEvaluate (static memory, so evaluating never allocates).
// One accumulator per perspective, and per perspective the addresses of the W1 rows of the
// pieces on the board. There is at most one piece per square, so 64 entries always suffice.
const MAX_PIECES: i32 = 64;
const ACC_WHITE: usize = memory.data(MAX_HIDDEN * 2, 16);
const ACC_BLACK: usize = memory.data(MAX_HIDDEN * 2, 16);
const ROWS_WHITE: usize = memory.data(MAX_PIECES * 4, 16); // 4 bytes per address (wasm32)
const ROWS_BLACK: usize = memory.data(MAX_PIECES * 4, 16);

// ------------------------------------------------------------------- loading a file

/**
 * Returns the address of a buffer of at least `size` bytes for the host to copy a network
 * file into (backs cb_nnue_alloc), or 0 if `size` is not plausible.
 */
export function nnueAlloc(size: i32): usize {
  if (size <= 0 || size > MAX_FILE_BYTES) return 0;
  fileRequested = size;
  if (fileBuffer != 0 && fileCapacity >= size) return fileBuffer;
  if (fileBuffer != 0) heap.free(fileBuffer);
  fileBuffer = heap.alloc(<usize>size);
  fileCapacity = size;
  return fileBuffer;
}

/**
 * Checks the `size`-byte file in the nnueAlloc buffer and makes it the active network
 * (backs cb_nnue_load). Returns false, with the reason in the engine log, for anything
 * docs/NNUE_FORMAT.md says a loader must reject; the previous network then stays active.
 */
export function nnueLoad(size: i32): bool {
  if (fileBuffer == 0) return reject("no buffer: call cb_nnue_alloc first");
  // Never read beyond what the host said it would copy (or stale bytes of an earlier file).
  if (size > fileRequested) {
    return reject("size " + size.toString() + " is larger than the " + fileRequested.toString() + " bytes requested from cb_nnue_alloc");
  }
  if (size < HEADER_BYTES) return reject("file too short (" + size.toString() + " bytes)");

  // 1. The header: every field must have the value this engine understands.
  const p = fileBuffer;
  if (load<u32>(p, 0) != MAGIC) return reject("not a CBNN network file (wrong magic)");
  const version = load<u32>(p, 4);
  if (version != VERSION) return reject("unsupported CBNN version " + version.toString());
  const inputs = load<u32>(p, 8);
  if (inputs != <u32>INPUTS) return reject("unsupported input size " + inputs.toString() + " (expected 768)");
  const hl = load<u32>(p, 12);
  if (hl < <u32>MIN_HIDDEN || hl > <u32>MAX_HIDDEN || (hl & 7) != 0) {
    return reject("hidden size " + hl.toString() + " is not a multiple of 8 between 8 and 2048");
  }
  const act = load<u32>(p, 16);
  if (act != <u32>CRELU && act != <u32>SCRELU) return reject("unknown activation " + act.toString());
  if (load<u32>(p, 20) != <u32>QA || load<u32>(p, 24) != <u32>QB || load<u32>(p, 28) != <u32>SCALE) {
    return reject("unsupported quantization (QA, QB and scale must be 255, 64 and 400)");
  }
  // Offset 32 holds flags and 36..63 are reserved; like the app's own reader we ignore them.

  // 2. The size must match the hidden size exactly: 64 header bytes, W1, b1, W2 and b2.
  const expected = <u32>HEADER_BYTES + 1542 * hl + 4;
  if (<u32>size != expected) {
    return reject("file has " + size.toString() + " bytes, expected " + expected.toString() + " for hidden size " + hl.toString());
  }

  // 3. Copy the weights into their own 16-byte aligned block. The layout stays exactly as in
  //    the file: W1 (768·HL i16), b1 (HL i16), W2 (2·HL i16), b2 (i32). With HL a multiple of
  //    8, every array and every W1 row then starts on a 16-byte boundary, which suits v128.
  const bytes = <usize>(expected - <u32>HEADER_BYTES);
  if (paramsCapacity < bytes) {
    const block = heap.alloc(bytes + 15); // (allocated before the old block is freed)
    if (paramsBlock != 0) heap.free(paramsBlock);
    paramsBlock = block;
    paramsCapacity = bytes;
  }
  const base = (paramsBlock + 15) & ~<usize>15;
  memory.copy(base, p + <usize>HEADER_BYTES, bytes);

  const n = <usize>hl;
  hidden = <i32>hl;
  activation = <i32>act;
  rowBytes = n * 2;
  W1 = base;
  B1 = W1 + <usize>INPUTS * rowBytes;
  W2 = B1 + rowBytes;
  B2 = load<i32>(W2 + 2 * rowBytes);
  smallOutputWeights = true;
  for (let i: usize = 0; i < 2 * n; i++) {
    const w = <i32>load<i16>(W2 + (i << 1));
    if (w < -128 || w > 128) {
      smallOutputWeights = false;
      break;
    }
  }
  ready = true;
  // The hash table stores evaluations and scores of the previous network: forget them.
  ttClear();
  logMessage("NNUE: 768 -> " + hl.toString() + " x2 -> 1, " + (act == <u32>SCRELU ? "SCReLU" : "CReLU"));
  return true;
}

/** True once a network has been loaded successfully. */
export function nnueReady(): bool {
  return ready;
}

/** Logs why a network file was rejected and returns false. */
function reject(reason: string): bool {
  logMessage("NNUE: " + reason);
  return false;
}

// ---------------------------------------------------------------------- evaluation

/**
 * Evaluation of `pos` by the loaded network, in centipawns from the side to move's point of
 * view, exactly as specified in docs/NNUE_FORMAT.md (clamped to ±(MATE_BOUND - 1)).
 * Returns 0 if no network is loaded (check nnueReady() first).
 */
export function nnueEvaluate(pos: Position): i32 {
  if (!ready) return 0;
  const count = collectFeatures(pos);
  refreshAccumulator(ACC_WHITE, ROWS_WHITE, count);
  refreshAccumulator(ACC_BLACK, ROWS_BLACK, count);
  const us = pos.side == WHITE ? ACC_WHITE : ACC_BLACK;
  const them = pos.side == WHITE ? ACC_BLACK : ACC_WHITE;

  // The output layer, then the reference formula with 64-bit integers. Integer division
  // in AssemblyScript truncates toward zero, which is exactly what the format specifies.
  let out: i64;
  if (activation == CRELU) {
    out = outputCReLU(us, them) + <i64>B2;
  } else {
    const sum = smallOutputWeights ? outputSCReLU(us, them) : outputSCReLUWide(us, them);
    out = sum / <i64>QA + <i64>B2;
  }
  let cp = out * <i64>SCALE / <i64>(QA * QB);
  if (cp > EVAL_LIMIT) cp = EVAL_LIMIT;
  else if (cp < -EVAL_LIMIT) cp = -EVAL_LIMIT;
  return <i32>cp;
}

/**
 * Writes, for every piece on the board, the address of its W1 row as seen by White into
 * ROWS_WHITE and as seen by Black into ROWS_BLACK. Returns the number of pieces.
 *
 * Feature numbers (docs/NNUE_FORMAT.md): from White's perspective a piece is
 * `(white ? 0 : 384) + type·64 + square`; from Black's perspective `(black ? 0 : 384) +
 * type·64 + (square ^ 56)`. (`square ^ 56` flips the board vertically: a1 <-> a8.)
 */
function collectFeatures(pos: Position): i32 {
  const w1 = W1;
  const stride = rowBytes;
  let count = 0;
  for (let piece = 0; piece < 12; piece++) {
    const color = pieceColor(piece);
    const type = pieceType(piece);
    // Feature number of this piece type on a1, for each perspective ("own pieces first").
    const whiteBase = (color == WHITE ? 0 : 384) + type * 64;
    const blackBase = (color == BLACK ? 0 : 384) + type * 64;
    let bb = pos.pieceBB(piece);
    while (bb != 0) {
      const sq = lsb(bb);
      bb &= bb - 1;
      const slot = <usize>count << 2;
      store<usize>(ROWS_WHITE + slot, w1 + <usize>(whiteBase + sq) * stride);
      store<usize>(ROWS_BLACK + slot, w1 + <usize>(blackBase + (sq ^ 56)) * stride);
      count++;
    }
  }
  return count;
}

/**
 * acc = b1 + the sum of the `count` W1 rows listed at `rows`, in 16-bit lanes. With the
 * format's clipped weights (|W1|, |b1| ≤ 505, at most 32 pieces) the sums always fit; for
 * other files a lane wraps around on overflow, exactly like the i16 accumulator of the spec.
 *
 * To keep memory traffic low, the accumulator is built in tiles of 64 values that stay in
 * eight v128 variables (CPU registers) while all rows are added; each tile is stored once.
 * HL is a multiple of 8 but not necessarily of 64, so the rest is done 8 values at a time.
 */
function refreshAccumulator(acc: usize, rows: usize, count: i32): void {
  const bytes = rowBytes;
  const b1 = B1;
  const end = rows + (<usize>count << 2);
  let off: usize = 0;
  for (; off + 128 <= bytes; off += 128) {
    const b = b1 + off;
    let a0 = v128.load(b, 0);
    let a1 = v128.load(b, 16);
    let a2 = v128.load(b, 32);
    let a3 = v128.load(b, 48);
    let a4 = v128.load(b, 64);
    let a5 = v128.load(b, 80);
    let a6 = v128.load(b, 96);
    let a7 = v128.load(b, 112);
    for (let r = rows; r < end; r += 4) {
      const w = load<usize>(r) + off;
      a0 = i16x8.add(a0, v128.load(w, 0));
      a1 = i16x8.add(a1, v128.load(w, 16));
      a2 = i16x8.add(a2, v128.load(w, 32));
      a3 = i16x8.add(a3, v128.load(w, 48));
      a4 = i16x8.add(a4, v128.load(w, 64));
      a5 = i16x8.add(a5, v128.load(w, 80));
      a6 = i16x8.add(a6, v128.load(w, 96));
      a7 = i16x8.add(a7, v128.load(w, 112));
    }
    const out = acc + off;
    v128.store(out, a0, 0);
    v128.store(out, a1, 16);
    v128.store(out, a2, 32);
    v128.store(out, a3, 48);
    v128.store(out, a4, 64);
    v128.store(out, a5, 80);
    v128.store(out, a6, 96);
    v128.store(out, a7, 112);
  }
  for (; off < bytes; off += 16) {
    let a = v128.load(b1 + off);
    for (let r = rows; r < end; r += 4) a = i16x8.add(a, v128.load(load<usize>(r) + off));
    v128.store(acc + off, a);
  }
}

// ------------------------------------------------------------------- output layer
// Each function returns the exact 64-bit sum over both accumulators. v128 lanes hold eight
// i16 values; `i32x4.dot_i16x8_s(a, b)` multiplies lane by lane and adds neighbouring pairs
// into four i32 lanes. The comments give the largest possible magnitude of each step, which
// shows that nothing can overflow.

/** Clamps eight i16 lanes to [0, QA]: the "CReLU" part of both activations. */
@inline
function clampToQA(x: v128): v128 {
  return i16x8.min_s(i16x8.max_s(x, i16x8.splat(0)), i16x8.splat(<i16>QA));
}

/** Adds the four i32 lanes of `x` to the two i64 lanes of `sum`. */
@inline
function addWidened(sum: v128, x: v128): v128 {
  return i64x2.add(sum, i64x2.add(i64x2.extend_low_i32x4_s(x), i64x2.extend_high_i32x4_s(x)));
}

/** CReLU: Σ cr(us[j])·W2[j] + Σ cr(them[j])·W2[HL + j]. */
function outputCReLU(us: usize, them: usize): i64 {
  const bytes = rowBytes;
  const w2us = W2;
  const w2them = W2 + bytes;
  let sum = i64x2.splat(0);
  for (let off: usize = 0; off < bytes; off += 16) {
    const a = clampToQA(v128.load(us + off));
    const b = clampToQA(v128.load(them + off));
    // A dot lane is the sum of two products a·w: at most 2·255·32768 ≈ 16.7 million, so the
    // two dot products together (≈ 33 million) fit easily in an i32 lane.
    const d = i32x4.add(i32x4.dot_i16x8_s(a, v128.load(w2us + off)), i32x4.dot_i16x8_s(b, v128.load(w2them + off)));
    sum = addWidened(sum, d);
  }
  return i64x2.extract_lane(sum, 0) + i64x2.extract_lane(sum, 1);
}

/**
 * SCReLU: Σ cr(us[j])²·W2[j] + Σ cr(them[j])²·W2[HL + j], for networks whose output weights
 * all lie in [-128, 128] (always true for networks trained in Chess Builder, where |W2| ≤
 * 127). Then a·w fits in 16 bits (255·128 = 32640), so `i16x8.mul` computes it exactly and a
 * dot product with `a` gives (a·w)·a = a²·w.
 */
function outputSCReLU(us: usize, them: usize): i64 {
  const bytes = rowBytes;
  const w2us = W2;
  const w2them = W2 + bytes;
  let sum = i64x2.splat(0);
  for (let off: usize = 0; off < bytes; off += 16) {
    const a = clampToQA(v128.load(us + off));
    const b = clampToQA(v128.load(them + off));
    // A dot lane is the sum of two products (a·w)·a: at most 2·32640·255 ≈ 16.6 million, so
    // the two dot products together (≈ 33 million) fit easily in an i32 lane.
    const d = i32x4.add(
      i32x4.dot_i16x8_s(i16x8.mul(a, v128.load(w2us + off)), a),
      i32x4.dot_i16x8_s(i16x8.mul(b, v128.load(w2them + off)), b),
    );
    sum = addWidened(sum, d);
  }
  return i64x2.extract_lane(sum, 0) + i64x2.extract_lane(sum, 1);
}

/**
 * SCReLU for any output weights (a file written elsewhere may use the whole i16 range). Then
 * a·w no longer fits in 16 bits, and a²·w can reach ±2.1 billion, so not even two of them fit
 * in 32 bits: this plain loop computes every product and the sum in 64 bits.
 */
function outputSCReLUWide(us: usize, them: usize): i64 {
  const n = <usize>hidden;
  const w2them = W2 + rowBytes;
  let sum: i64 = 0;
  for (let j: usize = 0; j < n; j++) {
    const at = j << 1;
    let a = <i32>load<i16>(us + at);
    let b = <i32>load<i16>(them + at);
    a = a < 0 ? 0 : a > QA ? QA : a;
    b = b < 0 ? 0 : b > QA ? QA : b;
    sum += <i64>(a * a) * <i64>load<i16>(W2 + at) + <i64>(b * b) * <i64>load<i16>(w2them + at);
  }
  return sum;
}
