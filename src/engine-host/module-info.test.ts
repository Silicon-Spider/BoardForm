import { beforeAll, describe, expect, it } from "vitest";
import { EXPORT_SIGNATURES, checkExportSignatures } from "./abi";
import { compileFixture, compileSources, minimalEngineSource } from "./__fixtures__/compile";
import { EngineInstance } from "./instance";
import { compileModule, formatFuncType, moduleInfoOf, readModuleInfo } from "./module-info";

let wasm: Uint8Array;
beforeAll(async () => {
  wasm = await compileFixture();
});

describe("readModuleInfo", () => {
  it("reads import and export signatures", () => {
    const info = readModuleInfo(wasm)!;
    expect(info).not.toBeNull();
    expect(info.imports).toContainEqual({ module: "env", name: "cb_info", kind: "function", type: { params: ["i32", "i32", "i32", "i32", "f64", "f64", "i32"], results: [] } });
    expect(info.imports).toContainEqual({
      module: "wasi_snapshot_preview1",
      name: "clock_time_get",
      kind: "function",
      type: { params: ["i32", "i64", "i32"], results: ["i32"] },
    });
    const go = info.exports.find((e) => e.name === "cb_go")!;
    expect(go.type).toEqual(EXPORT_SIGNATURES.cb_go);
    expect(info.exports.find((e) => e.name === "memory")).toEqual({ name: "memory", kind: "memory", type: null });
    expect(formatFuncType(go.type!)).toBe("(i32, f64, i32, i32, i32, i32, i32, i32) -> i32");
  });

  it("returns null for bytes it cannot read", () => {
    expect(readModuleInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(readModuleInfo(wasm.subarray(0, 40))).toBeNull();
  });

  it("registers info for modules compiled through compileModule", async () => {
    const m = await compileModule(wasm);
    expect(moduleInfoOf(m)?.exports.length).toBeGreaterThan(10);
    expect(moduleInfoOf(await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>))).toBeNull();
  });
});

describe("ABI signature checks", () => {
  it("accepts the fixture", () => {
    expect(checkExportSignatures(readModuleInfo(wasm)!)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects i64 parameters and warns about convertible mismatches", async () => {
    const src = minimalEngineSource().replace("nodes: f64", "nodes: i64") + "\nexport function cb_perft(depth: i32): i32 { return 20; }\n";
    const r = await compileSources({ "main.ts": src });
    expect(r.ok).toBe(true);
    const checked = checkExportSignatures(readModuleInfo(r.wasm!)!);
    expect(checked.errors).toHaveLength(1);
    expect(checked.errors[0]).toMatch(/^cb_go has signature \(i32, i64, .*i64 parameters cannot be passed/);
    expect(checked.warnings).toHaveLength(1);
    expect(checked.warnings[0]).toMatch(/^cb_perft has signature \(i32\) -> i32, the ABI expects \(i32\) -> f64/);
    await expect(EngineInstance.create(r.wasm!)).rejects.toThrow(/Incompatible engine: cb_go has signature/);
  });
});

describe("imports that need type information", () => {
  it("creates an imported memory with the declared limits", async () => {
    const r = await compileSources({ "main.ts": minimalEngineSource() }, "main.ts", { extraArgs: ["--importMemory", "--initialMemory", "5"] });
    expect(r.ok).toBe(true);
    const mem = readModuleInfo(r.wasm!)!.imports.find((i) => i.kind === "memory");
    expect(mem).toMatchObject({ module: "env", name: "memory", kind: "memory" });
    const e = await EngineInstance.create(r.wasm!);
    e.position("startpos", []);
    expect(e.go({ depth: 1 }).bestMove).toBe("e2e4");
  });

  it("returns 0n from stubs of unknown imports with i64 results", async () => {
    const r = await compileSources({
      "main.ts": minimalEngineSource({ extra: `import { big_import } from "./env";\nexport function dbg_big(): i32 { return <i32>(big_import() + 1); }` }),
      "env.ts": "export declare function big_import(): i64;\n",
    });
    expect(r.ok).toBe(true);
    const logs: string[] = [];
    const e = await EngineInstance.create(r.wasm!, { onLog: (s) => logs.push(s) });
    expect(e.callRaw("dbg_big")).toBe(1);
    expect(logs.some((l) => l.includes("env.big_import") && l.includes("returned 0"))).toBe(true);
  });
});
