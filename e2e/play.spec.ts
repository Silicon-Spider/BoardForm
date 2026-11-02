// End-to-end tests of the Play page (#/play): games against engines, engine games, clocks, error
// paths, analysis, resume after a reload, game actions and the route's query parameters.
//
// Run: E2E_PORT=5212 npx playwright test e2e/play.spec.ts
// Set E2E_SHOTS=<dir> to also write screenshots of the states the tests pass through.
//
// Every test gets a fresh browser context (empty IndexedDB), so the app seeds the three starter
// engines (Blocky, Classic, Sprout) on load; `openPlay` waits for them. Engine limits are node
// counts or short move times so the games are quick and deterministic enough.
import { expect, test as base, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

// --- helpers ---------------------------------------------------------------------------------

// Source modules are imported inside the page (Vite serves them in dev); typed from the sources.
type StorageModule = typeof import("../src/storage/index");
type TemplatesModule = typeof import("../src/engine-host/templates");

const GAME_BOARD = '[aria-label="Game board"]';
const ANALYSIS_BOARD = '[aria-label="Analysis board"]';
const SHOTS = process.env.E2E_SHOTS ?? "";

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

type EngineIds = Record<"Blocky" | "Classic" | "Sprout", string> & Record<string, string>;

/** Opens the Play page and waits until the starter engines exist. Returns name → id. */
async function openPlay(page: Page, hash = "#/play"): Promise<EngineIds> {
  await page.goto("/" + hash);
  await expect
    .poll(() => page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).enginesRepo.list()).length), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(3);
  return engineIds(page);
}

async function engineIds(page: Page): Promise<EngineIds> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return Object.fromEntries((await s.enginesRepo.list()).map((e) => [e.name, e.id]));
  }) as Promise<EngineIds>;
}

async function setSetting(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(async ([k, v]) => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.set(k as string, v), [key, value] as const);
}

async function getSetting<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(async (k) => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.get(k, null), key) as Promise<T>;
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
  startFen: string;
}

async function savedGames(page: Page): Promise<SavedGame[]> {
  return page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).gamesRepo.list()) as unknown as SavedGame[]) as Promise<SavedGame[]>;
}

/** Writes the setup the "New game" form starts from (play.lastSetup), then reloads the page. */
async function useSetup(page: Page, setup: Record<string, unknown>): Promise<void> {
  await setSetting(page, "play.lastSetup", setup);
  await page.reload();
  await expect(page.locator(".play-setup")).toBeVisible();
}

const engineSide = (engineId: string, limits: Record<string, number>, timeControl: Record<string, number> | null = null) => ({
  player: "engine",
  engineId,
  limits,
  timeControl,
  hashMb: null,
});
const humanSide = (timeControl: Record<string, number> | null = null) => ({ player: "human", engineId: null, limits: {}, timeControl, hashMb: null });

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
async function clickMove(page: Page, boardSel: string, from: string, to: string, orientation: "white" | "black" = "white") {
  await expect(page.locator(`${boardSel} [data-square="${from}"]`).first()).toBeVisible();
  const a = await squarePoint(page, boardSel, from, orientation);
  await page.mouse.click(a.x, a.y);
  const b = await squarePoint(page, boardSel, to, orientation);
  await page.mouse.click(b.x, b.y);
}

const moveCells = (page: Page) => page.locator(".play-movelist .cb-ml-move:not(.cb-ml-move--empty)");

async function expectPlies(page: Page, n: number, timeout = 30_000) {
  await expect(moveCells(page)).toHaveCount(n, { timeout });
}

/** Waits until the human's side shows "Your move". */
async function waitYourMove(page: Page, timeout = 60_000) {
  await expect(page.locator(".play-player-status", { hasText: "Your move" })).toBeVisible({ timeout });
}

/** Confirms the open confirmation dialog with the given button label. */
async function confirmDialog(page: Page, label: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Stores an extra engine directly (scratch "empty skeleton", or an eval engine with given eval.ts). */
async function createEngine(page: Page, opts: { name: string; kind: "scratch-empty" | "eval"; evalSource?: string }): Promise<string> {
  return page.evaluate(async ({ name, kind, evalSource }) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const t = (await import(String("/src/engine-host/templates.ts"))) as TemplatesModule;
    const id = s.newId();
    const now = Date.now();
    const files = kind === "scratch-empty" ? t.scratchFiles("empty") : { "eval.ts": evalSource ?? t.defaultFilesFor("eval")["eval.ts"] };
    await s.enginesRepo.put({
      id,
      name,
      description: "",
      kind: kind === "scratch-empty" ? "scratch" : "eval",
      createdAt: now,
      updatedAt: now,
      color: "#f472b6",
      files,
      entry: "main.ts",
      options: { hashMb: 16 },
      build: null,
      networkId: null,
      parentId: null,
      tags: [],
    } as never);
    return id;
  }, opts);
}

/** Milliseconds shown by a clock's aria-label ("White clock 4:57" or "White clock 0:12.3"). */
function clockMs(label: string): number {
  const m = /(\d+):(\d{2})(?:\.(\d))?$/.exec(label);
  if (!m) throw new Error(`not a clock label: ${label}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3] ?? 0) * 100;
}

async function noHorizontalScroll(page: Page) {
  const [doc, win] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(doc).toBeLessThanOrEqual(win);
}

// --- tests -----------------------------------------------------------------------------------

test.describe("Play page", () => {
  test("you vs Classic at 0.2 s per move: click moves, engine replies, resign saves the game", async ({ page }) => {
    await openPlay(page);
    await expect(page.locator(".play-setup")).toBeVisible();
    await shot(page, "setup-dark-1440");

    // Quick preset "You vs engine (White)", then 0.2 s per move for the engine.
    await page.locator(".play-preset").first().click();
    const black = page.locator('.play-sidecard[data-side="b"]');
    await expect(black.getByRole("button", { name: "Black player" })).toContainText("Classic");
    await black.getByLabel("Time per move").fill("0.2");
    await expect(page.locator(".play-start-button")).toBeEnabled();
    await page.locator(".play-start-button").click();

    await waitYourMove(page);
    await expect(page.locator(".play-board-col .play-player").last()).toContainText("You");
    await clickMove(page, GAME_BOARD, "e2", "e4");
    await expectPlies(page, 2);
    await waitYourMove(page);

    // Engine info: a depth and a score; the eval bar shows a number.
    const card = page.locator(".play-engine").first();
    await expect(card.locator(".play-engine-stats dd").nth(1)).not.toHaveText("—");
    await expect(page.locator(".play-evalbar")).not.toHaveAttribute("aria-label", "Evaluation —");

    await clickMove(page, GAME_BOARD, "d2", "d4");
    await expectPlies(page, 4);
    await waitYourMove(page);
    await shot(page, "game-human-dark-1440");

    // Resign → confirm → banner → saved.
    await page.getByRole("button", { name: "Resign" }).click();
    await confirmDialog(page, "Resign");
    const banner = page.locator(".play-result");
    await expect(banner).toContainText("Black wins");
    await expect(banner).toContainText("You resigned.");
    await expect(banner).toHaveClass(/play-result--loss/);
    await expect(banner).toContainText("Saved to your games");
    await shot(page, "game-human-resigned");

    const games = await savedGames(page);
    expect(games).toHaveLength(1);
    expect(games[0].result).toBe("0-1");
    expect(games[0].termination).toBe("resign");
    expect(games[0].moves.slice(0, 4)).toEqual(expect.arrayContaining(["e2e4", "d2d4"]));
    expect(games[0].moves).toHaveLength(4);
    expect(games[0].white).toMatchObject({ type: "human", name: "You" });
    expect(games[0].black).toMatchObject({ type: "engine", name: "Classic" });
    // Human moves have no eval, engine moves do.
    expect(games[0].evals[0]).toBeNull();
    expect(typeof games[0].evals[1]).toBe("number");
    expect(games[0].pgn).toContain('[White "You"]');
    expect(games[0].pgn).toContain("0-1");

    // The in-progress record is finished and nothing resumes after a reload.
    await page.reload();
    await expect(page.locator(".play-resume")).toHaveCount(0);
    await expect(page.locator(".play-result")).toBeVisible();

    // Rematch: colours swap, so Classic opens and the board turns to Black.
    await page.getByRole("button", { name: "Rematch" }).click();
    await waitYourMove(page);
    await expectPlies(page, 1);
    await expect(page.locator(".play-board-col .play-player").last()).toContainText("You");
    const board = await page.locator(GAME_BOARD).boundingBox();
    const a1 = await page.locator(`${GAME_BOARD} [data-square="a1"]`).boundingBox();
    expect(a1!.y).toBeLessThan(board!.y + board!.height / 2);
    // Only one move by the engine: aborting saves an unfinished game.
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");
    await expect.poll(async () => (await savedGames(page)).length).toBe(2);
  });

  test("setup form: invalid fields block the start, custom FEN, opening picker, random start, swap", async ({ page }) => {
    await openPlay(page);
    await page.locator(".play-preset").first().click();
    const black = page.locator('.play-sidecard[data-side="b"]');
    const start = page.locator(".play-start-button");
    await expect(start).toBeEnabled();

    // A field showing an error blocks the start (the setup would otherwise keep the old value).
    await black.getByLabel("Time per move").fill("abc");
    await expect(black.locator(".field-error")).toBeVisible();
    await expect(start).toBeDisabled();
    await expect(page.locator(".play-problems")).toContainText("Fix the field marked in red first.");
    await black.getByLabel("Time per move").fill("0.5");
    await expect(start).toBeEnabled();
    await black.getByLabel("Hash table").fill("9999");
    await expect(black).toContainText("At most 512");
    await expect(start).toBeDisabled();
    await black.getByLabel("Hash table").fill("");
    await expect(start).toBeEnabled();
    // No limit at all.
    await black.getByLabel("Time per move").fill("");
    await expect(page.locator(".play-problems")).toContainText("Set a clock or at least one search limit for Black.");
    await expect(start).toBeDisabled();
    await black.getByLabel("Depth").fill("4");
    await expect(start).toBeEnabled();

    // Custom FEN: an invalid one is explained, a valid one shows on the preview board.
    await page.getByRole("radio", { name: "Custom" }).click();
    const fenInput = page.locator(".play-fen-input");
    await fenInput.fill("8/8/8/8");
    await expect(page.locator(".play-start-fen .field-error")).toContainText("The FEN is not valid");
    await expect(start).toBeDisabled();
    await fenInput.fill("4k3/8/8/8/8/8/3QK3/8 w - - 0 1");
    await expect(page.locator(".play-start-fen .field-error")).toHaveCount(0);
    await expect(page.locator('[aria-label="Start position preview"] [data-piece]')).toHaveCount(3);
    await expect(start).toBeEnabled();
    await fenInput.fill("k7/1Q6/1K6/8/8/8/8/8 b - - 0 1");
    await expect(page.locator(".play-start-fen .field-error")).toContainText("already over");
    await shot(page, "setup-fen-error");

    // Opening picker: Cancel keeps the previous start; search, keyboard, Enter picks.
    await page.getByRole("radio", { name: "Opening" }).click();
    const picker = page.getByRole("dialog", { name: "Choose an opening" });
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: "Cancel" }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Opening" }).click();
    await expect(picker).toBeVisible();
    await picker.getByLabel("Search openings").fill("sicilian");
    await expect(picker.getByRole("option").first()).toContainText("Sicilian");
    await picker.getByLabel("Search openings").press("ArrowDown");
    await picker.getByLabel("Search openings").press("Enter");
    await expect(picker).toBeHidden();
    await expect(page.locator(".play-start-opening-name")).toContainText("Sicilian");
    await expect(page.locator(".play-start-opening")).toContainText("book plies");
    // The preview shows the position after the book moves (1. e4 c5 ... in every Sicilian line).
    await expect(page.locator('[aria-label="Start position preview"] [data-square="e4"][data-piece="wP"]')).toBeAttached();
    await expect(page.locator('[aria-label="Start position preview"] [data-square="c7"]')).toHaveCount(0);
    await shot(page, "setup-opening");

    // Random: explained under the board.
    await page.getByRole("radio", { name: "Random" }).click();
    await expect(page.locator(".play-board-note")).toContainText("A random opening is chosen when the game starts.");

    // Swap colours.
    await page.getByRole("button", { name: "Swap colours" }).click();
    await expect(page.getByRole("button", { name: "White player" })).toContainText("Classic");
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Human");
    // Everything autosaves: the form survives a reload.
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByRole("button", { name: "White player" })).toContainText("Classic");
    await expect(page.getByRole("radio", { name: "Random" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('.play-sidecard[data-side="w"]').getByLabel("Depth")).toHaveValue("4");
  });

  test("analysis tools: load FEN, import PGN, replace board, play from here, an engine that does not compile", async ({ page }) => {
    await openPlay(page);
    const brokenId = await createEngine(page, { name: "Broken eval", kind: "eval", evalSource: "export function evaluate(): i32 {\n  return 1 +;\n}\n" });
    await page.getByRole("radio", { name: "Analysis" }).click();

    // Load FEN.
    await page.getByRole("button", { name: "Load FEN…" }).click();
    let dialog = page.getByRole("dialog", { name: "Load a position (FEN)" });
    await dialog.locator("textarea").fill("rnbqkbnr/pppp/8");
    await dialog.getByRole("button", { name: "Load position" }).click();
    await expect(dialog.locator(".field-error")).toContainText("The FEN is not valid");
    await dialog.locator("textarea").fill("4k3/8/8/8/8/8/3QK3/8 w - - 0 1");
    await dialog.getByRole("button", { name: "Load position" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`${ANALYSIS_BOARD} [data-piece]`)).toHaveCount(3);

    // Import PGN: an invalid text is explained; a valid one loads with its player names.
    await page.getByRole("button", { name: "Import PGN…" }).click();
    dialog = page.getByRole("dialog", { name: "Import a PGN" });
    await dialog.locator("textarea").fill("1. e4 e5 2. Ke3 Kxe3 *");
    await dialog.getByRole("button", { name: "Load into analysis" }).click();
    await expect(dialog.locator(".field-error")).toContainText("Could not read this PGN");
    await dialog.locator("textarea").fill('[White "Anderssen"]\n[Black "Kieseritzky"]\n\n1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ *');
    await dialog.getByRole("button", { name: "Load into analysis" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Loaded 6 plies into the analysis board")).toBeVisible();
    await expectPlies(page, 6);
    await expect(page.locator(".play-board-col")).toContainText("Anderssen");
    await expect(page.locator(".play-board-col")).toContainText("Kieseritzky");

    // New board asks before throwing away moves that are not saved anywhere.
    await page.getByRole("button", { name: "New board" }).click();
    await expect(page.getByRole("dialog")).toContainText("Replace the analysis board?");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expectPlies(page, 6);
    await page.getByRole("button", { name: "New board" }).click();
    await confirmDialog(page, "Replace");
    await expect(page.locator(".play-analysis .cb-ml-empty")).toBeVisible();

    // An engine that does not compile: the error and a Workshop link in the engine card.
    await page.getByRole("button", { name: "Analysis engine" }).click();
    await page.getByRole("option", { name: /Broken eval/ }).click();
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    const card = page.locator(".play-analysis .play-engine");
    await expect(card.locator(".play-analysis-error")).toContainText("Broken eval does not compile", { timeout: 60_000 });
    await expect(card.getByRole("link", { name: "Open it in the Workshop" })).toHaveAttribute("href", `#/engines/${brokenId}?file=eval.ts`);
    await expect(page.getByRole("button", { name: "Analyse", exact: true })).toBeVisible();
    await shot(page, "analysis-build-error");

    // Play from here: the position goes into the new-game form.
    await clickMove(page, ANALYSIS_BOARD, "g1", "f3");
    await page.getByRole("button", { name: "Play from here" }).click();
    await expect(page.getByRole("radio", { name: "Play" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".play-fen-input")).toHaveValue(/5N2\/PPPPPPPP\/RNBQKB1R b KQkq/);
  });

  test("engine vs engine: Classic vs Blocky at 3000 nodes plays to the end, then review it", async ({ page }) => {
    test.setTimeout(240_000);
    await openPlay(page);
    // Quick preset "Engine vs engine", then 3000 nodes per move instead of 1 s.
    await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
    for (const side of ["w", "b"] as const) {
      const card = page.locator(`.play-sidecard[data-side="${side}"]`);
      await card.getByLabel("Time per move").fill("");
      await card.getByLabel("Max positions searched (nodes)").fill("3000");
    }
    // Black: Blocky.
    await page.getByRole("button", { name: "Black player" }).click();
    await page.getByRole("option", { name: /Blocky/ }).click();
    await expect(page.getByRole("button", { name: "White player" })).toContainText("Classic");
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Blocky");
    // No pause between moves.
    await page.getByLabel("Move delay in milliseconds").focus();
    await page.keyboard.press("Home");
    await expect(page.locator(".play-delay")).toContainText("None");
    await shot(page, "setup-engines");
    await page.locator(".play-start-button").click();

    await expect(page.locator(".play-engine")).toHaveCount(2);
    await expect(page.locator(".play-player-status", { hasText: "3k nodes" }).first()).toBeAttached();
    // Pause holds the game; Resume continues it.
    await expect(moveCells(page).nth(5)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.locator(".play-engine-status", { hasText: "Paused" })).toHaveCount(2);
    const paused = await moveCells(page).count();
    await page.waitForTimeout(1500);
    await expect(moveCells(page)).toHaveCount(paused);
    await shot(page, "game-engines-paused");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(moveCells(page).nth(paused)).toBeVisible({ timeout: 30_000 });

    const banner = page.locator(".play-result");
    await expect(banner).toBeVisible({ timeout: 200_000 });
    await expect(banner).toContainText("Saved to your games");
    await shot(page, "game-engines-finished");

    const [g] = await savedGames(page);
    expect(["checkmate", "stalemate", "threefold", "fifty-move", "insufficient-material"]).toContain(g.termination);
    expect(g.white).toMatchObject({ type: "engine", name: "Classic" });
    expect(g.black).toMatchObject({ type: "engine", name: "Blocky" });
    expect(g.evals).toHaveLength(g.moves.length);
    expect(g.evals.filter((v) => typeof v === "number").length).toBeGreaterThan(g.moves.length * 0.9);
    const plies = g.moves.length;

    // Saved games tab → open it → review card with the evaluation graph.
    await page.getByRole("tab", { name: /Saved games/ }).click();
    const row = page.locator(".play-gamerow").first();
    await expect(row).toContainText("Classic vs Blocky");
    await shot(page, "saved-games-list");
    await row.locator(".play-gamerow-main").click();
    await expect(page.getByRole("radio", { name: "Analysis" })).toHaveAttribute("aria-checked", "true");
    const review = page.locator(".play-review");
    await expect(review).toContainText("Classic vs Blocky");
    await expect(review.locator(".play-evalgraph .cb-chart-box")).toBeVisible();
    await expectPlies(page, plies);
    await expect(page.locator(".cb-ml-move--current")).toHaveCount(1);

    // Navigation: start, next, previous, end, keyboard.
    const current = page.locator(".cb-ml-move--current");
    await page.getByRole("button", { name: "Start position" }).click();
    await expect(current).toHaveCount(0);
    await page.getByRole("button", { name: "Next move" }).click();
    await expect(current).toHaveText(g.san[0]);
    await page.keyboard.press("ArrowRight");
    await expect(current).toHaveText(g.san[1]);
    await page.getByRole("button", { name: "Latest position" }).click();
    await expect(current).toHaveText(g.san[plies - 1]);
    await page.keyboard.press("ArrowLeft");
    await expect(current).toHaveText(g.san[plies - 2]);

    // A click on the graph jumps to that ply.
    const overlay = review.locator(".cb-chart-overlay");
    const box = await overlay.boundingBox();
    if (!box) throw new Error("no graph");
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    await expect.poll(async () => (await moveCells(page).evaluateAll((els) => els.findIndex((e) => e.classList.contains("cb-ml-move--current"))))).toBeLessThan(plies * 0.5);
    await shot(page, "review-graph-click");
  });

  test("1+0 clock: the human runs out of time and loses on time", async ({ page }) => {
    test.setTimeout(150_000);
    const ids = await openPlay(page);
    await useSetup(page, {
      white: humanSide({ baseMs: 60_000, incMs: 0 }),
      black: engineSide(ids.Classic, {}, { baseMs: 60_000, incMs: 0 }),
      start: { kind: "standard" },
      sameClock: true,
    });
    await expect(page.locator('.play-sidecard[data-side="w"] select')).toHaveValue("1+0");
    await page.locator(".play-start-button").click();
    await waitYourMove(page);
    await expect(page.locator(".play-board-col .cb-clock--running")).toHaveCount(1);
    await expect(page.locator(".play-result")).toBeVisible({ timeout: 75_000 });
    await expect(page.locator(".play-result")).toContainText("Black wins");
    await expect(page.locator(".play-result")).toContainText("You ran out of time.");
    await expect(page.locator('.play-board-col [role="timer"][aria-label="White clock 0:00.0"]')).toBeVisible();
    await shot(page, "game-flag");
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.result).toBe("0-1");
    expect(g.termination).toBe("timeout");
  });

  test("10 s + 100 ms engine game finishes without a flag fall", async ({ page }) => {
    test.setTimeout(180_000);
    const ids = await openPlay(page);
    const tc = { baseMs: 10_000, incMs: 100 };
    await setSetting(page, "play.moveDelayMs", 0);
    await useSetup(page, {
      white: engineSide(ids.Classic, {}, tc),
      black: engineSide(ids.Blocky, {}, tc),
      start: { kind: "standard" },
      sameClock: true,
    });
    await expect(page.locator('.play-sidecard[data-side="w"] select')).toHaveValue("custom");
    await page.locator(".play-start-button").click();
    await expect(page.locator(".play-board-col .cb-clock").first()).toBeVisible();
    await expect(page.locator(".play-result")).toBeVisible({ timeout: 150_000 });
    await shot(page, "game-engines-clock");
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.termination).not.toBe("timeout");
    expect(["checkmate", "stalemate", "threefold", "fifty-move", "insufficient-material"]).toContain(g.termination);
    // Each move was charged to the clock, none beyond the time available.
    expect(g.times.every((t) => t >= 0 && t < 10_000)).toBe(true);
  });

  test("an empty-skeleton engine that returns no move loses by engine error", async ({ page }) => {
    const ids = await openPlay(page);
    const emptyId = await createEngine(page, { name: "Empty skeleton", kind: "scratch-empty" });
    await page.goto(`/#/play?white=${ids.Sprout}&black=${emptyId}`);
    const banner = page.locator(".play-result");
    await expect(banner).toBeVisible({ timeout: 90_000 });
    await expect(banner).toContainText("White wins");
    await expect(banner).toContainText("Empty skeleton produced no move.");
    await expect(banner).not.toContainText(/checkmate|stalemate/i);
    // The query is consumed: a reload does not start another game.
    await expect(page).toHaveURL(/#\/play$/);
    // The engine's TODO log line is in its console.
    const card = page.locator(".play-engine", { hasText: "Empty skeleton" });
    await card.locator(".play-console-toggle").click();
    await expect(card.locator(".play-console-log")).not.toContainText("No output yet");
    await shot(page, "game-empty-engine");
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.result).toBe("1-0");
    expect(g.termination).toBe("engine-error");
    expect(g.moves).toHaveLength(1);
  });

  test("an eval engine with a syntax error shows the build error and a Workshop link; no game starts", async ({ page }) => {
    const ids = await openPlay(page);
    const brokenId = await createEngine(page, { name: "Broken eval", kind: "eval", evalSource: "export function evaluate(): i32 {\n  return 1 +;\n}\n" });
    await useSetup(page, {
      white: humanSide(),
      black: engineSide(brokenId, { movetimeMs: 200 }),
      start: { kind: "standard" },
      sameClock: true,
    });
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Broken eval");
    await page.locator(".play-start-button").click();
    const err = page.locator(".play-loaderror");
    await expect(err).toBeVisible({ timeout: 60_000 });
    await expect(err).toContainText("Broken eval does not compile");
    await expect(err.locator(".play-diagnostics li").first()).toContainText("eval.ts");
    const link = err.getByRole("link", { name: "Open in the Workshop" });
    await expect(link).toHaveAttribute("href", `#/engines/${brokenId}?file=eval.ts`);
    await expect(page.locator(".play-actions")).toHaveCount(0);
    await shot(page, "game-build-error");
    // Nothing was stored, and the board does not accept moves.
    expect(await savedGames(page)).toHaveLength(0);
    expect(await getSetting(page, "play.current")).toBeNull();
    await expect(page.locator(`${GAME_BOARD}`)).toBeVisible();

    // Back to setup → the form, untouched.
    await err.getByRole("button", { name: "Back to setup" }).click();
    await expect(page.locator(".play-setup")).toBeVisible();
    await expect(page.getByRole("button", { name: "Black player" })).toContainText("Broken eval");

    // A reload after the failure offers no resume.
    await page.reload();
    await expect(page.locator(".play-setup")).toBeVisible();
    await expect(page.locator(".play-resume")).toHaveCount(0);

    // The Workshop link opens the engine on eval.ts.
    await page.locator(".play-start-button").click();
    await expect(err).toBeVisible({ timeout: 60_000 });
    await err.getByRole("link", { name: "Open in the Workshop" }).click();
    await expect(page).toHaveURL(new RegExp(`#/engines/${brokenId}\\?file=eval\\.ts$`));
    void ids;
  });

  test("analysis: infinite search, stop, navigate the line, play a PV move", async ({ page }) => {
    const ids = await openPlay(page);
    await page.getByRole("radio", { name: "Analysis" }).click();
    await expect(page.locator(".play-analysis")).toBeVisible();
    await expect(page.locator(".play-analysis .cb-ml-empty")).toBeVisible();
    await shot(page, "analysis-empty");
    await clickMove(page, ANALYSIS_BOARD, "e2", "e4");
    await clickMove(page, ANALYSIS_BOARD, "e7", "e5");
    await expectPlies(page, 2);

    await page.getByRole("button", { name: "Analysis engine" }).click();
    await page.getByRole("option", { name: /Classic/ }).click();
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    const card = page.locator(".play-analysis .play-engine");
    await expect(card.locator(".play-engine-status")).toContainText("Analysing", { timeout: 60_000 });
    const depth = card.locator(".play-engine-stats dd").nth(1);
    await expect.poll(async () => parseInt((await depth.textContent()) ?? "0", 10), { timeout: 60_000 }).toBeGreaterThanOrEqual(8);
    await expect(page.locator(`${ANALYSIS_BOARD} .cb-arrows *`).first()).toBeAttached();
    await shot(page, "analysis-running");

    // Step back one ply: the engine analyses the new position (its PV starts with Black's move).
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".cb-ml-move--current")).toHaveText("e4");
    await expect(page.locator(".play-moves-hint")).toBeVisible();
    await expect(card.locator(".play-pv-num").first()).toHaveText("1…", { timeout: 30_000 });
    // Play the PV up to its second move: the line is replaced from here.
    const second = await card.locator(".play-pv-move").nth(1).textContent();
    const first = await card.locator(".play-pv-move").nth(0).textContent();
    await card.locator(".play-pv-move").nth(1).click();
    await expectPlies(page, 3);
    await expect(moveCells(page).nth(1)).toHaveText(first ?? "");
    await expect(page.locator(".cb-ml-move--current")).toHaveText(second ?? "");

    // Stop keeps the last info.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(card.locator(".play-engine-status")).toContainText("Stopped");
    await expect(page.getByRole("button", { name: "Analyse", exact: true })).toBeVisible();
    // Navigation buttons.
    await page.getByRole("button", { name: "Start position" }).click();
    await expect(page.locator(".cb-ml-move--current")).toHaveCount(0);
    await page.getByRole("button", { name: "Latest position" }).click();
    await expect(page.locator(".cb-ml-move--current")).toHaveText(second ?? "");
    // The analysis board survives a reload.
    await page.waitForTimeout(600);
    await page.reload();
    await expectPlies(page, 3);
    void ids;
  });

  test("reload mid-game: resume, the time away is not charged; takeback, draw offer, flip, PGN export", async ({ page, context }) => {
    test.setTimeout(150_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const ids = await openPlay(page);
    await useSetup(page, {
      white: humanSide({ baseMs: 300_000, incMs: 0 }),
      black: engineSide(ids.Classic, { movetimeMs: 300 }, { baseMs: 300_000, incMs: 0 }),
      start: { kind: "standard" },
      sameClock: true,
    });
    await page.locator(".play-start-button").click();
    await waitYourMove(page);
    await clickMove(page, GAME_BOARD, "d2", "d4");
    await expectPlies(page, 2);
    await waitYourMove(page);
    await page.waitForTimeout(3000); // White thinks for 3 s
    await page.reload();

    const resume = page.locator(".play-resume");
    await expect(resume).toBeVisible();
    await expect(resume).toContainText("The clocks stopped when you left.");
    await expect(resume).toContainText("The engine restarts when you resume.");
    await shot(page, "resume-banner");
    // About 3 s of White's thinking time were charged before the reload (not 0, not more than ~8 s).
    const whiteClock = page.locator('.play-board-col [role="timer"]').last();
    const shown = (await whiteClock.getAttribute("aria-label")) ?? "";
    const restoredMs = clockMs(shown);
    expect(restoredMs).toBeLessThanOrEqual(300_000 - 2000);
    expect(restoredMs).toBeGreaterThan(300_000 - 8000);
    // The clock does not run while the game waits for "Resume".
    await page.waitForTimeout(3000);
    await expect(whiteClock).toHaveAttribute("aria-label", shown);
    await expect(page.locator(".play-actions")).toHaveCount(0);

    await page.getByRole("button", { name: "Resume game" }).click();
    await waitYourMove(page);
    await expect(page.locator(".play-board-col .cb-clock--running")).toHaveCount(1);
    await clickMove(page, GAME_BOARD, "c2", "c4");
    await expectPlies(page, 4);
    await waitYourMove(page);
    const after = await getSetting<{ clock: { w: number }; times: number[] }>(page, "play.current");
    // The move after the resume was charged only the time since the resume.
    expect(after.times[2]).toBeLessThan(5000);
    expect(after.clock.w).toBeLessThanOrEqual(restoredMs + 1000);
    expect(after.clock.w).toBeGreaterThan(restoredMs - 6000);

    // Draw offer this early: declined with a reason.
    await page.getByRole("button", { name: "Offer draw" }).click();
    await expect(page.locator(".play-notice")).toContainText("Classic declines the draw");
    await expect(page.locator(".play-result")).toHaveCount(0);

    // Takeback removes the engine's reply and your move.
    await page.getByRole("button", { name: "Takeback" }).click();
    await expectPlies(page, 2);
    await expect(page.locator(".play-notice")).toContainText("Took back 2 moves.");
    await waitYourMove(page);
    await expect(page.locator(`${GAME_BOARD} [data-square="c2"]`)).toBeAttached();

    // Flip: a1 moves from the bottom-left to the top-right.
    const board = await page.locator(GAME_BOARD).boundingBox();
    const a1 = () => page.locator(`${GAME_BOARD} [data-square="a1"]`).boundingBox();
    expect((await a1())!.y).toBeGreaterThan(board!.y + board!.height / 2);
    await page.getByRole("button", { name: "Flip", exact: true }).click();
    await expect.poll(async () => (await a1())!.y).toBeLessThan(board!.y + board!.height / 2);
    await shot(page, "game-flipped");
    await page.keyboard.press("f");
    await expect.poll(async () => (await a1())!.y).toBeGreaterThan(board!.y + board!.height / 2);

    // Copy PGN.
    await page.getByRole("button", { name: "Copy PGN" }).click();
    await expect(page.getByText("PGN copied")).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('[White "You"]');
    expect(clip).toContain("1. d4");
    // Download PGN.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PGN" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^you-vs-classic-\d{4}-\d{2}-\d{2}\.pgn$/);
    const text = await (await download.createReadStream()).toArray();
    expect(Buffer.concat(text).toString("utf8")).toContain("1. d4");

    // Abort (confirmed) saves it as unfinished.
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");
    await expect(page.locator(".play-result")).toContainText("Game aborted");
    await expect.poll(async () => (await savedGames(page)).map((g) => g.termination)).toEqual(["aborted"]);
  });

  test("query parameters: ?engine=, ?white=&black=, ?fen=, problems in links", async ({ page }) => {
    const ids = await openPlay(page);
    await setSetting(page, "play.lastSetup", {
      white: humanSide(),
      black: engineSide(ids.Classic, { movetimeMs: 200 }),
      start: { kind: "standard" },
      sameClock: true,
    });

    // ?engine= → you (White) vs that engine, started at once; the query is removed.
    await page.goto(`/#/play?engine=${ids.Sprout}`);
    await waitYourMove(page);
    await expect(page).toHaveURL(/#\/play$/);
    await expect(page.locator(".play-board-col .play-player").first()).toContainText("Sprout");
    await expect(page.locator(".play-board-col .play-player").last()).toContainText("You");

    // Another link during the game asks first; "Keep playing" keeps the game.
    await page.goto(`/#/play?engine=${ids.Classic}`);
    const pending = page.locator(".play-callout", { hasText: "Start the game from the link?" });
    await expect(pending).toBeVisible();
    await shot(page, "link-pending");
    await pending.getByRole("button", { name: "Keep playing" }).click();
    await expect(pending).toHaveCount(0);
    await expect(page.locator(".play-board-col .play-player").first()).toContainText("Sprout");
    // ...and "Start new game" replaces it (no moves were played, so nothing is saved).
    await page.goto(`/#/play?engine=${ids.Blocky}`);
    await page.locator(".play-callout").getByRole("button", { name: "Start new game" }).click();
    await waitYourMove(page);
    await expect(page.locator(".play-board-col .play-player").first()).toContainText("Blocky");
    expect(await savedGames(page)).toHaveLength(0);

    // ?white=<engine>&black=human: the engine opens, the board is turned to Black.
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");
    await page.goto(`/#/play?white=${ids.Sprout}&black=human`);
    await waitYourMove(page);
    await expectPlies(page, 1);
    await expect(page.locator(".play-board-col .play-player").last()).toContainText("You");
    const board = await page.locator(GAME_BOARD).boundingBox();
    const a1 = await page.locator(`${GAME_BOARD} [data-square="a1"]`).boundingBox();
    expect(a1!.y).toBeLessThan(board!.y + board!.height / 2);

    // ?fen= with both players: the game starts from that position.
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    await page.goto(`/#/play?white=human&black=${ids.Classic}&fen=${encodeURIComponent(fen)}`);
    await waitYourMove(page);
    await expect(page.locator(`${GAME_BOARD} [data-piece]`)).toHaveCount(3);
    await clickMove(page, GAME_BOARD, "e2", "e4");
    await expectPlies(page, 2);
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await confirmDialog(page, "Abort game");

    // An invalid FEN: a problem callout, the game does not start.
    await page.getByRole("button", { name: "New game" }).click();
    await page.goto(`/#/play?engine=${ids.Classic}&fen=not-a-fen`);
    const problem = page.locator(".play-callout.warn");
    await expect(problem).toContainText("The position in the link is not a valid FEN");
    await expect(page.locator(".play-setup")).toBeVisible();
    await shot(page, "link-bad-fen");
    await problem.getByRole("button", { name: "Dismiss" }).click();
    await expect(problem).toHaveCount(0);

    // An unknown engine.
    await page.goto("/#/play?engine=does-not-exist");
    await expect(page.locator(".play-callout.warn")).toContainText("The engine in the link no longer exists");
    await expect(page.locator(".play-setup")).toBeVisible();
  });

  test("query parameters: ?analysis=&fen= and ?game=", async ({ page }) => {
    const ids = await openPlay(page);
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    await page.goto(`/#/play?analysis=${ids.Classic}&fen=${encodeURIComponent(fen)}`);
    await expect(page.getByRole("radio", { name: "Analysis" })).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveURL(/#\/play$/);
    const card = page.locator(".play-analysis .play-engine");
    await expect(card.locator(".play-engine-status")).toContainText("Analysing", { timeout: 60_000 });
    await expect(card.locator(".play-pv-num").first()).toHaveText("3.", { timeout: 30_000 });
    await expect(page.locator(`${ANALYSIS_BOARD} [data-square="c6"][data-piece="bN"]`)).toBeAttached();
    await page.getByRole("button", { name: "Stop", exact: true }).click();

    // A saved game opens for review; an unknown one explains itself.
    const gameId = await page.evaluate(async (classic) => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const id = s.newId();
      await s.gamesRepo.put({
        id,
        createdAt: Date.now(),
        white: { type: "human", name: "You" },
        black: { type: "engine", engineId: classic, name: "Classic" },
        startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
        san: ["f3", "e5", "g4", "Qh4#"],
        result: "0-1",
        termination: "checkmate",
        pgn: '[White "You"]\n[Black "Classic"]\n\n1. f3 e5 2. g4 Qh4# 0-1',
        matchId: null,
        opening: null,
        timeControl: { white: null, black: null },
        evals: [null, -30, null, -10000],
        times: [1000, 200, 1000, 200],
      } as never);
      return id;
    }, ids.Classic);
    await page.goto(`/#/play?game=${gameId}`);
    const review = page.locator(".play-review");
    await expect(review).toContainText("You vs Classic");
    await expect(review).toContainText("Checkmate");
    await expectPlies(page, 4);
    await expect(page.locator(".cb-ml-move--current")).toHaveText("Qh4#");
    // The human played White, so the board is not flipped; the result shows on the player bars.
    await expect(page.locator(".play-board-col .play-player-result--loss")).toBeVisible();
    await shot(page, "link-game-review");

    // Deleting it (after confirming) empties the list; the review closes but the moves stay.
    await page.getByRole("tab", { name: /Saved games/ }).click();
    await page.getByRole("button", { name: "Delete You vs Classic" }).click();
    await expect(page.getByRole("dialog")).toContainText("This cannot be undone.");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".play-gamerow")).toHaveCount(1);
    await page.getByRole("button", { name: "Delete You vs Classic" }).click();
    await confirmDialog(page, "Delete");
    await expect(page.locator(".play-games .empty-state")).toContainText("No saved games yet");
    expect(await savedGames(page)).toHaveLength(0);
    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect(page.locator(".play-review")).toHaveCount(0);
    await expectPlies(page, 4);

    await page.goto("/#/play?game=missing-game");
    await expect(page.locator(".play-callout.warn")).toContainText("The game in the link no longer exists.");
  });

  test("human vs human: promotion, takeback of one ply, agreed draw; New game asks before aborting", async ({ page }) => {
    const ids = await openPlay(page);
    await useSetup(page, {
      white: humanSide(),
      black: humanSide(),
      start: { kind: "fen", fen: "8/4P2p/8/8/8/8/k7/4K3 w - - 0 1" },
      sameClock: true,
    });
    await page.locator(".play-start-button").click();
    await expect(page.locator(".play-player-status", { hasText: "To move" })).toBeVisible();
    await expect(page.locator(".play-engine")).toHaveCount(0);

    // e7-e8 opens the promotion chooser; pick a knight.
    await clickMove(page, GAME_BOARD, "e7", "e8");
    await page.locator('[data-promotion="n"]').click();
    await expectPlies(page, 1);
    await expect(moveCells(page).first()).toHaveText("e8=N");
    await expect(page.locator(`${GAME_BOARD} [data-square="e8"][data-piece="wN"]`)).toBeAttached();
    // Takeback with two humans removes one ply.
    await page.getByRole("button", { name: "Takeback" }).click();
    await expectPlies(page, 0);
    await clickMove(page, GAME_BOARD, "e7", "e8");
    await page.locator('[data-promotion="q"]').click();
    await expect(moveCells(page).first()).toHaveText("e8=Q");
    await clickMove(page, GAME_BOARD, "a2", "b3");
    await expectPlies(page, 2);

    // New game during a game asks first; cancelling keeps it.
    await page.getByRole("button", { name: "New game" }).click();
    await expect(page.getByRole("dialog")).toContainText("Abort the current game?");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expectPlies(page, 2);

    // Draw by agreement.
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await confirmDialog(page, "Draw");
    await expect(page.locator(".play-result")).toContainText("Draw agreed.");
    await expect.poll(async () => (await savedGames(page)).map((g) => g.termination)).toEqual(["draw-agreed"]);
    const [g] = await savedGames(page);
    expect(g.startFen).toBe("8/4P2p/8/8/8/8/k7/4K3 w - - 0 1");
    expect(g.white).toMatchObject({ type: "human", name: "White player" });
    // Finished: "New game" goes straight to the form.
    await page.locator(".play-result").getByRole("button", { name: "New game" }).click();
    await expect(page.locator(".play-setup")).toBeVisible();
    void ids;
  });

  test("engine vs engine survives a reload: resume reloads the engines and the game continues", async ({ page }) => {
    const ids = await openPlay(page);
    await setSetting(page, "play.moveDelayMs", 300);
    await useSetup(page, {
      white: engineSide(ids.Classic, { nodes: 2000 }),
      black: engineSide(ids.Sprout, { nodes: 2000 }),
      start: { kind: "opening", name: "Italian Game", eco: "C50", moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"] },
      sameClock: true,
    });
    await page.locator(".play-start-button").click();
    await expect(page.locator(".play-moves-head")).toContainText("Book: Italian Game (C50)");
    await expect(moveCells(page).nth(8)).toBeVisible({ timeout: 60_000 });
    await page.reload();
    const resume = page.locator(".play-resume");
    await expect(resume).toContainText("The engines restart when you resume.");
    await expect(resume).not.toContainText("clocks");
    const before = await moveCells(page).count();
    expect(before).toBeGreaterThanOrEqual(9);
    await page.getByRole("button", { name: "Resume game" }).click();
    await expect(moveCells(page).nth(before + 1)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await confirmDialog(page, "Stop game");
    await expect(page.locator(".play-result")).toContainText("Game aborted");
    await expect.poll(async () => (await savedGames(page)).length).toBe(1);
    const [g] = await savedGames(page);
    expect(g.moves.slice(0, 5)).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]);
    expect(g.result).toBe("*");
  });

  test("layout: setup, game, analysis and saved games at 400 px and in the light theme", async ({ page }) => {
    const ids = await openPlay(page);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => localStorage.setItem("cb.theme", t), theme);
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto("/#/play");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".play-setup")).toBeVisible();
      await noHorizontalScroll(page);
      await shot(page, `narrow-setup-${theme}`);
      await page.locator(".app-main").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await shot(page, `narrow-setup-bottom-${theme}`);

      // A game at 400 px.
      await page.locator(".play-preset").first().click();
      await page.locator('.play-sidecard[data-side="b"]').getByLabel("Time per move").fill("0.2");
      await page.locator(".play-start-button").click();
      await waitYourMove(page);
      // The board scrolls back into view when the game starts (the button is far below it).
      await expect(page.locator(GAME_BOARD)).toBeInViewport();
      await clickMove(page, GAME_BOARD, "e2", "e4");
      await expectPlies(page, 2);
      await waitYourMove(page);
      await noHorizontalScroll(page);
      await shot(page, `narrow-game-${theme}`);
      await page.getByRole("button", { name: "Resign" }).click();
      await confirmDialog(page, "Resign");
      await expect(page.locator(".play-result")).toContainText("Saved to your games");
      await page.locator(".play-result").scrollIntoViewIfNeeded();
      await shot(page, `narrow-result-${theme}`);

      // Saved games.
      await page.getByRole("tab", { name: /Saved games/ }).click();
      await expect(page.locator(".play-gamerow").first()).toBeVisible();
      await noHorizontalScroll(page);
      await page.locator(".play-side").scrollIntoViewIfNeeded();
      await shot(page, `narrow-games-${theme}`);

      // Review: opening a game from the list brings its board into view.
      await page.locator(".play-gamerow-main").first().click();
      await expect(page.locator(".play-review")).toBeVisible();
      await expect(page.locator(ANALYSIS_BOARD)).toBeInViewport();
      await noHorizontalScroll(page);
      await page.locator(".play-review").scrollIntoViewIfNeeded();
      await shot(page, `narrow-review-${theme}`);

      // Wide, same theme.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("radio", { name: "Play" }).click();
      await page.locator(".play-result").getByRole("button", { name: "New game" }).click();
      await expect(page.locator(".play-setup")).toBeVisible();
      await shot(page, `wide-setup-${theme}`);
    }
    void ids;
  });
});
