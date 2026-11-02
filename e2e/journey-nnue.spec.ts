// User journey: NNUE networks from start to finish, across the Lab, the engine library, the
// Workshop, Play and the Arena.
//
//   1. Neuron, the starter NNUE engine, really plays with the bundled starter network.
//   2. "Add to an existing one": continue training the starter network with a small self-play
//      run, watch it live, publish an engine from it and let it play Neuron in the Arena.
//   3. Widen the starter network (HL128 -> HL256): it evaluates exactly like the old one until it
//      is trained, then it trains.
//   4. A new network from scratch that keeps training in the background while the user plays,
//      across a reload (auto-resume) and a browser restart (persistent profile).
//   5. Networks playing each other (Play and Arena); an engine whose network was deleted says so
//      wherever it is used.
//   6. The new-engine wizard preselects a network for NNUE engines.
//
// Run: E2E_PORT=5243 npx playwright test e2e/journey-nnue.spec.ts
//
// Every test gets a fresh browser context (empty IndexedDB): the app seeds four starter engines
// (Blocky, Classic, Sprout, Neuron) and the starter network on load; `openApp` waits for them.
// Self-play and matches use node limits, so the games do not depend on the machine's speed.
// Screenshots for manual review go to .scratch/journey-nnue/shots/.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { GameRecord, MatchRecord, NetworkRecord, TrainingRunRecord } from "../src/types";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type TrainingModule = typeof import("../src/training/index");
type EngineHostModule = typeof import("../src/engine-host/index");
type NnueModule = typeof import("../src/nnue/index");
type ArenaModule = typeof import("../src/arena/index");

const SCRATCH = join(process.cwd(), ".scratch", "journey-nnue");
const SHOTS_DIR = join(SCRATCH, "shots");
mkdirSync(SHOTS_DIR, { recursive: true });

const STARTER_NETWORK_ID = "starter-network-hl128";
const STARTER_NETWORK_NAME = "Starter network (128 SCReLU)";
const NEURON_ID = "starter-engine-neuron";

// --- fixtures: console errors fail the test --------------------------------------------------

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors = trackErrors(page);
      await use(errors);
      expect(errors, "browser console errors").toEqual([]);
    },
    { auto: true },
  ],
});

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()}`);
  });
  return errors;
}

// --- helpers ---------------------------------------------------------------------------------

type EngineIds = Record<"Blocky" | "Classic" | "Sprout" | "Neuron", string> & Record<string, string>;

/** Opens the app and waits until the four starter engines and the starter network exist. */
async function openApp(page: Page, hash = "#/lab"): Promise<EngineIds> {
  await page.goto("/" + hash);
  await expect
    .poll(
      () =>
        page.evaluate(async (netId) => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          const [engines, net] = await Promise.all([s.enginesRepo.list(), s.networksRepo.get(netId)]);
          return engines.filter((e) => e.builtin).length >= 4 && !!net;
        }, STARTER_NETWORK_ID),
      { timeout: 60_000, message: "starter engines and network are seeded" },
    )
    .toBe(true);
  return engineIds(page);
}

async function engineIds(page: Page): Promise<EngineIds> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return Object.fromEntries((await s.enginesRepo.list()).map((e) => [e.name, e.id]));
  }) as Promise<EngineIds>;
}

async function readRun(page: Page, id: string): Promise<TrainingRunRecord | null> {
  return page.evaluate(async (rid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.runsRepo.get(rid)) ?? null;
  }, id);
}

async function getNetwork(page: Page, id: string): Promise<NetworkRecord | null> {
  return page.evaluate(async (nid) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).networksRepo.get(nid)) ?? null, id);
}

async function getMatch(page: Page, id: string): Promise<MatchRecord | null> {
  return page.evaluate(async (mid) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).matchesRepo.get(mid)) ?? null, id);
}

type SavedGame = Pick<GameRecord, "id" | "result" | "termination" | "moves" | "evals" | "white" | "black" | "matchId">;

async function savedGames(page: Page, matchId?: string): Promise<SavedGame[]> {
  return page.evaluate(async (mid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const games = await s.gamesRepo.list(mid ? { matchId: mid } : undefined);
    return games.map((g) => ({ id: g.id, result: g.result, termination: g.termination, moves: g.moves, evals: g.evals, white: g.white, black: g.black, matchId: g.matchId }));
  }, matchId ?? null);
}

/**
 * White-POV evaluations of `fens` two ways: by the engine itself (cb_eval of the built engine with
 * the network it loads) and by the reference implementation over the stored network.
 */
async function engineVsReference(page: Page, engineId: string, networkId: string, fens: string[]): Promise<{ engine: Array<number | null>; reference: Array<number | null>; terms: string[] }> {
  return page.evaluate(
    async ({ engineId, networkId, fens }) => {
      const h = (await import(String("/src/engine-host/index.ts"))) as EngineHostModule;
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      const client = await h.loadEngine(engineId);
      try {
        const engine: Array<number | null> = [];
        let terms: string[] = [];
        for (const fen of fens) {
          await client.position(fen, []);
          engine.push(await client.eval());
          terms = ((await client.evalTrace()) ?? []).map((e) => e.label).filter((l) => l.toLowerCase() !== "total");
        }
        return { engine, reference: await t.networks.evaluate(networkId, fens), terms };
      } finally {
        client.terminate();
      }
    },
    { engineId, networkId, fens },
  );
}

/**
 * Records (in the page) whether elements matching each check ever appeared, however briefly: a
 * small self-play phase can finish between two polls of a normal assertion. Survives in-app
 * navigation (the hash router keeps the page).
 */
async function watchFor(page: Page, checks: Record<string, { selector: string; text?: string | RegExp }>): Promise<void> {
  const serial = Object.fromEntries(
    Object.entries(checks).map(([k, c]) => [k, { selector: c.selector, text: c.text instanceof RegExp ? { re: c.text.source } : c.text ?? null }]),
  );
  await page.evaluate((checks) => {
    const w = window as unknown as { __journeySeen?: Record<string, boolean> };
    const seen: Record<string, boolean> = (w.__journeySeen = {});
    const test = () => {
      for (const [key, c] of Object.entries(checks)) {
        if (seen[key]) continue;
        for (const el of document.querySelectorAll(c.selector)) {
          const text = el.textContent ?? "";
          const ok = c.text === null ? true : typeof c.text === "string" ? text.includes(c.text) : new RegExp(c.text.re).test(text);
          if (ok) {
            seen[key] = true;
            break;
          }
        }
      }
    };
    new MutationObserver(test).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    test();
  }, serial);
}

async function seenSoFar(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => ({ ...((window as unknown as { __journeySeen?: Record<string, boolean> }).__journeySeen ?? {}) }));
}

/** Same as formatCount in src/utils/format.ts (what the stat tiles show). */
function formatCount(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0) + "M";
}

/** The value of a StatGrid tile ("Games", "Positions", ...) inside `scope`. */
function stat(scope: Locator, label: string): Locator {
  return scope.locator(".lab-stat", { has: scope.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
}

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

/** Width the page (or the app's scrolling main area) scrolls sideways by (0 = fits). */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector(".app-main");
    const doc = document.documentElement.scrollWidth - window.innerWidth;
    return Math.max(0, doc, main ? main.scrollWidth - main.clientWidth : 0);
  });
}

/**
 * Screenshots of the current page in both themes at 1440 and 400 px (for manual review), and a
 * check that nothing scrolls sideways. The window is made as tall as the content so the whole page
 * is in the picture (the app scrolls inside .app-main). Restores the 1440 px dark view.
 */
async function captureViews(page: Page, name: string): Promise<void> {
  for (const width of [1440, 400]) {
    const height = width === 400 ? 860 : 900;
    await page.setViewportSize({ width, height });
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(250);
      expect.soft(await horizontalOverflow(page), `${name} at ${width}px (${theme}) scrolls sideways`).toBe(0);
      const full = await page.evaluate(() => {
        const main = document.querySelector(".app-main");
        return main ? main.getBoundingClientRect().top + main.scrollHeight : document.documentElement.scrollHeight;
      });
      await page.setViewportSize({ width, height: Math.min(6000, Math.max(height, Math.ceil(full))) });
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(SHOTS_DIR, `${name}-${theme}-${width}.png`) });
      await page.setViewportSize({ width, height });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "dark");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

/** Opens an ActionMenu (by its accessible name) and picks an item. */
async function menu(page: Page, button: Locator, item: string): Promise<void> {
  await button.click();
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

async function wizardNext(page: Page): Promise<void> {
  await page.locator(".lab-wizard-footer").getByRole("button", { name: "Next" }).click();
}

async function expectWizardStep(page: Page, label: string): Promise<void> {
  await expect(page.locator(".lab-wstep.current")).toContainText(label);
}

function labNav(page: Page, section: string): Locator {
  return page.locator(".lab-nav-link", { hasText: section });
}

function runStatus(page: Page): Locator {
  return page.locator(".lab-run-header .lab-status");
}

const GAME_BOARD = '[aria-label="Game board"]';
const moveCells = (page: Page) => page.locator(".play-movelist .cb-ml-move:not(.cb-ml-move--empty)");

/** Centre of a square of the board in client coordinates. */
async function squarePoint(page: Page, boardSel: string, square: string, orientation: "white" | "black") {
  const box = await page.locator(boardSel).boundingBox();
  if (!box) throw new Error(`board ${boardSel} not visible`);
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const s = box.width / 8;
  return { x: box.x + (col + 0.5) * s, y: box.y + (row + 0.5) * s };
}

/** Click-click move on a board. */
async function clickMove(page: Page, from: string, to: string, orientation: "white" | "black" = "white") {
  await expect(page.locator(`${GAME_BOARD} [data-square="${from}"]`).first()).toBeVisible();
  const a = await squarePoint(page, GAME_BOARD, from, orientation);
  await page.mouse.click(a.x, a.y);
  const b = await squarePoint(page, GAME_BOARD, to, orientation);
  await page.mouse.click(b.x, b.y);
}

async function waitYourMove(page: Page, timeout = 60_000) {
  await expect(page.locator(".play-player-status", { hasText: "Your move" })).toBeVisible({ timeout });
}

async function confirmDialog(page: Page, label: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The Play page's side card of White ("w") or Black ("b"). */
const sideCard = (page: Page, side: "w" | "b") => page.locator(`.play-sidecard[data-side="${side}"]`);

/** Sets a side's search limit to `nodes` positions per move (and switches the time limit off). */
async function playNodes(page: Page, side: "w" | "b", nodes: number): Promise<void> {
  const card = sideCard(page, side);
  await card.getByLabel("Time per move").fill("");
  await card.getByLabel("Max positions searched (nodes)").fill(String(nodes));
}

// Positions for evaluation checks (a quiet opening, a middlegame, an endgame with Black to move).
const FENS = [
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7",
  "8/5pk1/6p1/8/3R4/6P1/5PK1/1r6 b - - 3 41",
  "rnb1kbnr/pppp1ppp/8/4p3/4P2q/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3",
];

// ------------------------------------------------------------------------------------- tests

// A click that cannot happen should fail fast, not wait for the test timeout.
test.use({ actionTimeout: 30_000 });

test.describe("Journey: NNUE networks", () => {
  test("Neuron plays with the starter network; the starter network reads well in the Lab", async ({ page }) => {
    test.setTimeout(240_000);
    const ids = await openApp(page, "#/engines");
    expect(ids.Neuron).toBe(NEURON_ID);

    // The library card names the network.
    const card = page.locator(".engines-card:not(.engines-card--skeleton)").filter({ has: page.locator(".engines-card-name", { hasText: /^Neuron$/ }) });
    await expect(card.locator(".engines-card-meta")).toContainText(STARTER_NETWORK_NAME);

    // The engine really evaluates with the starter network: its own cb_eval equals the reference
    // inference over the stored network, position for position, and the breakdown says "NNUE".
    const cmp = await engineVsReference(page, NEURON_ID, STARTER_NETWORK_ID, FENS);
    expect(cmp.terms).toEqual(["NNUE"]);
    expect(cmp.engine).toEqual(cmp.reference);
    expect(cmp.engine.every((v) => typeof v === "number")).toBe(true);
    // A sane opening score: within a pawn after 1. e4.
    expect(Math.abs(cmp.engine[0] as number)).toBeLessThan(100);

    // The Workshop's evaluation breakdown shows the NNUE term, not the fallback.
    await page.goto(`/#/engines/${NEURON_ID}`);
    await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".workshop-networkbar")).toContainText(STARTER_NETWORK_NAME);
    await page.locator(".workshop-side-tabs .tab, .workshop-stack-tabs .tab", { hasText: "Test" }).first().click();
    await page.locator(".workshop-tool-tabs .tab", { hasText: "Evaluate" }).first().click();
    const tool = page.locator(".workshop-tool-body > div:not([hidden])");
    const evalButton = tool.getByRole("button", { name: "Evaluate", exact: true });
    await expect(evalButton).toBeEnabled({ timeout: 180_000 });
    await evalButton.click();
    await expect(tool.locator(".workshop-eval-result:not(.stale)")).toBeVisible({ timeout: 60_000 });
    await expect(tool.locator(".workshop-trace tbody tr")).toHaveCount(1);
    await expect(tool.locator(".workshop-trace tbody tr").first()).toContainText("NNUE");
    await expect(tool).not.toContainText("Fallback (no network)");
    await expect(tool.locator(".callout.warn", { hasText: "No network loaded" })).toHaveCount(0);
    await shot(page, "neuron-workshop-eval");

    // Play: you (White) vs Neuron from a position where White's queen hangs on d5: Neuron takes it.
    // (A link with ?engine= and a valid ?fen= starts the game at once, 1 s per move.)
    const fen = "rnbqkb1r/pppp1ppp/5n2/3Qp3/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3";
    await page.goto(`/#/play?engine=${NEURON_ID}&fen=${encodeURIComponent(fen)}`);
    await waitYourMove(page);
    await expect(page.locator(".play-board-col .play-player").first()).toContainText("Neuron");
    await expect(moveCells(page)).toHaveCount(1);
    await expect(moveCells(page).first()).toHaveText("Nxd5");
    // A few more moves: Neuron answers each with a legal move and shows its search.
    await clickMove(page, "e4", "d5");
    await expect(moveCells(page)).toHaveCount(3, { timeout: 60_000 });
    await waitYourMove(page);
    const engineCard = page.locator(".play-engine").first();
    await expect(engineCard).toContainText("Neuron");
    await expect(engineCard.locator(".play-engine-stats dd").nth(1)).not.toHaveText("—");
    await shot(page, "neuron-play");
    await page.getByRole("button", { name: "Resign" }).click();
    await confirmDialog(page, "Resign");
    await expect(page.locator(".play-result")).toContainText("Saved to your games");
    const [game] = await savedGames(page);
    expect(game.black).toMatchObject({ type: "engine", name: "Neuron" });
    expect(game.moves[0]).toBe("f6d5");
    const firstEval = game.evals?.[0];
    expect(typeof firstEval).toBe("number");
    // Black is a knight for a queen up: Neuron's own score says so (White's point of view).
    expect(firstEval as number).toBeLessThan(-300);

    // The Lab lists the starter network with a Starter badge and its stats.
    await page.goto("/#/lab/networks");
    const row = page.locator("tr", { hasText: STARTER_NETWORK_NAME });
    await expect(row.locator(".badge", { hasText: "Starter" })).toBeVisible();
    await expect(row.locator(".badge", { hasText: "In 1 engine" })).toBeVisible();
    await expect(row.locator('td[data-label="Hidden"]')).toHaveText("128");
    await expect(row).toContainText("SCReLU");
    const starter = (await getNetwork(page, STARTER_NETWORK_ID))!;
    expect(starter.builtin).toBe(true);
    expect(starter.sizeBytes).toBe(197_444);
    await expect(row).toContainText(formatCount(starter.stats.positionsSeen));
    await captureViews(page, "starter-networks-list");

    // Its page: badges, description, stats, sample evaluations, Neuron as its user, lineage.
    await row.getByRole("link", { name: STARTER_NETWORK_NAME }).click();
    await expect(page).toHaveURL(new RegExp(`#/lab/networks/${STARTER_NETWORK_ID}$`));
    const header = page.locator(".lab-detail-header");
    await expect(header.getByRole("heading", { name: STARTER_NETWORK_NAME })).toBeVisible();
    await expect(header.locator(".badge", { hasText: "HL128" })).toBeVisible();
    await expect(header.locator(".badge", { hasText: "Starter" })).toBeVisible();
    await expect(header).toContainText("Trained on 5 million positions");
    const stats = page.locator(".lab-section > .card").first();
    await expect(stat(stats, "Hidden size")).toHaveText("128 neurons");
    await expect(stat(stats, "Epochs")).toHaveText(String(starter.stats.epochs));
    await expect(stat(stats, "Positions seen")).toHaveText(formatCount(starter.stats.positionsSeen));
    await expect(page.locator("#lab-net-evals .lab-sample").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#lab-net-evals")).not.toContainText("Could not");
    await expect(page.locator("#lab-net-engines")).toContainText("Neuron");
    await expect(page.locator("#lab-net-lineage")).toContainText("starter network");
    await captureViews(page, "starter-network-detail");
  });

  test("continue training the starter network with self-play, watch it live, publish an engine and match it against Neuron", async ({ page }) => {
    test.setTimeout(300_000);
    const GAMES = 120;
    await openApp(page, "#/lab");

    // Lab -> New training run -> Continue training a network -> the starter network.
    await page.getByRole("link", { name: "New training run" }).first().click();
    await expectWizardStep(page, "Network");
    await page.locator(".lab-choice", { hasText: "Continue training a network" }).click();
    await expect(page.getByRole("radio", { name: /Continue training a network/ })).toBeChecked();
    await page.locator(".lab-pick", { hasText: STARTER_NETWORK_NAME }).click();
    await expect(page.locator(".lab-pick.checked")).toContainText(STARTER_NETWORK_NAME);
    await expect(page.locator(".lab-pick.checked .badge", { hasText: "Starter" })).toBeVisible();
    await expect(page.locator(".lab-wizard-body")).toContainText("It has no saved optimizer state, so the optimizer starts fresh.");
    await wizardNext(page);

    // Data: the network itself plays the self-play games (the stock NNUE engine with it).
    await expectWizardStep(page, "Data");
    await page.getByRole("button", { name: "Engine that plays the self-play games" }).click();
    await page.getByRole("option", { name: /This run's newest network/ }).click();
    await page.locator("#lab-sp-games").fill(String(GAMES));
    await page.locator("#lab-sp-workers").fill("2");
    await page.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("1000");
    await wizardNext(page);
    await expectWizardStep(page, "Training");
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    // Small batches and a few epochs: training takes a few seconds, enough to watch it live.
    await page.locator("#lab-h-batch").fill("16");
    await page.locator("#lab-h-epochs").fill("3");
    await wizardNext(page);
    await expectWizardStep(page, "Loop & publishing");
    await expect(page.getByRole("switch", { name: "Publish an engine" })).toBeChecked();
    await wizardNext(page);
    await expectWizardStep(page, "Review");
    await expect(page.locator(".lab-wizard-body")).toContainText("Continue training an existing network");
    await page.locator("#lab-run-name").fill("Neuron Plus");
    await watchFor(page, {
      boards: { selector: "#lab-run-now .lab-board" },
      selfplayStats: { selector: "#lab-run-now", text: "Self-play games" },
      startingEvals: { selector: "#lab-run-evals", text: "evaluations of the network this run starts from" },
      training: { selector: "#lab-run-now", text: /Training: epoch \d of 3/ },
      liveLoss: { selector: "#lab-run-now .lab-stat", text: "Training loss" },
      charts: { selector: "#lab-run-charts svg" },
      activity: { selector: ".activity-button", text: "1 running" },
    });
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const runId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(page.getByRole("heading", { name: "Neuron Plus" })).toBeVisible();
    // Live self-play: boards being played (40 games take a few seconds).
    await page.locator("#lab-run-now .lab-board").first().waitFor({ timeout: 30_000 }).then(
      () => captureViews(page, "continue-selfplay"),
      () => undefined,
    );
    await page.locator("#lab-run-now", { hasText: "Training: epoch" }).waitFor({ timeout: 120_000 }).then(
      () => shot(page, "continue-training"),
      () => undefined,
    );
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 180_000 });
    expect(await seenSoFar(page)).toEqual({ boards: true, selfplayStats: true, startingEvals: true, training: true, liveLoss: true, charts: true, activity: true });

    // What was stored: the cycle's dataset (all its games), one network derived from the starter.
    const run = (await readRun(page, runId))!;
    expect(run.status).toBe("finished");
    expect(run.networkHistory).toHaveLength(1);
    expect(run.datasetIds).toHaveLength(1);
    const ds = await page.evaluate(async (id) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).datasetsRepo.get(id)) ?? null, run.datasetIds[0]);
    expect(ds!.games).toBe(GAMES);
    expect(ds!.positions).toBeGreaterThan(GAMES * 30);
    expect(ds!.source.networkId).toBe(STARTER_NETWORK_ID);
    const net = (await getNetwork(page, run.networkId!))!;
    expect(net.name).toBe("Neuron Plus - c1");
    expect(net.parentId).toBe(STARTER_NETWORK_ID);
    expect(net.hidden).toBe(128);
    expect(net.activation).toBe(1);
    expect(net.stats.trainingRunId).toBe(runId);
    // A continued network's stats add up its whole history: the starter's epochs and positions
    // plus this run's (the best of its 3 epochs is kept).
    const starter = (await getNetwork(page, STARTER_NETWORK_ID))!;
    const ownEpochs = net.stats.epochs - starter.stats.epochs;
    expect(ownEpochs).toBeGreaterThanOrEqual(1);
    expect(ownEpochs).toBeLessThanOrEqual(3);
    // Positions seen in this run: about (1 - validation split) of the dataset per epoch trained.
    const ownPositions = net.stats.positionsSeen - starter.stats.positionsSeen;
    const perEpoch = ds!.positions * 0.9;
    expect(ownPositions).toBeGreaterThan(perEpoch * ownEpochs * 0.95);
    expect(ownPositions).toBeLessThan(perEpoch * ownEpochs * 1.05 + 16);
    expect(net.stats.valLoss).not.toBeNull();

    // The dashboard: the history row, the stats and the before / after evaluations.
    const history = page.locator("#lab-run-networks tbody tr");
    await expect(history).toHaveCount(1);
    await expect(history.first()).toContainText("Neuron Plus - c1");
    await expect(history.first().locator(".badge", { hasText: "Current" })).toBeVisible();
    const now = page.locator("#lab-run-now");
    await expect(stat(now, "Networks")).toHaveText("1");
    await expect(page.locator("#lab-run-evals")).toContainText("Before");
    await expect(page.locator("#lab-run-evals")).toContainText("After");
    await expect(page.locator(".lab-run-play")).toContainText("Engine: Neuron Plus");
    // A few thousand positions rarely improve a network trained on millions: when the new one is
    // worse on the held-out positions than the network it started from (measured before the first
    // step), the dashboard says so.
    const startLoss = run.points.find((p) => p.cycle === 0 && p.epoch === 0 && p.step === 0)?.valLoss;
    expect(typeof startLoss).toBe("number");
    await expect(page.getByTestId("lab-run-worse")).toHaveCount((net.stats.valLoss as number) > (startLoss as number) ? 1 : 0);
    await captureViews(page, "continue-finished");

    // Lineage: the new network is "continued from" the starter; the starter lists it as a child.
    await history.first().getByRole("link", { name: "Neuron Plus - c1" }).click();
    await expect(page).toHaveURL(new RegExp(`#/lab/networks/${run.networkId}$`));
    const lineage = page.locator("#lab-net-lineage");
    await expect(lineage).toContainText("continued from");
    await expect(lineage.getByRole("link", { name: STARTER_NETWORK_NAME })).toBeVisible();
    await expect(page.locator("#lab-net-training")).toContainText("Neuron Plus");
    await expect(stat(page.locator(".lab-section > .card").first(), "Epochs")).toHaveText(String(net.stats.epochs));
    await expect(stat(page.locator(".lab-section > .card").first(), "Positions seen")).toHaveText(formatCount(net.stats.positionsSeen));
    await captureViews(page, "continue-network-detail");
    await lineage.getByRole("link", { name: STARTER_NETWORK_NAME }).click();
    await expect(page.locator(".lab-children")).toContainText("Neuron Plus - c1");
    // The networks list: the new one names its parent and is used by the published engine.
    await labNav(page, "Networks").click();
    const plusRow = page.locator("tr", { hasText: "Neuron Plus - c1" });
    await expect(plusRow.getByRole("link", { name: STARTER_NETWORK_NAME })).toBeVisible();
    await expect(plusRow.locator(".badge", { hasText: "In 1 engine" })).toBeVisible();
    await expect(plusRow).toContainText(formatCount(net.stats.positionsSeen));

    // The published engine plays with the new network: its eval equals the reference over it.
    const engine = await page.evaluate(async (id) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).enginesRepo.get(id)) ?? null, run.engineId!);
    expect(engine).toMatchObject({ kind: "nnue", networkId: run.networkId, name: "Neuron Plus" });
    const cmp = await engineVsReference(page, run.engineId!, run.networkId!, FENS);
    expect(cmp.terms).toEqual(["NNUE"]);
    expect(cmp.engine).toEqual(cmp.reference);
    // Training changed the network: it no longer evaluates exactly like the starter.
    const starterEvals = await page.evaluate(
      async ({ id, fens }) => ((await import(String("/src/training/index.ts"))) as TrainingModule).networks.evaluate(id, fens),
      { id: STARTER_NETWORK_ID, fens: FENS },
    );
    expect(cmp.reference).not.toEqual(starterEvals);

    // Arena: Neuron Plus vs Neuron, 4 games at 2000 nodes, 2 at once.
    await page.goto("/#/arena");
    await page.getByTestId("arena-new").click();
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    const pick = async (n: number, name: RegExp) => {
      await page.getByRole("button", { name: `Engine ${n}`, exact: true }).click();
      await page.locator('li[role="option"]', { hasText: name }).first().click();
      await expect(page.getByRole("button", { name: `Engine ${n}`, exact: true })).toContainText(name);
    };
    await pick(1, /Neuron Plus/);
    await pick(2, /^Neuron(?! Plus)/);
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
    const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
    await nodesCap.locator('input[type="checkbox"]').check();
    await nodesCap.locator("input.input").fill("2000");
    await page.getByLabel("Games per pairing").fill("4");
    await page.getByLabel("Games at once").fill("2");
    await expect(page.locator("#arena-name")).toHaveValue("Neuron Plus vs Neuron");
    await page.getByTestId("arena-form-start").click();
    await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const matchId = page.url().split("/").pop()!;
    await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
    const match = (await getMatch(page, matchId))!;
    expect(match.results).toHaveLength(4);
    // W/D/L in the duel summary agree with the stored results.
    const plus = { w: 0, d: 0, l: 0 };
    for (const r of match.results) {
      const plusWhite = r.whiteId === run.engineId;
      if (r.result === "1/2-1/2") plus.d++;
      else if ((r.result === "1-0") === plusWhite) plus.w++;
      else plus.l++;
    }
    await expect(page.locator(".arena-duel-detail").first()).toContainText(`+${plus.w} =${plus.d} −${plus.l}`);
    const points = plus.w + plus.d / 2;
    const fmt = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(1));
    await expect(page.getByTestId("arena-score")).toHaveText(`${fmt(points)} – ${fmt(4 - points)}`);
    const games = await savedGames(page, matchId);
    expect(games).toHaveLength(4);
    for (const g of games) expect(g.moves.length).toBeGreaterThan(10);
    await captureViews(page, "continue-arena");
  });

  test("widen the starter network to HL256: unchanged evaluations before training, then it trains", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page, `#/lab/networks/${STARTER_NETWORK_ID}`);
    await menu(page, page.getByRole("button", { name: "More network actions" }), "Widen");
    await expect(page).toHaveURL(/#\/lab\/new\?/);
    await expectWizardStep(page, "Network");
    await expect(page.getByRole("radio", { name: /Widen a network/ })).toBeChecked();
    await expect(page.locator(".lab-pick.checked")).toContainText(STARTER_NETWORK_NAME);
    // The next size up is suggested; the wizard explains that nothing changes until training.
    await expect(page.getByRole("radiogroup", { name: "New hidden size" }).getByRole("radio", { name: "256" })).toBeChecked();
    await expect(page.locator(".lab-wizard-body")).toContainText("The network plays exactly the same until it is trained.");
    await expect(page.locator(".lab-wizard-body")).toContainText("Currently 128 neurons");
    await captureViews(page, "widen-wizard");
    await wizardNext(page);
    await expectWizardStep(page, "Data");
    await page.getByRole("button", { name: "Engine that plays the self-play games" }).click();
    await page.getByRole("option", { name: /This run's newest network/ }).click();
    await page.locator("#lab-sp-games").fill("40");
    await page.locator("#lab-sp-workers").fill("2");
    await page.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("1000");
    await wizardNext(page);
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await page.locator("#lab-h-epochs").fill("1");
    await wizardNext(page);
    await expectWizardStep(page, "Loop & publishing");
    await wizardNext(page);
    await expectWizardStep(page, "Review");
    await expect(page.locator(".lab-wizard-body")).toContainText("Widen an existing network");
    await expect(page.locator(".lab-wizard-body")).toContainText("256 neurons (from 128)");
    await page.locator("#lab-run-name").fill("Neuron Wide");
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const runId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 180_000 });
    const run = (await readRun(page, runId))!;
    expect(run.config.network).toEqual({ mode: "widen", networkId: STARTER_NETWORK_ID, newHidden: 256 });

    // Before training: the network the run started from (the starter's weights widened with the
    // run's seed) evaluates every position exactly like the starter, in floating point and
    // quantized (what an engine plays with), although it has twice the neurons.
    const before = await page.evaluate(
      async ({ netId, seed, fens }) => {
        const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
        const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
        const data = (await s.networksRepo.getData(netId))!;
        const original = data.float ?? n.dequantizeNetwork(n.parseNetworkFile(data.quantized));
        const wide = n.widenNetwork(original, 256, seed);
        const q1 = n.parseNetworkFile(data.quantized);
        const q2 = n.parseNetworkFile(n.quantizeNetwork(wide));
        return {
          hidden: q2.hidden,
          float: fens.map((f) => [n.evaluateFloat(original, f), n.evaluateFloat(wide, f)]),
          quantized: fens.map((f) => [n.evaluateQuantized(q1, f), n.evaluateQuantized(q2, f)]),
        };
      },
      { netId: STARTER_NETWORK_ID, seed: run.config.hyper.seed, fens: FENS },
    );
    expect(before.hidden).toBe(256);
    for (const [a, b] of before.quantized) expect(b).toBe(a);
    for (const [a, b] of before.float) expect(b).toBeCloseTo(a, 6);
    // The trainer measured that starting network before the first step (the epoch-0 point).
    expect(run.points.find((p) => p.cycle === 0 && p.epoch === 0 && p.step === 0)?.valLoss).toEqual(expect.any(Number));

    // After training: an HL256 network derived from the starter, which now evaluates differently.
    expect(run.networkHistory).toHaveLength(1);
    const wide = (await getNetwork(page, run.networkId!))!;
    expect(wide).toMatchObject({ hidden: 256, activation: 1, parentId: STARTER_NETWORK_ID, name: "Neuron Wide - c1" });
    expect(wide.sizeBytes).toBeGreaterThan(197_444 * 1.9);
    const after = await page.evaluate(
      async ({ ids, fens }) => {
        const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
        return Promise.all(ids.map((id) => t.networks.evaluate(id, fens)));
      },
      { ids: [STARTER_NETWORK_ID, run.networkId!], fens: FENS },
    );
    expect(after[1]).not.toEqual(after[0]);
    // Its published engine plays with the HL256 network (engine and reference agree exactly).
    const cmp = await engineVsReference(page, run.engineId!, run.networkId!, FENS);
    expect(cmp.terms).toEqual(["NNUE"]);
    expect(cmp.engine).toEqual(cmp.reference);

    // The dashboard and the network page.
    await expect(page.locator("#lab-run-networks tbody tr")).toContainText("Neuron Wide - c1");
    await captureViews(page, "widen-finished");
    await page.goto(`/#/lab/networks/${run.networkId}`);
    await expect(page.locator(".lab-detail-header .badge", { hasText: "HL256" })).toBeVisible();
    await expect(page.locator("#lab-net-lineage")).toContainText("widened from");
    await expect(page.locator("#lab-net-lineage").getByRole("link", { name: STARTER_NETWORK_NAME })).toBeVisible();
    await expect(stat(page.locator(".lab-section > .card").first(), "Hidden size")).toHaveText("256 neurons");
    await captureViews(page, "widen-network-detail");
  });

  test("a new network keeps training in the background while you play and look around, and resumes by itself after a reload", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page, "#/lab/new");
    // The wizard's defaults (HL128 SCReLU, Classic self-play, Balanced training, publish an engine,
    // keep training when reopened), scaled down: fewer games, fewer nodes, two workers.
    await expectWizardStep(page, "Network");
    await expect(page.getByRole("radio", { name: /Train a new network/ })).toBeChecked();
    await expect(page.getByRole("radiogroup", { name: "Hidden size" }).getByRole("radio", { name: "128" })).toBeChecked();
    await wizardNext(page);
    await expect(page.getByRole("button", { name: "Engine that plays the self-play games" })).toContainText("Classic");
    await page.locator("#lab-sp-games").fill("600");
    await page.locator("#lab-sp-workers").fill("2");
    await page.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("2000");
    await wizardNext(page);
    await expect(page.getByRole("radiogroup", { name: "Training preset" }).locator(".lab-choice.checked")).toContainText("Balanced");
    await wizardNext(page);
    await expect(page.getByRole("switch", { name: "Publish an engine" })).toBeChecked();
    await wizardNext(page);
    await expectWizardStep(page, "Review");
    await page.locator("#lab-run-name").fill("Background net");
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const runId = decodeURIComponent(page.url().split("/").pop() as string);
    const run0 = (await readRun(page, runId))!;
    expect(run0.autoResume).toBe(true);
    expect(run0.config.network).toEqual({ mode: "new", hidden: 128, activation: 1 });
    expect(run0.config.hyper).toMatchObject({ epochs: 12, batchSize: 1024, lrSchedule: "cosine" });
    expect(run0.config.data.selfPlay).toMatchObject({ games: 600, concurrency: 2, limits: { nodes: 2000 } });
    await expect(page.locator("#lab-run-now .lab-board").first()).toBeVisible({ timeout: 60_000 });

    // From now on, sample the header's activity indicator every 100 ms (in the page, so it keeps
    // sampling across the in-app navigation below).
    await page.evaluate(() => {
      const w = window as unknown as { __activity?: { present: number; absent: number } };
      const rec = (w.__activity = { present: 0, absent: 0 });
      setInterval(() => {
        const button = document.querySelector(".activity-button");
        if (button && /\d+ running/.test(button.textContent ?? "")) rec.present++;
        else rec.absent++;
      }, 100);
    });
    const gamesNow = async () => (await readRun(page, runId))?.progress.done ?? 0;
    const gamesBefore = await gamesNow();

    // Play a game against Classic meanwhile.
    await page.getByRole("link", { name: "Play", exact: true }).first().click();
    await expect(page).toHaveURL(/#\/play/);
    await page.locator(".play-preset").first().click();
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Classic");
    await playNodes(page, "b", 2000);
    await page.locator(".play-start-button").click();
    await waitYourMove(page);
    await clickMove(page, "e2", "e4");
    await expect(moveCells(page)).toHaveCount(2, { timeout: 60_000 });
    await waitYourMove(page);
    await clickMove(page, "d2", "d4");
    await expect(moveCells(page)).toHaveCount(4, { timeout: 60_000 });
    await waitYourMove(page);
    await expect(page.locator(".activity-button")).toContainText("1 running");
    await shot(page, "background-play");

    // Open the Arena, then go back to the run through the activity indicator.
    await page.getByRole("link", { name: "Arena", exact: true }).first().click();
    await expect(page).toHaveURL(/#\/arena/);
    await page.locator(".activity-button").click();
    const item = page.locator(".activity-item", { hasText: "Background net" });
    await expect(item).toBeVisible();
    await expect(item).toContainText(/self-play \d+\/600 games|training epoch \d+\/12|loading training data/);
    await shot(page, "background-activity-panel");
    await item.click();
    await expect(page).toHaveURL(new RegExp(`#/lab/runs/${runId}$`));
    const samples = await page.evaluate(() => (window as unknown as { __activity: { present: number; absent: number } }).__activity);
    expect(samples.present).toBeGreaterThan(5);
    expect(samples.absent, "the activity indicator disappeared while the run was going").toBe(0);
    // The run kept going the whole time.
    await expect(runStatus(page)).toHaveText(/Self-play|Training/);
    await expect.poll(gamesNow, { timeout: 30_000 }).toBeGreaterThan(gamesBefore);

    // Reload with auto-resume on: the run picks itself up again. (Games are stored in batches at
    // least every 10 s; wait until some are, so there is something that must survive.)
    const datasetId = (await readRun(page, runId))!.datasetIds[0];
    const datasetGames = async () =>
      page.evaluate(async (id) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).datasetsRepo.get(id))?.games ?? 0, datasetId);
    await expect.poll(datasetGames, { timeout: 30_000 }).toBeGreaterThan(0);
    const storedBefore = await datasetGames();
    const beforeReload = (await readRun(page, runId))!;
    expect(["selfplay", "training"], "the run should still be going before the reload").toContain(beforeReload.status);
    await page.reload();
    await expect(page.locator(".toaster .toast", { hasText: "Resumed the training run" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".lab-run-controls").getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".activity-button")).toContainText("1 running");
    // Nothing stored before the reload was lost: the cycle's dataset keeps its games.
    expect(await datasetGames()).toBeGreaterThanOrEqual(storedBefore);
    await shot(page, "background-resumed");
    // The game against Classic is still waiting on the Play page.
    await page.getByRole("link", { name: "Play", exact: true }).first().click();
    await expect(page.locator(".play-resume")).toContainText("Game paused while you were away");
    await expect(moveCells(page)).toHaveCount(4);
    await page.goBack();

    // It finishes by itself: 600 games, then 12 epochs; the engine is published.
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 240_000 });
    const done = (await readRun(page, runId))!;
    expect(done.networkHistory).toHaveLength(1);
    expect(await datasetGames()).toBe(600);
    const net = (await getNetwork(page, done.networkId!))!;
    expect(net).toMatchObject({ hidden: 128, activation: 1, parentId: null });
    expect(net.stats.epochs).toBeGreaterThanOrEqual(1);
    expect(net.stats.epochs).toBeLessThanOrEqual(12);
    expect(done.engineId).not.toBeNull();
    // The training curve has a point for every epoch end.
    const epochEnds = new Set(done.points.filter((p) => p.epoch >= 1 && p.valLoss !== null).map((p) => p.epoch));
    expect(epochEnds.size).toBe(12);
    await captureViews(page, "background-finished");
  });

  test("two networks play each other in Play and in the Arena; once a network is deleted its engine says so everywhere", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page, "#/engines");

    // A second trained network: HL64 trained on material-balance positions (quick, via the service).
    const materialNetId = await page.evaluate(async () => {
      const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const count = 30_000;
      const header = new Uint8Array(16);
      header.set([67, 66, 68, 83]); // "CBDS"
      new DataView(header.buffer).setUint32(4, 1, true);
      new DataView(header.buffer).setUint32(8, count, true);
      const datasetId = await t.datasets.importFile(new Blob([header, n.makeMaterialDataset(count, 3)]), { name: "Material positions" });
      const runId = await t.training.createRun(
        {
          name: "Material net",
          network: { mode: "new", hidden: 64, activation: 1 },
          data: { datasetIds: [datasetId], selfPlay: null },
          hyper: { epochs: 4, batchSize: 256, learningRate: 0.002, lrSchedule: "constant", evalWeight: 1, weightDecay: 0.01, validationSplit: 0.1, threads: 1, seed: 5 },
          loop: { enabled: false, cycles: 1, selfPlayWithLatest: false, keepCycles: null, gating: null },
          publishEngine: false,
        },
        { start: true },
      );
      for (let i = 0; i < 600; i++) {
        const run = await s.runsRepo.get(runId);
        if (run?.status === "finished" && run.networkId) return run.networkId;
        if (run?.status === "error") throw new Error(run.error ?? "run failed");
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("the material network did not finish training");
    });
    const materialNet = (await getNetwork(page, materialNetId))!;
    expect(materialNet.name).toBe("Material net - c1");

    // New engine -> NNUE: the newest trained network is preselected (not "None").
    await page.getByRole("button", { name: "New engine" }).first().click();
    const wizard = page.getByRole("dialog");
    await wizard.locator(".engines-approach", { hasText: "NNUE" }).first().click();
    await expect(wizard.locator(".engines-option.is-selected")).toContainText("Material net - c1");
    await expect(wizard.locator(".engines-option", { hasText: STARTER_NETWORK_NAME })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Material net - c1 engine");
    await page.getByLabel("Name", { exact: true }).fill("Materialist");
    await captureViews(page, "wizard-nnue-default");
    await wizard.getByRole("button", { name: "Create engine" }).click();
    await expect(page).toHaveURL(/#\/engines\/[^/?]+/);
    const materialistId = decodeURIComponent(page.url().split("/").pop()!.split("?")[0]);
    const materialist = await page.evaluate(async (id) => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).enginesRepo.get(id)) ?? null, materialistId);
    expect(materialist).toMatchObject({ kind: "nnue", networkId: materialNetId, name: "Materialist" });
    const cmp = await engineVsReference(page, materialistId, materialNetId, FENS);
    expect(cmp.terms).toEqual(["NNUE"]);
    expect(cmp.engine).toEqual(cmp.reference);

    // Play: Neuron (starter network) vs Materialist (material network), engine vs engine.
    await page.goto("/#/play");
    await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
    await page.getByRole("button", { name: "White player" }).click();
    await page.getByRole("option", { name: /^Neuron/ }).click();
    await page.getByRole("button", { name: "Black player" }).click();
    await page.getByRole("option", { name: /Materialist/ }).click();
    await expect(page.getByRole("button", { name: "White player" })).toContainText("Neuron");
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Materialist");
    await playNodes(page, "w", 1500);
    await playNodes(page, "b", 1500);
    await page.getByLabel("Move delay in milliseconds").focus();
    await page.keyboard.press("Home");
    await page.locator(".play-start-button").click();
    await expect(page.locator(".play-engine")).toHaveCount(2);
    await expect(page.locator(".play-engine", { hasText: "Neuron" })).toContainText("NNUE");
    await expect(page.locator(".play-engine", { hasText: "Materialist" })).toContainText("NNUE");
    await expect(moveCells(page).nth(9)).toBeVisible({ timeout: 60_000 });
    await shot(page, "networks-play");
    await expect(page.locator(".play-result")).toBeVisible({ timeout: 200_000 });
    await expect(page.locator(".play-result")).toContainText("Saved to your games");
    const [game] = await savedGames(page);
    expect(game.white).toMatchObject({ type: "engine", name: "Neuron" });
    expect(game.black).toMatchObject({ type: "engine", name: "Materialist" });
    expect(game.moves.length).toBeGreaterThan(10);

    // Arena: the same two, 2 games at 1500 nodes.
    const matchId = await page.evaluate(
      async ({ a, b }) => {
        const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
        const cfg = m.defaultMatchConfig({ engineIds: [a, b], hashMb: 16, maxWorkers: 2 });
        cfg.name = "Starter vs material";
        cfg.gamesPerPairing = 2;
        cfg.concurrency = 2;
        cfg.participants = cfg.participants.map((p) => ({ ...p, limits: { nodes: 1500 }, timeControl: null }));
        return m.arena.createMatch(cfg, { start: true });
      },
      { a: NEURON_ID, b: materialistId },
    );
    await page.goto(`/#/arena/${matchId}`);
    await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
    const match = (await getMatch(page, matchId))!;
    expect(match.results).toHaveLength(2);
    const standings = page.getByTestId("arena-standings");
    await expect(standings).toContainText("Neuron");
    await expect(standings).toContainText("Materialist");
    await captureViews(page, "networks-arena");

    // Delete the material network: the confirmation names the engine that uses it.
    await page.goto(`/#/lab/networks/${materialNetId}`);
    await menu(page, page.getByRole("button", { name: "More network actions" }), "Delete…");
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("1 engine uses it");
    await expect(confirm).toContainText("Materialist");
    await expect(confirm).toContainText("can't play until you choose another network");
    await shot(page, "network-delete-confirm");
    await confirm.getByRole("button", { name: "Delete network" }).click();
    await expect(page).toHaveURL(/#\/lab\/networks$/);
    expect(await getNetwork(page, materialNetId)).toBeNull();

    // The library card.
    await page.goto("/#/engines");
    const card = page.locator(".engines-card:not(.engines-card--skeleton)").filter({ has: page.locator(".engines-card-name", { hasText: /^Materialist$/ }) });
    await expect(card.locator(".engines-card-meta")).toContainText("Network missing");
    // The Workshop.
    await page.goto(`/#/engines/${materialistId}`);
    await expect(page.locator(".workshop-networkbar")).toContainText("was deleted");
    await shot(page, "network-deleted-workshop");
    // Play: the game does not start, and says why.
    await page.goto(`/#/play?engine=${materialistId}`);
    const loadError = page.locator(".play-loaderror");
    await expect(loadError).toBeVisible({ timeout: 60_000 });
    await expect(loadError).toContainText("no longer exists");
    await expect(loadError).toContainText("Materialist");
    await shot(page, "network-deleted-play");
    // Arena: the match pauses with the same clear error and a link to the engine.
    const brokenMatch = await page.evaluate(
      async ({ a, b }) => {
        const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
        const cfg = m.defaultMatchConfig({ engineIds: [a, b], hashMb: 16, maxWorkers: 2 });
        cfg.name = "Without a network";
        cfg.gamesPerPairing = 2;
        cfg.concurrency = 1;
        cfg.participants = cfg.participants.map((p) => ({ ...p, limits: { nodes: 1500 }, timeControl: null }));
        return m.arena.createMatch(cfg, { start: true });
      },
      { a: NEURON_ID, b: materialistId },
    );
    await page.goto(`/#/arena/${brokenMatch}`);
    const callout = page.getByTestId("arena-error");
    await expect(callout).toBeVisible({ timeout: 60_000 });
    await expect(callout).toContainText("no longer exists");
    await expect(callout.getByRole("link", { name: "Open Materialist" })).toHaveAttribute("href", `#/engines/${materialistId}`);
    await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "paused");
    await shot(page, "network-deleted-arena");
    // The run that trained it lists it as deleted.
    await page.goto("/#/lab/runs");
    await page.locator("tr", { hasText: "Material net" }).getByRole("link", { name: "Material net" }).click();
    await expect(page.locator("#lab-run-networks")).toContainText("Deleted network");
  });

  test("closing the browser keeps the networks, datasets and the run; reopening it resumes the run", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const profile = join(SCRATCH, `profile-${Date.now()}`);
    rmSync(profile, { recursive: true, force: true });
    const launch = () => chromium.launchPersistentContext(profile, { baseURL, viewport: { width: 1440, height: 900 } });
    // Console errors of every page opened here (the fixture only watches its own page).
    const errorLists: string[][] = [];
    let context: BrowserContext | null = await launch();
    try {
      let page = context.pages()[0] ?? (await context.newPage());
      errorLists.push(trackErrors(page));
      await openApp(page, "#/lab");
      // A long self-play run (auto-resume on), started through the service.
      const runId = await page.evaluate(async () => {
        const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
        const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
        const classic = (await s.enginesRepo.list()).find((e) => e.name === "Classic")!;
        return t.training.createRun(
          {
            name: "Survives a restart",
            network: { mode: "new", hidden: 64, activation: 1 },
            data: { datasetIds: [], selfPlay: { engineId: classic.id, limits: { nodes: 2000 }, randomPlies: 8, games: 5000, concurrency: 2, maxPlies: 300, skipPlies: 8 } },
            hyper: { epochs: 2, batchSize: 1024, learningRate: 0.001, lrSchedule: "constant", evalWeight: 0.75, weightDecay: 0.01, validationSplit: 0.05, threads: 1, seed: 1 },
            loop: { enabled: false, cycles: 1, selfPlayWithLatest: false, keepCycles: null, gating: null },
            publishEngine: true,
          },
          { autoResume: true, start: true },
        );
      });
      await page.goto(`/#/lab/runs/${runId}`);
      await expect(runStatus(page)).toHaveText("Self-play", { timeout: 60_000 });
      // Wait until some games are stored, then close the whole browser in the middle of self-play.
      const storedGames = async (p: Page) =>
        p.evaluate(async (id) => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          const run = await s.runsRepo.get(id);
          const ds = run?.datasetIds[0] ? await s.datasetsRepo.get(run.datasetIds[0]) : undefined;
          return ds?.games ?? 0;
        }, runId);
      await expect.poll(() => storedGames(page), { timeout: 90_000 }).toBeGreaterThanOrEqual(20);
      const before = await storedGames(page);
      await context.close();
      context = null;

      // Reopen the browser: everything is there and the run continues by itself.
      context = await launch();
      page = context.pages()[0] ?? (await context.newPage());
      errorLists.push(trackErrors(page));
      await openApp(page, `#/lab/runs/${runId}`);
      await expect(page.getByRole("heading", { name: "Survives a restart" })).toBeVisible();
      await expect(page.locator(".toaster .toast", { hasText: "Resumed the training run" })).toBeVisible({ timeout: 60_000 });
      await expect(runStatus(page)).toHaveText("Self-play", { timeout: 60_000 });
      await expect(page.locator(".activity-button")).toContainText("1 running");
      const after = await storedGames(page);
      expect(after).toBeGreaterThanOrEqual(before);
      await expect.poll(() => storedGames(page), { timeout: 90_000 }).toBeGreaterThan(after);
      await expect(page.locator("#lab-run-now .lab-board").first()).toBeVisible({ timeout: 30_000 });
      await shot(page, "restart-resumed");
      // The rest of the data survived too: the starter network and the run's dataset.
      await page.goto("/#/lab/networks");
      await expect(page.locator("tr", { hasText: STARTER_NETWORK_NAME })).toBeVisible();
      await page.goto("/#/lab/datasets");
      await expect(page.locator("tr", { hasText: "Survives a restart - cycle 1" })).toBeVisible();
      await page.goto("/#/lab/runs");
      await expect(page.locator("tr", { hasText: "Survives a restart" }).locator(".lab-status")).toHaveText("Self-play");
      // Stop it (nothing trained yet, so no network is kept).
      await page.goto(`/#/lab/runs/${runId}`);
      await page.locator(".lab-run-controls").getByRole("button", { name: "Stop", exact: true }).click();
      await expect(runStatus(page)).toHaveText("Stopped", { timeout: 30_000 });
    } finally {
      await context?.close();
      rmSync(profile, { recursive: true, force: true });
    }
    expect(errorLists.flat()).toEqual([]);
  });
});

