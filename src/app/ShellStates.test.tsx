// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStatus = vi.hoisted(() => ({ current: null as null | { type: string; message: string; reloadRequired: boolean; at: number } }));
vi.mock("@/storage", () => ({ useDatabaseStatus: () => dbStatus.current }));

import { DatabaseBanner, ErrorBoundary, NotFoundPage } from "./ShellStates";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  dbStatus.current = null;
});

const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name);

describe("ErrorBoundary", () => {
  it("shows a recoverable crash screen and retries on “Try again”", () => {
    let broken = true;
    function Page() {
      if (broken) throw new Error("Cannot read properties of undefined (reading 'moves')");
      return <p>Page content</p>;
    }
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/play">
          <Page />
        </ErrorBoundary>,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Something went wrong on this page");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("reading 'moves'");
    expect(container.querySelector("details pre")?.textContent).toContain("Error: Cannot read properties");
    expect(container.querySelector('a[href="#/engines"]')?.textContent).toBe("Go to your engines");
    broken = false;
    act(() => button("Try again")!.click());
    expect(container.textContent).toBe("Page content");
  });

  it("clears the crash when the route changes", () => {
    function Boom(): never {
      throw new Error("boom");
    }
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/a">
          <Boom />
        </ErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("Something went wrong");
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/b">
          <p>Other page</p>
        </ErrorBoundary>,
      ),
    );
    expect(container.textContent).toBe("Other page");
  });
});

describe("NotFoundPage", () => {
  it("names the path and links back", () => {
    act(() => root.render(<NotFoundPage path="/nowhere" />));
    expect(container.querySelector("h1")?.textContent).toBe("Page not found");
    expect(container.textContent).toContain("#/nowhere");
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["#/engines", "#/help"]);
  });
});

describe("DatabaseBanner", () => {
  it("is hidden while the database is fine and asks for a reload when needed", () => {
    act(() => root.render(<DatabaseBanner />));
    expect(container.textContent).toBe("");
    dbStatus.current = { type: "version-change", message: "BoardForm was updated in another tab.", reloadRequired: true, at: 1 };
    act(() => root.render(<DatabaseBanner key="again" />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("updated in another tab");
    expect(button("Reload")).toBeTruthy();
  });
});
