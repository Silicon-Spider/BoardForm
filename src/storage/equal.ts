// Structural equality for stored records (plain objects, arrays, primitives, ArrayBuffers and typed
// arrays — exactly what IndexedDB's structured clone gives back). Used by the hook caches to keep
// object identities stable when a re-query returns unchanged data. Worker-safe.

const toTag = (v: object): string => Object.prototype.toString.call(v);

function bytesOf(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const tag = toTag(a);
  if (tag !== toTag(b)) return false;

  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return bytesEqual(bytesOf(a as ArrayBuffer), bytesOf(b as ArrayBuffer));
  }
  if (ArrayBuffer.isView(a)) {
    return ArrayBuffer.isView(b) && bytesEqual(bytesOf(a), bytesOf(b));
  }
  if (tag === "[object Date]") return (a as Date).getTime() === (b as Date).getTime();
  if (tag === "[object Map]" || tag === "[object Set]") {
    // Not used by any record type; compare entries in insertion order.
    return deepEqual([...(a as Map<unknown, unknown>)], [...(b as Map<unknown, unknown>)]);
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
