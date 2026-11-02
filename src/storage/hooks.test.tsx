// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listQuery } from "./cache";
import { closeDatabase } from "./db";
import { useEngine, useEngines, useGames, useSetting } from "./hooks";
import { enginesRepo, gamesRepo, settingsRepo } from "./repos";
import { makeEngine, makeGame, resetStorage, sleep } from "./test-utils";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await resetStorage();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

async function render(ui: ReactNode) {
  await act(async () => root.render(ui));
}

/** Let IndexedDB, the cache debounce and React settle, up to ~2 s. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await act(async () => {
      await sleep(10);
    });
  }
  expect(cond()).toBe(true);
}

function EngineList({ testId = "list" }: { testId?: string }) {
  const engines = useEngines();
  return <p data-testid={testId}>{engines === undefined ? "loading" : engines.map((e) => e.name).join(",") || "empty"}</p>;
}

const seen: string[] = [];
function EngineName({ id }: { id: string | null }) {
  const engine = useEngine(id);
  const label = engine === undefined ? "loading" : engine === null ? "missing" : engine.name;
  seen.push(label);
  return <span data-testid="one">{label}</span>;
}

function Counter({ testId }: { testId: string }) {
  const [n, setN] = useSetting("test.counter", 0);
  return (
    <button data-testid={testId} onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

function RecentGames() {
  const games = useGames({ limit: 2 });
  return <p data-testid="games">{games === undefined ? "loading" : games.map((g) => g.id).join(",")}</p>;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p data-testid="error">{this.state.error.message}</p> : this.props.children;
  }
}

describe("useEngines", () => {
  it("is undefined while loading, then lists engines and follows changes; all components share one query", async () => {
    await enginesRepo.put(makeEngine("a", { name: "Alpha", updatedAt: 1 }));
    await enginesRepo.put(makeEngine("b", { name: "Bravo", updatedAt: 2 }));
    await render(
      <>
        <EngineList testId="l1" />
        <EngineList testId="l2" />
        <EngineList testId="l3" />
      </>,
    );
    expect(text("l1")).toBe("loading");
    await until(() => text("l1") === "Bravo,Alpha");
    expect(text("l2")).toBe("Bravo,Alpha");
    expect(text("l3")).toBe("Bravo,Alpha");
    expect(listQuery("engines").stats.loads).toBe(1);

    await act(async () => {
      await enginesRepo.update("a", { name: "Alpha 2" });
    });
    await until(() => text("l1") === "Alpha 2,Bravo");
    await act(async () => {
      await enginesRepo.remove("b");
    });
    await until(() => text("l3") === "Alpha 2");
  });
});

describe("useEngine", () => {
  it("returns the record, null when missing or without id, and never flashes 'missing' for a just-created engine", async () => {
    await enginesRepo.put(makeEngine("a", { name: "Alpha" }));
    await render(<EngineName id="a" />);
    await until(() => text("one") === "Alpha");

    await render(<EngineName id={null} />);
    expect(text("one")).toBe("missing");

    await render(<EngineName id="new" />);
    await until(() => text("one") === "missing");
    seen.length = 0;
    await act(async () => {
      await enginesRepo.put(makeEngine("new", { name: "Fresh" }));
    });
    await until(() => text("one") === "Fresh");
    expect(seen).not.toContain("missing");

    await act(async () => {
      await enginesRepo.remove("new");
    });
    await until(() => text("one") === "missing");

    // A change event for an id that does not exist must not leave it stuck on "loading".
    await render(<EngineName id="ghost" />);
    await until(() => text("one") === "missing");
    await act(async () => {
      await enginesRepo.remove("ghost");
    });
    await until(() => text("one") === "missing");
    await act(async () => {
      await sleep(80);
    });
    expect(text("one")).toBe("missing");
  });
});

describe("useSetting", () => {
  it("returns the fallback, persists writes and updates every user at once", async () => {
    await render(
      <>
        <Counter testId="c1" />
        <Counter testId="c2" />
      </>,
    );
    expect(text("c1")).toBe("0");
    await act(async () => {
      (container.querySelector('[data-testid="c1"]') as HTMLButtonElement).click();
    });
    expect(text("c1")).toBe("1");
    expect(text("c2")).toBe("1"); // same render pass, before the database write finished
    await until(() => text("c2") === "1");
    expect(await settingsRepo.get("test.counter", 0)).toBe(1);

    // A write from elsewhere (another tab, a service) shows up too.
    await act(async () => {
      await settingsRepo.set("test.counter", 41);
    });
    await until(() => text("c1") === "41" && text("c2") === "41");
  });
});

describe("useGames", () => {
  it("returns the newest games", async () => {
    await gamesRepo.put(makeGame("g1", 1));
    await gamesRepo.put(makeGame("g2", 2));
    await gamesRepo.put(makeGame("g3", 3));
    await render(<RecentGames />);
    await until(() => text("games") === "g3,g2");
    await act(async () => {
      await gamesRepo.put(makeGame("g4", 4));
    });
    await until(() => text("games") === "g4,g3");
  });
});

describe("errors", () => {
  it("surface in the page's error boundary instead of loading forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closeDatabase();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined; // IndexedDB disabled
    await render(
      <Boundary>
        <EngineList />
      </Boundary>,
    );
    await until(() => text("error") !== null);
    expect(text("error")).toMatch(/IndexedDB/);
  });
});
