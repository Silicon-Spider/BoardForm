import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage, storageEstimate } from "./persist";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(storage: Partial<StorageManager> | undefined) {
  vi.stubGlobal("navigator", { userAgent: "test", storage });
}

describe("requestPersistentStorage", () => {
  it("is false when the API is missing", async () => {
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("does not ask again when storage is already persistent", async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => true, persist });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks and reports the answer; never rejects", async () => {
    stubStorage({ persisted: async () => false, persist: async () => true });
    expect(await requestPersistentStorage()).toBe(true);
    stubStorage({ persisted: async () => false, persist: async () => false });
    expect(await requestPersistentStorage()).toBe(false);
    stubStorage({
      persisted: async () => false,
      persist: async () => {
        throw new Error("denied");
      },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });
});

describe("storageEstimate", () => {
  it("reports usage, quota and persistence", async () => {
    stubStorage({ estimate: async () => ({ usage: 1234, quota: 1e9 }), persisted: async () => true });
    expect(await storageEstimate()).toEqual({ usage: 1234, quota: 1e9, persisted: true });
  });

  it("uses NaN / false for what the browser does not report", async () => {
    stubStorage(undefined);
    const none = await storageEstimate();
    expect(none.usage).toBeNaN();
    expect(none.quota).toBeNaN();
    expect(none.persisted).toBe(false);
    stubStorage({
      estimate: async () => {
        throw new Error("nope");
      },
    });
    expect((await storageEstimate()).quota).toBeNaN();
  });
});
