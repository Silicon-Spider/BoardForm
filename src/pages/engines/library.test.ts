import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "@/blocks/default-workspace";
import { GENERATOR_VERSION, generateEvalSource } from "@/blocks/generator";
import { TEMPLATE_VERSION, defaultFilesFor, scratchFiles, templateFiles } from "@/engine-host/templates";
import type { EngineRecord } from "@/types";
import { checkedBuildStatus, immediateBuildStatus } from "./build-status";
import { engineInitials } from "./EngineCard";
import {
  countByKind,
  engineMatches,
  filterEngines,
  isKindFilter,
  isLibrarySort,
  normalizeSearchText,
  searchTokens,
  sortEngines,
} from "./filters";
import {
  ENGINE_COLORS,
  copyName,
  createEngineRecord,
  duplicateEngineRecord,
  fileBaseName,
  isHexColor,
  pickDefaultColor,
  redundantRestoredStarters,
  suggestName,
  uniqueName,
  type NewEngineDetails,
} from "./records";
import { engineFileName, restoredStartersMessage } from "./actions";
import { capabilitiesFromInspection } from "./wasm-check";

const CTX = { id: "new-id", now: 1_700_000_000_000, hashMb: 32 };

function details(overrides: Partial<NewEngineDetails>): NewEngineDetails {
  return { approach: "eval", name: "My engine", description: "", color: "#ef6363", ...overrides };
}

function engine(id: string, overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    id,
    name: `Engine ${id}`,
    description: "",
    kind: "eval",
    createdAt: 1000,
    updatedAt: 1000,
    color: "#5b9cf5",
    options: { hashMb: 16 },
    files: { "eval.ts": "// eval" },
    entry: "main.ts",
    networkId: null,
    ...overrides,
  };
}

describe("uniqueName / copyName", () => {
  it("keeps a free name and numbers taken ones (case-insensitive)", () => {
    expect(uniqueName("My blocks engine", [])).toBe("My blocks engine");
    expect(uniqueName("My blocks engine", ["my BLOCKS engine"])).toBe("My blocks engine 2");
    expect(uniqueName("My blocks engine", ["My blocks engine", "My blocks engine 2"])).toBe("My blocks engine 3");
    expect(uniqueName("  Spaced  ", ["other"])).toBe("Spaced");
    expect(uniqueName("   ", [])).toBe("Untitled engine");
  });

  it("appends (copy) without stacking suffixes", () => {
    expect(copyName("Blocky", [])).toBe("Blocky (copy)");
    expect(copyName("Blocky", ["Blocky", "Blocky (copy)"])).toBe("Blocky (copy 2)");
    expect(copyName("Blocky (copy)", ["Blocky", "Blocky (copy)"])).toBe("Blocky (copy 2)");
    expect(copyName("Blocky (copy 2)", ["Blocky (copy)", "Blocky (copy 2)", "blocky (COPY 3)"])).toBe("Blocky (copy 4)");
  });

  it("keeps suffixed names within the 80-character limit", () => {
    const long = "x".repeat(80);
    expect(copyName(long, [])).toBe(`${"x".repeat(73)} (copy)`);
    expect(copyName(long, [`${"x".repeat(73)} (copy)`])).toBe(`${"x".repeat(71)} (copy 2)`);
    expect(uniqueName(long, [long])).toBe(`${"x".repeat(78)} 2`);
    for (const n of [copyName(long, []), uniqueName(long, [long])]) expect(n.length).toBeLessThanOrEqual(80);
  });
});

describe("suggestName", () => {
  const taken = ["Classic", "My blocks engine", "Sprout"];
  it("uses a per-approach base name, made unique", () => {
    expect(suggestName("blocks", taken)).toBe("My blocks engine 2");
    expect(suggestName("eval", taken)).toBe("My eval engine");
    expect(suggestName("scratch", taken)).toBe("My scratch engine");
  });
  it("derives names from the copy source, the network or the module", () => {
    expect(suggestName("copy", taken, { source: engine("c", { name: "Classic" }) })).toBe("Classic (copy)");
    expect(suggestName("copy", taken)).toBe("My engine");
    expect(suggestName("nnue", taken, { networkName: "Run 3 best" })).toBe("Run 3 best engine");
    expect(suggestName("wasm", taken, { moduleName: "Sprout", fileName: "x.wasm" })).toBe("Sprout 2");
    expect(suggestName("wasm", taken, { moduleName: null, fileName: "C:\\bots\\stockfish-lite.wasm" })).toBe("stockfish-lite");
    expect(suggestName("wasm", taken)).toBe("My uploaded engine");
  });
  it("fileBaseName strips folders and the extension", () => {
    expect(fileBaseName("a/b/c.wasm")).toBe("c");
    expect(fileBaseName("engine")).toBe("engine");
  });
});

describe("colours", () => {
  it("picks the first unused palette colour", () => {
    expect(pickDefaultColor([])).toBe(ENGINE_COLORS[0].value);
    expect(pickDefaultColor([ENGINE_COLORS[0].value.toUpperCase(), ENGINE_COLORS[1].value])).toBe(ENGINE_COLORS[2].value);
    const all = ENGINE_COLORS.map((c) => c.value);
    expect(all).toContain(pickDefaultColor(all));
  });
  it("validates hex colours", () => {
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#A1B2C3")).toBe(true);
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#12345")).toBe(false);
  });
});

describe("createEngineRecord", () => {
  it("fills the common fields", () => {
    const r = createEngineRecord(details({ approach: "eval", name: "  Mine  ", description: " d ", color: "#22d3ee" }), CTX);
    expect(r).toMatchObject({
      id: "new-id",
      name: "Mine",
      description: "d",
      color: "#22d3ee",
      createdAt: CTX.now,
      updatedAt: CTX.now,
      options: { hashMb: 32 },
      builtin: false,
      tags: [],
      build: null,
      networkId: null,
      parentId: null,
    });
  });

  it("blocks: own copy of the default workspace + generated eval.ts", () => {
    const r = createEngineRecord(details({ approach: "blocks" }), CTX);
    expect(r.kind).toBe("blocks");
    expect(r.blocks).toEqual(DEFAULT_WORKSPACE);
    expect(r.blocks).not.toBe(DEFAULT_WORKSPACE);
    expect(Object.isFrozen(r.blocks)).toBe(false);
    expect(r.files).toEqual({ "eval.ts": generateEvalSource(DEFAULT_WORKSPACE).code });
    expect(r.files!["eval.ts"]).toContain("export function evaluate");
    expect(r.generatorVersion).toBe(GENERATOR_VERSION);
    expect(r.entry).toBe("main.ts");
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
  });

  it("eval: only eval.ts on top of the template", () => {
    const r = createEngineRecord(details({ approach: "eval" }), CTX);
    expect(r.kind).toBe("eval");
    expect(r.files).toEqual(defaultFilesFor("eval"));
    expect(Object.keys(r.files!)).toEqual(["eval.ts"]);
    expect(r.entry).toBe("main.ts");
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
    expect(r.blocks).toBeUndefined();
  });

  it("full: the complete template tree", () => {
    const r = createEngineRecord(details({ approach: "full" }), CTX);
    expect(r.kind).toBe("full");
    expect(r.files).toEqual({ ...templateFiles });
    expect(Object.keys(r.files!)).toContain("main.ts");
    expect(Object.keys(r.files!).length).toBeGreaterThan(5);
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
  });

  it("nnue: the NNUE eval and the chosen network", () => {
    const r = createEngineRecord(details({ approach: "nnue", networkId: "net-1" }), CTX);
    expect(r.kind).toBe("nnue");
    expect(r.files).toEqual(defaultFilesFor("nnue"));
    expect(r.networkId).toBe("net-1");
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
    expect(createEngineRecord(details({ approach: "nnue", networkId: null }), CTX).networkId).toBeNull();
  });

  it("scratch: the chosen skeleton, no template version", () => {
    const minimal = createEngineRecord(details({ approach: "scratch", scratchVariant: "minimal" }), CTX);
    const empty = createEngineRecord(details({ approach: "scratch", scratchVariant: "empty" }), CTX);
    expect(minimal.kind).toBe("scratch");
    expect(minimal.files).toEqual(scratchFiles("minimal"));
    expect(empty.files).toEqual(scratchFiles("empty"));
    expect(minimal.files).not.toEqual(empty.files);
    expect(minimal.entry).toBe("main.ts");
    expect(minimal.templateVersion).toBeUndefined();
    expect(createEngineRecord(details({ approach: "scratch" }), CTX).files).toEqual(scratchFiles("minimal"));
  });

  it("wasm: the module bytes, a network only when the module can load one", () => {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
    const plain = createEngineRecord(details({ approach: "wasm", wasm, networkId: "net-1", wasmSupportsNnue: false }), CTX);
    expect(plain.kind).toBe("wasm");
    expect(plain.wasm).toBe(wasm);
    expect(plain.files).toBeUndefined();
    expect(plain.entry).toBeUndefined();
    expect(plain.networkId).toBeNull();
    const nnue = createEngineRecord(details({ approach: "wasm", wasm, networkId: "net-1", wasmSupportsNnue: true }), CTX);
    expect(nnue.networkId).toBe("net-1");
    expect(() => createEngineRecord(details({ approach: "wasm", wasm: null }), CTX)).toThrow(/wasm/i);
  });

  it("copy: a duplicate of the source with the form's name, description and colour", () => {
    const source = engine("src", { kind: "nnue", networkId: "net-9", builtin: true, tags: ["starter"], options: { hashMb: 64 } });
    const r = createEngineRecord(details({ approach: "copy", source, name: "Fork", description: "forked", color: "#a78bfa" }), CTX);
    expect(r).toMatchObject({ id: "new-id", kind: "nnue", name: "Fork", description: "forked", color: "#a78bfa", networkId: "net-9", builtin: false, parentId: "src", options: { hashMb: 64 }, tags: [] });
    expect(() => createEngineRecord(details({ approach: "copy", source: null }), CTX)).toThrow(/copy/i);
  });

  it("rejects an empty name and repairs an invalid colour", () => {
    expect(() => createEngineRecord(details({ name: "   " }), CTX)).toThrow(/name/i);
    expect(isHexColor(createEngineRecord(details({ color: "not a colour" }), CTX).color)).toBe(true);
  });
});

describe("duplicateEngineRecord", () => {
  it("deep-clones with a new identity and keeps files, blocks, module, network and build", () => {
    const build = { sourceHash: "h", wasm: new Uint8Array([1, 2, 3]).buffer, builtAt: 5, compiler: "asc", sizeBytes: 3, compileMs: 1, warnings: 0 };
    const source = engine("orig", {
      kind: "blocks",
      builtin: true,
      tags: ["starter", "mine"],
      blocks: { blocks: { blocks: [{ type: "x" }] } },
      files: { "eval.ts": "code" },
      networkId: "net",
      build,
      wasm: new Uint8Array([9]).buffer,
      createdAt: 1,
      updatedAt: 2,
    });
    const copy = duplicateEngineRecord(source, { id: "copy-id", now: 99, name: "Orig (copy)" });
    expect(copy).toMatchObject({ id: "copy-id", name: "Orig (copy)", builtin: false, parentId: "orig", createdAt: 99, updatedAt: 99, networkId: "net", kind: "blocks" });
    expect(copy.tags).toEqual(["mine"]);
    expect(copy.files).toEqual(source.files);
    expect(copy.blocks).toEqual(source.blocks);
    expect(copy.build!.sourceHash).toBe("h");
    expect(new Uint8Array(copy.build!.wasm)).toEqual(new Uint8Array([1, 2, 3]));
    expect(copy.wasm!.byteLength).toBe(1);
    // Independent copies.
    expect(copy.files).not.toBe(source.files);
    expect(copy.build!.wasm).not.toBe(source.build!.wasm);
    copy.files!["eval.ts"] = "changed";
    expect(source.files!["eval.ts"]).toBe("code");
  });
});

describe("restoring the starter engines", () => {
  const starter = (id: string, name: string, overrides: Partial<EngineRecord> = {}) =>
    engine(id, { name, builtin: true, tags: ["starter"], files: { "eval.ts": `// ${name}` }, ...overrides });

  it("drops fresh copies of starters that are still there unchanged, keeps the others", () => {
    const existing = [
      starter("old-blocky", "Blocky", { kind: "blocks", blocks: { a: [1, 2], b: "x" }, files: { "eval.ts": "// gen" } }),
      // Edited: its sources differ from the fresh copy.
      starter("old-classic", "Classic", { files: { "eval.ts": "// my own eval" }, updatedAt: 5000 }),
      // Renamed by the user: not a twin (different name).
      starter("renamed", "My Sprout", { kind: "scratch", files: { "main.ts": "// Sprout" } }),
      // A user engine with a starter's name is not a starter.
      engine("mine", { name: "Sprout", kind: "scratch", files: { "main.ts": "// Sprout" } }),
    ];
    const fresh = [
      // Same content even though the stored object went through a different path (key order).
      starter("new-blocky", "blocky ", { kind: "blocks", blocks: { b: "x", a: [1, 2] }, files: { "eval.ts": "// gen" }, createdAt: 9000, updatedAt: 9000 }),
      starter("new-classic", "Classic", { createdAt: 9000, updatedAt: 9000 }),
      starter("new-sprout", "Sprout", { kind: "scratch", files: { "main.ts": "// Sprout" }, createdAt: 9000, updatedAt: 9000 }),
    ];
    expect(redundantRestoredStarters(existing, fresh)).toEqual(["new-blocky"]);
    // A built starter whose sources are unchanged still counts as a twin (the build does not matter).
    const built = starter("built-classic", "Classic", { build: { sourceHash: "h", wasm: new ArrayBuffer(1), builtAt: 1, compiler: "asc", sizeBytes: 1, compileMs: 1, warnings: 0 }, updatedAt: 7000 });
    expect(redundantRestoredStarters([built], fresh)).toEqual(["new-classic"]);
    expect(redundantRestoredStarters([], fresh)).toEqual([]);
  });

  it("says what came back, or that nothing was missing", () => {
    expect(restoredStartersMessage([])).toMatchObject({ message: "Your starter engines are all here" });
    expect(restoredStartersMessage(["Sprout"]).detail).toBe("Sprout is back in your library.");
    expect(restoredStartersMessage(["Blocky", "Classic", "Sprout"]).detail).toBe("Blocky, Classic and Sprout are back in your library.");
  });

  it("names exported engine files like the Workshop does", () => {
    expect(engineFileName("Classic (copy)")).toMatch(/^classic-copy\.engine\.json$/);
  });
});

describe("filters", () => {
  const list = [
    engine("a", { name: "Blocky", kind: "blocks", description: "Drag-and-drop evaluation", tags: ["starter"], updatedAt: 30, createdAt: 3 }),
    engine("b", { name: "Classic", kind: "eval", description: "Tapered évaluation", updatedAt: 20, createdAt: 1 }),
    engine("c", { name: "sprout", kind: "scratch", description: "Small engine", tags: ["starter", "learning"], updatedAt: 10, createdAt: 2 }),
    engine("d", { name: "Engine 10", kind: "nnue", updatedAt: 40, createdAt: 4 }),
    engine("e", { name: "Engine 9", kind: "nnue", updatedAt: 40, createdAt: 5 }),
  ];

  it("normalizes text and splits tokens", () => {
    expect(normalizeSearchText("  Élan   VITAL ")).toBe("elan vital");
    expect(searchTokens("  ")).toEqual([]);
    expect(searchTokens("Small  ENGINE")).toEqual(["small", "engine"]);
  });

  it("matches name, description and tags, every word, ignoring case and accents", () => {
    expect(engineMatches(list[1], searchTokens("evaluation"))).toBe(true); // "évaluation"
    expect(filterEngines(list, { query: "starter", kind: "all" }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterEngines(list, { query: "small learning", kind: "all" }).map((e) => e.id)).toEqual(["c"]);
    expect(filterEngines(list, { query: "small missing", kind: "all" })).toEqual([]);
    expect(filterEngines(list, { query: "", kind: "nnue" }).map((e) => e.id)).toEqual(["d", "e"]);
    expect(filterEngines(list, { query: "starter", kind: "scratch" }).map((e) => e.id)).toEqual(["c"]);
  });

  it("sorts without touching the input", () => {
    const before = list.map((e) => e.id);
    expect(sortEngines(list, "updated").map((e) => e.id)).toEqual(["e", "d", "a", "b", "c"]); // ties by name: "Engine 9" < "Engine 10"
    expect(sortEngines(list, "name").map((e) => e.id)).toEqual(["a", "b", "e", "d", "c"]);
    expect(sortEngines(list, "kind").map((e) => e.id)).toEqual(["a", "b", "c", "e", "d"]);
    expect(sortEngines(list, "created").map((e) => e.id)).toEqual(["e", "d", "a", "c", "b"]);
    expect(list.map((e) => e.id)).toEqual(before);
  });

  it("counts kinds and validates stored settings", () => {
    expect(countByKind(list)).toEqual({ all: 5, blocks: 1, eval: 1, full: 0, scratch: 1, nnue: 2, wasm: 0 });
    expect(isKindFilter("all")).toBe(true);
    expect(isKindFilter("nnue")).toBe(true);
    expect(isKindFilter("bogus")).toBe(false);
    expect(isLibrarySort("created")).toBe(true);
    expect(isLibrarySort(3)).toBe(false);
  });
});

describe("build status", () => {
  it("knows uploaded modules and unbuilt engines without hashing", () => {
    expect(immediateBuildStatus(engine("w", { kind: "wasm", wasm: new ArrayBuffer(2048) }))).toEqual({ state: "uploaded", sizeBytes: 2048 });
    expect(immediateBuildStatus(engine("w", { kind: "wasm" }))).toEqual({ state: "no-module" });
    expect(immediateBuildStatus(engine("x", { build: null }))).toEqual({ state: "none" });
    const built = engine("y", { build: { sourceHash: "h", wasm: new ArrayBuffer(10), builtAt: 7, compiler: "asc", sizeBytes: 76800, compileMs: 1, warnings: 0 } });
    expect(immediateBuildStatus(built)).toBeNull();
    expect(checkedBuildStatus(built, true)).toEqual({ state: "built", sizeBytes: 76800, builtAt: 7 });
    expect(checkedBuildStatus(built, false)).toEqual({ state: "stale", sizeBytes: 76800, builtAt: 7 });
  });
});

describe("wasm capabilities", () => {
  it("reads capabilities from exports and imports", () => {
    expect(
      capabilitiesFromInspection({
        exports: ["memory", "cb_eval", "cb_eval_trace", "cb_perft", "cb_nnue_alloc", "cb_nnue_load", "cb_set_option"],
        imports: ["env.cb_now", "env.cb_should_stop"],
      }),
    ).toEqual({ eval: true, trace: true, perft: true, nnue: true, options: true, instantStop: true });
    expect(capabilitiesFromInspection({ exports: ["cb_nnue_alloc"], imports: ["env.cb_now"] })).toEqual({
      eval: false,
      trace: false,
      perft: false,
      nnue: false,
      options: false,
      instantStop: false,
    });
  });
});

describe("engineInitials", () => {
  it("takes the first letter or digit of the first two words", () => {
    expect(engineInitials("My blocks engine")).toBe("MB");
    expect(engineInitials("Classic (copy)")).toBe("CC");
    expect(engineInitials("Minimal 1.0 (0x88, alpha-beta)")).toBe("M1");
    expect(engineInitials("  sprout ")).toBe("S");
    expect(engineInitials("— ")).toBe("?");
    expect(engineInitials("élan vital")).toBe("ÉV");
  });
});
