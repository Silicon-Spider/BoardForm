import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRecord } from "@/types";
import { cacheConfig, gamesQuery, getLiveQuery, listQuery, peekLiveQuery, settingQuery, writeSetting, type QueryState } from "./cache";
import { getDB } from "./db";
import { CHANNEL_NAME } from "./events";
import { enginesRepo, gamesRepo, settingsRepo } from "./repos";
import { makeEngine, makeGame, resetStorage, sleep, waitFor } from "./test-utils";

const saved = { ...cacheConfig };
beforeAll(() => {
  Object.assign(cacheConfig, { debounceMs: 5, maxWaitMs: 40, graceMs: 80, retryMs: 20 });
});
afterAll(() => {
  Object.assign(cacheConfig, saved);
});
beforeEach(resetStorage);

const offs: Array<() => void> = [];
afterEach(() => {
  while (offs.length) offs.pop()!();
  vi.restoreAllMocks();
});

function data<T>(state: QueryState<T>): T {
  if (state.status !== "ready") throw new Error(`not ready: ${state.status}`);
  return state.data;
}

async function readyEngines() {
  const q = listQuery("engines");
  offs.push(q.subscribe(() => {}));
  await waitFor(() => q.getSnapshot().status === "ready", 2000, "engines ready");
  return q;
}

const names = (list: EngineRecord[]) => list.map((e) => e.name);

describe("list caches", () => {
  it("load lazily, once, shared by every subscriber", async () => {
    await enginesRepo.put(makeEngine("a", { updatedAt: 1 }));
    await enginesRepo.put(makeEngine("b", { updatedAt: 2 }));
    const q = listQuery("engines");
    expect(listQuery("engines")).toBe(q);
    expect(q.getSnapshot().status).toBe("loading");
    await sleep(20);
    expect(q.stats.loads).toBe(0); // nothing happens until someone subscribes

    const l1 = vi.fn();
    const l2 = vi.fn();
    offs.push(q.subscribe(l1), q.subscribe(l2));
    await waitFor(() => q.getSnapshot().status === "ready");
    expect(q.stats.loads).toBe(1);
    expect(data(q.getSnapshot()).map((e) => e.id)).toEqual(["b", "a"]);
    expect(l1).toHaveBeenCalled();
    expect(l2).toHaveBeenCalled();
  });

  it("refresh a burst of changes with very few queries", async () => {
    const q = await readyEngines();
    const before = q.stats.loads + q.stats.patches;
    await Promise.all(Array.from({ length: 40 }, (_, i) => enginesRepo.put(makeEngine(`e${i}`, { updatedAt: i }))));
    await waitFor(() => data(q.getSnapshot()).length === 40);
    await sleep(30);
    expect(q.stats.loads + q.stats.patches - before).toBeLessThanOrEqual(2);
    expect(data(q.getSnapshot())[0].id).toBe("e39"); // newest-updated first
  });

  it("re-read only the changed records and keep unchanged references", async () => {
    for (const id of ["a", "b", "c"]) await enginesRepo.put(makeEngine(id, { updatedAt: 1 }));
    const q = await readyEngines();
    const [a, b, c] = data(q.getSnapshot());
    const loads = q.stats.loads;

    await enginesRepo.update("b", { name: "B2" });
    await waitFor(() => names(data(q.getSnapshot())).includes("B2"));
    const next = data(q.getSnapshot());
    expect(next.map((e) => e.id)).toEqual(["b", "a", "c"]); // b is now the most recently updated
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(c);
    expect(next[0]).not.toBe(b);
    expect(q.stats.loads).toBe(loads);
    expect(q.stats.patches).toBeGreaterThan(0);
  });

  it("keep the very same snapshot when a write changes nothing", async () => {
    await enginesRepo.put(makeEngine("a"));
    const q = await readyEngines();
    const snap = q.getSnapshot();
    const record = data(snap)[0];
    await enginesRepo.put(makeEngine("a")); // identical content, new object
    await sleep(40);
    expect(q.stats.patches).toBeGreaterThan(0); // it did re-read...
    expect(q.getSnapshot()).toBe(snap); // ...but kept the snapshot
    expect(data(q.getSnapshot())[0]).toBe(record);
  });

  it("drop deleted records", async () => {
    await enginesRepo.put(makeEngine("a"));
    await enginesRepo.put(makeEngine("b"));
    const q = await readyEngines();
    await enginesRepo.remove("a");
    await waitFor(() => data(q.getSnapshot()).length === 1);
    expect(data(q.getSnapshot())[0].id).toBe("b");
  });

  it("report a just-written record as pending until it is in the snapshot", async () => {
    const q = await readyEngines();
    await enginesRepo.put(makeEngine("fresh"));
    expect(data(q.getSnapshot()).some((e) => e.id === "fresh")).toBe(false);
    expect(q.isPending("fresh")).toBe(true);
    await waitFor(() => data(q.getSnapshot()).some((e) => e.id === "fresh"));
    expect(q.isPending("fresh")).toBe(false);
    expect(q.isPending("never-written")).toBe(false);
  });

  it("notify once a refresh settles even if nothing changed, so pending lookups resolve", async () => {
    const q = await readyEngines();
    const listener = vi.fn();
    offs.push(q.subscribe(listener));
    await enginesRepo.remove("ghost"); // a change event for a record that never existed
    expect(q.isPending("ghost")).toBe(true);
    const snap = q.getSnapshot();
    listener.mockClear();
    await waitFor(() => !q.isPending("ghost"));
    await sleep(10);
    expect(listener).toHaveBeenCalled();
    expect(q.getSnapshot()).toBe(snap);
  });

  it("pick up changes announced by other tabs", async () => {
    const q = await readyEngines();
    // Another tab wrote to the shared database and announced it on the channel.
    await (await getDB()).put("engines", makeEngine("remote", { name: "From tab 2" }));
    const tab2 = new BroadcastChannel(CHANNEL_NAME);
    offs.push(() => tab2.close());
    tab2.postMessage({ type: "chess-builder-db:changes", events: [{ store: "engines", id: "remote", op: "put" }] });
    await waitFor(() => names(data(q.getSnapshot())).includes("From tab 2"), 2000, "remote change");
  });

  it("stay alive for the grace period after the last subscriber, then reload from scratch", async () => {
    await enginesRepo.put(makeEngine("a"));
    const q = listQuery("engines");
    const off = q.subscribe(() => {});
    await waitFor(() => q.getSnapshot().status === "ready");
    off();
    expect(peekLiveQuery("list:engines")).toBe(q);
    await enginesRepo.put(makeEngine("b")); // still kept fresh during the grace period
    await waitFor(() => data(q.getSnapshot()).length === 2);
    await sleep(cacheConfig.graceMs + 40);
    expect(peekLiveQuery("list:engines")).toBeUndefined();

    const q2 = listQuery("engines");
    expect(q2).not.toBe(q);
    expect(q2.getSnapshot().status).toBe("loading");
    offs.push(q2.subscribe(() => {}));
    await waitFor(() => q2.getSnapshot().status === "ready");
    expect(data(q2.getSnapshot())).toHaveLength(2);
  });
});

describe("failures", () => {
  it("enter the error state, retry while subscribed, and recover", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const q = getLiveQuery<number>("test:flaky", () => ({
      store: "engines",
      load: async () => {
        if (fail) throw new Error("disk on fire");
        return 42;
      },
    }));
    offs.push(q.subscribe(() => {}));
    await waitFor(() => q.getSnapshot().status === "error");
    const state = q.getSnapshot();
    expect(state.status === "error" && (state.error as Error).message).toBe("disk on fire");
    fail = false;
    await waitFor(() => q.getSnapshot().status === "ready", 2000, "retry");
    expect(data(q.getSnapshot())).toBe(42);
  });

  it("drop an errored cache when its last subscriber leaves, so a remount starts fresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const q = getLiveQuery<number>("test:broken", () => ({
      store: "engines",
      load: async () => {
        throw new Error("nope");
      },
    }));
    const off = q.subscribe(() => {});
    await waitFor(() => q.getSnapshot().status === "error");
    off();
    expect(peekLiveQuery("test:broken")).toBeUndefined();
  });
});

describe("games and settings caches", () => {
  it("games of one match refresh on new games and ignore no-op changes", async () => {
    await gamesRepo.put(makeGame("g1", 1, "m1"));
    await gamesRepo.put(makeGame("x", 2, "m2"));
    const q = gamesQuery({ matchId: "m1" });
    expect(gamesQuery({ matchId: "m1" })).toBe(q);
    expect(gamesQuery({ matchId: "m2" })).not.toBe(q);
    offs.push(q.subscribe(() => {}));
    await waitFor(() => q.getSnapshot().status === "ready");
    expect(data(q.getSnapshot()).map((g) => g.id)).toEqual(["g1"]);

    const snap = q.getSnapshot();
    await gamesRepo.put(makeGame("y", 3, "m2")); // another match
    await sleep(40);
    expect(q.getSnapshot()).toBe(snap);

    await gamesRepo.put(makeGame("g2", 5, "m1"));
    await waitFor(() => data(q.getSnapshot()).length === 2);
    expect(data(q.getSnapshot()).map((g) => g.id)).toEqual(["g2", "g1"]);
  });

  it("settings update optimistically and settle on the last written value", async () => {
    const q = settingQuery("ui.depth");
    const seen: unknown[] = [];
    offs.push(
      q.subscribe(() => {
        const s = q.getSnapshot();
        if (s.status === "ready") seen.push(s.data.value);
      }),
    );
    await waitFor(() => q.getSnapshot().status === "ready");
    expect(data(q.getSnapshot()).exists).toBe(false);

    const p = writeSetting("ui.depth", 5);
    expect(data(q.getSnapshot())).toEqual({ exists: true, value: 5 }); // before the write finished
    await p;
    expect(await settingsRepo.get("ui.depth", 0)).toBe(5);

    seen.length = 0;
    await Promise.all([writeSetting("ui.depth", 1), writeSetting("ui.depth", 2), writeSetting("ui.depth", 3)]);
    await sleep(60);
    expect(data(q.getSnapshot()).value).toBe(3);
    expect(seen.slice(seen.indexOf(3))).toEqual(seen.slice(seen.indexOf(3)).map(() => 3)); // never regresses
    expect(await settingsRepo.get("ui.depth", 0)).toBe(3);

    // Other keys do not disturb it.
    const snap = q.getSnapshot();
    await settingsRepo.set("other", 1);
    await sleep(30);
    expect(q.getSnapshot()).toBe(snap);
  });
});
