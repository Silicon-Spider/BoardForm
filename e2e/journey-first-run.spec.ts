// Journey: a first-time visitor. What BoardForm shows on an empty profile, Help → Getting started
// followed literally, the app's name everywhere a user can see it, every page at phone to desktop
// widths in both themes, the keyboard, and the promise that engines are "saved even if the tab is
// closed and later reopened" — tested by closing the whole browser and relaunching it with the same
// profile, and by a backup → delete all data → restore round trip.
//
// Run: E2E_PORT=5245 npx playwright test e2e/journey-first-run.spec.ts --reporter=line
import { mkdir, readFile, rm } from "node:fs/promises";
import { chromium, expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type HostModule = typeof import("../src/engine-host/index");
type TrainingModule = typeof import("../src/training/index");
type ArenaModule = typeof import("../src/arena/index");

const LONG = 120_000;
const STARTERS = [
  { name: "Blocky", kind: "Blocks" },
  { name: "Classic", kind: "Eval code" },
  { name: "Sprout", kind: "Scratch" },
  { name: "Neuron", kind: "NNUE" },
] as const;
const STARTER_NETWORK_ID = "starter-network-hl128";
const STARTER_NETWORK_NAME = "Starter network (128 SCReLU)";
const OLD_NAME = /chess[\s-]?builder/i;

// ------------------------------------------------------------------------------------------------
// Helpers

/** Collects uncaught page errors and console errors (checked at the end of each test). */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cards = (page: Page): Locator => page.locator(".engines-card:not(.engines-card--skeleton)");
const card = (page: Page, name: string): Locator =>
  cards(page).filter({ has: page.locator(".engines-card-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
const toast = (page: Page, text: string | RegExp): Locator => page.locator(".toast").filter({ hasText: text });
const dialog = (page: Page): Locator => page.getByRole("dialog");
const workshopActions = (page: Page): Locator => page.locator(".workshop-header-actions");

/** Waits until the starter engines AND the starter network are in the database; returns name → id. */
async function waitForSeed(page: Page): Promise<Record<string, string>> {
  let ids: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        const out = await page.evaluate(async () => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          const engines = await s.enginesRepo.list();
          const nets = await s.networksRepo.list();
          return { ids: Object.fromEntries(engines.map((e) => [e.name, e.id])), builtin: engines.filter((e) => e.builtin).length, nets: nets.length };
        });
        ids = out.ids;
        return out.builtin >= 4 && out.nets >= 1;
      },
      { timeout: 90_000, message: "starter engines and the starter network are seeded" },
    )
    .toBe(true);
  return ids;
}

async function openApp(page: Page, hash = "#/engines"): Promise<Record<string, string>> {
  await page.goto("/" + hash);
  return waitForSeed(page);
}

/** No horizontal page scroll, and no element sticking out of the window on the right. */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const problems: string[] = [];
    const scroller = document.scrollingElement ?? document.documentElement;
    if (scroller.scrollWidth > vw + 1) problems.push(`page scrolls sideways (${scroller.scrollWidth} > ${vw})`);
    // An element is a problem when it reaches past the window and no ancestor clips or scrolls it.
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o !== "visible" && p.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      if (getComputedStyle(el).position === "fixed" || clipped(el)) continue;
      problems.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ends at ${Math.round(r.right)} px: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
      if (problems.length > 8) break;
    }
    return problems;
  });
}

/** Visible buttons, links and form fields without an accessible name. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
    };
    const nameOf = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (t) return t;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) {
        const t = [...labels].map((l) => l.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
        const t = (el.textContent ?? "").trim();
        if (t) return t;
        const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
        if (alt) return alt;
      }
      return el.getAttribute("title")?.trim() ?? "";
    };
    const out: string[] = [];
    const selector = "button, a[href], [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea";
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!visible(el) || el.closest(".blocklyWidgetDiv, .blocklySvg, .cm-editor")) continue;
      if (!nameOf(el)) out.push(el.outerHTML.slice(0, 140));
    }
    return out;
  });
}

/**
 * Changes a Blockly number field as a user would: scrolls the workspace (mouse wheel) until the field
 * is in view, clicks it and types. `after` is the text of a field shortly before it (e.g. "7th"),
 * null for the first matching field.
 */
async function editBlockNumber(page: Page, after: string | null, from: string, to: string): Promise<void> {
  const marked = await page.evaluate(
    ({ after, from }) => {
      document.querySelectorAll("[data-e2e-target]").forEach((el) => el.removeAttribute("data-e2e-target"));
      const fields = [...document.querySelectorAll(".blocklyEditableField")];
      const start = after === null ? -1 : fields.findIndex((f) => (f.textContent ?? "").trim() === after);
      const target = fields.slice(start + 1).find((f) => (f.textContent ?? "").trim() === from);
      if ((after !== null && start < 0) || !target) return false;
      target.setAttribute("data-e2e-target", "1");
      return true;
    },
    { after, from },
  );
  expect(marked, `a "${from}" field after "${after}"`).toBe(true);
  const field = page.locator('[data-e2e-target="1"]');
  const canvas = page.locator(".blocklySvg").first();
  for (let i = 0; i < 40; i++) {
    const f = await field.boundingBox();
    const c = await canvas.boundingBox();
    if (!f || !c) throw new Error("the blocks workspace is not visible");
    const middle = c.y + c.height / 2;
    if (f.y > c.y + 40 && f.y + f.height < c.y + c.height - 40) break;
    await page.mouse.move(c.x + c.width / 2, middle);
    await page.mouse.wheel(0, Math.max(-400, Math.min(400, f.y - middle)));
    await page.waitForTimeout(120);
  }
  await field.click();
  await expect(page.locator(".blocklyHtmlInput")).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(to);
  await page.keyboard.press("Enter");
}

async function storedEngine(page: Page, id: string) {
  return page.evaluate(async (engineId) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const e = await s.enginesRepo.get(engineId);
    return e ? { name: e.name, kind: e.kind, files: e.files ?? {}, networkId: e.networkId ?? null, built: !!e.build, blocks: JSON.stringify(e.blocks ?? null) } : null;
  }, id);
}

/** Builds an engine with buildEngine() and searches the start position to depth 3 in a worker. */
async function buildAndSearch(page: Page, id: string): Promise<{ ok: boolean; bestMove: string | null; errors: string[]; nnue: boolean | null }> {
  return page.evaluate(async (engineId) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
    const record = await s.enginesRepo.get(engineId);
    if (!record) return { ok: false, bestMove: null, errors: ["missing record"], nnue: null };
    if (record.kind !== "wasm") {
      const out = await h.buildEngine(record, { force: true });
      if (!out.ok) return { ok: false, bestMove: null, errors: (out.result?.diagnostics ?? []).slice(0, 3).map((d) => `${d.file}:${d.line} ${d.message}`), nnue: null };
    }
    const client = await h.loadEngine(engineId, { hashMb: 1 });
    try {
      await client.newGame();
      await client.position("startpos", []);
      const result = await client.go({ depth: 3 });
      // An NNUE engine's breakdown names its network term "NNUE" (or "Fallback (no network)").
      const trace = client.capabilities.trace ? await client.evalTrace() : null;
      const nnue = trace ? trace.some((t) => t.label === "NNUE") : null;
      return { ok: true, bestMove: result.bestMove, errors: [], nnue };
    } finally {
      client.terminate();
    }
  }, id);
}

/** Every user-visible piece of text on the page (including tooltips and form values). */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const titles = [...document.querySelectorAll("[title], [aria-label], [placeholder]")]
      .map((el) => [el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
      .join("\n");
    const values = [...document.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value).join("\n");
    return `${document.title}\n${document.body.innerText}\n${titles}\n${values}`;
  });
}

// ------------------------------------------------------------------------------------------------
// 1. First run

test("first run: the library says what BoardForm is, shows four starters and the starter network, and points the way in", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page).toHaveTitle(/BoardForm/);
  expect(await page.title()).not.toMatch(OLD_NAME);
  await expect(page.locator(".app-brand")).toContainText("BoardForm");
  await waitForSeed(page);

  // The library: a heading, what the app does, and the four starter engines with their kinds.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your engines");
  await expect(page.locator(".page-subtitle")).toContainText("WebAssembly");
  await expect(cards(page)).toHaveCount(4);
  for (const s of STARTERS) {
    await expect(card(page, s.name).locator(".cb-kind")).toHaveText(s.kind);
    await expect(card(page, s.name)).toContainText("Not built yet");
  }
  // Neuron names its network; the network is in the Lab.
  await expect(card(page, "Neuron")).toContainText(STARTER_NETWORK_NAME);

  // A welcome explains where to start and leads to Getting started.
  const welcome = page.locator(".engines-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("New to BoardForm?");
  await welcome.getByRole("link", { name: "Getting started" }).click();
  await expect(page).toHaveURL(/#\/help\/getting-started$/);
  const article = page.locator(".help-article");
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("Getting started");

  // Every starter the help names is in the library with the kind the help gives it.
  const helpRows = await article.locator("table").first().locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].slice(0, 2).map((td) => (td.textContent ?? "").trim())));
  expect(helpRows).toEqual(STARTERS.map((s) => [s.name, s.kind === "Eval code" ? "Eval code" : s.kind]));
  await expect(article).toContainText("5 million self-play positions");

  // The links in the article lead to real pages.
  await article.getByRole("link", { name: "NNUE Lab" }).first().click();
  await expect(page).toHaveURL(/#\/lab$/);
  // The Lab's first-run guide mentions the trained starter network and links to it.
  const guide = page.locator(".lab-guide");
  await expect(guide).toContainText("Don't want to start from zero?");
  await guide.getByRole("link", { name: STARTER_NETWORK_NAME }).click();
  await expect(page).toHaveURL(new RegExp(`#/lab/networks/${STARTER_NETWORK_ID}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(STARTER_NETWORK_NAME);
  await expect(page.locator(".lab-section, main").first()).toContainText("Trained on 5 million positions");
  await expect(page.locator(".lab-section, main").first()).toContainText("Neuron");

  // Neuron's Workshop shows the network without contradicting its description ("5 million positions").
  await page.goto("/#/engines/starter-engine-neuron");
  const details = page.locator(".workshop-network-details");
  await expect(details).toContainText("128 hidden");
  await expect(details).toContainText("positions seen in training");
  await expect(details).not.toContainText("trained on");

  // The welcome's "Duplicate Blocky" opens a copy in the Workshop, ready for the first change.
  await page.goto("/#/engines");
  await welcome.getByRole("button", { name: "Duplicate Blocky" }).click();
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Engine name")).toHaveValue("Blocky (copy)");
  await expect(toast(page, "Created “Blocky (copy)”")).toBeVisible();
  await expect(page.locator(".blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });

  // Closing the welcome is remembered.
  await page.goto("/#/engines");
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Close the welcome" }).click();
  await expect(welcome).toHaveCount(0);
  await page.reload();
  await expect(cards(page)).toHaveCount(5);
  await page.waitForTimeout(500);
  await expect(welcome).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 2. Getting started, followed literally

test("Getting started, literally: duplicate Blocky, change the 7th-rank bonus, build, play it against the original, then a match", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  const ids = await openApp(page);
  await expect(cards(page)).toHaveCount(4);

  // "Before you experiment, Duplicate the engine you start from" — the card's ⋯ menu.
  await card(page, "Blocky").getByRole("button", { name: "More actions for Blocky" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(toast(page, "Created “Blocky (copy)”")).toBeVisible();
  await expect(card(page, "Blocky (copy)")).toBeVisible();
  await card(page, "Blocky (copy)").getByRole("link", { name: /Open/ }).click();
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}$/);
  const copyId = decodeURIComponent(page.url().split("/").pop()!);
  await expect(page.getByLabel("Engine name")).toHaveValue("Blocky (copy)");
  await expect(page.locator(".blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });

  // "Change a bonus": the pawn-on-the-7th-rank bonus, 10 → 40 points. It autosaves.
  await editBlockNumber(page, "7th", "10", "40");
  await expect.poll(async () => (await storedEngine(page, copyId))?.files["eval.ts"] ?? "", { timeout: 15_000 }).toMatch(/pawn_on_our_7th_rank[\s\S]*?mg \+= 40;/);
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/);
  // The original is untouched.
  expect((await storedEngine(page, ids.Blocky))?.files["eval.ts"]).toMatch(/pawn_on_our_7th_rank[\s\S]*?mg \+= 10;/);

  // "Build (Ctrl+B)".
  await page.locator(".workshop-main").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Control+B");
  await expect(toast(page, /Build succeeded/)).toBeVisible({ timeout: LONG });

  // "Evaluate shows the static evaluation and its breakdown term by term": a pawn on a7 earns 40.
  await page.locator(".workshop-side-tabs .tab, .workshop-stack-tabs .tab", { hasText: "Test" }).first().click();
  const fen = page.getByLabel("Position (FEN)");
  await fen.fill("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  await fen.press("Enter");
  const tool = page.locator(".workshop-tool-body > div:not([hidden])");
  await page.locator(".workshop-tool-tabs .tab", { hasText: "Evaluate" }).first().click();
  await tool.getByRole("button", { name: "Evaluate", exact: true }).click();
  const row = tool.locator(".workshop-trace tbody tr", { hasText: "Pawn on our 7th rank" });
  await expect(row).toBeVisible({ timeout: LONG });
  await expect(row.locator("td").nth(1)).toHaveText("40");

  // "Play": the copy against the original, engine against engine, at depth 2 with no move delay.
  await page.locator(".app-nav-link", { hasText: "Play" }).click();
  await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
  for (const side of ["w", "b"] as const) {
    const sideCard = page.locator(`.play-sidecard[data-side="${side}"]`);
    await sideCard.getByLabel("Time per move").fill("");
    await sideCard.getByLabel("Depth").fill("2");
  }
  await page.getByRole("button", { name: "White player" }).click();
  await page.getByRole("option", { name: /Blocky \(copy\)/ }).click();
  await page.getByRole("button", { name: "Black player" }).click();
  await page.getByRole("option", { name: /^Blocky\b(?! \(copy\))/ }).click();
  await expect(page.getByRole("button", { name: "White player" })).toContainText("Blocky (copy)");
  await expect(page.getByRole("button", { name: "Black player" })).not.toContainText("(copy)");
  await page.getByLabel("Move delay in milliseconds").focus();
  await page.keyboard.press("Home");
  await page.locator(".play-start-button").click();
  const banner = page.locator(".play-result");
  await expect(banner).toBeVisible({ timeout: 150_000 });
  await expect(banner).toContainText("Saved to your games");

  // The saved game: its PGN download is named after the players and says BoardForm.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PGN" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pgn$/);
  expect(download.suggestedFilename()).not.toMatch(OLD_NAME);
  const pgn = await readFile(await download.path(), "utf8");
  expect(pgn).toContain('[Site "BoardForm"]');
  expect(pgn).toContain('[White "Blocky (copy)"]');
  expect(pgn).toContain('[Black "Blocky"]');
  await testInfo.attach("game.pgn", { body: pgn, contentType: "text/plain" });
  await page.getByRole("tab", { name: /Saved games/ }).click();
  await expect(page.locator(".play-gamerow").first()).toContainText("Blocky (copy) vs Blocky");

  // "Match": the Workshop's Match button opens the new-match form with the copy; add the original.
  await page.goto(`/#/engines/${copyId}`);
  await workshopActions(page).getByRole("link", { name: "Match" }).click();
  const form = page.locator(".arena-dialog");
  await expect(form).toBeVisible();
  await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Blocky (copy)");
  await page.getByRole("button", { name: "Engine 2", exact: true }).click();
  await page.getByRole("option", { name: /^Blocky\b(?! \(copy\))/ }).click();
  await expect(page.getByRole("button", { name: "Engine 2", exact: true })).not.toContainText("(copy)");
  await form.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
  const depthCap = form.locator(".arena-form-shared .cb-limits-cap", { hasText: "Depth" });
  await depthCap.locator('input[type="checkbox"]').check();
  await depthCap.locator("input.input").fill("2");
  await page.getByLabel("Games per pairing").fill("2");
  await page.getByTestId("arena-form-start").click();
  await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
  const standings = page.getByTestId("arena-standings");
  await expect(standings).toContainText("Blocky (copy)");
  await expect(page.getByTestId("arena-result-row")).toHaveCount(2);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 3. Saved even when the browser is closed

/** Creates an engine with the new-engine wizard ("approach" = the card title in step 1). */
async function createWithWizard(page: Page, approach: string, name: string, step2?: () => Promise<void>): Promise<string> {
  await page.goto("/#/engines");
  await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
  await page.locator(".engines-header-actions").getByRole("button", { name: "New engine" }).click();
  await page
    .locator(".engines-approach")
    .filter({ has: page.locator(".engines-approach-title", { hasText: new RegExp(`^${escapeRe(approach)}$`) }) })
    .click();
  await expect(dialog(page)).toContainText("Step 2 of 2");
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (step2) await step2();
  const create = dialog(page).getByRole("button", { name: "Create engine" });
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
  return decodeURIComponent(page.url().split("/").pop()!);
}

/** Types at the end of the Workshop's code editor and waits for the autosave. */
async function typeInEditor(page: Page, text: string): Promise<void> {
  const content = page.locator(".workshop-main .cm-content").first();
  await expect(content).toBeVisible({ timeout: 30_000 });
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape");
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/, { timeout: 15_000 });
}

/** Everything the user made, as stored (for comparing before and after a restart / restore). */
async function inventory(page: Page) {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const [engines, networks, datasets, games, matches] = await Promise.all([s.enginesRepo.list(), s.networksRepo.list(), s.datasetsRepo.list(), s.gamesRepo.list(), s.matchesRepo.list()]);
    const chunks = await Promise.all(datasets.map((d) => s.datasetsRepo.chunkCount(d.id)));
    const netData = await Promise.all(networks.map(async (n) => (await s.networksRepo.getData(n.id))?.quantized.byteLength ?? 0));
    return {
      engines: engines
        .map((e) => ({ id: e.id, name: e.name, kind: e.kind, networkId: e.networkId ?? null, files: JSON.stringify(e.files ?? null), blocks: JSON.stringify(e.blocks ?? null), wasm: e.wasm?.byteLength ?? 0, description: e.description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      networks: networks.map((n, i) => ({ id: n.id, name: n.name, hidden: n.hidden, bytes: netData[i] })).sort((a, b) => a.name.localeCompare(b.name)),
      datasets: datasets.map((d, i) => ({ id: d.id, name: d.name, positions: d.positions, chunks: chunks[i] })).sort((a, b) => a.name.localeCompare(b.name)),
      games: games.map((g) => ({ id: g.id, white: g.white.name, black: g.black.name, plies: g.moves.length, result: g.result, matchId: g.matchId ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
      matches: matches.map((m) => ({ id: m.id, name: m.config.name, status: m.status, results: m.results.length })),
    };
  });
}

test("everything is still there after closing the browser: engines of every kind, a network, a dataset, a game and a match", async ({ baseURL }, testInfo) => {
  test.setTimeout(300_000);
  const profile = ".scratch/journey-first-run/profile";
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const launch = () => chromium.launchPersistentContext(profile, { baseURL, viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  // --- Session 1: make one of everything. ---
  let context: BrowserContext = await launch();
  let page = context.pages()[0] ?? (await context.newPage());
  let errors = trackErrors(page);
  const ids = await openApp(page);

  // A network to train with, and a dataset of self-play games.
  const netId = await page.evaluate(async () => {
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    return t.networks.createRandom({ name: "Persist net", hidden: 16, activation: 1, seed: 7 });
  });
  const datasetId = await page.evaluate(async (classicId) => {
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    return t.datasets.generate({
      name: "Persist data",
      selfPlay: { engineId: classicId, limits: { depth: 1 }, randomPlies: 4, games: 4, concurrency: 1, maxPlies: 60, skipPlies: 0 },
    });
  }, ids.Classic);

  // Engines of every kind through the wizard, each edited in the Workshop.
  const blocksId = await createWithWizard(page, "Blocks", "Persist blocks");
  await expect(page.locator(".blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });
  await editBlockNumber(page, null, "82", "95");
  await expect.poll(async () => (await storedEngine(page, blocksId))?.blocks ?? "", { timeout: 15_000 }).toMatch(/"MG_P":"?95"?/);
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/);

  const evalId = await createWithWizard(page, "Evaluation code", "Persist eval");
  await typeInEditor(page, "\n// persisted edit: eval\n");

  const fullId = await createWithWizard(page, "Full engine code", "Persist full");
  const nameField = page.getByLabel("Engine name");
  await nameField.fill("Persist full (renamed)");
  await nameField.press("Enter");
  await expect.poll(async () => (await storedEngine(page, fullId))?.name).toBe("Persist full (renamed)");

  const scratchId = await createWithWizard(page, "From scratch", "Persist scratch");
  await typeInEditor(page, "\n// persisted edit: scratch\n");

  const nnueId = await createWithWizard(page, "NNUE", "Persist nnue", async () => {
    await dialog(page).locator(".engines-option", { hasText: "Persist net" }).click();
  });
  expect((await storedEngine(page, nnueId))?.networkId).toBe(netId);

  const wasmBytes = await page.evaluate(async (sproutId) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
    const out = await h.buildEngine((await s.enginesRepo.get(sproutId))!);
    return Array.from(new Uint8Array(out.engine.build!.wasm));
  }, ids.Sprout);
  const wasmId = await createWithWizard(page, "Upload .wasm", "Persist wasm", async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog(page).getByRole("button", { name: "Choose file…" }).click()]);
    await chooser.setFiles({ name: "sprout.wasm", mimeType: "application/wasm", buffer: Buffer.from(wasmBytes) });
  });

  // A saved game (Play, engine vs engine at depth 1) and a finished Arena match.
  await page.goto("/#/play");
  await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
  for (const side of ["w", "b"] as const) {
    const sideCard = page.locator(`.play-sidecard[data-side="${side}"]`);
    await sideCard.getByLabel("Time per move").fill("");
    await sideCard.getByLabel("Depth").fill("1");
  }
  await page.getByLabel("Move delay in milliseconds").focus();
  await page.keyboard.press("Home");
  await page.locator(".play-start-button").click();
  await expect(page.locator(".play-result")).toContainText("Saved to your games", { timeout: 150_000 });
  const matchId = await page.evaluate(
    async ({ a, b }) => {
      const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
      const cfg = m.defaultMatchConfig({ engineIds: [a, b], hashMb: 16, maxWorkers: 2 });
      cfg.name = "Persist match";
      cfg.gamesPerPairing = 2;
      cfg.concurrency = 1;
      cfg.participants = cfg.participants.map((p) => ({ ...p, limits: { depth: 2 }, timeControl: null }));
      cfg.adjudication = { ...cfg.adjudication, maxPlies: 80 };
      return m.arena.createMatch(cfg, { start: true });
    },
    { a: scratchId, b: ids.Classic },
  );
  await page.goto(`/#/arena/${matchId}`);
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });

  // The dataset has finished its games; the colour theme is switched to light in Settings.
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          return !t.datasets.isGenerating(id) && ((await s.datasetsRepo.get(id))?.games ?? 0) >= 4;
        }, datasetId),
      { timeout: 120_000, message: "the dataset generation finishes" },
    )
    .toBe(true);
  await page.goto("/#/settings?section=appearance");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const before = await inventory(page);
  expect(before.engines.map((e) => e.name)).toEqual(
    ["Blocky", "Classic", "Neuron", "Persist blocks", "Persist eval", "Persist full (renamed)", "Persist nnue", "Persist scratch", "Persist wasm", "Sprout"].sort((a, b) => a.localeCompare(b)),
  );
  expect(before.games.filter((g) => g.matchId === null)).toHaveLength(1);
  expect(before.games.filter((g) => g.matchId === matchId)).toHaveLength(2);
  expect(before.datasets[0]).toMatchObject({ name: "Persist data" });
  expect(before.datasets[0].positions).toBeGreaterThan(0);
  await testInfo.attach("inventory-before.json", { body: JSON.stringify(before, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);

  // --- Close the browser completely, then start it again with the same profile. ---
  await context.close();
  context = await launch();
  page = context.pages()[0] ?? (await context.newPage());
  errors = trackErrors(page);
  await page.goto("/#/engines");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(cards(page)).toHaveCount(10, { timeout: 60_000 });
  const after = await inventory(page);
  expect(after).toEqual(before);
  // The edits are there.
  expect((await storedEngine(page, blocksId))?.blocks).toMatch(/"MG_P":"?95"?/);
  expect((await storedEngine(page, evalId))?.files["eval.ts"]).toContain("// persisted edit: eval");
  expect((await storedEngine(page, scratchId))?.files["main.ts"]).toContain("// persisted edit: scratch");
  await expect(card(page, "Persist full (renamed)")).toBeVisible();
  await expect(card(page, "Persist nnue")).toContainText("Persist net");

  // Every engine still builds and plays; the NNUE engine plays with its network.
  for (const id of [blocksId, evalId, fullId, scratchId, nnueId, wasmId]) {
    const r = await buildAndSearch(page, id);
    expect(r.ok, `${id}: ${r.errors.join("\n")}`).toBe(true);
    expect(r.bestMove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    if (id === nnueId) expect(r.nnue).toBe(true);
  }

  // The saved game opens in Play.
  const game = after.games.find((g) => g.matchId === null)!;
  await page.goto(`/#/play?game=${game.id}`);
  const review = page.locator(".play-review");
  await expect(review).toContainText(`${game.white} vs ${game.black}`, { timeout: 30_000 });
  await expect(page.locator(".play-movelist .cb-ml-move:not(.cb-ml-move--empty)")).toHaveCount(game.plies);

  // The match shows its results.
  await page.goto(`/#/arena/${matchId}`);
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished");
  await expect(page.getByTestId("arena-standings")).toContainText("Persist scratch");
  await expect(page.getByTestId("arena-result-row")).toHaveCount(2);

  // The Lab lists the network and the dataset.
  await page.goto("/#/lab/networks");
  await expect(page.locator(".lab-section").first()).toContainText("Persist net");
  await page.goto(`/#/lab/datasets/${datasetId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Persist data");
  expect(errors).toEqual([]);
  await context.close();
});

// ------------------------------------------------------------------------------------------------
// 4. Backup → delete all data → restore, with networks and datasets

test("backup with datasets, delete all data, restore: networks, datasets and engines come back and the NNUE engine plays with its network", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await openApp(page);

  // A network, an engine that uses it, and an imported dataset.
  const made = await page.evaluate(async () => {
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    const netId = await t.networks.createRandom({ name: "Backup net", hidden: 16, activation: 0, seed: 11 });
    const engineId = await t.networks.createEngine(netId, { name: "Backup nnue" });
    const lines = [
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 | 20 | 0.5",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1 | 35 | 1.0",
      "4k3/8/8/8/8/8/8/4K2R w K - 0 1 | 500 | 1.0",
    ];
    const datasetId = await t.datasets.importFile(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }), { name: "Backup data" });
    return { netId, engineId, datasetId };
  });
  const before = await inventory(page);
  expect(before.networks.map((n) => n.name)).toEqual(["Backup net", STARTER_NETWORK_NAME]);
  expect(before.datasets).toEqual([{ id: made.datasetId, name: "Backup data", positions: 3, chunks: 1 }]);

  // Export a backup with the datasets ticked.
  await page.goto("/#/settings?section=storage");
  await page.getByLabel(/Include datasets/).check();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^boardform-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backupPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(backupPath);
  await expect(toast(page, "Backup saved")).toBeVisible();
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as { format: string; stores: Record<string, unknown[]> };
  expect(backup.format).toBe("boardform-backup");
  expect(JSON.stringify(backup).match(OLD_NAME)).toBeNull();
  expect(backup.stores.networks).toHaveLength(2);
  expect(backup.stores.datasets).toHaveLength(1);
  expect(backup.stores.datasetChunks).toHaveLength(1);

  // Delete all data (confirmed by typing DELETE): only fresh starters are left.
  await page.getByRole("button", { name: "Delete all data…" }).click();
  await dialog(page).getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog(page).getByRole("button", { name: "Delete everything" }).click();
  await expect(toast(page, "All data deleted")).toBeVisible({ timeout: 30_000 });
  await waitForSeed(page);
  const wiped = await inventory(page);
  expect(wiped.engines.map((e) => e.name)).toEqual(["Blocky", "Classic", "Neuron", "Sprout"]);
  expect(wiped.datasets).toEqual([]);
  expect(wiped.networks.map((n) => n.name)).toEqual([STARTER_NETWORK_NAME]);

  // Restore it.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import backup…" }).click()]);
  await chooser.setFiles(backupPath);
  await expect(dialog(page)).toContainText("Restore this backup?");
  await dialog(page).getByRole("button", { name: "Restore backup" }).click();
  await expect(toast(page, "Backup restored")).toBeVisible({ timeout: 60_000 });
  const result = page.locator(".settings-import-result");
  await expect(result).toContainText("2 networks");
  await expect(result).toContainText("1 dataset");
  // Starters seeded after the wipe are offered for removal (Neuron has a fixed id: it was replaced).
  await result.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(toast(page, /Removed 3 duplicate starter engines/)).toBeVisible();

  const restored = await inventory(page);
  expect(restored.networks).toEqual(before.networks);
  expect(restored.datasets).toEqual(before.datasets);
  expect(restored.engines.map((e) => e.id).sort()).toEqual(before.engines.map((e) => e.id).sort());

  // The restored NNUE engines play with their networks; the dataset's positions are readable.
  for (const id of [made.engineId, "starter-engine-neuron"]) {
    const r = await buildAndSearch(page, id);
    expect(r.ok, r.errors.join("\n")).toBe(true);
    expect(r.nnue, `${id} evaluates with its network`).toBe(true);
  }
  const samples = await page.evaluate(async (id) => {
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    return t.datasets.samplePositions(id, 3);
  }, made.datasetId);
  expect(samples).toHaveLength(3);
  await page.goto(`/#/lab/datasets/${made.datasetId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Backup data");
  await page.goto("/#/engines");
  await expect(card(page, "Backup nnue")).toContainText("Backup net");
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 5. Every page, every width, both themes; names and jargon

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const JARGON = /\bWP-[A-Z]|\barchitect\b|starter-(engine|network)-|seeded\.(network\.)?v1/i;

test("every page fits 320–1440 px in dark and light, its controls have names, and nothing shows the old name or internal jargon", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  const ids = await openApp(page);
  // `code`: the page shows engine source, where the engine ABI's cb_* names belong.
  const routes: Array<{ hash: string; code?: boolean }> = [
    { hash: "#/engines" },
    { hash: "#/engines?new=1" },
    { hash: `#/engines/${ids.Blocky}`, code: true },
    { hash: `#/engines/${ids.Classic}`, code: true },
    { hash: `#/engines/${ids.Sprout}`, code: true },
    { hash: `#/engines/${ids.Neuron}`, code: true },
    { hash: "#/play" },
    { hash: "#/play?analysis=" + ids.Classic },
    { hash: "#/arena" },
    { hash: "#/arena?new=1" },
    { hash: "#/lab" },
    { hash: "#/lab/runs" },
    { hash: "#/lab/networks" },
    { hash: `#/lab/networks/${STARTER_NETWORK_ID}` },
    { hash: "#/lab/datasets" },
    { hash: "#/lab/new" },
    { hash: "#/settings" },
    { hash: "#/help" },
    ...["getting-started", "blocks", "eval-api", "full-engine", "scratch", "abi", "nnue", "play-and-arena", "limits", "storage"].map((t) => ({
      hash: `#/help/${t}`,
      code: true, // the help documents the engine ABI and API (cb_now, cb_go, ...)
    })),
  ];
  const problems: string[] = [];
  for (const r of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/" + r.hash);
    await expect(page.locator("h1, .workshop-header").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(r.code && r.hash.startsWith("#/engines/") ? 2500 : 700);

    const text = await visibleText(page);
    if (OLD_NAME.test(text)) problems.push(`${r.hash}: shows the old name "${text.match(OLD_NAME)?.[0]}"`);
    if (JARGON.test(text)) problems.push(`${r.hash}: internal jargon "${text.match(JARGON)?.[0]}"`);
    if (UUID.test(text)) problems.push(`${r.hash}: shows a raw id ${text.match(UUID)?.[0]}`);
    if (!r.code && /\bcb_[a-z]/.test(text)) problems.push(`${r.hash}: mentions ${text.match(/\bcb_[a-z_]+/)?.[0]} outside the engine docs`);
    for (const c of await unnamedControls(page)) problems.push(`${r.hash}: control without a name: ${c}`);

    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      for (const width of [1440, 768, 400, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        for (const p of await horizontalOverflow(page)) problems.push(`${r.hash} at ${width} px (${theme}): ${p}`);
      }
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  }
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 6. Keyboard only

/** The focused element has a visible focus indicator (outline, ring or one drawn by its container). */
async function focusIsVisible(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "nothing has focus";
    const ringOf = (e: Element) => {
      const cs = getComputedStyle(e);
      return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== "");
    };
    // A card link draws its ring on the card (:has(:focus-visible)); a splitter on ::after.
    const after = getComputedStyle(el, "::after");
    const drawnAfter = after.content !== "none" && ((after.outlineStyle !== "none" && parseFloat(after.outlineWidth) > 0) || after.boxShadow !== "none");
    if (ringOf(el) || drawnAfter || (el.parentElement && ringOf(el.closest(".engines-card") ?? el))) return null;
    return `no focus indicator on ${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`;
  });
}

test("keyboard only: tab order with visible focus, / to search, Enter opens, Escape closes dialogs and menus and gives focus back", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await openApp(page);
  await expect(cards(page)).toHaveCount(4);

  // Tab from the top: "Skip to content", then the header; every stop shows where the focus is.
  await page.locator("body").press("Tab");
  const skip = page.getByRole("button", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  expect(await focusIsVisible(page)).toBeNull();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("header"))).toBe(true);
  const stops: string[] = [];
  for (let i = 0; i < 24; i++) {
    const problem = await focusIsVisible(page);
    if (problem) stops.push(problem);
    await page.keyboard.press("Tab");
  }
  expect(stops).toEqual([]);
  // The skip link jumps past the header: the next stop is on the page itself.
  await page.reload();
  await expect(cards(page)).toHaveCount(4);
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => {
    const el = document.activeElement;
    return `${el?.tagName.toLowerCase()} "${(el?.textContent ?? "").trim().slice(0, 30)}" in main: ${!!el?.closest("main")}`;
  });
  expect(next).toMatch(/in main: true$/);

  // "/" focuses the search; Escape clears it.
  await page.locator("body").click({ position: { x: 5, y: 880 } });
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search engines" });
  await expect(search).toBeFocused();
  await page.keyboard.type("neuron");
  await expect(cards(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(cards(page)).toHaveCount(4);

  // Enter on "New engine" opens the wizard with the focus inside; Escape closes it and returns focus.
  const newEngine = page.locator(".engines-header-actions").getByRole("button", { name: "New engine" });
  await newEngine.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(newEngine).toBeFocused();

  // A card's menu: Enter opens it on the first item, arrows move, Escape closes it.
  const more = card(page, "Classic").getByRole("button", { name: "More actions for Classic" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();

  // Enter on a card opens the engine in the Workshop; Ctrl+B builds it.
  await card(page, "Sprout").locator(".engines-card-link").focus();
  expect(await focusIsVisible(page)).toBeNull();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}$/);
  await expect(page.locator(".workshop-header")).toBeVisible();
  await page.getByLabel("Engine name").focus();
  await page.keyboard.press("Control+B");
  await expect(toast(page, /Build succeeded/)).toBeVisible({ timeout: LONG });

  // The Arena's new-match form and Settings' delete-all confirmation close on Escape.
  await page.goto("/#/arena");
  const newMatch = page.getByTestId("arena-new");
  await newMatch.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.goto("/#/settings?section=danger");
  const deleteAll = page.getByRole("button", { name: "Delete all data…" });
  await deleteAll.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(deleteAll).toBeFocused();
  expect((await inventory(page)).engines).toHaveLength(4);

  // Help: "/" focuses the help search.
  await page.goto("/#/help");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 880 } });
  await page.keyboard.press("/");
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type)).toBe("search");
  await page.keyboard.type("perft");
  await expect(page.locator(".help-sidebar, .help-search, main").first()).toContainText(/perft/i);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// 7. Exported files

test("exported engines, networks and match PGNs carry the new name and import again", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  const ids = await openApp(page);

  // An engine file from the library card's menu: named after the engine, written as a BoardForm file.
  await card(page, "Neuron").getByRole("button", { name: "More actions for Neuron" }).click();
  const [engineFile] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export" }).click()]);
  expect(engineFile.suggestedFilename()).toBe("neuron.engine.json");
  const engineJson = await readFile(await engineFile.path(), "utf8");
  expect((JSON.parse(engineJson) as { format: string }).format).toBe("boardform-engine");
  expect(engineJson).not.toMatch(OLD_NAME);
  // ... and it imports as a new engine that still plays with the bundled network.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import engine" }).click()]);
  await chooser.setFiles(await engineFile.path());
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const importedId = decodeURIComponent(page.url().split("/").pop()!);
  await expect(toast(page, /Imported “Neuron/)).toBeVisible();
  const played = await buildAndSearch(page, importedId);
  expect(played.ok, played.errors.join("\n")).toBe(true);
  expect(played.nnue).toBe(true);

  // The starter network as an .nnue file from the Lab.
  await page.goto(`/#/lab/networks/${STARTER_NETWORK_ID}`);
  await page.getByRole("button", { name: "More network actions" }).click();
  const [netFile] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export .nnue" }).click()]);
  expect(netFile.suggestedFilename()).toMatch(/^starter-network.*\.nnue$/);
  expect((await readFile(await netFile.path())).byteLength).toBe(197_444);

  // A match's PGN: Site "BoardForm".
  const matchId = await page.evaluate(
    async ({ a, b }) => {
      const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
      const cfg = m.defaultMatchConfig({ engineIds: [a, b], hashMb: 16, maxWorkers: 2 });
      cfg.name = "Naming match";
      cfg.gamesPerPairing = 1;
      cfg.concurrency = 1;
      cfg.participants = cfg.participants.map((p) => ({ ...p, limits: { depth: 1 }, timeControl: null }));
      cfg.adjudication = { ...cfg.adjudication, maxPlies: 40 };
      return m.arena.createMatch(cfg, { start: true });
    },
    { a: ids.Sprout, b: ids.Classic },
  );
  await page.goto(`/#/arena/${matchId}`);
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 120_000 });
  const [pgnFile] = await Promise.all([page.waitForEvent("download"), page.getByTestId("arena-export").click()]);
  expect(pgnFile.suggestedFilename()).toBe("naming-match.pgn");
  const pgn = await readFile(await pgnFile.path(), "utf8");
  expect(pgn).toContain('[Site "BoardForm"]');
  expect(pgn).not.toMatch(OLD_NAME);
  expect(errors).toEqual([]);
});
