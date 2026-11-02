// Minimal WebAssembly binary reader: the signatures of a module's imports and exports.
//
// `WebAssembly.Module.imports()/exports()` only give names and kinds. The host also needs value
// types (an import stub must return `0n` for i64 results, imported memories need their limits,
// and uploaded engines are checked against the ABI's signatures), so we read the type, import,
// function and export sections ourselves. Anything unexpected makes the reader return null and
// callers fall back to best-effort behaviour.

export type WasmValType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref" | "ref";
export type WasmExternKind = "function" | "table" | "memory" | "global" | "tag";

export interface WasmFuncType {
  params: WasmValType[];
  results: WasmValType[];
}

export interface WasmLimits {
  initial: number;
  maximum: number | null;
  shared: boolean;
  /** memory64 / table64 */
  index64: boolean;
}

export type WasmImportInfo =
  | { module: string; name: string; kind: "function"; type: WasmFuncType | null }
  | { module: string; name: string; kind: "table"; element: WasmValType; limits: WasmLimits }
  | { module: string; name: string; kind: "memory"; limits: WasmLimits }
  | { module: string; name: string; kind: "global"; valueType: WasmValType; mutable: boolean }
  | { module: string; name: string; kind: "tag" };

export interface WasmExportInfo {
  name: string;
  kind: WasmExternKind;
  /** Signature for function exports (null if unknown). */
  type: WasmFuncType | null;
}

export interface WasmModuleInfo {
  imports: WasmImportInfo[];
  exports: WasmExportInfo[];
}

const KINDS: WasmExternKind[] = ["function", "table", "memory", "global", "tag"];

class Reader {
  pos: number;
  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
  }

  u8(): number {
    if (this.pos >= this.end) throw new Error("unexpected end of section");
    return this.bytes[this.pos++];
  }

  /** Unsigned LEB128 (up to 64 bits, returned as a Number). */
  uleb(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error("LEB128 too long");
  }

  /** Signed LEB128 (heap types are s33); value only needed to skip it. */
  sleb(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.u8();
      result |= (b & 0x7f) << Math.min(shift, 28);
      shift += 7;
      if (shift > 70) throw new Error("LEB128 too long");
    } while (b & 0x80);
    return result;
  }

  name(): string {
    const len = this.uleb();
    if (this.pos + len > this.end) throw new Error("name out of bounds");
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return text;
  }

  valType(): WasmValType {
    const b = this.u8();
    switch (b) {
      case 0x7f:
        return "i32";
      case 0x7e:
        return "i64";
      case 0x7d:
        return "f32";
      case 0x7c:
        return "f64";
      case 0x7b:
        return "v128";
      case 0x70:
        return "funcref";
      case 0x6f:
        return "externref";
      case 0x63: // (ref null ht)
      case 0x64: // (ref ht)
        this.sleb();
        return "ref";
      default:
        // Other single-byte reference type shorthands (anyref, eqref, i31ref, nullref, exnref...).
        if (b >= 0x69 && b <= 0x74) return "ref";
        throw new Error(`unknown value type 0x${b.toString(16)}`);
    }
  }

  vecValTypes(): WasmValType[] {
    const n = this.uleb();
    const out: WasmValType[] = [];
    for (let i = 0; i < n; i++) out.push(this.valType());
    return out;
  }

  limits(): WasmLimits {
    const flags = this.u8();
    const initial = this.uleb();
    const maximum = flags & 1 ? this.uleb() : null;
    return { initial, maximum, shared: (flags & 2) !== 0, index64: (flags & 4) !== 0 };
  }
}

/** Reads import/export signatures; returns null if the bytes are not a module this reader understands. */
export function readModuleInfo(bytes: Uint8Array): WasmModuleInfo | null {
  try {
    if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
    const types: WasmFuncType[] = [];
    const imports: WasmImportInfo[] = [];
    /** Type index of every function in the function index space (imports first). */
    const funcTypes: number[] = [];
    const rawExports: Array<{ name: string; kind: WasmExternKind; index: number }> = [];

    let pos = 8;
    while (pos < bytes.length) {
      const header = new Reader(bytes, pos, bytes.length);
      const id = header.u8();
      const size = header.uleb();
      const start = header.pos;
      const end = start + size;
      if (end > bytes.length) return null;
      const r = new Reader(bytes, start, end);

      if (id === 1) {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const form = r.u8();
          if (form !== 0x60) return null; // GC / rec groups: not needed by any engine toolchain we target
          types.push({ params: r.vecValTypes(), results: r.vecValTypes() });
        }
      } else if (id === 2) {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const module = r.name();
          const name = r.name();
          const kind = r.u8();
          if (kind === 0x00) {
            const typeIndex = r.uleb();
            funcTypes.push(typeIndex);
            imports.push({ module, name, kind: "function", type: types[typeIndex] ?? null });
          } else if (kind === 0x01) {
            const element = r.valType();
            imports.push({ module, name, kind: "table", element, limits: r.limits() });
          } else if (kind === 0x02) {
            imports.push({ module, name, kind: "memory", limits: r.limits() });
          } else if (kind === 0x03) {
            const valueType = r.valType();
            imports.push({ module, name, kind: "global", valueType, mutable: r.u8() === 1 });
          } else if (kind === 0x04) {
            r.u8(); // attribute
            r.uleb(); // type index
            imports.push({ module, name, kind: "tag" });
          } else {
            return null;
          }
        }
      } else if (id === 3) {
        const count = r.uleb();
        for (let i = 0; i < count; i++) funcTypes.push(r.uleb());
      } else if (id === 7) {
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const name = r.name();
          const kind = KINDS[r.u8()];
          if (!kind) return null;
          rawExports.push({ name, kind, index: r.uleb() });
        }
      }
      pos = end;
    }

    const exports: WasmExportInfo[] = rawExports.map((e) => ({
      name: e.name,
      kind: e.kind,
      type: e.kind === "function" ? (types[funcTypes[e.index]] ?? null) : null,
    }));
    return { imports, exports };
  } catch {
    return null;
  }
}

// --- Module → info registry -------------------------------------------------------------------
// A compiled WebAssembly.Module no longer has its bytes, so we remember the info of modules we
// compiled ourselves. The engine worker receives the info next to the module and re-registers it.

const registry = new WeakMap<WebAssembly.Module, WasmModuleInfo>();

export function rememberModuleInfo(module: WebAssembly.Module, info: WasmModuleInfo | null): void {
  if (info) registry.set(module, info);
}

export function moduleInfoOf(module: WebAssembly.Module): WasmModuleInfo | null {
  return registry.get(module) ?? null;
}

/** Compiles bytes to a module and registers its info. */
export async function compileModule(bytes: ArrayBuffer | Uint8Array): Promise<WebAssembly.Module> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const module = await WebAssembly.compile(view as BufferSource);
  rememberModuleInfo(module, readModuleInfo(view));
  return module;
}

/** "(i32, f64) -> i32" */
export function formatFuncType(t: WasmFuncType): string {
  const results = t.results.length === 0 ? "void" : t.results.length === 1 ? t.results[0] : `(${t.results.join(", ")})`;
  return `(${t.params.join(", ")}) -> ${results}`;
}
