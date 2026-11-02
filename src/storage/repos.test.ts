import "fake-indexeddb/auto";
import { IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRecord } from "@/types";
import { StorageError } from "./db";
import {
  DELETE_BATCH,
  chunkId,
  clearAllData,
  datasetsRepo,
  enginesRepo,
  gamesRepo,
  matchesRepo,
  networksRepo,
  runsRepo,
  settingsRepo,
} from "./repos";
import {
  makeChunk,
  makeDataset,
  makeEngine,
  makeGame,
  makeMatch,
  makeNetwork,
  makeNetworkData,
  makeRun,
  resetStorage,
  sleep,
} from "./test-utils";

beforeEach(resetStorage);
afterEach(() => {
  vi.restoreAllMocks();
});

async function rejection(p: Promise<unknown>): Promise<StorageError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }
  throw new Error("expected the promise to reject");
}

describe("enginesRepo", () => {
  it("puts, gets, lists newest-updated first and removes", async () => {
    await enginesRepo.put(makeEngine("a", { updatedAt: 10 }));
    await enginesRepo.put(makeEngine("b", { updatedAt: 30 }));
    await enginesRepo.put(makeEngine("c", { updatedAt: 20 }));
    expect((await enginesRepo.get("b"))?.name).toBe("Engine b");
    expect(await enginesRepo.get("nope")).toBeUndefined();
    expect((await enginesRepo.list()).map((e) => e.id)).toEqual(["b", "c", "a"]);

    await enginesRepo.remove("c");
    expect(await enginesRepo.get("c")).toBeUndefined();
    expect((await enginesRepo.list()).map((e) => e.id)).toEqual(["b", "a"]);
    await enginesRepo.remove("does-not-exist"); // no error
  });

  it("breaks updatedAt ties by id so the order is deterministic", async () => {
    for (const id of ["m", "k", "z", "a"]) await enginesRepo.put(makeEngine(id, { updatedAt: 5 }));
    expect((await enginesRepo.list()).map((e) => e.id)).toEqual(["a", "k", "m", "z"]);
  });

  it("put replaces the whole record", async () => {
    await enginesRepo.put(makeEngine("a", { tags: ["x"] }));
    await enginesRepo.put(makeEngine("a", { name: "Renamed" }));
    const got = await enginesRepo.get("a");
    expect(got?.name).toBe("Renamed");
    expect(got?.tags).toBeUndefined();
  });

  it("update shallow-merges, keeps the id, bumps updatedAt and returns the merged record", async () => {
    await enginesRepo.put(makeEngine("a", { updatedAt: 1_000, options: { hashMb: 64 } }));
    const before = Date.now();
    const merged = await enginesRepo.update("a", { name: "New name", id: "hijack", files: { "eval.ts": "// new" } } as Partial<EngineRecord>);
    expect(merged.id).toBe("a");
    expect(merged.name).toBe("New name");
    expect(merged.files).toEqual({ "eval.ts": "// new" });
    expect(merged.options).toEqual({ hashMb: 64 }); // untouched fields kept
    expect(merged.updatedAt).toBeGreaterThanOrEqual(before);
    expect(await enginesRepo.get("a")).toEqual(merged);
    expect(await enginesRepo.get("hijack")).toBeUndefined();
  });

  it("update bumps updatedAt strictly even within the same millisecond and ignores a stale patch.updatedAt", async () => {
    const now = Date.now();
    await enginesRepo.put(makeEngine("a", { updatedAt: now + 50 })); // e.g. a clock running ahead
    const one = await enginesRepo.update("a", { name: "1", updatedAt: 1 });
    const two = await enginesRepo.update("a", { name: "2" });
    expect(one.updatedAt).toBe(now + 51);
    expect(two.updatedAt).toBe(now + 52);
  });

  it("concurrent updates of different fields are both applied (one transaction each)", async () => {
    await enginesRepo.put(makeEngine("a"));
    await Promise.all([enginesRepo.update("a", { name: "N" }), enginesRepo.update("a", { description: "D" })]);
    const got = await enginesRepo.get("a");
    expect(got?.name).toBe("N");
    expect(got?.description).toBe("D");
  });

  it("update of a missing record rejects with not-found and writes nothing", async () => {
    const err = await rejection(enginesRepo.update("ghost", { name: "x" }));
    expect(err.code).toBe("not-found");
    expect(err.message).toMatch(/no longer exists/);
    expect(await enginesRepo.list()).toEqual([]);
  });

  it("stores binary builds and wasm modules", async () => {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
    await enginesRepo.put(
      makeEngine("w", {
        kind: "wasm",
        wasm,
        build: { sourceHash: "h", wasm, builtAt: 1, compiler: "asc", sizeBytes: 8, compileMs: 1, warnings: 0 },
      }),
    );
    const got = await enginesRepo.get("w");
    expect(new Uint8Array(got!.wasm!)).toEqual(new Uint8Array(wasm));
    expect(new Uint8Array(got!.build!.wasm)).toEqual(new Uint8Array(wasm));
  });

  it("rejects records without an id and values that cannot be cloned", async () => {
    const noId = await rejection(enginesRepo.put({ ...makeEngine("x"), id: "" }));
    expect(noId.code).toBe("invalid-data");
    const clone = await rejection(enginesRepo.put({ ...makeEngine("x"), blocks: { fn: () => 1 } }));
    expect(clone.code).toBe("data-clone");
    expect(clone.message).toMatch(/cannot store/);
  });

  it("reports a full disk as a descriptive quota error", async () => {
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const err = await rejection(enginesRepo.put(makeEngine("q")));
    expect(err.code).toBe("quota-exceeded");
    expect(err.message).toMatch(/storage is full/i);
    expect(err.message).toMatch(/save the engine/);
  });
});

describe("networksRepo", () => {
  it("stores metadata and weights separately; remove deletes both", async () => {
    await networksRepo.put(makeNetwork("n1"));
    await networksRepo.putData(makeNetworkData("n1"));
    await networksRepo.put(makeNetwork("n2", { updatedAt: 9_999 }));
    await networksRepo.putData(makeNetworkData("n2"));

    expect((await networksRepo.list()).map((n) => n.id)).toEqual(["n2", "n1"]);
    const data = await networksRepo.getData("n1");
    expect(data?.float?.w1).toBeInstanceOf(Float32Array);
    expect(data?.float?.w1.length).toBe(768 * 4);
    expect(Array.from(data!.float!.b1)).toEqual(Array.from(makeNetworkData("n1").float!.b1));
    expect(data?.optimizer?.step).toBe(3);

    const updated = await networksRepo.update("n1", { name: "Renamed" });
    expect(updated.name).toBe("Renamed");

    await networksRepo.remove("n1");
    expect(await networksRepo.get("n1")).toBeUndefined();
    expect(await networksRepo.getData("n1")).toBeUndefined();
    expect(await networksRepo.getData("n2")).toBeDefined();
  });
});

describe("datasetsRepo", () => {
  it("stores chunks under canonical ids and counts / reads them", async () => {
    await datasetsRepo.put(makeDataset("d"));
    expect(chunkId("d", 7)).toBe("d:000007");
    await datasetsRepo.putChunk({ ...makeChunk("d", 7), id: "wrong-id" });
    await datasetsRepo.putChunk(makeChunk("d", 0));
    const c7 = await datasetsRepo.getChunk("d", 7);
    expect(c7?.id).toBe("d:000007");
    expect(new Uint8Array(c7!.data)[0]).toBe(7);
    expect(await datasetsRepo.getChunk("d", 3)).toBeUndefined();
    expect(await datasetsRepo.chunkCount("d")).toBe(2);
    expect(await datasetsRepo.chunkCount("other")).toBe(0);
  });

  it("rejects chunks with a bad index or no dataset", async () => {
    expect((await rejection(datasetsRepo.putChunk({ ...makeChunk("d", 0), index: -1 }))).code).toBe("invalid-data");
    expect((await rejection(datasetsRepo.putChunk({ ...makeChunk("d", 0), index: 1.5 }))).code).toBe("invalid-data");
    expect((await rejection(datasetsRepo.putChunk({ ...makeChunk("d", 0), datasetId: "" }))).code).toBe("invalid-data");
  });

  it("iterates chunks in numeric index order, tolerating awaits between steps", async () => {
    const indexes = [5, 0, 1_000_000, 12, 3, 999_999, 1, 20, 2, 4, 11];
    for (const i of indexes) await datasetsRepo.putChunk(makeChunk("d", i));
    await datasetsRepo.putChunk(makeChunk("e", 0)); // other dataset
    const seen: number[] = [];
    for await (const chunk of datasetsRepo.iterateChunks("d")) {
      seen.push(chunk.index);
      await sleep(1); // a consumer doing real work between chunks
    }
    expect(seen).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("remove deletes every chunk of the dataset (across several batches) but nothing else", async () => {
    await datasetsRepo.put(makeDataset("big"));
    await datasetsRepo.put(makeDataset("keep"));
    const n = DELETE_BATCH * 2 + 5;
    for (let i = 0; i < n; i++) await datasetsRepo.putChunk(makeChunk("big", i, 1));
    for (let i = 0; i < 3; i++) await datasetsRepo.putChunk(makeChunk("keep", i, 1));
    expect(await datasetsRepo.chunkCount("big")).toBe(n);

    await datasetsRepo.remove("big");
    expect(await datasetsRepo.get("big")).toBeUndefined();
    expect(await datasetsRepo.chunkCount("big")).toBe(0);
    expect(await datasetsRepo.get("keep")).toBeDefined();
    expect(await datasetsRepo.chunkCount("keep")).toBe(3);
  });

  it("update merges into the dataset record", async () => {
    await datasetsRepo.put(makeDataset("d"));
    const merged = await datasetsRepo.update("d", { positions: 4096, chunks: 2 });
    expect(merged.positions).toBe(4096);
    expect(merged.name).toBe("Data d");
  });
});

describe("gamesRepo", () => {
  beforeEach(async () => {
    await gamesRepo.put(makeGame("g1", 100, "m1"));
    await gamesRepo.put(makeGame("g2", 300, "m1"));
    await gamesRepo.put(makeGame("g3", 200, null));
    await gamesRepo.put(makeGame("g4", 400, "m2"));
    await gamesRepo.put(makeGame("g5", 300, "m1")); // same createdAt as g2
  });

  it("lists newest first, with a stable tie order shared by the limited and unlimited paths", async () => {
    const all = (await gamesRepo.list()).map((g) => g.id);
    expect(all).toEqual(["g4", "g5", "g2", "g3", "g1"]);
    expect((await gamesRepo.list({ limit: 3 })).map((g) => g.id)).toEqual(all.slice(0, 3));
    expect((await gamesRepo.list({ limit: 0 })).length).toBe(0);
    expect((await gamesRepo.list({ limit: 99 })).map((g) => g.id)).toEqual(all);
  });

  it("lists the games of one match (newest first), optionally limited", async () => {
    expect((await gamesRepo.list({ matchId: "m1" })).map((g) => g.id)).toEqual(["g5", "g2", "g1"]);
    expect((await gamesRepo.list({ matchId: "m1", limit: 2 })).map((g) => g.id)).toEqual(["g5", "g2"]);
    expect((await gamesRepo.list({ matchId: "m2" })).map((g) => g.id)).toEqual(["g4"]);
    expect(await gamesRepo.list({ matchId: "none" })).toEqual([]);
  });

  it("removeByMatch deletes only that match's games", async () => {
    await gamesRepo.removeByMatch("m1");
    expect((await gamesRepo.list()).map((g) => g.id)).toEqual(["g4", "g3"]);
    await gamesRepo.remove("g4");
    expect(await gamesRepo.get("g4")).toBeUndefined();
    expect((await gamesRepo.get("g3"))?.pgn).toBe("1. e4 *");
  });
});

describe("matchesRepo and runsRepo", () => {
  it("support the full CRUD contract", async () => {
    await matchesRepo.put(makeMatch("m1", 10));
    await matchesRepo.put(makeMatch("m2", 20));
    expect((await matchesRepo.list()).map((m) => m.id)).toEqual(["m2", "m1"]);
    const m = await matchesRepo.update("m1", { status: "running" });
    expect(m.status).toBe("running");
    expect((await matchesRepo.list())[0].id).toBe("m1"); // now the most recently updated
    await matchesRepo.remove("m2");
    expect((await matchesRepo.list()).length).toBe(1);

    await runsRepo.put(makeRun("r1"));
    const r = await runsRepo.update("r1", { status: "training", cycle: 2 });
    expect(r.cycle).toBe(2);
    expect((await runsRepo.get("r1"))?.status).toBe("training");
    expect((await runsRepo.list()).length).toBe(1);
    await runsRepo.remove("r1");
    expect(await runsRepo.get("r1")).toBeUndefined();
  });
});

describe("settingsRepo", () => {
  it("returns the fallback until a value is set, then the value", async () => {
    expect(await settingsRepo.get("theme", "dark")).toBe("dark");
    await settingsRepo.set("theme", "light");
    expect(await settingsRepo.get("theme", "dark")).toBe("light");
    await settingsRepo.set("limits", { depth: 8, nodes: null });
    expect(await settingsRepo.get("limits", {})).toEqual({ depth: 8, nodes: null });
    await settingsRepo.set("nothing", null);
    expect(await settingsRepo.get("nothing", "fallback")).toBeNull(); // null is a real value
    await settingsRepo.set("unset", undefined);
    expect(await settingsRepo.get("unset", 3)).toBe(3);
    await settingsRepo.remove("theme");
    expect(await settingsRepo.get("theme", "dark")).toBe("dark");
  });
});

describe("clearAllData", () => {
  it("empties every store", async () => {
    await enginesRepo.put(makeEngine("a"));
    await networksRepo.put(makeNetwork("n"));
    await networksRepo.putData(makeNetworkData("n"));
    await datasetsRepo.putChunk(makeChunk("d", 0));
    await gamesRepo.put(makeGame("g", 1));
    await settingsRepo.set("k", 1);
    await clearAllData();
    expect(await enginesRepo.list()).toEqual([]);
    expect(await networksRepo.getData("n")).toBeUndefined();
    expect(await datasetsRepo.chunkCount("d")).toBe(0);
    expect(await gamesRepo.list()).toEqual([]);
    expect(await settingsRepo.get("k", 0)).toBe(0);
  });
});
