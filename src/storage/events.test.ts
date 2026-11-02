import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_RECORDS, CHANNEL_NAME, COLLAPSE_THRESHOLD, emitChanges, subscribe, type ChangeEvent } from "./events";
import { datasetsRepo, enginesRepo, gamesRepo, networksRepo, settingsRepo } from "./repos";
import { makeChunk, makeEngine, makeGame, makeNetwork, resetStorage, sleep, waitFor } from "./test-utils";

beforeEach(resetStorage);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function record(store: Parameters<typeof subscribe>[0]): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  cleanups.push(subscribe(store, (e) => events.push(e)));
  return events;
}

/** Another "tab": a separate BroadcastChannel on the same name. */
function otherTab(): { channel: BroadcastChannel; received: unknown[] } {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const received: unknown[] = [];
  channel.onmessage = (ev: MessageEvent) => received.push(ev.data);
  cleanups.push(() => channel.close());
  return { channel, received };
}

describe("subscribe (same tab)", () => {
  it("fires after the write committed, for puts and deletes", async () => {
    const reads: Array<Promise<unknown>> = [];
    const events: ChangeEvent[] = [];
    cleanups.push(
      subscribe("engines", (e) => {
        events.push(e);
        // Reading inside the callback must already see the committed state.
        reads.push(enginesRepo.get(e.id));
      }),
    );
    await enginesRepo.put(makeEngine("a"));
    expect(events).toEqual([{ store: "engines", id: "a", op: "put" }]);
    expect(await reads[0]).toMatchObject({ id: "a" });

    await enginesRepo.update("a", { name: "x" });
    await enginesRepo.remove("a");
    expect(events).toEqual([
      { store: "engines", id: "a", op: "put" },
      { store: "engines", id: "a", op: "put" },
      { store: "engines", id: "a", op: "delete" },
    ]);
    expect(await reads[2]).toBeUndefined();
  });

  it("filters by store; '*' receives every store", async () => {
    const engines = record("engines");
    const all = record("*");
    await enginesRepo.put(makeEngine("a"));
    await settingsRepo.set("k", 1);
    await gamesRepo.put(makeGame("g", 1));
    expect(engines.map((e) => e.store)).toEqual(["engines"]);
    expect(all).toEqual([
      { store: "engines", id: "a", op: "put" },
      { store: "settings", id: "k", op: "put" },
      { store: "games", id: "g", op: "put" },
    ]);
  });

  it("does not fire for failed writes", async () => {
    const events = record("*");
    await expect(enginesRepo.update("missing", { name: "x" })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("network removal reports both the record and its weights", async () => {
    await networksRepo.put(makeNetwork("n"));
    const events = record("*");
    await networksRepo.remove("n");
    expect(events).toEqual([
      { store: "networks", id: "n", op: "delete" },
      { store: "networkData", id: "n", op: "delete" },
    ]);
  });

  it("unsubscribes independently, even for the same callback subscribed twice", async () => {
    const cb = vi.fn();
    const off1 = subscribe("engines", cb);
    const off2 = subscribe("engines", cb);
    await enginesRepo.put(makeEngine("a"));
    expect(cb).toHaveBeenCalledTimes(2);
    off1();
    await enginesRepo.put(makeEngine("b"));
    expect(cb).toHaveBeenCalledTimes(3);
    off2();
    off2(); // idempotent
    await enginesRepo.put(makeEngine("c"));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("a throwing listener does not break the write or other listeners", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      subscribe("engines", () => {
        throw new Error("boom");
      }),
    );
    const events = record("engines");
    await enginesRepo.put(makeEngine("a"));
    expect(events.length).toBe(1);
    expect(errors).toHaveBeenCalled();
  });

  it("collapses large bursts into one ALL_RECORDS event per store", () => {
    const events = record("*");
    const many: ChangeEvent[] = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) => ({ store: "datasetChunks", id: `c${i}`, op: "delete" }));
    emitChanges([{ store: "datasets", id: "d", op: "put" }, ...many], { broadcast: false });
    expect(events).toEqual([
      { store: "datasets", id: "d", op: "put" },
      { store: "datasetChunks", id: ALL_RECORDS, op: "delete" },
    ]);
  });

  it("deleting a big dataset sends a bounded number of events", async () => {
    for (let i = 0; i < 300; i++) await datasetsRepo.putChunk(makeChunk("d", i, 1));
    const events = record("*");
    await datasetsRepo.remove("d");
    // One collapsed event per full delete batch, a remainder batch below the threshold is itemised.
    expect(events.length).toBeLessThanOrEqual(COLLAPSE_THRESHOLD + 2);
    expect(events).toContainEqual({ store: "datasetChunks", id: ALL_RECORDS, op: "delete" });
    expect(events).toContainEqual({ store: "datasets", id: "d", op: "delete" });
  });
});

describe("subscribe (other tabs / workers)", () => {
  it("broadcasts local writes on the shared channel, without echoing them back locally", async () => {
    const tab = otherTab();
    const local = record("engines");
    await enginesRepo.put(makeEngine("a"));
    await waitFor(() => tab.received.length > 0, 2000, "broadcast");
    expect(tab.received[0]).toMatchObject({ events: [{ store: "engines", id: "a", op: "put" }] });
    await sleep(30);
    expect(local).toEqual([{ store: "engines", id: "a", op: "put" }]); // exactly once
  });

  it("delivers changes announced by another tab to local subscribers", async () => {
    const tab = otherTab();
    const local = record("engines");
    const messageType = "boardform-db:changes";
    tab.channel.postMessage({ type: messageType, events: [{ store: "engines", id: "remote", op: "put" }] });
    // Malformed messages are ignored.
    tab.channel.postMessage("garbage");
    tab.channel.postMessage({ type: messageType, events: [{ store: "nope", id: "x", op: "put" }, { store: "engines", id: 5, op: "put" }] });
    tab.channel.postMessage({ type: "other", events: [{ store: "engines", id: "y", op: "put" }] });
    await waitFor(() => local.length > 0, 2000, "remote event");
    await sleep(30);
    expect(local).toEqual([{ store: "engines", id: "remote", op: "put" }]);
  });
});
