import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { clearAllData, enginesRepo, networksRepo, settingsRepo } from "./repos";
import { exportBackup, importBackup } from "./backup";
import {
  NETWORK_SEED_FLAG_KEY,
  SEED_FLAG_KEY,
  STARTER_NETWORK_ID,
  STARTER_NETWORK_TIMEOUT_MS,
  STARTER_NNUE_ENGINE_ID,
  ensureSeeded,
  whenSeeded,
} from "./seed";
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

describe("ensureSeeded: the starter network", () => {
  // The real file the app serves from public/; fetched through a stubbed fetch() and location.
  const netBytes = (): ArrayBuffer => {
    const buf = readFileSync(resolve(__dirname, "../../public/networks/starter-hl128.nnue"));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  const serve = (ok = true) => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      expect(String(url)).toBe("http://app.test/networks/starter-hl128.nnue");
      if (!ok) throw new TypeError("Failed to fetch");
      return new Response(netBytes(), { status: 200 });
    });
    vi.stubGlobal("location", { href: "http://app.test/#/engines" });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("adds the starter network and the engine Neuron that plays it", async () => {
    serve();
    await ensureSeeded();
    const engines = await enginesRepo.list();
    expect(engines.map((e) => e.name)).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    const neuron = (await enginesRepo.get(STARTER_NNUE_ENGINE_ID))!;
    expect(neuron).toMatchObject({ kind: "nnue", builtin: true, networkId: STARTER_NETWORK_ID, templateVersion: 7, tags: ["starter", "nnue"] });
    expect(mocks.defaultFilesFor).toHaveBeenCalledWith("nnue");

    const net = (await networksRepo.get(STARTER_NETWORK_ID))!;
    expect(net).toMatchObject({ hidden: 128, activation: 1, builtin: true, sizeBytes: 197_444, parentId: null });
    expect(net.name).toBe("Starter network (128 SCReLU)");
    const data = (await networksRepo.getData(STARTER_NETWORK_ID))!;
    expect(new Uint8Array(data.quantized)).toEqual(new Uint8Array(netBytes()));
    expect(data.float?.w1).toBeInstanceOf(Float32Array); // can be trained further
    expect(data.float?.w1.length).toBe(768 * 128);

    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(true);
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it("adds only the network part to a database seeded before it existed", async () => {
    await ensureSeeded(); // no location: the network part is skipped, as in an old version
    expect(await enginesRepo.list()).toHaveLength(3);
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(false);

    const fetchMock = serve();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000); // the next start, a day later
    await ensureSeeded();
    // Added later, Neuron is the newest engine: listed first (newest-updated first).
    expect((await enginesRepo.list()).map((e) => e.name)).toEqual(["Neuron", "Blocky", "Classic", "Sprout"]);
    expect(mocks.generateEvalSource).toHaveBeenCalledTimes(1); // the engines were not rebuilt
    await ensureSeeded();
    expect(fetchMock).toHaveBeenCalledTimes(1); // flag set: no more downloads
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it("retries on a later start when the download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(false);
    await ensureSeeded();
    expect(await enginesRepo.list()).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not download the starter network"), expect.anything());
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(false);

    serve();
    await ensureSeeded();
    expect(await enginesRepo.get(STARTER_NNUE_ENGINE_ID)).toBeDefined();
  });

  it("never overwrites or duplicates the network or Neuron when seeding again", async () => {
    serve();
    await ensureSeeded();
    await enginesRepo.update(STARTER_NNUE_ENGINE_ID, { name: "My Neuron" });
    await networksRepo.update(STARTER_NETWORK_ID, { name: "Renamed" });
    await settingsRepo.remove(NETWORK_SEED_FLAG_KEY); // what "Restore starter engines" does
    await ensureSeeded();
    expect((await enginesRepo.get(STARTER_NNUE_ENGINE_ID))?.name).toBe("My Neuron");
    expect((await networksRepo.get(STARTER_NETWORK_ID))?.name).toBe("Renamed");
    expect(await enginesRepo.list()).toHaveLength(4);

    // Deleted ones come back once the flag is cleared.
    await enginesRepo.remove(STARTER_NNUE_ENGINE_ID);
    await networksRepo.remove(STARTER_NETWORK_ID);
    await ensureSeeded();
    expect(await enginesRepo.get(STARTER_NNUE_ENGINE_ID)).toBeUndefined(); // flag still set
    await settingsRepo.remove(NETWORK_SEED_FLAG_KEY);
    await ensureSeeded();
    expect((await enginesRepo.get(STARTER_NNUE_ENGINE_ID))?.name).toBe("Neuron");
    expect((await networksRepo.get(STARTER_NETWORK_ID))?.builtin).toBe(true);
  });

  it("seeds the network once when two tabs start together", async () => {
    const fetchMock = serve();
    vi.resetModules();
    const tabA = await import("./seed");
    vi.resetModules();
    const tabB = await import("./seed");
    await Promise.all([tabA.ensureSeeded(), tabB.ensureSeeded()]);
    vi.resetModules();
    const { enginesRepo: freshRepo } = await import("./repos");
    expect((await freshRepo.list()).map((e) => e.name)).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ensureSeeded: a slow starter-network download and data changing meanwhile", () => {
  const netBytes = (): ArrayBuffer => {
    const buf = readFileSync(resolve(__dirname, "../../public/networks/starter-hl128.nnue"));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  const names = async () => (await enginesRepo.list()).map((e) => e.name);
  const nextTask = () => new Promise<void>((r) => setImmediate(r));

  /** A download that only finishes on release(). `honourAbort: false` = a fetch that ignores the signal. */
  function gatedDownload(honourAbort = true) {
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      await new Promise<void>((resolveOpen, reject) => {
        void opened.then(resolveOpen);
        if (honourAbort) init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
      return new Response(netBytes(), { status: 200 });
    });
    vi.stubGlobal("location", { href: "http://app.test/#/engines" });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, release, signals };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not hold up whenSeeded (the engines list) while the network downloads; Neuron is listed last", async () => {
    const { release } = gatedDownload();
    let done = false;
    const seeding = ensureSeeded().then(() => {
      done = true;
    });
    await whenSeeded(); // would never resolve if it waited for the download
    expect(await names()).toEqual(["Blocky", "Classic", "Sprout"]);
    expect(done).toBe(false);

    // The library is ready with the three engines and gets Neuron, at the end, once it arrives.
    const q = listQuery("engines");
    const off = q.subscribe(() => {});
    await waitFor(() => q.getSnapshot().status === "ready");
    release();
    await seeding;
    await waitFor(() => {
      const s = q.getSnapshot();
      return s.status === "ready" && s.data.length === 4;
    });
    const s = q.getSnapshot();
    off();
    expect(s.status === "ready" && s.data.map((e) => e.name)).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(true);
  });

  for (const honourAbort of [true, false]) {
    it(`gives up a download that does not answer in time (${honourAbort ? "aborted" : "fetch ignores the abort"}) and retries next start`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { fetchMock, signals } = gatedDownload(honourAbort);
      const seeding = ensureSeeded();
      await whenSeeded();
      while (fetchMock.mock.calls.length === 0) await nextTask();
      await vi.advanceTimersByTimeAsync(STARTER_NETWORK_TIMEOUT_MS);
      await seeding; // resolves (the starter network is optional), does not reject
      expect(signals[0]?.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not download the starter network"), expect.anything());
      expect(await names()).toEqual(["Blocky", "Classic", "Sprout"]);
      expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(false);

      vi.useRealTimers();
      const retry = gatedDownload();
      retry.release();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000); // the next start
      await ensureSeeded();
      expect(await names()).toEqual(["Neuron", "Blocky", "Classic", "Sprout"]);
    });
  }

  it("brings all four starters back when all data is deleted while the network downloads", async () => {
    const { fetchMock, release } = gatedDownload();
    const first = ensureSeeded();
    await whenSeeded();
    await clearAllData();
    const again = ensureSeeded(); // what Settings → "Delete all data" does next
    await whenSeeded();
    // The engines came back at once; they did not wait for the download either.
    expect(await names()).toEqual(["Blocky", "Classic", "Sprout"]);
    release();
    await Promise.all([first, again]);
    expect(await names()).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    expect((await networksRepo.list()).map((n) => n.id)).toEqual([STARTER_NETWORK_ID]);
    expect(await settingsRepo.get(SEED_FLAG_KEY, false)).toBe(true);
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("brings the starters back when all data is deleted right after the network was added", async () => {
    gatedDownload().release();
    await ensureSeeded();
    await clearAllData();
    await ensureSeeded();
    expect(await names()).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    expect(await networksRepo.get(STARTER_NETWORK_ID)).toBeDefined();
  });

  it("runs another pass when Restore starter engines clears the flags during a download", async () => {
    const { fetchMock, release } = gatedDownload();
    const first = ensureSeeded();
    await whenSeeded();
    const classic = (await enginesRepo.list()).find((e) => e.name === "Classic")!;
    await enginesRepo.remove(classic.id);
    // What restoreStarterEngines (src/pages/engines/actions.ts) does:
    await settingsRepo.remove(SEED_FLAG_KEY);
    await settingsRepo.remove(NETWORK_SEED_FLAG_KEY);
    const restore = ensureSeeded();
    await whenSeeded();
    expect((await names()).filter((n) => n === "Classic")).toHaveLength(1); // back without waiting for the download
    release();
    await Promise.all([first, restore]);
    expect(await enginesRepo.get(STARTER_NNUE_ENGINE_ID)).toBeDefined();
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a restored backup's starter network and Neuron, also when the backup arrives during the download", async () => {
    // A backup from another browser: Neuron and the starter network renamed by the user.
    gatedDownload().release();
    await ensureSeeded();
    await enginesRepo.update(STARTER_NNUE_ENGINE_ID, { name: "My Neuron" });
    await networksRepo.update(STARTER_NETWORK_ID, { name: "My network" });
    const json = JSON.parse(await (await exportBackup()).text()) as { stores: { settings: Array<{ key: string }> } };
    // Without the network flag, so the seeding's own check (records with the fixed ids) is what protects them.
    json.stores.settings = json.stores.settings.filter((s) => s.key !== NETWORK_SEED_FLAG_KEY);
    const backup = new Blob([JSON.stringify(json)], { type: "application/json" });

    // A fresh browser restores it while its own first-run download is still going on.
    await resetStorage();
    const { release } = gatedDownload();
    const seeding = ensureSeeded();
    await whenSeeded();
    await importBackup(backup);
    release();
    await seeding;
    expect((await enginesRepo.list()).filter((e) => e.id === STARTER_NNUE_ENGINE_ID).map((e) => e.name)).toEqual(["My Neuron"]);
    expect((await networksRepo.list()).map((n) => n.name)).toEqual(["My network"]);
    expect(await settingsRepo.get(NETWORK_SEED_FLAG_KEY, false)).toBe(true);
  });

  it("lets a second tab use its library while the first tab downloads, and downloads only once", async () => {
    const { fetchMock, release } = gatedDownload();
    vi.resetModules();
    const tabA = await import("./seed");
    const seedingA = tabA.ensureSeeded();
    await tabA.whenSeeded();
    while (fetchMock.mock.calls.length === 0) await nextTask(); // A holds the network lock, downloading
    vi.resetModules();
    const tabB = await import("./seed");
    const seedingB = tabB.ensureSeeded();
    await tabB.whenSeeded(); // B's engines part sees A's flag and is done; its network part waits for A's lock
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([seedingA, seedingB]);
    vi.resetModules();
    const { enginesRepo: freshRepo } = await import("./repos");
    expect((await freshRepo.list()).map((e) => e.name)).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
