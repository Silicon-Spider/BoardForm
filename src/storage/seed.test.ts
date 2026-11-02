import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: { blocks: { languageVersion: 0, blocks: [{ type: "cb_eval_root", id: "root" }] } },
  generateEvalSource: vi.fn((_ws: object) => ({ code: "// generated eval", errors: [] as string[], warnings: [] as string[] })),
  defaultFilesFor: vi.fn((kind: string) => (kind === "eval" ? { "eval.ts": "// classic tapered eval" } : {})),
  scratchFiles: vi.fn((variant: string) => ({ "main.ts": `// scratch ${variant}` })),
  requestPersistentStorage: vi.fn(async () => true),
}));

vi.mock("@/blocks", () => ({
  GENERATOR_VERSION: 2,
  DEFAULT_WORKSPACE: mocks.workspace,
  generateEvalSource: mocks.generateEvalSource,
}));
vi.mock("@/engine-host/templates", () => ({
  TEMPLATE_VERSION: 7,
  defaultFilesFor: mocks.defaultFilesFor,
  scratchFiles: mocks.scratchFiles,
}));
vi.mock("./persist", () => ({
  requestPersistentStorage: mocks.requestPersistentStorage,
  storageEstimate: vi.fn(async () => ({ usage: 0, quota: 0, persisted: false })),
}));

import { listQuery } from "./cache";
import { clearAllData, enginesRepo, settingsRepo } from "./repos";
import { SEED_FLAG_KEY, ensureSeeded } from "./seed";
import { resetStorage, waitFor } from "./test-utils";

beforeEach(async () => {
  await resetStorage();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureSeeded", () => {
  it("creates the three built-in starter engines and the flag", async () => {
    await ensureSeeded();
    const engines = await enginesRepo.list();
    expect(engines.map((e) => e.name)).toEqual(["Blocky", "Classic", "Sprout"]);
    expect(engines.map((e) => e.kind)).toEqual(["blocks", "eval", "scratch"]);
    for (const e of engines) {
      expect(e.builtin).toBe(true);
      expect(e.templateVersion).toBe(7);
      expect(e.options).toEqual({ hashMb: 16 });
      expect(e.description.length).toBeGreaterThan(20);
      expect(e.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(e.build ?? null).toBeNull();
    }
    expect(new Set(engines.map((e) => e.color)).size).toBe(3);
    expect(new Set(engines.map((e) => e.id)).size).toBe(3);

    const [blocky, classic, sprout] = engines;
    expect(blocky.blocks).toEqual(mocks.workspace);
    expect(mocks.generateEvalSource).toHaveBeenCalledWith(mocks.workspace);
    expect(blocky.files).toEqual({ "eval.ts": "// generated eval" });
    expect(classic.files).toEqual({ "eval.ts": "// classic tapered eval" });
    expect(mocks.defaultFilesFor).toHaveBeenCalledWith("eval");
    expect(sprout.files).toEqual({ "main.ts": "// scratch minimal" });
    expect(mocks.scratchFiles).toHaveBeenCalledWith("minimal");
    expect(sprout.description).toMatch(/small single-file engine to learn from/);

    expect(await settingsRepo.get(SEED_FLAG_KEY, false)).toBe(true);
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: repeated and concurrent calls seed once", async () => {
    await Promise.all([ensureSeeded(), ensureSeeded(), ensureSeeded()]);
    await ensureSeeded();
    expect(await enginesRepo.list()).toHaveLength(3);
    expect(mocks.generateEvalSource).toHaveBeenCalledTimes(1);
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it("does not bring deleted starter engines back, but re-seeds after all data was cleared", async () => {
    await ensureSeeded();
    for (const e of await enginesRepo.list()) await enginesRepo.remove(e.id);
    await ensureSeeded();
    expect(await enginesRepo.list()).toHaveLength(0);

    await clearAllData();
    await ensureSeeded();
    expect(await enginesRepo.list()).toHaveLength(3);
  });

  it("still creates Blocky (with a warning) when the generator reports errors or throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.generateEvalSource.mockReturnValueOnce({ code: "// partial", errors: ["Unknown block 'x'"], warnings: [] });
    await ensureSeeded();
    const blocky = (await enginesRepo.list()).find((e) => e.name === "Blocky");
    expect(blocky?.files).toEqual({ "eval.ts": "// partial" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unknown block 'x'"));

    await clearAllData();
    warn.mockClear();
    mocks.generateEvalSource.mockImplementationOnce(() => {
      throw new Error("generator crashed");
    });
    await ensureSeeded();
    const again = (await enginesRepo.list()).find((e) => e.name === "Blocky");
    expect(again?.files).toEqual({ "eval.ts": "" });
    expect(again?.blocks).toEqual(mocks.workspace);
    expect(warn).toHaveBeenCalled();
  });

  it("makes the engines list wait for a first-run seed instead of showing an empty library", async () => {
    const first: number[] = [];
    const q = listQuery("engines");
    const seeding = ensureSeeded();
    const off = q.subscribe(() => {
      const s = q.getSnapshot();
      if (s.status === "ready" && first.length === 0) first.push(s.data.length);
    });
    await seeding;
    await waitFor(() => first.length > 0);
    off();
    expect(first).toEqual([3]);
  });

  async function twoTabsSeedAtOnce(): Promise<number> {
    // Two independent module graphs = two tabs, each with its own connection to the same database.
    vi.resetModules();
    const tabA = await import("./seed");
    vi.resetModules();
    const tabB = await import("./seed");
    await Promise.all([tabA.ensureSeeded(), tabB.ensureSeeded()]);
    vi.resetModules();
    const { enginesRepo: freshRepo } = await import("./repos");
    return (await freshRepo.list()).length;
  }

  it("seeds once when two tabs start together (Web Locks)", async () => {
    expect(typeof navigator.locks?.request).toBe("function");
    expect(await twoTabsSeedAtOnce()).toBe(3);
  });

  it("seeds once when two tabs start together without Web Locks (transaction re-check)", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    expect(await twoTabsSeedAtOnce()).toBe(3);
  });

  it("falls back to the transaction guard when Web Locks exist but refuse to work", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    vi.stubGlobal("navigator", { userAgent: "test", locks: { request } });
    await ensureSeeded();
    expect(request).toHaveBeenCalled();
    expect(await enginesRepo.list()).toHaveLength(3);
  });

  it("reports a failure of the seeding itself (not swallowed by the lock fallback)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.defaultFilesFor.mockImplementationOnce(() => {
      throw new Error("template bundle missing");
    });
    await expect(ensureSeeded()).rejects.toThrow("template bundle missing");
    expect(await enginesRepo.list()).toHaveLength(0);
    expect(await settingsRepo.get(SEED_FLAG_KEY, false)).toBe(false);
    await ensureSeeded(); // and a later call can still succeed
    expect(await enginesRepo.list()).toHaveLength(3);
  });
});
