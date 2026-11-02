// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VISIBLE_TOASTS,
  MAX_VISIBLE_TOASTS_NARROW,
  NARROW_TOASTS_QUERY,
  Toaster,
  dismissAllToasts,
  dismissToast,
  getToasts,
  pauseToasts,
  resumeToasts,
  splitToasts,
  toast,
} from "./toast";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    resumeToasts();
    dismissAllToasts();
  });
  vi.useRealTimers();
});

describe("toast store", () => {
  it("dismisses toasts after their timeout (errors stay longer)", () => {
    toast("Saved", { kind: "success" });
    toast("Broken", { kind: "error" });
    expect(getToasts().map((t) => t.message)).toEqual(["Saved", "Broken"]);
    vi.advanceTimersByTime(4100);
    expect(getToasts().map((t) => t.message)).toEqual(["Broken"]);
    vi.advanceTimersByTime(5000);
    expect(getToasts()).toEqual([]);
  });

  it("keeps timeoutMs 0 toasts until they are dismissed by id", () => {
    const id = toast("Importing…", { timeoutMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(getToasts()).toHaveLength(1);
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);
  });

  it("merges an identical toast into the one showing and restarts its countdown", () => {
    const a = toast("Match paused", { kind: "error", detail: "Engine crashed" });
    vi.advanceTimersByTime(8000);
    const b = toast("Match paused", { kind: "error", detail: "Engine crashed" });
    expect(b).toBe(a);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].count).toBe(2);
    vi.advanceTimersByTime(8000); // 16 s after the first: the restarted 9 s countdown still runs
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(getToasts()).toHaveLength(0);
  });

  it("does not merge toasts that differ, or progress toasts", () => {
    toast("Match paused", { kind: "error", detail: "A" });
    toast("Match paused", { kind: "error", detail: "B" });
    toast("Match paused", { kind: "warn", detail: "A" });
    const p1 = toast("Importing…", { timeoutMs: 0 });
    const p2 = toast("Importing…", { timeoutMs: 0 });
    expect(p1).not.toBe(p2);
    expect(getToasts()).toHaveLength(5);
  });

  it("moves a merged toast to the newest position", () => {
    toast("First");
    toast("Second");
    toast("First");
    expect(getToasts().map((t) => t.message)).toEqual(["Second", "First"]);
  });

  it("pauses and resumes every countdown", () => {
    toast("Hello"); // 4 s
    vi.advanceTimersByTime(3000);
    pauseToasts();
    vi.advanceTimersByTime(60_000);
    expect(getToasts()).toHaveLength(1);
    toast("Added while paused"); // its countdown starts on resume
    resumeToasts();
    // 1 s was left, but a resumed toast stays at least 1.5 s so it can be read.
    vi.advanceTimersByTime(1400);
    expect(getToasts().map((t) => t.message)).toEqual(["Hello", "Added while paused"]);
    vi.advanceTimersByTime(200);
    expect(getToasts().map((t) => t.message)).toEqual(["Added while paused"]);
    vi.advanceTimersByTime(2500);
    expect(getToasts()).toHaveLength(0);
  });

  it("caps the number of remembered toasts, dropping the oldest timed ones first", () => {
    const keep = toast("Working…", { timeoutMs: 0 });
    for (let i = 0; i < 40; i++) toast(`Note ${i}`);
    const items = getToasts();
    expect(items.length).toBeLessThanOrEqual(30);
    expect(items[0].id).toBe(keep);
    expect(items[items.length - 1].message).toBe("Note 39");
  });
});

describe("splitToasts", () => {
  it("shows the newest `limit` toasts and folds the rest", () => {
    expect(splitToasts([1, 2, 3, 4, 5], 3, false)).toEqual({ folded: [1, 2], visible: [3, 4, 5] });
    expect(splitToasts([1, 2], 3, false)).toEqual({ folded: [], visible: [1, 2] });
    expect(splitToasts([1, 2, 3, 4, 5], 3, true)).toEqual({ folded: [], visible: [1, 2, 3, 4, 5] });
  });
});

describe("<Toaster>", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const visible = () => [...container.querySelectorAll<HTMLElement>(".toast:not([hidden])")];
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);

  it("shows at most three toasts and folds older ones behind “+N more”", () => {
    act(() => root.render(<Toaster />));
    act(() => {
      for (let i = 1; i <= 5; i++) toast(`Match ${i} finished`, { kind: "error" });
    });
    expect(container.querySelectorAll(".toast")).toHaveLength(5);
    expect(visible().map((t) => t.textContent)).toEqual([
      expect.stringContaining("Match 3"),
      expect.stringContaining("Match 4"),
      expect.stringContaining("Match 5"),
    ]);
    expect(visible()).toHaveLength(MAX_VISIBLE_TOASTS);
    const more = button("+2 more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(visible()).toHaveLength(5);
    act(() => button("Clear all")!.click());
    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("shows two at once on narrow screens", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === NARROW_TOASTS_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    act(() => root.render(<Toaster />));
    act(() => {
      for (let i = 1; i <= 4; i++) toast(`Note ${i}`);
    });
    expect(visible()).toHaveLength(MAX_VISIBLE_TOASTS_NARROW);
    expect(button("+2 more")).toBeTruthy();
  });

  it("announces errors as alerts and the rest as status, with a dismiss button", () => {
    act(() => root.render(<Toaster />));
    act(() => {
      toast("Saved", { kind: "success" });
      toast("Could not save", { kind: "error", detail: "Disk full" });
    });
    const [ok, err] = visible();
    expect(ok.getAttribute("role")).toBe("status");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("Disk full");
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Notifications");
    const close = err.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')!;
    act(() => close.click());
    expect(visible()).toHaveLength(1);
  });

  it("shows how many times a merged toast was raised", () => {
    act(() => root.render(<Toaster />));
    act(() => {
      toast("Engine crashed", { kind: "error" });
      toast("Engine crashed", { kind: "error" });
      toast("Engine crashed", { kind: "error" });
    });
    expect(visible()).toHaveLength(1);
    expect(container.querySelector(".toast-count")?.textContent).toBe("×3");
  });

  it("does not stay paused after a clicked close button disappears", () => {
    act(() => root.render(<Toaster />));
    act(() => {
      toast("One");
      toast("Two");
    });
    const close = visible()[1].querySelector<HTMLButtonElement>(".toast-close")!;
    act(() => close.focus()); // a mouse click focuses the button first (Chrome on Windows)
    // detail: 1 = a pointer click (element.click() has detail 0, which reads as the keyboard).
    act(() => void close.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(visible()).toHaveLength(1);
    // The focused button left the DOM without a blur event; the countdown must still finish.
    act(() => vi.advanceTimersByTime(4100));
    expect(visible()).toHaveLength(0);
  });

  it("pauses while focus is inside and dismisses the focused toast with Escape", () => {
    act(() => root.render(<Toaster />));
    act(() => {
      toast("One");
      toast("Two");
    });
    const close = visible()[1].querySelector<HTMLButtonElement>(".toast-close")!;
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(30_000));
    expect(visible()).toHaveLength(2); // paused while focused
    act(() => {
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(visible().map((t) => t.textContent)).toEqual([expect.stringContaining("One")]);
    // Focus moved to the remaining toast's close button, so it is still paused.
    expect(document.activeElement?.classList.contains("toast-close")).toBe(true);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => vi.advanceTimersByTime(4100));
    expect(visible()).toHaveLength(0);
  });
});
