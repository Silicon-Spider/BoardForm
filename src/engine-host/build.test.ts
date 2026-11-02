import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompileRequest, CompileResult, EngineRecord, NetworkDataRecord } from "@/types";

// --- mocks (hoisted above the imports below) --------------------------------------------------

const state = vi.hoisted(() => ({
  engines: new Map<string, EngineRecord>(),
  networkData: new Map<string, NetworkDataRecord>(),
  settings: new Map<string, unknown>(),
  failUpdate: false,
  compileCalls: 0,
  compileDelayMs: 0,
}));

vi.mock("@/storage/repos", () => ({
  enginesRepo: {
    get: vi.fn(async (id: string) => structuredClone(state.engines.get(id))),
    update: vi.fn(async (id: string, patch: Partial<EngineRecord>) => {
      if (state.failUpdate) throw new Error("quota exceeded");
      const current = state.engines.get(id);
      if (!current) throw new Error("not-found");
      const merged = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
      state.engines.set(id, merged);
      return structuredClone(merged);
    }),
  },
  networksRepo: { getData: vi.fn(async (id: string) => structuredClone(state.networkData.get(id))) },
  settingsRepo: {
    get: vi.fn(async (key: string, fallback: unknown) => (state.settings.has(key) ? structuredClone(state.settings.get(key)) : fallback)),
    set: vi.fn(async (key: string, value: unknown) => void state.settings.set(key, structuredClone(value))),
  },
}));

// The real compiler, in-process (the browser client uses a worker).
vi.mock("@/compiler", async () => {
  const { compileWithAsc } = await import("@/compiler/core");
  const { loadAsc } = await import("@/compiler/load-asc.js");
  const { COMPILER_VERSION } = await import("@/compiler/version");
  return {
    COMPILER_VERSION,
    compile: async (req: CompileRequest, opts?: { onStatus?: (s: "loading-compiler" | "compiling") => void }): Promise<CompileResult> => {
      state.compileCalls++;
      opts?.onStatus?.("compiling");
      if (state.compileDelayMs) await new Promise((r) => setTimeout(r, state.compileDelayMs));
      return compileWithAsc(await loadAsc(), req);
    },
  };
});

// A small template that compiles: the tiny fixture engine plus an (unused) eval.ts.
vi.mock("./templates", async () => {
  const { fixtureFiles } = await import("./__fixtures__/compile");
  const files = { ...fixtureFiles("tiny-engine"), "eval.ts": "export const TEMPLATE_EVAL: i32 = 1;\n" };
  return {
    TEMPLATE_VERSION: 7,
    templateFiles: files,
    variantFiles: { "eval-nnue.ts": "export const NNUE_EVAL: i32 = 2;\n" },
    usesTemplate: (kind: string) => kind === "blocks" || kind === "eval" || kind === "nnue",
    defaultFilesFor: () => ({}),
    scratchFiles: () => ({}),
  };
});

import { COMPILER_VERSION } from "@/compiler/version";
import { enginesRepo } from "@/storage/repos";
import { fixtureFiles } from "./__fixtures__/compile";
import { BuildError, STOCK_NNUE_SETTING, assembleSources, buildEngine, getEngineArtifacts, getStockNnueWasm, isBuildCurrent, sourceHashOf } from "./build";
import { templateFiles } from "./templates";
import { DEFAULT_WORKSPACE } from "@/blocks/default-workspace";
import { GENERATOR_VERSION, generateEvalSource } from "@/blocks/generator";

const FIXTURE = fixtureFiles("tiny-engine");

function record(over: Partial<EngineRecord> & Pick<EngineRecord, "kind">): EngineRecord {
  return {
    id: over.id ?? `e-${Math.random().toString(36).slice(2)}`,
    name: "Test engine",
    description: "",
    createdAt: 1,
    updatedAt: 1,
    color: "#888",
    options: { hashMb: 16 },
    ...over,
  };
}

function store(e: EngineRecord): EngineRecord {
  state.engines.set(e.id, structuredClone(e));
  return e;
}

beforeEach(() => {
  state.engines.clear();
  state.networkData.clear();
  state.settings.clear();
  state.failUpdate = false;
  state.compileCalls = 0;
  state.compileDelayMs = 0;
  vi.mocked(enginesRepo.update).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assembleSources", () => {
  it("blocks: generated eval.ts over the template, other stored files ignored", () => {
    const r = assembleSources(record({ kind: "blocks", files: { "eval.ts": "GENERATED", "main.ts": "IGNORED" } }));
    expect(r.entry).toBe("main.ts");
    expect(r.files["eval.ts"]).toBe("GENERATED");
    expect(r.files["main.ts"]).toBe(templateFiles["main.ts"]);
    expect(Object.keys(r.files).sort()).toEqual(Object.keys(templateFiles).sort());
  });

  it("blocks without generated code is an error", () => {
    expect(() => assembleSources(record({ kind: "blocks", files: {} }))).toThrow(/no generated evaluation code/);
    expect(() => assembleSources(record({ kind: "blocks", blocks: {}, files: {}, generatorVersion: GENERATOR_VERSION }))).toThrow(
      /no generated evaluation code/,
    );
  });

  it("blocks: code from an older generator is regenerated from the saved workspace", () => {
    for (const generatorVersion of [undefined, GENERATOR_VERSION - 1]) {
      const r = assembleSources(record({ kind: "blocks", blocks: DEFAULT_WORKSPACE, files: { "eval.ts": "OLD" }, generatorVersion }));
      expect(r.files["eval.ts"]).toBe(generateEvalSource(DEFAULT_WORKSPACE).code);
    }
    const current = assembleSources(record({ kind: "blocks", blocks: DEFAULT_WORKSPACE, files: { "eval.ts": "CURRENT" }, generatorVersion: GENERATOR_VERSION }));
    expect(current.files["eval.ts"]).toBe("CURRENT");
  });

  it("eval / nnue: overrides on top of the template (keys normalized)", () => {
    for (const kind of ["eval", "nnue"] as const) {
      const r = assembleSources(record({ kind, files: { "./eval.ts": "MINE", "extra.ts": "X" } }));
      expect(r.files["eval.ts"]).toBe("MINE");
      expect(r.files["extra.ts"]).toBe("X");
      expect(r.files["main.ts"]).toBe(templateFiles["main.ts"]);
    }
  });

  it("full / scratch: the stored tree as-is, with a custom entry", () => {
    expect(assembleSources(record({ kind: "full", files: { "main.ts": "M", "x.ts": "X" } })).files).toEqual({ "main.ts": "M", "x.ts": "X" });
    const r = assembleSources(record({ kind: "scratch", files: { "engine.ts": "E" }, entry: "./engine.ts" }));
    expect(r).toEqual({ files: { "engine.ts": "E" }, entry: "engine.ts" });
  });

  it("throws for uploaded wasm engines and missing entry files", () => {
    expect(() => assembleSources(record({ kind: "wasm", wasm: new ArrayBuffer(8) }))).toThrow(/uploaded WebAssembly module/);
    expect(() => assembleSources(record({ kind: "full", files: { "other.ts": "" } }))).toThrow(/no entry file main\.ts/);
    expect(() => assembleSources(record({ kind: "scratch" }))).toThrow(/no source files at all/);
  });
});

describe("sourceHashOf", () => {
  it("is canonical over file order and sensitive to content and entry", async () => {
    const a = await sourceHashOf({ files: { "a.ts": "1", "b.ts": "2" }, entry: "a.ts" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sourceHashOf({ files: { "b.ts": "2", "a.ts": "1" }, entry: "a.ts" })).toBe(a);
    expect(await sourceHashOf({ files: { "a.ts": "1", "b.ts": "3" }, entry: "a.ts" })).not.toBe(a);
    expect(await sourceHashOf({ files: { "a.ts": "1", "b.ts": "2" }, entry: "b.ts" })).not.toBe(a);
  });
});

describe("buildEngine", () => {
  it("compiles, persists the build and then serves it from cache", async () => {
    const engine = store(record({ kind: "full", files: FIXTURE }));
    const statuses: string[] = [];
    const first = await buildEngine(engine, { onStatus: (s) => statuses.push(s) });
    expect(first.ok).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(first.result?.ok).toBe(true);
    expect(statuses).toEqual(["Compiling…", "Saving the build…"]);
    expect(vi.mocked(enginesRepo.update)).toHaveBeenCalledTimes(1);
    const build = first.engine.build!;
    expect(build).toMatchObject({ compiler: COMPILER_VERSION, warnings: 0, sourceHash: await sourceHashOf(assembleSources(engine)) });
    expect(build.sizeBytes).toBe(build.wasm.byteLength);
    expect(WebAssembly.validate(new Uint8Array(build.wasm))).toBe(true);
    expect(state.engines.get(engine.id)?.build?.sourceHash).toBe(build.sourceHash);
    expect(await isBuildCurrent(first.engine)).toBe(true);

    const second = await buildEngine(first.engine);
    expect(second).toMatchObject({ ok: true, fromCache: true, result: null });
    expect(state.compileCalls).toBe(1);

    const forced = await buildEngine(first.engine, { force: true });
    expect(forced.fromCache).toBe(false);
    expect(state.compileCalls).toBe(2);
  });

  it("records the template version for template-based kinds only", async () => {
    const evalEngine = store(record({ kind: "eval", files: { "eval.ts": "export const MINE: i32 = 3;\n" } }));
    expect((await buildEngine(evalEngine)).engine.templateVersion).toBe(7);
    const full = store(record({ kind: "full", files: FIXTURE }));
    expect((await buildEngine(full)).engine.templateVersion).toBeUndefined();
  });

  it("shares one compilation between concurrent builds of the same sources", async () => {
    state.compileDelayMs = 50;
    const engine = store(record({ kind: "full", files: FIXTURE }));
    const statusA: string[] = [];
    const statusB: string[] = [];
    const [a, b] = await Promise.all([buildEngine(engine, { onStatus: (s) => statusA.push(s) }), buildEngine(engine, { onStatus: (s) => statusB.push(s) })]);
    expect(state.compileCalls).toBe(1);
    expect(a).toBe(b);
    expect(statusB).toContain("Saving the build…");
  });

  it("keeps the previous build when compilation fails", async () => {
    const good = await buildEngine(store(record({ id: "keep", kind: "full", files: FIXTURE })));
    const previous = good.engine.build!;
    const broken = { ...good.engine, files: { ...FIXTURE, "main.ts": FIXTURE["main.ts"] + "\nexport function oops(): i32 { return nope; }\n" } };
    store(broken);
    vi.mocked(enginesRepo.update).mockClear();
    const r = await buildEngine(broken);
    expect(r.ok).toBe(false);
    expect(r.result?.diagnostics.find((d) => d.severity === "error")).toMatchObject({ file: "main.ts", code: 2304 });
    expect(vi.mocked(enginesRepo.update)).not.toHaveBeenCalled();
    expect(r.engine.build?.sourceHash).toBe(previous.sourceHash);
    expect(state.engines.get("keep")?.build?.sourceHash).toBe(previous.sourceHash);
    expect(await isBuildCurrent(broken)).toBe(false);
  });

  it("still returns the build when saving it fails", async () => {
    state.failUpdate = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await buildEngine(store(record({ kind: "full", files: FIXTURE })));
    expect(r.ok).toBe(true);
    expect(r.engine.build?.wasm.byteLength).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it("does not compile uploaded wasm engines", async () => {
    const r = await buildEngine(record({ kind: "wasm", wasm: new ArrayBuffer(16) }));
    expect(r).toMatchObject({ ok: true, fromCache: true, result: null });
    expect(state.compileCalls).toBe(0);
  });
});

describe("getEngineArtifacts", () => {
  it("builds on demand and returns the attached network", async () => {
    const network = new Uint8Array([0x43, 0x42, 0x4e, 0x4e, 9]).buffer;
    state.networkData.set("net1", { id: "net1", quantized: network, float: null, optimizer: null });
    const engine = store(record({ kind: "eval", files: { "eval.ts": "export const E: i32 = 1;\n" }, networkId: "net1" }));
    const a = await getEngineArtifacts(engine.id);
    expect(WebAssembly.validate(new Uint8Array(a.wasm))).toBe(true);
    expect(new Uint8Array(a.network!)).toEqual(new Uint8Array(network));
    expect(a.engine.build).toBeTruthy();
    await getEngineArtifacts(engine.id);
    expect(state.compileCalls).toBe(1); // second time from the persisted build
  });

  it("fails clearly for missing engines, missing networks and compile errors", async () => {
    await expect(getEngineArtifacts("nope")).rejects.toThrow(/Engine not found/);
    store(record({ id: "lost-net", kind: "full", files: FIXTURE, networkId: "gone" }));
    await expect(getEngineArtifacts("lost-net")).rejects.toThrow(/no longer exists/);
    store(record({ id: "broken", kind: "full", files: { "main.ts": "export function f(): i32 { return x; }\n" } }));
    const err = await getEngineArtifacts("broken").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect((err as BuildError).result.ok).toBe(false);
    expect((err as BuildError).message).toMatch(/^“Test engine” failed to compile: main\.ts:1:35 error TS2304/);
  });

  it("returns the stored module of uploaded engines", async () => {
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer;
    store(record({ id: "up", kind: "wasm", wasm: bytes }));
    const a = await getEngineArtifacts("up");
    expect(new Uint8Array(a.wasm)).toEqual(new Uint8Array(bytes));
    store(record({ id: "empty", kind: "wasm" }));
    await expect(getEngineArtifacts("empty")).rejects.toThrow(/^“[^”]+” has no WebAssembly module yet\. Open it in the Workshop and choose a \.wasm file\.$/);
  });
});

describe("getStockNnueWasm", () => {
  it("compiles once, caches in memory and in settings, and hands out copies", async () => {
    const a = await getStockNnueWasm();
    expect(WebAssembly.validate(new Uint8Array(a))).toBe(true);
    const cached = state.settings.get(STOCK_NNUE_SETTING) as { hash: string; wasm: ArrayBuffer };
    expect(cached.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cached.wasm.byteLength).toBe(a.byteLength);
    structuredClone(a, { transfer: [a] }); // the caller may transfer (detach) its copy
    const b = await getStockNnueWasm();
    expect(b.byteLength).toBe(cached.wasm.byteLength);
    expect(state.compileCalls).toBe(1);
  });

  it("reuses the settings cache in a fresh session", async () => {
    vi.resetModules();
    const fresh = await import("./build");
    state.settings.set(STOCK_NNUE_SETTING, { hash: await fresh.sourceHashOf(fresh.stockNnueSources()), wasm: new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer });
    const w = await fresh.getStockNnueWasm();
    expect(w.byteLength).toBe(8);
    expect(state.compileCalls).toBe(0);
  });
});
