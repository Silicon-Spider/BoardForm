import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FORMAT, ENGINE_FILE_FORMAT, exportBackup, exportEngineFile, importBackup, importEngineFile, uniqueImportName } from "./backup";
import { decodeValue, encodeValue } from "./codec";
import { StorageError } from "./db";
import { deepEqual } from "./equal";
import { subscribe, type ChangeEvent } from "./events";
import { datasetsRepo, enginesRepo, gamesRepo, matchesRepo, networksRepo, runsRepo, settingsRepo } from "./repos";
import { STORE_NAMES } from "./stores";
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
} from "./test-utils";

beforeEach(resetStorage);

const offs: Array<() => void> = [];
afterEach(() => {
  while (offs.length) offs.pop()!();
});

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255, 128]).buffer;

async function errorOf(p: Promise<unknown>): Promise<StorageError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }
  throw new Error("expected a rejection");
}

const jsonBlob = (value: unknown) => new Blob([JSON.stringify(value)], { type: "application/json" });

describe("codec", () => {
  it("round-trips binary values, typed arrays and non-JSON numbers", () => {
    const backing = new Float32Array([9, 1.5, -2.25, 3e-8, 9]);
    const value = {
      buf: new Uint8Array([0, 1, 2, 250, 255]).buffer,
      f32: backing.subarray(1, 4), // a view with a byte offset
      i16: new Int16Array([-32768, 0, 32767]),
      u8: new Uint8Array(70_000).map((_, i) => i & 0xff), // larger than one fromCharCode slice
      big: new BigInt64Array([-5n, 2n ** 40n]),
      dv: new DataView(new Uint8Array([1, 2, 3]).buffer),
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      n: 1.25,
      when: new Date("2026-01-02T03:04:05.000Z"),
      list: [1, undefined, null, "x"],
      nested: { $cb: "ArrayBuffer", b64: "AAAA", other: 1 }, // user data that looks like a tag
      skip: undefined,
    };
    const json = JSON.parse(JSON.stringify(encodeValue(value)));
    const back = decodeValue(json) as typeof value;

    expect(back.buf).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(back.buf))).toEqual([0, 1, 2, 250, 255]);
    expect(back.f32).toBeInstanceOf(Float32Array);
    expect(Array.from(back.f32)).toEqual([1.5, -2.25, Math.fround(3e-8)]);
    expect(Array.from(back.i16)).toEqual([-32768, 0, 32767]);
    expect(deepEqual(back.u8, value.u8)).toBe(true);
    expect(Array.from(back.big)).toEqual([-5n, 2n ** 40n]);
    expect(back.dv).toBeInstanceOf(DataView);
    expect(back.dv.getUint8(2)).toBe(3);
    expect(back.nan).toBeNaN();
    expect(back.inf).toBe(Infinity);
    expect(back.ninf).toBe(-Infinity);
    expect(back.n).toBe(1.25);
    expect(back.when.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(back.list).toEqual([1, null, null, "x"]);
    expect(back.nested).toEqual({ $cb: "ArrayBuffer", b64: "AAAA", other: 1 });
    expect("skip" in back).toBe(false);
  });

  it("rejects malformed or unknown tags", () => {
    expect(() => decodeValue({ $cb: "ArrayBuffer" })).toThrow(StorageError);
    expect(() => decodeValue({ $cb: "Float32Array", b64: "AAA=" })).toThrow(/wrong length/); // 2 bytes
    expect(() => decodeValue({ $cb: "constructor", b64: "AAAA" })).toThrow(/Unsupported value type/);
    expect(() => decodeValue({ $cb: "number", v: "12" })).toThrow(StorageError);
  });
});

async function populate(): Promise<void> {
  await enginesRepo.put(
    makeEngine("e1", {
      networkId: "n1",
      build: { sourceHash: "abc", wasm: WASM, builtAt: 1, compiler: "assemblyscript 0.28.20", sizeBytes: 10, compileMs: 5, warnings: 0 },
    }),
  );
  await enginesRepo.put(makeEngine("e2", { kind: "wasm", wasm: WASM }));
  await networksRepo.put(makeNetwork("n1"));
  await networksRepo.putData(makeNetworkData("n1"));
  await datasetsRepo.put(makeDataset("d1", { chunks: 3 }));
  for (let i = 0; i < 3; i++) await datasetsRepo.putChunk(makeChunk("d1", i, 4));
  await gamesRepo.put(makeGame("g1", 10, "m1"));
  await gamesRepo.put(makeGame("g2", 20));
  await matchesRepo.put(makeMatch("m1"));
  const run = makeRun("r1");
  run.points = [{ t: 1, cycle: 0, epoch: 0, step: 1, positions: 10, trainLoss: Number.NaN, valLoss: null, lr: 0.001 }];
  await runsRepo.put(run);
  await settingsRepo.set("play.limits", { depth: 6 });
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  const chunks: unknown[] = [];
  for await (const c of datasetsRepo.iterateChunks("d1")) chunks.push(c);
  return {
    engines: await enginesRepo.list(),
    networks: await networksRepo.list(),
    networkData: [await networksRepo.getData("n1")],
    datasets: await datasetsRepo.list(),
    datasetChunks: chunks,
    games: await gamesRepo.list(),
    matches: await matchesRepo.list(),
    trainingRuns: await runsRepo.list(),
    settings: [await settingsRepo.get("play.limits", null)],
  };
}

describe("exportBackup / importBackup", () => {
  it("round-trips every store, including ArrayBuffer and Float32Array values", async () => {
    await populate();
    const before = await snapshot();
    const blob = await exportBackup({ includeDatasets: true, includeGames: true });
    expect(blob.type).toBe("application/json");

    const parsed = JSON.parse(await blob.text());
    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.exportedAt).toBe("string");
    expect(parsed.stores.engines[0].build.wasm).toMatchObject({ $cb: "ArrayBuffer" });
    expect(parsed.counts).toMatchObject({ engines: 2, datasetChunks: 3, games: 2 });

    await resetStorage(); // a different browser / profile
    const counts = await importBackup(blob);
    expect(counts).toEqual({
      engines: 2,
      networks: 1,
      networkData: 1,
      datasets: 1,
      datasetChunks: 3,
      games: 2,
      matches: 1,
      trainingRuns: 1,
      settings: 1,
    });
    const after = await snapshot();
    expect(deepEqual(after, before)).toBe(true);

    const data = await networksRepo.getData("n1");
    expect(data?.float?.w1).toBeInstanceOf(Float32Array);
    expect(data?.optimizer?.m.w2).toBeInstanceOf(Float32Array);
    expect(new Uint8Array((await enginesRepo.get("e2"))!.wasm!)).toEqual(new Uint8Array(WASM));
    expect((await runsRepo.get("r1"))!.points[0].trainLoss).toBeNaN();
    expect(await gamesRepo.list({ matchId: "m1" })).toHaveLength(1); // indexes rebuilt
  });

  it("leaves datasets out by default and games out on request", async () => {
    await populate();
    const def = JSON.parse(await (await exportBackup()).text());
    expect(Object.keys(def.stores).sort()).toEqual(STORE_NAMES.filter((s) => s !== "datasets" && s !== "datasetChunks").sort());
    const noGames = JSON.parse(await (await exportBackup({ includeGames: false, includeDatasets: true })).text());
    expect(Object.keys(noGames.stores)).not.toContain("games");
    expect(Object.keys(noGames.stores)).toContain("datasetChunks");
  });

  it("overwrites records with the same id, keeps the rest and notifies subscribers", async () => {
    await enginesRepo.put(makeEngine("e1", { name: "From backup" }));
    const blob = await exportBackup();
    await enginesRepo.put(makeEngine("e1", { name: "Changed locally" }));
    await enginesRepo.put(makeEngine("local-only"));

    const events: ChangeEvent[] = [];
    offs.push(subscribe("engines", (e) => events.push(e)));
    const counts = await importBackup(blob);
    expect(counts.engines).toBe(1);
    expect((await enginesRepo.get("e1"))?.name).toBe("From backup");
    expect(await enginesRepo.get("local-only")).toBeDefined();
    expect(events).toContainEqual({ store: "engines", id: "e1", op: "put" });
  });

  it("rejects bad files with a descriptive error and writes nothing", async () => {
    expect((await errorOf(importBackup(new Blob(["{ not json"])))).message).toMatch(/not readable JSON/);
    expect((await errorOf(importBackup(jsonBlob({ hello: 1 })))).message).toMatch(/not a Chess Builder backup/);
    expect((await errorOf(importBackup(jsonBlob({ format: ENGINE_FILE_FORMAT, version: 1 })))).message).toMatch(/single-engine file/);
    expect((await errorOf(importBackup(jsonBlob({ format: BACKUP_FORMAT, version: 99, stores: {} })))).message).toMatch(/newer version/);

    const damaged = { format: BACKUP_FORMAT, version: 1, stores: { engines: [makeEngine("ok"), { name: "no id" }] } };
    const err = await errorOf(importBackup(jsonBlob(damaged)));
    expect(err.code).toBe("invalid-data");
    expect(err.message).toMatch(/record 2 of "engines" has no id/);
    expect(await enginesRepo.list()).toEqual([]); // validated before writing
  });
});

describe("exportEngineFile / importEngineFile", () => {
  it("exports an engine with its network and imports it as a new copy", async () => {
    await populate();
    const original = (await enginesRepo.get("e1"))!;
    const blob = await exportEngineFile("e1");
    const parsed = JSON.parse(await blob.text());
    expect(parsed.format).toBe(ENGINE_FILE_FORMAT);
    expect(parsed.engine.build).toBeNull(); // the stale build is not shipped
    expect(parsed.network.record.id).toBe("n1");

    const newId = await importEngineFile(blob);
    expect(newId).not.toBe("e1");
    const copy = (await enginesRepo.get(newId))!;
    expect(copy.name).toBe(`${original.name} (imported)`);
    expect(copy.build).toBeNull();
    expect(copy.builtin).toBe(false);
    expect(copy.files).toEqual(original.files);
    expect(copy.networkId).toBeTruthy();
    expect(copy.networkId).not.toBe("n1");

    const net = (await networksRepo.get(copy.networkId!))!;
    expect(net.name).toBe("Net n1 (imported)");
    const data = (await networksRepo.getData(copy.networkId!))!;
    const sourceData = (await networksRepo.getData("n1"))!;
    expect(data.id).toBe(copy.networkId);
    expect(deepEqual(data.quantized, sourceData.quantized)).toBe(true);
    expect(data.float?.w1).toBeInstanceOf(Float32Array);
    expect(deepEqual(data.float, sourceData.float)).toBe(true);

    // The original is untouched; a second import gets a distinct name.
    expect((await enginesRepo.get("e1"))?.networkId).toBe("n1");
    const third = await importEngineFile(blob);
    expect((await enginesRepo.get(third))?.name).toBe(`${original.name} (imported 2)`);
  });

  it("keeps the name when it is free, and round-trips uploaded wasm modules", async () => {
    await enginesRepo.put(makeEngine("w", { kind: "wasm", wasm: WASM, name: "Uploaded" }));
    const blob = await exportEngineFile("w");
    await enginesRepo.remove("w");
    const id = await importEngineFile(blob);
    const engine = (await enginesRepo.get(id))!;
    expect(engine.name).toBe("Uploaded");
    expect(engine.networkId).toBeNull();
    expect(new Uint8Array(engine.wasm!)).toEqual(new Uint8Array(WASM));
  });

  it("exports without the network when it no longer exists", async () => {
    await enginesRepo.put(makeEngine("e", { networkId: "gone" }));
    const parsed = JSON.parse(await (await exportEngineFile("e")).text());
    expect(parsed.network).toBeNull();
    expect(parsed.engine.networkId).toBeNull();
  });

  it("rejects missing engines and wrong files", async () => {
    expect((await errorOf(exportEngineFile("nope"))).code).toBe("not-found");
    await enginesRepo.put(makeEngine("x"));
    const backup = await exportBackup();
    expect((await errorOf(importEngineFile(backup))).message).toMatch(/full backup/);
    expect((await errorOf(importEngineFile(jsonBlob({ format: ENGINE_FILE_FORMAT, version: 1, engine: { name: "x", kind: "rocket" } })))).message).toMatch(
      /unknown engine type/,
    );
    expect((await errorOf(importEngineFile(jsonBlob({ format: ENGINE_FILE_FORMAT, version: 1, engine: { name: "x", kind: "wasm" } })))).message).toMatch(
      /WebAssembly module is missing/,
    );
  });

  it("names collisions case-insensitively", () => {
    expect(uniqueImportName("Blocky", ["Classic"])).toBe("Blocky");
    expect(uniqueImportName("Blocky", ["blocky "])).toBe("Blocky (imported)");
    expect(uniqueImportName("Blocky", ["Blocky", "Blocky (imported)"])).toBe("Blocky (imported 2)");
  });
});
