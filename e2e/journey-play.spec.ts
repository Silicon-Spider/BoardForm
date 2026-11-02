// Journey: "play themself on that computer, play their networks or get their networks to play each
// other and set parameters like the max number of moves that the engine is allowed to search, the
// time control or the depth for the engine".
//
// Every limit is checked against what the engines themselves report: an init script records each
// engine worker's traffic (the hash size it starts with, the limits of every search, every search
// info and the result), so the tests compare the settings made in the UI with the depth, nodes and
// time the engines actually used, and with the clocks, engine cards and saved games.
//
// Run: E2E_PORT=5244 npx playwright test e2e/journey-play.spec.ts --reporter=line
// Measurements are printed (prefix "[measure]") and attached to each test as annotations.
//
// Every test gets a fresh browser context: the app seeds Blocky, Classic, Sprout and Neuron (an NNUE
// engine playing the bundled starter network) on load; `openApp` waits for them. Limits are depths
// and node counts wherever possible, so the results do not depend on the machine's load.
import { expect, test as base, type Locator, type Page } from "@playwright/test";

// --- fixtures: console errors fail the test --------------------------------------------------

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`[console] ${m.text()}`);
      });
      await use(errors);
      expect(errors, "browser console errors").toEqual([]);
    },
    { auto: true },
  ],
});

// --- app modules inside the page (typed from the sources) -------------------------------------

type StorageModule = typeof import("../src/storage/index");
type EngineHostModule = typeof import("../src/engine-host/index");
type ArenaModule = typeof import("../src/arena/index");

type StarterName = "Blocky" | "Classic" | "Sprout" | "Neuron";
type Ids = Record<StarterName, string>;
const STARTERS: StarterName[] = ["Blocky", "Classic", "Sprout", "Neuron"];

const GAME_BOARD = '[aria-label="Game board"]';

/** Opens the app and waits until the four starter engines and the starter network exist. */
async function openApp(page: Page, hash = "#/play"): Promise<Ids> {
  await page.goto("/" + hash);
  let ids: Partial<Ids> = {};
  await expect
    .poll(
      async () => {
        ids = await page.evaluate(async () => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          const [engines, networks] = await Promise.all([s.enginesRepo.list(), s.networksRepo.list()]);
          if (networks.length === 0) return {};
          return Object.fromEntries(engines.map((e) => [e.name, e.id]));
        });
        return STARTERS.every((n) => !!ids[n]);
      },
      { timeout: 60_000, message: "the starter engines and network are seeded" },
    )
    .toBe(true);
  return ids as Ids;
}

async function setSetting(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(async ([k, v]) => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.set(k as string, v), [key, value] as const);
}

interface SavedGame {
  id: string;
  result: string;
  termination: string;
  moves: string[];
  san: string[];
  evals: Array<number | null>;
  times: number[];
  pgn: string;
  white: { type: string; name: string };
  black: { type: string; name: string };
  matchId?: string | null;
}

async function savedGames(page: Page, matchId?: string): Promise<SavedGame[]> {
  return page.evaluate(
    async (mid) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).gamesRepo.list(mid ? { matchId: mid } : undefined)) as unknown as SavedGame[],
    matchId,
  ) as Promise<SavedGame[]>;
}

/** Records the measurements of a test: printed and attached as an annotation. */
function measure(text: string): void {
  console.log(`[measure] ${text}`);
  test.info().annotations.push({ type: "measure", description: text });
}

// --- the engine-worker tap --------------------------------------------------------------------

interface TapInfo {
  depth: number;
  nodes: number;
  timeMs: number;
  scoreCp: number | null;
  mate: number | null;
  pv0: string | null;
}
interface TapLimits {
  depth?: number;
  nodes?: number;
  movetimeMs?: number;
  clock?: { wtime: number; btime: number; winc: number; binc: number; movestogo?: number };
}
interface TapGo {
  w: number;
  limits: TapLimits;
  infos: TapInfo[];
  done: boolean;
  bestMove: string | null;
  elapsedMs: number | null;
}

/**
 * Installed with addInitScript: wraps Worker so that every engine worker ("chess-engine") records
 * its init message (hash size, network) and each search: limits, infos and the result.
 */
function installWorkerTap(): void {
  type Rec = { w: number; kind: string; hashMb?: number | null; network?: number; args?: unknown[]; infos: unknown[]; result: unknown };
  const log: Rec[] = [];
  (window as unknown as { __engineTap: Rec[] }).__engineTap = log;
  const Native = window.Worker;
  let seq = 0;
  class TappedWorker extends Native {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(url, opts);
      if (opts?.name !== "chess-engine") return;
      const w = ++seq;
      const calls = new Map<number, Rec>();
      const post = this.postMessage.bind(this) as (m: unknown, t?: Transferable[]) => void;
      this.postMessage = ((msg: { type?: string; id?: number; method?: string; args?: unknown[]; hashMb?: number | null; network?: ArrayBuffer | null }, transfer?: Transferable[]) => {
        if (msg?.type === "init") log.push({ w, kind: "init", hashMb: msg.hashMb ?? null, network: msg.network ? msg.network.byteLength : 0, infos: [], result: null });
        else if (msg?.type === "call" && msg.method === "go") {
          const rec: Rec = { w, kind: "go", args: JSON.parse(JSON.stringify(msg.args)) as unknown[], infos: [], result: null };
          calls.set(msg.id!, rec);
          log.push(rec);
        }
        if (transfer) post(msg, transfer);
        else post(msg);
      }) as Worker["postMessage"];
      this.addEventListener("message", (ev: MessageEvent) => {
        const m = ev.data as { type?: string; id?: number; info?: { depth: number; nodes: number; timeMs: number; scoreCp: number | null; mate: number | null; pv: string[] }; value?: { bestMove: string | null; elapsedMs: number } };
        const rec = m?.id !== undefined ? calls.get(m.id) : undefined;
        if (!rec) return;
        if (m.type === "info" && m.info) rec.infos.push({ depth: m.info.depth, nodes: m.info.nodes, timeMs: m.info.timeMs, scoreCp: m.info.scoreCp, mate: m.info.mate, pv0: m.info.pv[0] ?? null });
        else if (m.type === "result" && m.value) rec.result = { bestMove: m.value.bestMove, elapsedMs: m.value.elapsedMs };
      });
    }
  }
  window.Worker = TappedWorker as typeof Worker;
}

async function tapInits(page: Page): Promise<Array<{ w: number; hashMb: number | null; network: number }>> {
  return page.evaluate(() =>
    (window as unknown as { __engineTap: Array<{ w: number; kind: string; hashMb: number | null; network: number }> }).__engineTap
      .filter((r) => r.kind === "init")
      .map((r) => ({ w: r.w, hashMb: r.hashMb, network: r.network })),
  );
}

async function tapGos(page: Page): Promise<TapGo[]> {
  return page.evaluate(() =>
    (window as unknown as { __engineTap: Array<{ w: number; kind: string; args: unknown[]; infos: TapInfo[]; result: { bestMove: string | null; elapsedMs: number } | null }> }).__engineTap
      .filter((r) => r.kind === "go")
      .map((r) => ({ w: r.w, limits: r.args[0] as TapLimits, infos: r.infos, done: !!r.result, bestMove: r.result?.bestMove ?? null, elapsedMs: r.result?.elapsedMs ?? null })),
  );
}

const maxDepthOf = (g: TapGo) => g.infos.reduce((m, i) => Math.max(m, i.depth), 0);
const lastInfo = (g: TapGo): TapInfo | null => (g.infos.length ? g.infos[g.infos.length - 1] : null);
const stats = (xs: number[]) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs), avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) } : { min: NaN, max: NaN, avg: NaN });

// --- UI helpers -------------------------------------------------------------------------------

/** Centre of a square of the game board (White at the bottom unless `orientation` is black). */
async function squarePoint(page: Page, square: string, orientation: "white" | "black") {
  const box = await page.locator(GAME_BOARD).boundingBox();
  if (!box) throw new Error("game board not visible");
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const s = box.width / 8;
  return { x: box.x + (col + 0.5) * s, y: box.y + (row + 0.5) * s };
}

async function clickMove(page: Page, from: string, to: string, orientation: "white" | "black" = "white") {
  await expect(page.locator(`${GAME_BOARD} [data-square="${from}"]`).first()).toBeVisible();
  const a = await squarePoint(page, from, orientation);
  await page.mouse.click(a.x, a.y);
  const b = await squarePoint(page, to, orientation);
  await page.mouse.click(b.x, b.y);
}

const moveCells = (page: Page) => page.locator(".play-movelist .cb-ml-move:not(.cb-ml-move--empty)");

async function waitYourMove(page: Page, timeout = 60_000) {
  await expect(page.locator(".play-player-status", { hasText: "Your move" })).toBeVisible({ timeout });
}

async function confirmDialog(page: Page, label: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Milliseconds shown by a clock's aria-label ("White clock 4:57" or "White clock 0:12.3"). */
function clockMs(label: string | null): number {
  const m = /(\d+):(\d{2})(?:\.(\d))?$/.exec(label ?? "");
  if (!m) throw new Error(`not a clock label: ${label}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3] ?? 0) * 100;
}

const clockOf = (page: Page, side: "White" | "Black") => page.locator(`.play-board-col [role="timer"][aria-label^="${side} clock"]`);

/** Picks an engine (or "Human") in an EnginePicker identified by its accessible name. */
async function pick(page: Page, scope: Locator | Page, pickerName: string, option: string) {
  await scope.getByRole("button", { name: pickerName, exact: true }).click();
  await page.locator('li[role="option"]', { hasText: option }).first().click();
  await expect(scope.getByRole("button", { name: pickerName, exact: true })).toContainText(option);
}

/** Fills the compact limits editor's caps inside `scope`; missing caps are cleared (no cap). */
async function setCaps(scope: Locator, caps: { depth?: number; nodes?: number; movetimeS?: number }) {
  const fields: Array<[string, number | undefined]> = [
    ["Depth", caps.depth],
    ["Max positions searched (nodes)", caps.nodes],
    ["Time per move", caps.movetimeS],
  ];
  for (const [label, value] of fields) await scope.getByRole("textbox", { name: label, exact: true }).fill(value === undefined ? "" : String(value));
}

// ---------------------------------------------------------------------------------------------

test.describe("Journey: play and match engines with real limits", () => {
  test("every starter engine honours depth, node, time-per-move and clock limits (from its own reports)", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    const rows = await page.evaluate(async (names) => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const h = (await import(String("/src/engine-host/index.ts"))) as EngineHostModule;
      const engines = await s.enginesRepo.list();
      const positions = [
        "startpos",
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
      ];
      const out: Array<{ engine: string; kind: string; limits: Record<string, unknown>; fen: string; maxDepth: number; lastDepth: number | null; nodes: number | null; timeMs: number | null; elapsedMs: number; stopReason: string; mate: number | null; bestMove: string | null; pv0: string | null }> = [];
      for (const name of names) {
        const e = engines.find((x) => x.name === name)!;
        const client = await h.loadEngine(e.id, { label: name });
        // Sprout (no pruning, no hash table) is much slower per ply than the template engines.
        const depths = e.kind === "scratch" ? [2, 3, 4] : [2, 4, 6];
        const limitSets: Array<Record<string, unknown>> = [
          ...depths.map((depth) => ({ depth })),
          { nodes: 1000 },
          { nodes: 20000 },
          { movetimeMs: 100 },
          { movetimeMs: 400 },
          { clock: { wtime: 10_000, btime: 10_000, winc: 100, binc: 100 } },
          { clock: { wtime: 2_000, btime: 2_000, winc: 0, binc: 0, movestogo: 1 } },
        ];
        await client.newGame();
        for (const limits of limitSets) {
          for (const fen of positions) {
            await client.position(fen, []);
            let maxDepth = 0;
            const r = await client.go(limits, (i) => {
              maxDepth = Math.max(maxDepth, i.depth);
            });
            out.push({
              engine: name,
              kind: e.kind,
              limits,
              fen,
              maxDepth,
              lastDepth: r.info?.depth ?? null,
              nodes: r.info?.nodes ?? null,
              timeMs: r.info?.timeMs ?? null,
              elapsedMs: r.elapsedMs,
              stopReason: r.stopReason,
              mate: r.info?.mate ?? null,
              bestMove: r.bestMove,
              pv0: r.info?.pv[0] ?? null,
            });
          }
        }
        client.terminate();
      }
      return out;
    }, STARTERS);

    for (const name of STARTERS) {
      const mine = rows.filter((r) => r.engine === name);
      for (const r of mine) {
        const where = `${name} ${JSON.stringify(r.limits)} @ ${r.fen}`;
        expect(r.stopReason, where).toBe("done");
        expect(r.bestMove, where).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
        // The last report belongs to the move played.
        expect(r.pv0, where).toBe(r.bestMove);
      }
      // 1. Depth: never deeper than the limit, and the limit is reached (unless a mate ends it early).
      const depthRows = mine.filter((r) => typeof r.limits.depth === "number");
      for (const r of depthRows) {
        const n = r.limits.depth as number;
        expect(r.maxDepth, `${name} depth ${n} @ ${r.fen}`).toBeLessThanOrEqual(n);
        if (!r.mate) expect(r.lastDepth, `${name} depth ${n} @ ${r.fen}`).toBe(n);
      }
      // 2. Nodes: the final report counts the whole search, at or just above the limit.
      const nodeRows = mine.filter((r) => typeof r.limits.nodes === "number");
      const overshoot: number[] = [];
      for (const r of nodeRows) {
        const n = r.limits.nodes as number;
        expect(r.nodes, `${name} nodes ${n} @ ${r.fen}`).not.toBeNull();
        expect(r.nodes!, `${name} nodes ${n} @ ${r.fen}`).toBeGreaterThanOrEqual(n);
        expect(r.nodes!, `${name} nodes ${n} @ ${r.fen}`).toBeLessThanOrEqual(n + 16);
        overshoot.push(r.nodes! - n);
      }
      // 3. Time per move: uses (almost) all of it, never much more.
      const timeRows = mine.filter((r) => typeof r.limits.movetimeMs === "number");
      const usage: string[] = [];
      for (const r of timeRows) {
        const m = r.limits.movetimeMs as number;
        expect(r.elapsedMs, `${name} movetime ${m} @ ${r.fen}`).toBeGreaterThanOrEqual(m * 0.8);
        expect(r.elapsedMs, `${name} movetime ${m} @ ${r.fen}`).toBeLessThanOrEqual(m + 60);
        usage.push(`${m}→${Math.round(r.elapsedMs)}`);
      }
      // 4. Clocks: a sensible share of the remaining time, never close to all of it.
      const clockRows = mine.filter((r) => r.limits.clock);
      const clockUse: string[] = [];
      for (const r of clockRows) {
        const c = r.limits.clock as { wtime: number; movestogo?: number };
        expect(r.elapsedMs, `${name} clock ${JSON.stringify(c)} @ ${r.fen}`).toBeLessThan(c.wtime * 0.85);
        expect(r.elapsedMs, `${name} clock ${JSON.stringify(c)} @ ${r.fen}`).toBeGreaterThan(c.wtime / 60);
        clockUse.push(`${c.wtime}${c.movestogo ? `/${c.movestogo}` : ""}→${Math.round(r.elapsedMs)}`);
      }
      const kind = mine[0].kind;
      measure(
        `${name} (${kind}): depth limits ${[...new Set(depthRows.map((r) => r.limits.depth))].join("/")} → max reported ${Math.max(...depthRows.map((r) => r.maxDepth))}; ` +
          `node overshoot ${JSON.stringify(stats(overshoot))} (limits 1000/20000); movetime ms ${usage.join(" ")}; clock ms ${clockUse.join(" ")}`,
      );
    }
  });

  test("Play: engine A at depth 4 vs network engine B at 2000 nodes, own hash sizes; cards, eval bar and saved evals show the real search", async ({ page, context }) => {
    await context.addInitScript(installWorkerTap);
    const ids = await openApp(page);
    await setSetting(page, "play.moveDelayMs", 150);
    await page.reload();
    await expect(page.locator(".play-setup")).toBeVisible();

    // Set the game up through the form: Classic (White) at depth 4 with 32 MB, Neuron (Black) at 2000 nodes with 8 MB.
    await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
    const white = page.locator('.play-sidecard[data-side="w"]');
    const black = page.locator('.play-sidecard[data-side="b"]');
    await pick(page, white, "White player", "Classic");
    await pick(page, black, "Black player", "Neuron");
    await setCaps(white, { depth: 4 });
    await setCaps(black, { nodes: 2000 });
    await white.getByRole("textbox", { name: "Hash table", exact: true }).fill("32");
    await black.getByRole("textbox", { name: "Hash table", exact: true }).fill("8");
    await expect(white.getByRole("combobox", { name: "Clock" })).toHaveValue("none");
    await expect(page.locator(".play-problems")).toHaveCount(0);
    await page.locator(".play-start-button").click();

    // Player bars show each side's limits; the engines think and report.
    await expect(page.locator('.play-player[data-side="w"] .play-player-status')).toHaveText(/depth 4|Thinking/);
    await expect(moveCells(page).nth(11)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.play-player[data-side="b"]')).toContainText(/2k nodes|Thinking/);
    const whiteCard = page.getByRole("region", { name: "Classic engine" });
    const blackCard = page.getByRole("region", { name: "Neuron engine" });
    await expect(whiteCard.locator(".play-engine-stats dd").nth(1)).toHaveText(/^[1-4](\/\d+)?$/);
    await expect(page.locator(".play-evalbar[role=meter]")).toHaveAttribute("aria-label", /^Evaluation [+−-]?(\d|M)/);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await confirmDialog(page, "Stop game");
    await expect(page.locator(".play-result")).toContainText("Game aborted");

    // The cards keep the last search of each engine: depth ≤ 4 for Classic, ~2000 nodes for Neuron.
    const whiteDepth = Number((await whiteCard.locator(".play-engine-stats dd").nth(1).innerText()).split("/")[0]);
    expect(whiteDepth).toBeLessThanOrEqual(4);
    const blackNodes = await blackCard.locator(".play-engine-stats dd").nth(2).innerText();
    expect(blackNodes).toMatch(/^(1\.\d\dk|2\.00k|\d{1,3})$/);

    // What the engines were told and what they reported.
    const inits = await tapInits(page);
    expect(inits.map((i) => i.hashMb).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8, 32]);
    const neuronWorker = inits.find((i) => i.hashMb === 8)!;
    expect(neuronWorker.network, "Neuron starts with the 197,444-byte starter network").toBe(197_444);
    const gos = (await tapGos(page)).filter((g) => g.done);
    const classic = gos.filter((g) => g.limits.depth !== undefined);
    const neuron = gos.filter((g) => g.limits.nodes !== undefined);
    expect(classic.length).toBeGreaterThanOrEqual(6);
    expect(neuron.length).toBeGreaterThanOrEqual(6);
    for (const g of classic) {
      expect(g.limits).toEqual({ depth: 4 });
      expect(maxDepthOf(g)).toBeLessThanOrEqual(4);
      expect(g.w).toBe(inits.find((i) => i.hashMb === 32)!.w);
    }
    for (const g of neuron) {
      expect(g.limits).toEqual({ nodes: 2000 });
      const n = lastInfo(g)!.nodes;
      expect(n).toBeLessThanOrEqual(2016);
      expect(g.w).toBe(neuronWorker.w);
    }
    const neuronNodes = neuron.map((g) => lastInfo(g)!.nodes);
    measure(`Play depth 4: reported depths ${[...new Set(classic.map(maxDepthOf))].join(",")}; Play 2000 nodes (Neuron): reported nodes ${JSON.stringify(stats(neuronNodes))}`);

    // The saved game's evaluations are the engines' own final scores (White's point of view).
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.white).toMatchObject({ type: "engine", name: "Classic" });
    expect(g.black).toMatchObject({ type: "engine", name: "Neuron" });
    expect(g.termination).toBe("aborted");
    const played = gos.filter((x) => x.bestMove);
    for (let ply = 0; ply < Math.min(g.moves.length, played.length); ply++) {
      const last = lastInfo(played[ply]);
      expect(played[ply].bestMove, `ply ${ply + 1}`).toBe(g.moves[ply]);
      if (!last || last.mate) continue;
      const whitePov = ply % 2 === 0 ? last.scoreCp : -(last.scoreCp ?? 0);
      expect(g.evals[ply], `eval of ply ${ply + 1}`).toBe(whitePov);
    }
    void ids;
  });

  test("Play: clocks with moves per control — 10 moves in 6 s for both engines: no flag, the control resets after move 10, the display matches", async ({ page, context }) => {
    await context.addInitScript(installWorkerTap);
    await openApp(page);
    await setSetting(page, "play.moveDelayMs", 0);
    await page.reload();
    await expect(page.locator(".play-setup")).toBeVisible();

    await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
    const white = page.locator('.play-sidecard[data-side="w"]');
    const black = page.locator('.play-sidecard[data-side="b"]');
    await pick(page, white, "White player", "Classic");
    await pick(page, black, "Black player", "Neuron");
    // No caps, a custom clock: base 6 s, no increment, 10 moves per control (same clock for both).
    await setCaps(white, {});
    await setCaps(black, {});
    await white.getByRole("combobox", { name: "Clock" }).selectOption("custom");
    await white.getByRole("textbox", { name: "Base time", exact: true }).fill("6 s");
    await white.getByRole("textbox", { name: "Increment", exact: true }).fill("0");
    await white.getByRole("textbox", { name: "Moves per control", exact: true }).fill("10");
    await expect(black.getByRole("combobox", { name: "Clock" })).toContainText("Custom (10/6s+0)");
    await expect(page.locator(".play-problems")).toHaveCount(0);
    await page.locator(".play-start-button").click();

    // Both clocks start at 0:06.0; play past two controls (22 moves each), then stop.
    await expect(clockOf(page, "White")).toHaveAttribute("aria-label", /0:0[56]\.\d$/);
    await expect(moveCells(page).nth(43)).toBeVisible({ timeout: 120_000 });
    if (await page.locator(".play-result").count() === 0) {
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await confirmDialog(page, "Stop game");
    }
    await expect(page.locator(".play-result")).toBeVisible();
    await expect(page.locator(".play-result")).not.toContainText(/ran out of time/);

    const gos = (await tapGos(page)).filter((g) => g.limits.clock);
    expect(gos.length).toBeGreaterThanOrEqual(44);
    const [g] = await savedGames(page);
    expect(g.termination).not.toBe("timeout");
    // Each side's searches: moves-to-go counts down 10 → 1 and starts again; its clock is the last
    // clock minus the time charged for the move, plus the base time after every 10th move.
    const report: string[] = [];
    for (const side of ["w", "b"] as const) {
      const mine = gos.filter((_, i) => (i % 2 === 0) === (side === "w"));
      const times = g.times.filter((_, i) => (i % 2 === 0) === (side === "w"));
      let expected = 6000;
      mine.forEach((go, k) => {
        const c = go.limits.clock!;
        expect(c.movestogo, `${side} move ${k + 1}`).toBe(10 - (k % 10));
        const own = side === "w" ? c.wtime : c.btime;
        // (The saved times are whole milliseconds, the clock is not: allow the rounding to add up.)
        expect(Math.abs(own - expected), `${side} clock before move ${k + 1}`).toBeLessThanOrEqual(1 + k);
        if (k < times.length) {
          const t = times[k];
          // Sensible: never more than 45 % of what is left (the template's hard limit is 40 %).
          expect(t, `${side} move ${k + 1} took ${t} ms of ${own}`).toBeLessThan(own * 0.45 + 60);
          expected = expected - t + ((k + 1) % 10 === 0 ? 6000 : 0);
        }
      });
      const used = stats(times.slice(0, 20));
      report.push(`${side === "w" ? "Classic" : "Neuron"} per-move ms ${JSON.stringify(used)}, clock after move 10 → ${Math.round(side === "w" ? mine[10].limits.clock!.wtime : mine[10].limits.clock!.btime)} ms`);
      // The base time came back after move 10 (more on the clock than before move 10).
      const before10 = side === "w" ? mine[9].limits.clock!.wtime : mine[9].limits.clock!.btime;
      const after10 = side === "w" ? mine[10].limits.clock!.wtime : mine[10].limits.clock!.btime;
      expect(after10).toBeGreaterThan(before10 + 5000);
    }
    measure(`Play 10/6s+0: ${report.join("; ")}`);

    // The stopped clocks show what the game stored.
    const stored = await page.evaluate(async () => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.get<{ clock: { w: number; b: number } } | null>("play.current", null));
    expect(stored).not.toBeNull();
    for (const [side, ms] of [["White", stored!.clock.w], ["Black", stored!.clock.b]] as const) {
      const shown = clockMs(await clockOf(page, side).getAttribute("aria-label"));
      expect(Math.abs(shown - ms), `${side} clock display`).toBeLessThanOrEqual(1000);
    }
  });

  test("you vs each starter engine (and the network engine) from a link: click moves, the increment is added, the card shows the search, resign", async ({ page }) => {
    const ids = await openApp(page);
    // The link keeps the last setup's limits: the engine thinks 0.3 s per move, you have 1 min + 2 s.
    await setSetting(page, "play.lastSetup", {
      white: { player: "human", engineId: null, limits: {}, timeControl: { baseMs: 60_000, incMs: 2_000 }, hashMb: null },
      black: { player: "engine", engineId: ids.Classic, limits: { movetimeMs: 300 }, timeControl: null, hashMb: null },
      start: { kind: "standard" },
      sameClock: false,
    });
    const openings: Record<StarterName, [string, string]> = { Blocky: ["e2", "e4"], Classic: ["d2", "d4"], Sprout: ["g1", "f3"], Neuron: ["c2", "c4"] };
    for (const name of STARTERS) {
      await page.goto(`/#/play?engine=${ids[name]}`);
      await waitYourMove(page);
      await expect(page.locator('.play-player[data-side="b"]')).toContainText(name);
      await expect(clockOf(page, "White")).toHaveAttribute("aria-label", /White clock 1:00$|White clock 0:59/);
      const [from, to] = openings[name];
      // While the engine thinks, its current best move is drawn as an arrow (checked every frame:
      // the engine only thinks for 0.3 s).
      const arrowSeen = page.waitForFunction(() => !!document.querySelector('[aria-label="Game board"] .cb-arrows polygon'), null, { polling: "raf", timeout: 30_000 });
      await clickMove(page, from, to);
      // Your clock after the move: 1:00 − the time you took + 2 s increment.
      await expect(moveCells(page)).toHaveCount(1);
      await expect(clockOf(page, "White")).not.toHaveClass(/cb-clock--running/);
      const after = clockMs(await clockOf(page, "White").getAttribute("aria-label"));
      expect(after, `${name}: increment added`).toBeGreaterThan(60_000);
      expect(after).toBeLessThanOrEqual(62_000);
      // The engine replies within its 0.3 s, and its card shows that search.
      await expect(moveCells(page)).toHaveCount(2, { timeout: 30_000 });
      await waitYourMove(page);
      await arrowSeen;
      await expect(page.locator(`${GAME_BOARD} .cb-arrows polygon`), "no engine arrow on your turn").toHaveCount(0);
      const card = page.getByRole("region", { name: `${name} engine` });
      await expect(card.locator(".play-engine-stats dd").nth(1)).toHaveText(/^\d+(\/\d+)?$/);
      await expect(card.locator(".play-engine-stats dd").nth(2)).toHaveText(/^\d/);
      const time = await card.locator(".play-engine-stats dd").nth(4).innerText();
      expect(time, `${name} reports about 0.3 s`).toMatch(/^(2\d\d|30\d) ms$/);
      if (name === "Neuron") await expect(page.locator('.play-player[data-side="b"]')).toContainText("NNUE");
      // Resign: confirmed, saved.
      await page.getByRole("button", { name: "Resign", exact: true }).click();
      await confirmDialog(page, "Resign");
      await expect(page.locator(".play-result")).toContainText("Black wins");
      await expect(page.locator(".play-result")).toContainText("Saved to your games");
    }
    const games = await savedGames(page);
    expect(games).toHaveLength(4);
    expect(games.every((g) => g.termination === "resign" && g.result === "0-1" && g.white.type === "human")).toBe(true);
    expect(new Set(games.map((g) => g.black.name))).toEqual(new Set(STARTERS));
    // The human's time is saved per ply; the engine's is about its 0.3 s.
    for (const g of games) {
      expect(g.times).toHaveLength(2);
      expect(g.times[1]).toBeGreaterThanOrEqual(250);
      expect(g.times[1]).toBeLessThan(600);
    }
  });

  test("you vs Sprout from a FEN: promotion, takeback, a declined draw offer, resign", async ({ page }) => {
    const ids = await openApp(page);
    await setSetting(page, "play.lastSetup", {
      white: { player: "human", engineId: null, limits: {}, timeControl: null, hashMb: null },
      black: { player: "engine", engineId: ids.Sprout, limits: { movetimeMs: 200 }, timeControl: null, hashMb: null },
      start: { kind: "fen", fen: "8/P5k1/8/8/8/8/5PK1/8 w - - 0 1" },
      sameClock: false,
    });
    await page.reload();
    await expect(page.locator(".play-setup")).toBeVisible();
    await page.locator(".play-start-button").click();
    await waitYourMove(page);

    // a7-a8: the promotion picker; a queen.
    await clickMove(page, "a7", "a8");
    await page.locator('[data-promotion="q"]').click();
    await expect(moveCells(page).first()).toHaveText("a8=Q");
    await expect(moveCells(page)).toHaveCount(2, { timeout: 30_000 });
    await waitYourMove(page);
    // Takeback: your move and Sprout's reply.
    await page.getByRole("button", { name: "Takeback" }).click();
    await expect(moveCells(page)).toHaveCount(0);
    await expect(page.locator(".play-notice")).toContainText("Took back 2 moves.");
    // This time a knight.
    await waitYourMove(page);
    await clickMove(page, "a7", "a8");
    await page.locator('[data-promotion="n"]').click();
    await expect(moveCells(page).first()).toHaveText("a8=N");
    await expect(moveCells(page)).toHaveCount(2, { timeout: 30_000 });
    await waitYourMove(page);
    // A draw offer this early is declined, with the reason.
    await page.getByRole("button", { name: "Offer draw" }).click();
    await expect(page.locator(".play-notice")).toContainText("Sprout declines the draw: it is too early");
    await page.getByRole("button", { name: "Resign", exact: true }).click();
    await confirmDialog(page, "Resign");
    await expect(page.locator(".play-result")).toContainText("0–1");
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.moves[0]).toBe("a7a8n");
    expect(g.san[0]).toBe("a8=N");
    expect(g.termination).toBe("resign");
    expect(g.evals[0]).toBeNull(); // your move has no engine score
    expect(typeof g.evals[1]).toBe("number");
  });

  test("you on a moves-per-control clock (2 moves in 20 s): the base time comes back after your 2nd move; the engine has no clock", async ({ page }) => {
    const ids = await openApp(page);
    await page.locator(".play-preset").first().click(); // You vs engine, you play White
    const white = page.locator('.play-sidecard[data-side="w"]');
    const black = page.locator('.play-sidecard[data-side="b"]');
    await pick(page, black, "Black player", "Neuron");
    await page.getByRole("checkbox", { name: "Same clock for both sides" }).uncheck();
    await setCaps(black, { movetimeS: 0.2 });
    await white.getByRole("combobox", { name: "Clock" }).selectOption("custom");
    await white.getByRole("textbox", { name: "Base time", exact: true }).fill("20 s");
    await white.getByRole("textbox", { name: "Increment", exact: true }).fill("0");
    await white.getByRole("textbox", { name: "Moves per control", exact: true }).fill("2");
    await expect(white.getByRole("combobox", { name: "Clock" })).toContainText("Custom (2/20s+0)");
    await expect(black.getByRole("combobox", { name: "Clock" })).toHaveValue("none");
    await page.locator(".play-start-button").click();
    await waitYourMove(page);
    await expect(clockOf(page, "Black")).toHaveCount(0);

    const shown = async () => clockMs(await clockOf(page, "White").getAttribute("aria-label"));
    await clickMove(page, "e2", "e4");
    await expect(moveCells(page)).toHaveCount(1);
    await expect(clockOf(page, "White")).not.toHaveClass(/cb-clock--running/);
    const afterFirst = await shown();
    expect(afterFirst).toBeLessThan(20_000);
    expect(afterFirst).toBeGreaterThan(15_000);
    await expect(moveCells(page)).toHaveCount(2, { timeout: 30_000 });
    await waitYourMove(page);
    await clickMove(page, "d2", "d4");
    await expect(moveCells(page)).toHaveCount(3);
    await expect(clockOf(page, "White")).not.toHaveClass(/cb-clock--running/);
    // 2nd move of the control: what was left + 20 s.
    const afterSecond = await shown();
    expect(afterSecond).toBeGreaterThan(afterFirst + 20_000 - 5_000);
    expect(afterSecond).toBeLessThanOrEqual(afterFirst + 20_000);
    await expect(moveCells(page)).toHaveCount(4, { timeout: 30_000 });
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");
    await expect(page.locator(".play-result")).toContainText("Game aborted");
    const [g] = await savedGames(page);
    expect(g.black.name).toBe("Neuron");
    void ids;
  });

  test("Arena: per-engine settings through the form (depth / nodes / time per move / clock, hash) and a 30-ply limit", async ({ page, context }) => {
    test.setTimeout(240_000);
    await context.addInitScript(installWorkerTap);
    const ids = await openApp(page, "#/arena");
    await page.getByTestId("arena-new").click();
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    await pick(page, dialog, "Engine 1", "Classic");
    await pick(page, dialog, "Engine 2", "Blocky");
    await dialog.getByRole("button", { name: "Add engine" }).click();
    await pick(page, dialog, "Engine 3", "Sprout");
    await dialog.getByRole("button", { name: "Add engine" }).click();
    await pick(page, dialog, "Engine 4", "Neuron");
    await dialog.getByRole("checkbox", { name: "Same settings for every engine" }).uncheck();
    const rows = dialog.getByTestId("arena-form-row");
    await expect(rows).toHaveCount(4);
    const plan: Array<{ caps: { depth?: number; nodes?: number; movetimeS?: number }; clock: "none" | "custom"; hash: number }> = [
      { caps: { depth: 5 }, clock: "none", hash: 32 },
      { caps: { nodes: 3000 }, clock: "none", hash: 8 },
      { caps: { movetimeS: 0.15 }, clock: "none", hash: 4 },
      { caps: {}, clock: "custom", hash: 64 },
    ];
    for (let i = 0; i < plan.length; i++) {
      const row = rows.nth(i);
      await row.getByRole("combobox", { name: "Clock" }).selectOption(plan[i].clock);
      if (plan[i].clock === "custom") {
        await row.getByRole("textbox", { name: "Base time", exact: true }).fill("10 s");
        await row.getByRole("textbox", { name: "Increment", exact: true }).fill("0.1");
      }
      await setCaps(row, plan[i].caps);
      await row.getByRole("textbox", { name: "Hash", exact: true }).fill(String(plan[i].hash));
    }
    // The hash field offers what the engines can use (512 MB, as on the Play page and in Settings).
    await rows.nth(0).getByRole("textbox", { name: "Hash", exact: true }).fill("1024");
    await expect(rows.nth(0).locator(".field-error")).toHaveText("At most 512");
    await rows.nth(0).getByRole("textbox", { name: "Hash", exact: true }).fill("32");
    await dialog.getByRole("radiogroup", { name: "Openings" }).getByRole("radio", { name: "Start position" }).click();
    await dialog.getByLabel("Games per pairing").fill("1");
    await dialog.getByLabel("Games at once").fill("2");
    const adj = dialog.locator(".arena-adj-rule");
    await adj.nth(0).getByRole("checkbox").uncheck();
    await adj.nth(1).getByRole("checkbox").uncheck();
    await adj.nth(2).getByRole("checkbox").check();
    await adj.nth(2).getByLabel("After").fill("30");
    await expect(page.getByTestId("arena-form-total")).toContainText("6 pairings × 1 = 6 games");
    await page.getByTestId("arena-form-start").click();
    await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const matchId = page.url().split("/").pop()!;
    const detail = page.getByTestId("arena-detail");
    await expect(detail).toHaveAttribute("data-status", "finished", { timeout: 200_000 });

    // The settings panel lists each engine's limits and hash.
    const settings = page.locator('section[aria-labelledby="arena-settings-title"]');
    await expect(settings).toContainText("depth 5 · 32 MB hash");
    await expect(settings).toContainText("3k nodes · 8 MB hash");
    await expect(settings).toContainText("0.15 s/move · 4 MB hash");
    await expect(settings).toContainText("64 MB hash");
    await expect(settings).toContainText("draw after 30 plies");

    // Games: none longer than 30 plies; those that got there are draws by the ply limit.
    const games = await savedGames(page, matchId);
    expect(games).toHaveLength(6);
    for (const g of games) {
      expect(g.moves.length).toBeLessThanOrEqual(30);
      if (g.moves.length === 30) expect([g.result, g.termination]).toEqual(["1/2-1/2", "max-moves"]);
      expect(g.termination).not.toBe("timeout");
    }

    // Each engine got exactly its own limits and hash size, and kept to them.
    const inits = await tapInits(page);
    const hashOf = new Map(inits.map((i) => [i.w, i.hashMb]));
    const gos = (await tapGos(page)).filter((g) => g.done);
    const byKind = {
      depth: gos.filter((g) => g.limits.depth !== undefined),
      nodes: gos.filter((g) => g.limits.nodes !== undefined),
      movetime: gos.filter((g) => g.limits.movetimeMs !== undefined),
      clock: gos.filter((g) => g.limits.clock !== undefined),
    };
    for (const g of byKind.depth) {
      expect(g.limits).toEqual({ depth: 5 });
      expect(maxDepthOf(g)).toBeLessThanOrEqual(5);
      expect(hashOf.get(g.w)).toBe(32);
    }
    for (const g of byKind.nodes) {
      expect(g.limits).toEqual({ nodes: 3000 });
      expect(lastInfo(g)!.nodes).toBeLessThanOrEqual(3016);
      expect(hashOf.get(g.w)).toBe(8);
    }
    for (const g of byKind.movetime) {
      expect(g.limits).toEqual({ movetimeMs: 150 });
      expect(g.elapsedMs!).toBeLessThanOrEqual(150 + 60);
      expect(hashOf.get(g.w)).toBe(4);
    }
    for (const g of byKind.clock) {
      expect(g.limits.depth ?? g.limits.nodes ?? g.limits.movetimeMs).toBeUndefined();
      expect(g.limits.clock!.movestogo).toBeUndefined();
      expect(hashOf.get(g.w)).toBe(64);
    }
    for (const list of Object.values(byKind)) expect(list.length).toBeGreaterThanOrEqual(30);
    measure(
      `Arena per engine: Classic depth 5 → max ${Math.max(...byKind.depth.map(maxDepthOf))}; Blocky 3000 nodes → ${JSON.stringify(stats(byKind.nodes.map((g) => lastInfo(g)!.nodes)))}; ` +
        `Sprout 0.15 s → elapsed ms ${JSON.stringify(stats(byKind.movetime.map((g) => Math.round(g.elapsedMs!))))}; Neuron 10s+0.1 → per-move ms ${JSON.stringify(stats(byKind.clock.map((g) => Math.round(g.elapsedMs!))))}`,
    );
    void ids;
  });

  test("Arena adjudication: the resign rule and the draw rule end games as configured", async ({ page }) => {
    const ids = await openApp(page, "#/arena");
    const create = (cfg: { name: string; a: StarterName; b: StarterName; adjudication: Record<string, number | null> }) =>
      page.evaluate(
        async ({ cfg, ids }) => {
          const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
          const c = m.defaultMatchConfig({ engineIds: [ids[cfg.a], ids[cfg.b]], hashMb: 16, maxWorkers: 4 });
          c.name = cfg.name;
          c.gamesPerPairing = 2;
          c.concurrency = 2;
          c.openings = { mode: "none" };
          c.participants = c.participants.map((p) => ({ ...p, limits: { nodes: 5000 }, timeControl: null }));
          c.adjudication = cfg.adjudication as unknown as typeof c.adjudication;
          return m.arena.createMatch(c, { start: true });
        },
        { cfg, ids },
      );
    // Classic is far stronger than Sprout: resign once both see ≥ 4 pawns for 2 moves each.
    const resignId = await create({ name: "Resign rule", a: "Classic", b: "Sprout", adjudication: { resignScoreCp: 400, resignMoves: 2, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: 400 } });
    await page.goto(`/#/arena/${resignId}`);
    await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
    // Classic and Neuron are about equal: draw once both stay within ±0.8 pawns for 3 moves each after ply 10.
    const drawId = await create({ name: "Draw rule", a: "Classic", b: "Neuron", adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: 80, drawMoves: 3, drawMinPly: 10, maxPlies: 400 } });
    await page.goto(`/#/arena/${drawId}`);
    await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });

    const lastScores = (g: SavedGame, n: number) => g.evals.slice(-2 * n);
    for (const g of await savedGames(page, resignId)) {
      expect(g.termination, g.pgn).toBe("resign");
      expect(g.pgn).toMatch(/Both engines saw (White|Black) ahead by at least 4 pawns for 2 moves/);
      const winnerWhite = g.result === "1-0";
      expect((winnerWhite ? g.white : g.black).name).toBe("Classic");
      // The last 2 moves of each engine all saw the winner at least 400 cp ahead.
      for (const e of lastScores(g, 2)) expect(winnerWhite ? e! : -e!).toBeGreaterThanOrEqual(400);
    }
    for (const g of await savedGames(page, drawId)) {
      expect([g.result, g.termination], g.pgn).toEqual(["1/2-1/2", "adjudication"]);
      expect(g.pgn).toMatch(/Both engines scored the position within ±0.8 pawns for 3 moves/);
      expect(g.moves.length).toBeGreaterThan(10 + 5);
      for (const e of lastScores(g, 3)) expect(Math.abs(e!)).toBeLessThanOrEqual(80);
    }
    // The results table says why each game ended.
    await expect(page.getByTestId("arena-result-row")).toHaveCount(2);
  });

  test("the limits editor uses the same words everywhere; presets and the help topic match the app", async ({ page }) => {
    const ids = await openApp(page);
    const capLabels = ["Depth", "Max positions searched (nodes)", "Time per move"];
    const expectCaps = async (scope: Locator, where: string) => {
      for (const label of capLabels) await expect(scope.getByRole("textbox", { name: label, exact: true }), `${where}: ${label}`).toBeVisible();
    };

    // Play: the engine side's editor, and the human side's clock uses the same clock fields.
    await page.locator(".play-preset", { hasText: "Blitz 3+2" }).click();
    const white = page.locator('.play-sidecard[data-side="w"]');
    const black = page.locator('.play-sidecard[data-side="b"]');
    await expect(white.getByRole("combobox", { name: "Clock" })).toHaveValue("3+2");
    await expect(black.getByRole("combobox", { name: "Clock" })).toHaveValue("3+2");
    await expectCaps(black, "Play");
    await black.getByRole("combobox", { name: "Clock" }).selectOption("custom");
    await white.getByRole("combobox", { name: "Clock" }).selectOption("custom");
    for (const label of ["Base time", "Increment", "Moves per control"]) {
      await expect(black.getByRole("textbox", { name: label, exact: true }), `Play engine clock: ${label}`).toBeVisible();
      await expect(white.getByRole("textbox", { name: label, exact: true }), `Play human clock: ${label}`).toBeVisible();
    }
    // The human's moves per control is kept (and shown on the engine side with "same clock").
    await white.getByRole("textbox", { name: "Moves per control", exact: true }).fill("40");
    await expect(black.getByRole("textbox", { name: "Moves per control", exact: true })).toHaveValue("40");
    await expect(white.getByRole("combobox", { name: "Clock" })).toContainText("Custom (40/3+2)");

    // Arena: the shared editor and the per-engine ones.
    await page.goto("/#/arena?new=1");
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
    for (const label of capLabels) await expect(dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: label }).first(), `Arena: ${label}`).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Same settings for every engine" }).uncheck();
    await expectCaps(dialog.getByTestId("arena-form-row").first(), "Arena per engine");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Workshop test bench (no clock).
    await page.goto(`/#/engines/${ids.Classic}`);
    await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
    await page.locator(".workshop-side-tabs .tab, .workshop-stack-tabs .tab", { hasText: "Test" }).first().click();
    await page.locator(".workshop-tool-tabs .tab", { hasText: "Search" }).first().click();
    const tool = page.locator(".workshop-tool-body > div:not([hidden])");
    await expectCaps(tool, "Workshop");
    await expect(tool.getByRole("textbox", { name: "Time per move", exact: true })).toHaveValue("2");
    await expect(tool.getByRole("combobox", { name: "Clock" })).toHaveCount(0);

    // Lab self-play settings (no clock): default 5,000 nodes.
    await page.goto("/#/lab/datasets");
    await page.getByRole("button", { name: "Generate dataset" }).first().click();
    const gen = page.getByRole("dialog");
    await expect(gen).toBeVisible();
    for (const label of capLabels) await expect(gen.locator(".cb-limits-cap", { hasText: label }).first(), `Lab: ${label}`).toBeVisible();
    await expect(gen.locator(".cb-limits-cap", { hasText: "Max positions searched (nodes)" }).locator("input.input")).toHaveValue("5000");
    await gen.getByRole("button", { name: "Cancel" }).click();

    // The help topic describes the same fields, the defaults and the safety stop.
    await page.goto("/#/help/limits");
    const article = page.locator("article.help-article");
    await expect(article).toContainText("Max positions searched (nodes)");
    await expect(article).toContainText("1 second per move");
    await expect(article).toContainText("5,000 nodes");
    await expect(article).toContainText("60 seconds");
    await expect(article).toContainText("whichever limit it reaches first");
  });
});
