// JSON encoding for backups / engine files. Worker-safe.
//
// IndexedDB records contain values JSON cannot represent. They are written as tagged objects:
//   ArrayBuffer         → { "$cb": "ArrayBuffer", "b64": "<base64>" }
//   typed array / view  → { "$cb": "Float32Array", "b64": "<base64 of its bytes>" }   (any typed array, DataView)
//   NaN / ±Infinity     → { "$cb": "number", "v": "NaN" | "Infinity" | "-Infinity" }
//   bigint              → { "$cb": "bigint", "v": "123" }
//   Date                → { "$cb": "Date", "v": "<ISO string>" }
// A plain object that itself has a "$cb" key is wrapped as { "$cb": "object", "v": {...} } so it
// can never be mistaken for a tag. `undefined` properties are dropped (as JSON does).

import { StorageError } from "./db";

const TAG = "$cb";

interface TypedArrayCtor {
  new (buffer: ArrayBuffer): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
}

const TYPED_ARRAYS = new Map<string, TypedArrayCtor>([
  ["Int8Array", Int8Array],
  ["Uint8Array", Uint8Array],
  ["Uint8ClampedArray", Uint8ClampedArray],
  ["Int16Array", Int16Array],
  ["Uint16Array", Uint16Array],
  ["Int32Array", Int32Array],
  ["Uint32Array", Uint32Array],
  ["Float32Array", Float32Array],
  ["Float64Array", Float64Array],
  ["BigInt64Array", BigInt64Array],
  ["BigUint64Array", BigUint64Array],
]);

// ---------------------------------------------------------------------------------------------
// base64 (uses the native Uint8Array.toBase64 / fromBase64 where the browser has them)

interface Base64Native {
  toBase64?: () => string;
}
interface Base64NativeCtor {
  fromBase64?: (s: string) => Uint8Array;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as Base64Native).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let out = "";
  const SLICE = 0x8000; // keep String.fromCharCode's argument list small
  for (let i = 0; i < bytes.length; i += SLICE) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE) as unknown as number[]);
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64NativeCtor).fromBase64;
  if (typeof native === "function") return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Encode

const tagOf = (v: object): string => Object.prototype.toString.call(v);

/** Convert a stored value into a JSON-safe tree (see header). */
export function encodeValue(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : { [TAG]: "number", v: String(value) };
    case "bigint":
      return { [TAG]: "bigint", v: value.toString() };
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null) return null;
  const obj = value as object;
  const t = tagOf(obj);
  if (t === "[object ArrayBuffer]" || t === "[object SharedArrayBuffer]") {
    return { [TAG]: "ArrayBuffer", b64: bytesToBase64(new Uint8Array(obj as ArrayBuffer)) };
  }
  if (ArrayBuffer.isView(obj)) {
    const kind = t.slice(8, -1); // "[object Float32Array]" → "Float32Array"
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return { [TAG]: TYPED_ARRAYS.has(kind) || kind === "DataView" ? kind : "Uint8Array", b64: bytesToBase64(bytes) };
  }
  if (t === "[object Date]") return { [TAG]: "Date", v: (obj as Date).toISOString() };
  if (Array.isArray(obj)) {
    return obj.map((x) => {
      const e = encodeValue(x);
      return e === undefined ? null : e;
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const e = encodeValue(v);
    if (e !== undefined) out[k] = e;
  }
  return Object.prototype.hasOwnProperty.call(obj, TAG) ? { [TAG]: "object", v: out } : out;
}

// ---------------------------------------------------------------------------------------------
// Decode

function invalid(message: string): StorageError {
  return new StorageError("invalid-data", message);
}

function decodeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = decodeValue(v);
  return out;
}

function decodeTagged(tag: string, obj: Record<string, unknown>): unknown {
  switch (tag) {
    case "object":
      if (typeof obj.v !== "object" || obj.v === null || Array.isArray(obj.v)) throw invalid("Corrupt file: bad escaped object.");
      return decodeObject(obj.v as Record<string, unknown>);
    case "number":
      if (obj.v !== "NaN" && obj.v !== "Infinity" && obj.v !== "-Infinity") throw invalid("Corrupt file: bad number value.");
      return Number(obj.v);
    case "bigint":
      if (typeof obj.v !== "string") throw invalid("Corrupt file: bad bigint value.");
      return BigInt(obj.v);
    case "Date":
      if (typeof obj.v !== "string") throw invalid("Corrupt file: bad date value.");
      return new Date(obj.v);
  }
  if (typeof obj.b64 !== "string") throw invalid(`Corrupt file: "${tag}" value without data.`);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(obj.b64);
  } catch {
    throw invalid(`Corrupt file: "${tag}" value has invalid base64 data.`);
  }
  // Copy into a fresh, exactly-sized buffer (also guarantees alignment for wider element types).
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  if (tag === "ArrayBuffer") return buffer;
  if (tag === "DataView") return new DataView(buffer);
  const Ctor = TYPED_ARRAYS.get(tag);
  if (!Ctor) throw invalid(`Unsupported value type "${tag}" — was this file made by a newer version of BoardForm?`);
  if (buffer.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) throw invalid(`Corrupt file: "${tag}" data has a wrong length.`);
  return new Ctor(buffer);
}

/** Inverse of encodeValue. Throws a StorageError ("invalid-data") on malformed tags. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  const tag = obj[TAG];
  if (typeof tag === "string") return decodeTagged(tag, obj);
  return decodeObject(obj);
}
