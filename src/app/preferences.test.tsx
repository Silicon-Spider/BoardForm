// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Theme handling does not touch IndexedDB; keep the storage layer out of jsdom.
vi.mock("@/storage", () => ({ settingsRepo: { get: async () => undefined }, useSetting: () => [undefined, () => {}] }));

import { THEME_STORAGE_KEY, applyTheme, getThemePreference, setThemePreference, useThemePreference, watchSystemTheme } from "./preferences";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the browser does in every *other* tab when one tab writes the theme. */
function otherTabWrites(value: string | null): void {
  if (value === null) localStorage.removeItem(THEME_STORAGE_KEY);
  else localStorage.setItem(THEME_STORAGE_KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: value, storageArea: localStorage }));
}

beforeAll(() => {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.head.appendChild(meta);
  watchSystemTheme();
});

afterEach(() => {
  localStorage.clear();
  applyTheme("dark");
});

describe("colour theme", () => {
  it("applies the theme and the browser-chrome colour", () => {
    setThemePreference("light");
    expect(getThemePreference()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");
    setThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#161a20");
  });

  it("follows a theme change made in another tab", () => {
    expect(document.documentElement.dataset.theme).toBe("dark");
    otherTabWrites("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    otherTabWrites("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("falls back to dark when another tab clears storage, and ignores other keys", () => {
    otherTabWrites("light");
    localStorage.setItem("cb.play.snapshot", "{}");
    window.dispatchEvent(new StorageEvent("storage", { key: "cb.play.snapshot", newValue: "{}" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("re-renders components that show the preference, for this tab and other tabs", () => {
    const seen: string[] = [];
    function Probe() {
      const theme = useThemePreference();
      seen.push(theme);
      return <span>{theme}</span>;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    expect(host.textContent).toBe("dark");
    act(() => setThemePreference("system"));
    expect(host.textContent).toBe("system");
    act(() => otherTabWrites("light"));
    expect(host.textContent).toBe("light");
    act(() => root.unmount());
    expect(seen).toContain("system");
  });
});
