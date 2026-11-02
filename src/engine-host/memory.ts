// Reading and writing an engine's linear memory.
//
// Views are re-created on every access: when the module grows its memory, the old
// `memory.buffer` ArrayBuffer is detached and any cached Uint8Array over it becomes empty.

const utf8Decoder = new TextDecoder("utf-8");
const utf16Decoder = new TextDecoder("utf-16le");
const utf8Encoder = new TextEncoder();

/** Longest AssemblyScript string we decode (abort messages, trace labels). */
const MAX_AS_STRING_BYTES = 1 << 16;

export class WasmMemoryAccess {
  private memory: WebAssembly.Memory | null = null;

  attach(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  get attached(): boolean {
    return this.memory !== null;
  }

  /** Fresh byte view of the whole memory (empty if no memory is attached yet). */
  bytes(): Uint8Array {
    return this.memory ? new Uint8Array(this.memory.buffer) : new Uint8Array(0);
  }

  dataView(): DataView {
    return this.memory ? new DataView(this.memory.buffer) : new DataView(new ArrayBuffer(0));
  }

  get byteLength(): number {
    return this.memory ? this.memory.buffer.byteLength : 0;
  }

  /** Copies `len` bytes at `ptr` (clamped to memory bounds). */
  read(ptr: number, len: number): Uint8Array {
    const mem = this.bytes();
    const start = Math.max(0, Math.min(ptr, mem.length));
    const end = Math.max(start, Math.min(start + Math.max(0, len), mem.length));
    // slice() copies: TextDecoder rejects views of shared memories, and callers may keep the bytes.
    return mem.slice(start, end);
  }

  readUtf8(ptr: number, len: number): string {
    if (len <= 0) return "";
    return utf8Decoder.decode(this.read(ptr, len));
  }

  /** Writes bytes at `ptr`; returns false if they do not fit in memory. */
  write(ptr: number, data: Uint8Array): boolean {
    const mem = this.bytes();
    if (ptr < 0 || ptr + data.length > mem.length) return false;
    mem.set(data, ptr);
    return true;
  }

  /** Writes UTF-8 text at `ptr` if it fits in `capacity` bytes; returns the byte length or -1. */
  writeUtf8(ptr: number, text: string, capacity: number): number {
    const data = utf8Encoder.encode(text);
    if (data.length > capacity) return -1;
    return this.write(ptr, data) ? data.length : -1;
  }

  /**
   * Decodes an AssemblyScript string: UTF-16LE data at `ptr`, byte length stored as u32 at `ptr - 4`
   * (the object header's rtSize). Returns null for 0 / out-of-range pointers.
   */
  readAsString(ptr: number): string | null {
    if (!Number.isFinite(ptr) || ptr < 4) return null;
    const size = this.byteLength;
    if (ptr > size) return null;
    let len = this.dataView().getUint32(ptr - 4, true);
    len = Math.min(len, size - ptr, MAX_AS_STRING_BYTES) & ~1;
    return utf16Decoder.decode(this.read(ptr, len));
  }
}
