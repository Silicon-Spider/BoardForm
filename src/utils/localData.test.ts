import { describe, expect, it } from "vitest";
import { clearLocalAppData, listLocalAppKeys, type KeyedStorage } from "./localData";

/** An in-memory Storage with the same key()/length semantics as the real one. */
function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const keysOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)).sort();

describe("clearLocalAppData", () => {
  it("removes the Workshop drafts and the Play snapshot but keeps the theme", () => {
    const storage = memoryStorage({
      "cb.theme": "light",
      "cb.workshop.unsaved.engine-1": JSON.stringify({ at: 1, patch: { name: "x" } }),
      "cb.workshop.unsaved.engine-2": JSON.stringify({ at: 2, patch: { name: "y" } }),
      "cb.play.snapshot": JSON.stringify({ id: "g1" }),
      "cb.some.future.key": "1",
    });
    const removed = clearLocalAppData(storage);
    expect(removed.sort()).toEqual(["cb.play.snapshot", "cb.some.future.key", "cb.workshop.unsaved.engine-1", "cb.workshop.unsaved.engine-2"]);
    expect(keysOf(storage)).toEqual(["cb.theme"]);
    expect(storage.getItem("cb.theme")).toBe("light");
  });

  it("leaves keys of other apps on the same origin alone", () => {
    const storage = memoryStorage({ "other-app:token": "t", cbx: "1", "cb.play.snapshot": "{}", "CB.upper": "1" });
    clearLocalAppData(storage);
    expect(keysOf(storage)).toEqual(["CB.upper", "cbx", "other-app:token"]);
  });

  it("does nothing when there is nothing to remove", () => {
    const storage = memoryStorage({ "cb.theme": "dark" });
    expect(clearLocalAppData(storage)).toEqual([]);
    expect(clearLocalAppData(memoryStorage({}))).toEqual([]);
  });

  it("copes with blocked or failing storage", () => {
    expect(clearLocalAppData(null)).toEqual([]);
    const throwing: KeyedStorage = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key: () => null,
      removeItem: () => undefined,
    };
    expect(clearLocalAppData(throwing)).toEqual([]);
    // A key that cannot be removed does not stop the others.
    const base = memoryStorage({ "cb.a": "1", "cb.b": "2" });
    const partly: KeyedStorage = {
      get length() {
        return base.length;
      },
      key: (i) => base.key(i),
      removeItem: (k) => {
        if (k === "cb.a") throw new Error("nope");
        base.removeItem(k);
      },
    };
    expect(clearLocalAppData(partly)).toEqual(["cb.b"]);
  });

  it("lists only BoardForm keys", () => {
    expect(listLocalAppKeys(memoryStorage({ "cb.theme": "x", foo: "y" }))).toEqual(["cb.theme"]);
  });
});
