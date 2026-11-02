// CBNN v1 network files: constants, quantization and strict parsing.
//
// Normative spec: docs/NNUE_FORMAT.md. The JS reference inference (reference.ts) and the
// AssemblyScript engine (engine/template/nnue.ts) both consume what quantizeNetwork() writes,
// so every rounding / clipping rule here is part of the bit-exact contract.
import type { Activation, FloatNetworkData } from "@/types";

/** Number of input features: 2 colours × 6 piece types × 64 squares. */
export const INPUTS = 768;
/** Quantization factor of the feature transformer (W1, b1) and the activation range. */
export const QA = 255;
/** Quantization factor of the output weights (W2). */
export const QB = 64;
/** Output scale: `eval_cp = out · SCALE`. */
export const SCALE = 400;
/** W1, b1 and W2 are clipped to ±WEIGHT_CLIP before quantizing and after every optimizer step. */
export const WEIGHT_CLIP = 1.98;
/** Size of the CBNN header in bytes. */
export const HEADER_SIZE = 64;
export const CBNN_MAGIC = "CBNN";
export const CBNN_VERSION = 1;
export const MIN_HIDDEN = 8;
export const MAX_HIDDEN = 2048;
/** Hidden sizes offered in the UI (any multiple of 8 in [8, 2048] is valid). */
export const HIDDEN_SIZE_PRESETS: readonly number[] = [16, 32, 64, 128, 256, 512];
export const DEFAULT_HIDDEN = 128;
export const DEFAULT_ACTIVATION: Activation = 1;
export const ACTIVATION_NAMES: Readonly<Record<Activation, string>> = { 0: "CReLU", 1: "SCReLU" };

/** Integer network exactly as stored in a CBNN file. */
export interface QuantizedNetwork {
  hidden: number;
  activation: Activation;
  /** 768·HL, feature-major: element (f, j) at `f·HL + j`. */
  w1: Int16Array;
  /** HL */
  b1: Int16Array;
  /** 2·HL, side-to-move half first. */
  w2: Int16Array;
  /** Output bias in QA·QB units (i32). */
  b2: number;
}

/** Thrown for malformed network files or network objects. */
export class NetworkFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFormatError";
  }
}

/** True for a hidden size the format supports (multiple of 8 in [8, 2048]). */
export function isValidHidden(hidden: number): boolean {
  return Number.isInteger(hidden) && hidden >= MIN_HIDDEN && hidden <= MAX_HIDDEN && hidden % 8 === 0;
}

export function assertValidHidden(hidden: number): void {
  if (!isValidHidden(hidden)) {
    throw new NetworkFormatError(
      `Invalid hidden size ${hidden}: must be a multiple of 8 between ${MIN_HIDDEN} and ${MAX_HIDDEN}`,
    );
  }
}

/** Exact CBNN file size: `68 + 1542·HL` bytes (HL = 128 → 197 444). */
export function networkFileSize(hidden: number): number {
  return HEADER_SIZE + 1542 * hidden + 4;
}

/** Byte offsets of the payload sections inside a CBNN file. */
export function networkFileOffsets(hidden: number): { w1: number; b1: number; w2: number; b2: number } {
  return {
    w1: HEADER_SIZE,
    b1: HEADER_SIZE + 1536 * hidden,
    w2: HEADER_SIZE + 1538 * hidden,
    b2: HEADER_SIZE + 1542 * hidden,
  };
}

/** Clamps a weight to [-WEIGHT_CLIP, WEIGHT_CLIP]. */
export function clipWeight(x: number): number {
  return x < -WEIGHT_CLIP ? -WEIGHT_CLIP : x > WEIGHT_CLIP ? WEIGHT_CLIP : x;
}

/** Checks the shapes (and activation) of a float network; throws NetworkFormatError. */
export function validateFloatNetwork(net: FloatNetworkData, what = "network"): void {
  assertValidHidden(net.hidden);
  if (net.activation !== 0 && net.activation !== 1) {
    throw new NetworkFormatError(`${what}: unknown activation ${String(net.activation)} (expected 0 or 1)`);
  }
  const check = (name: string, arr: unknown, len: number) => {
    // Tag check instead of instanceof: arrays may come from another realm (worker, IndexedDB).
    if (Object.prototype.toString.call(arr) !== "[object Float32Array]") {
      throw new NetworkFormatError(`${what}: ${name} must be a Float32Array`);
    }
    const actual = (arr as Float32Array).length;
    if (actual !== len) {
      throw new NetworkFormatError(`${what}: ${name} has ${actual} entries, expected ${len} for hidden size ${net.hidden}`);
    }
  };
  check("w1", net.w1, INPUTS * net.hidden);
  check("b1", net.b1, net.hidden);
  check("w2", net.w2, 2 * net.hidden);
  check("b2", net.b2, 1);
}

function quantizeArray(src: Float32Array, scale: number, name: string): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const x = src[i] as number;
    if (x !== x) throw new NetworkFormatError(`Cannot quantize: ${name}[${i}] is NaN (training diverged?)`);
    // Clipping keeps every value within ±round(1.98·255) = ±505, so the i16 store never wraps.
    out[i] = Math.round(clipWeight(x) * scale);
  }
  return out;
}

/** Quantizes float weights per docs/NNUE_FORMAT.md (clip to ±1.98, then `Math.round`). */
export function quantizeWeights(net: FloatNetworkData): QuantizedNetwork {
  validateFloatNetwork(net);
  const b2f = net.b2[0] as number;
  if (!Number.isFinite(b2f)) throw new NetworkFormatError("Cannot quantize: output bias b2 is not finite (training diverged?)");
  const b2 = Math.round(b2f * QA * QB);
  if (b2 < -2147483648 || b2 > 2147483647) {
    throw new NetworkFormatError(`Cannot quantize: output bias ${b2f} does not fit the i32 field`);
  }
  return {
    hidden: net.hidden,
    activation: net.activation,
    w1: quantizeArray(net.w1, QA, "w1"),
    b1: quantizeArray(net.b1, QA, "b1"),
    w2: quantizeArray(net.w2, QB, "w2"),
    b2,
  };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function writeI16(dv: DataView, offset: number, src: Int16Array): void {
  if (LITTLE_ENDIAN) {
    new Int16Array(dv.buffer, dv.byteOffset + offset, src.length).set(src);
  } else {
    for (let i = 0; i < src.length; i++) dv.setInt16(offset + 2 * i, src[i] as number, true);
  }
}

function readI16(bytes: Uint8Array, offset: number, length: number): Int16Array {
  const out = new Int16Array(length);
  if (LITTLE_ENDIAN) {
    // Copy through bytes so neither alignment nor aliasing of the input buffer matters.
    new Uint8Array(out.buffer).set(bytes.subarray(offset, offset + 2 * length));
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < length; i++) out[i] = dv.getInt16(offset + 2 * i, true);
  }
  return out;
}

/** Writes a quantized network as a CBNN v1 file. */
export function serializeNetwork(q: QuantizedNetwork): ArrayBuffer {
  assertValidHidden(q.hidden);
  if (q.activation !== 0 && q.activation !== 1) throw new NetworkFormatError(`Unknown activation ${String(q.activation)}`);
  const hl = q.hidden;
  if (q.w1.length !== INPUTS * hl || q.b1.length !== hl || q.w2.length !== 2 * hl) {
    throw new NetworkFormatError("Quantized network arrays do not match its hidden size");
  }
  if (!Number.isInteger(q.b2) || q.b2 < -2147483648 || q.b2 > 2147483647) {
    throw new NetworkFormatError(`Output bias ${q.b2} is not an i32`);
  }
  const buf = new ArrayBuffer(networkFileSize(hl));
  const dv = new DataView(buf);
  for (let i = 0; i < 4; i++) dv.setUint8(i, CBNN_MAGIC.charCodeAt(i));
  dv.setUint32(4, CBNN_VERSION, true);
  dv.setUint32(8, INPUTS, true);
  dv.setUint32(12, hl, true);
  dv.setUint32(16, q.activation, true);
  dv.setUint32(20, QA, true);
  dv.setUint32(24, QB, true);
  dv.setUint32(28, SCALE, true);
  dv.setUint32(32, 0, true); // flags (reserved); bytes 36..63 stay zero
  const off = networkFileOffsets(hl);
  writeI16(dv, off.w1, q.w1);
  writeI16(dv, off.b1, q.b1);
  writeI16(dv, off.w2, q.w2);
  dv.setInt32(off.b2, q.b2, true);
  return buf;
}

/** Float network → CBNN v1 file bytes (what engines load). */
export function quantizeNetwork(net: FloatNetworkData): ArrayBuffer {
  return serializeNetwork(quantizeWeights(net));
}

/**
 * Float weights equivalent to a quantized network (W1/b1 ÷ QA, W2 ÷ QB, b2 ÷ QA·QB), e.g. to
 * continue training an imported .nnue file that has no float checkpoint. Quantizing the result
 * reproduces the original file exactly when its weights lie within the clip range
 * (|W1q|, |b1q| ≤ 505, |W2q| ≤ 127 — true for every file this app writes) and |b2q| < 2^23;
 * larger values are clipped / rounded by float32.
 */
export function dequantizeNetwork(q: QuantizedNetwork): FloatNetworkData {
  assertValidHidden(q.hidden);
  const scaled = (src: Int16Array, div: number) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = (src[i] as number) / div;
    return out;
  };
  return {
    hidden: q.hidden,
    activation: q.activation,
    w1: scaled(q.w1, QA),
    b1: scaled(q.b1, QA),
    w2: scaled(q.w2, QB),
    b2: new Float32Array([q.b2 / (QA * QB)]),
  };
}

function toBytes(input: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const tag = Object.prototype.toString.call(input);
  // Tag check instead of instanceof: buffers may come from another realm (worker, jsdom).
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return new Uint8Array(input as ArrayBufferLike);
  }
  throw new NetworkFormatError("Network file must be an ArrayBuffer or a typed array");
}

/** Header fields of a CBNN file (validated). */
export interface NetworkFileHeader {
  version: number;
  inputs: number;
  hidden: number;
  activation: Activation;
  qa: number;
  qb: number;
  scale: number;
  flags: number;
  sizeBytes: number;
}

/**
 * Validates a CBNN file header and size, returning the header. Throws NetworkFormatError with
 * a message suitable for showing to the user. Rejects exactly what docs/NNUE_FORMAT.md lists:
 * magic, version, inputs, hidden size, activation, QA/QB/scale and the total size.
 */
export function readNetworkHeader(input: ArrayBufferLike | ArrayBufferView): NetworkFileHeader {
  const bytes = toBytes(input);
  if (bytes.byteLength < HEADER_SIZE) {
    throw new NetworkFormatError(
      `File too small (${bytes.byteLength} bytes): a CBNN network starts with a ${HEADER_SIZE}-byte header`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0] as number, bytes[1] as number, bytes[2] as number, bytes[3] as number);
  if (magic !== CBNN_MAGIC) {
    const shown = magic.replace(/[^\x20-\x7e]/g, "?");
    throw new NetworkFormatError(`Not a CBNN network file (magic "${shown}", expected "${CBNN_MAGIC}")`);
  }
  const version = dv.getUint32(4, true);
  if (version !== CBNN_VERSION) {
    throw new NetworkFormatError(`Unsupported CBNN version ${version} (this app reads version ${CBNN_VERSION})`);
  }
  const inputs = dv.getUint32(8, true);
  if (inputs !== INPUTS) throw new NetworkFormatError(`Unsupported input size ${inputs} (expected ${INPUTS})`);
  const hidden = dv.getUint32(12, true);
  if (!isValidHidden(hidden)) {
    throw new NetworkFormatError(
      `Invalid hidden size ${hidden}: must be a multiple of 8 between ${MIN_HIDDEN} and ${MAX_HIDDEN}`,
    );
  }
  const activation = dv.getUint32(16, true);
  if (activation !== 0 && activation !== 1) {
    throw new NetworkFormatError(`Unknown activation id ${activation} (expected 0 = CReLU or 1 = SCReLU)`);
  }
  const qa = dv.getUint32(20, true);
  const qb = dv.getUint32(24, true);
  const scale = dv.getUint32(28, true);
  if (qa !== QA) throw new NetworkFormatError(`Unsupported quantization QA = ${qa} (expected ${QA})`);
  if (qb !== QB) throw new NetworkFormatError(`Unsupported quantization QB = ${qb} (expected ${QB})`);
  if (scale !== SCALE) throw new NetworkFormatError(`Unsupported output scale ${scale} (expected ${SCALE})`);
  const expected = networkFileSize(hidden);
  if (bytes.byteLength !== expected) {
    throw new NetworkFormatError(
      `Size mismatch: file has ${bytes.byteLength} bytes, a hidden-${hidden} network needs exactly ${expected}`,
    );
  }
  return { version, inputs, hidden, activation, qa, qb, scale, flags: dv.getUint32(32, true), sizeBytes: expected };
}

/** Parses and validates a CBNN v1 file. The returned arrays are copies (the input is not retained). */
export function parseNetworkFile(input: ArrayBufferLike | ArrayBufferView): QuantizedNetwork {
  const header = readNetworkHeader(input);
  const bytes = toBytes(input);
  const hl = header.hidden;
  const off = networkFileOffsets(hl);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    hidden: hl,
    activation: header.activation,
    w1: readI16(bytes, off.w1, INPUTS * hl),
    b1: readI16(bytes, off.b1, hl),
    w2: readI16(bytes, off.w2, 2 * hl),
    b2: dv.getInt32(off.b2, true),
  };
}

/** Non-throwing variant for import UIs: `{ ok: true, header }` or `{ ok: false, error }`. */
export function inspectNetworkFile(
  input: ArrayBufferLike | ArrayBufferView,
): { ok: true; header: NetworkFileHeader } | { ok: false; error: string } {
  try {
    return { ok: true, header: readNetworkHeader(input) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
