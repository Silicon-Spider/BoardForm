import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, compileInline, minimalEngineSource } from "./__fixtures__/compile";
import { inspectWasm } from "./inspect";

const buf = (bytes: Uint8Array) => bytes.slice().buffer;

let fixture: Uint8Array;
beforeAll(async () => {
  fixture = await compileFixture();
});

describe("inspectWasm", () => {
  it("accepts a complete engine and lists its exports and imports", async () => {
    const r = await inspectWasm(buf(fixture));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["cb_go", "cb_eval_trace", "cb_nnue_load", "memory"]));
    expect(r.imports).toEqual(expect.arrayContaining(["env.cb_info", "env.abort", "wasi_snapshot_preview1.fd_write"]));
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "Unknown import env.mystery_import: the host provides a stub that returns 0.",
        "WASI function wasi_snapshot_preview1.sock_accept is not supported: it will return ENOSYS.",
        expect.stringMatching(/uses WASI/),
      ]),
    );
    expect(r.warnings.some((w) => w.startsWith("No "))).toBe(false); // every optional export present
  });

  it("warns about each missing optional feature", async () => {
    const r = await inspectWasm(buf(await compileInline(minimalEngineSource())));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const missing = r.warnings.filter((w) => w.startsWith("No "));
    expect(missing).toHaveLength(6);
    expect(missing.join("\n")).toMatch(/cb_eval export/);
    expect(missing.join("\n")).toMatch(/cb_nnue_alloc \/ cb_nnue_load/);
  });

  it("lists every missing required export", async () => {
    const r = await inspectWasm(buf(await compileInline("export function hello(): i32 { return 1; }")));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(
      ["cb_abi_version", "cb_init", "cb_in", "cb_out", "cb_new_game", "cb_position", "cb_go"].map((n) => `Missing required export ${n}.`),
    );
    expect(r.exports).toEqual(["hello", "memory"]);
  });

  it("checks cb_abi_version() by instantiating the module", async () => {
    const r = await inspectWasm(buf(await compileInline(minimalEngineSource({ abiVersion: 2 }))));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["cb_abi_version() returned 2; this app implements ABI version 1."]);
  });

  it("reports modules that fail while instantiating", async () => {
    const r = await inspectWasm(buf(await compileInline(minimalEngineSource({ extra: 'assert(false, "broken start");' }))));
    expect(r.ok).toBe(false);
    // Exported memory is unreachable while the start function runs, so only the location is known.
    expect(r.errors[0]).toMatch(/^The module could not be instantiated: abort: \(message unavailable: the engine aborted while starting up\) at \?:\d+:\d+$/);
  });

  it("rejects bytes that are not WebAssembly", async () => {
    const r = await inspectWasm(new TextEncoder().encode("definitely not wasm").buffer);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^Not a valid WebAssembly module/);
    expect(r.exports).toEqual([]);
  });

  it("rejects ABI functions the host cannot call", async () => {
    const r = await inspectWasm(buf(await compileInline(minimalEngineSource().replace("nodes: f64", "nodes: i64"))));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("cb_go has signature"))).toBe(true);
  });
});
