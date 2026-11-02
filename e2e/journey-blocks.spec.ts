// User journey: the headline example of BoardForm, done the way a new user would do it.
//
//   "Create an HCE engine by dragging and dropping blocks, for example increase eval by 1 if any
//    pawn is on the 7th rank, with things they can change, e.g. the pawn or the 7th rank."
//
// Every block is placed with real mouse drags (pointer down on the toolbox flyout, move, release
// over the Evaluation block or a slot) — never by writing workspace JSON. The tests then build the
// engine, read the evaluation breakdown (value, sign, colour mirroring, relative ranks, units),
// change the piece and the rank with the block's dropdowns, try undo / redo, deleting, broken and
// empty configurations, reloading, the 400 px layout, a game against the engine on the Play page
// and an Arena match against Blocky.
//
// Run: E2E_PORT=5241 npx playwright test e2e/journey-blocks.spec.ts --reporter=line
// Set E2E_SHOTS=<dir> to also save screenshots of the states the journey passes through.
//
// Each test gets a fresh browser context (empty IndexedDB): the app seeds the four starter engines
// (Blocky, Classic, Sprout, Neuron) and the starter network on load. Engine searches use node
// limits so the results do not depend on the machine's load.
import { expect, test as base, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); String()
// stops tsc from resolving the URL and the cast gives the module its real type.
type StorageModule = typeof import("../src/storage/index");
type PreferencesModule = typeof import("../src/app/preferences");

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

// --- general helpers -------------------------------------------------------------------------

const SHOTS = process.env.E2E_SHOTS ?? "";
const LONG = 150_000;
const STARTERS = ["Blocky", "Classic", "Sprout", "Neuron"];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate(async (t) => {
    const p = (await import(String("/src/app/preferences.ts"))) as PreferencesModule;
    p.setThemePreference(t);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cards = (page: Page) => page.locator(".engines-card:not(.engines-card--skeleton)");
const card = (page: Page, name: string) =>
  cards(page).filter({ has: page.locator(".engines-card-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
const header = (page: Page) => page.locator(".workshop-header");
const buildPill = (page: Page) => page.locator(".workshop-header-status .workshop-pill");
const blocksPill = (page: Page) => page.locator(".blocks-editor-pill");
const visibleTool = (page: Page) => page.locator(".workshop-tool-body > div:not([hidden])");

/** Opens the library and waits until the starter engines are seeded and shown. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto("/#/engines");
  for (const name of STARTERS) await expect(card(page, name)).toBeVisible({ timeout: 60_000 });
}

/** The id of the engine the Workshop shows. */
function engineIdFromUrl(page: Page): string {
  const m = /#\/engines\/([^?/]+)/.exec(page.url());
  if (!m) throw new Error(`not a Workshop URL: ${page.url()}`);
  return decodeURIComponent(m[1]);
}

/** Library → New engine → Blocks → name → Create: returns the new engine's id (Workshop open). */
async function createBlocksEngine(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New engine" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Step 1 of 2");
  await page.locator(".engines-approach").filter({ has: page.locator(".engines-approach-title", { hasText: /^Blocks$/ }) }).click();
  await expect(dialog).toContainText("Step 2 of 2");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create engine" }).click();
  await expect(page).toHaveURL(/#\/engines\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await waitForBlockly(page);
  return engineIdFromUrl(page);
}

async function waitForBlockly(page: Page): Promise<void> {
  await expect(header(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("svg.blocklySvg .blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });
  await expect(blocksPill(page)).toBeVisible();
}

/** Clicks Build and waits for the outcome; returns the build pill's text. */
async function build(page: Page): Promise<string> {
  const button = header(page).getByRole("button", { name: /^(Build|Building…)$/ });
  await expect(button).toBeEnabled({ timeout: LONG });
  await button.click();
  await expect(page.locator(".toast", { hasText: /Build succeeded|Build failed|cannot be built/ }).last()).toBeVisible({ timeout: LONG });
  await expect(buildPill(page)).toHaveText(/Up to date|error|Build failed|Can't build|Not a working engine/, { timeout: LONG });
  return (await buildPill(page).textContent()) ?? "";
}

// --- the stored engine (what autosave wrote to IndexedDB) ------------------------------------

/** A block of the stored workspace, reduced to its type, fields and connected inputs. */
interface Brief {
  type: string;
  id: string;
  fields: Record<string, unknown>;
  inputs: Record<string, Brief | null>;
}

interface StoredBlocks {
  /** Types of the top-level blocks (only the Evaluation block when everything is connected). */
  tops: string[];
  /** Term names inside the Evaluation block, in order. */
  terms: string[];
  /** The first term, in full. */
  first: Brief | null;
  code: string;
}

async function storedBlocks(page: Page, engineId: string): Promise<StoredBlocks> {
  return page.evaluate(async (id) => {
    type Raw = { type: string; id: string; fields?: Record<string, unknown>; inputs?: Record<string, { block?: Raw; shadow?: Raw }>; next?: { block?: Raw } };
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const engine = await s.enginesRepo.get(id);
    const ws = engine?.blocks as { blocks?: { blocks?: Raw[] } } | undefined;
    const tops = ws?.blocks?.blocks ?? [];
    const brief = (b: Raw | undefined): { type: string; id: string; fields: Record<string, unknown>; inputs: Record<string, unknown> } | null =>
      b ? { type: b.type, id: b.id, fields: b.fields ?? {}, inputs: Object.fromEntries(Object.entries(b.inputs ?? {}).map(([k, v]) => [k, brief(v.block ?? v.shadow)])) } : null;
    const evaluation = tops.find((b) => b.type === "cb_evaluation");
    const terms: string[] = [];
    for (let t = evaluation?.inputs?.TERMS?.block; t; t = t.next?.block) terms.push(String(t.fields?.NAME ?? ""));
    return { tops: tops.map((b) => b.type), terms, first: brief(evaluation?.inputs?.TERMS?.block), code: engine?.files?.["eval.ts"] ?? "" } as StoredBlocks;
  }, engineId);
}

/** "if (any of [side] [piece] on [whose] [rank] rank) do add [n] points" read from a stored term. */
function describeTerm(term: Brief | null): string {
  const cond = term?.inputs.DO?.inputs.IF0;
  const zone = cond?.inputs.ZONE;
  const add = term?.inputs.DO?.inputs.DO0;
  if (!term || term.type !== "cb_term") return "no term";
  if (!term.inputs.DO) return `${String(term.fields.NAME)}: empty`;
  const condText = cond ? `${String(cond.fields.SIDE)} ${String(cond.fields.PIECE)} on ${String(zone?.fields.WHOSE)} rank ${String(zone?.fields.RANK)}` : "(no condition)";
  const addText = add ? `${String(add.fields.OP)} ${String(add.inputs.VALUE?.fields.NUM)}` : "(nothing)";
  return `${String(term.fields.NAME)}: if ${condText} do ${addText}`;
}

// --- Blockly, driven like a person: toolbox categories, flyout blocks, mouse drags -------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Label {
  /** The block that owns the label (its own outline, without the blocks plugged into it). */
  block: Box;
  /** Centre of the label text. */
  at: { x: number; y: number };
  right: number;
  top: number;
}

/**
 * Every on-screen label with exactly this text in the open flyout or on the canvas, top to
 * bottom. Blockly renders spaces in labels as no-break spaces.
 */
async function blockLabels(page: Page, where: "flyout" | "canvas", text: string): Promise<Label[]> {
  return page.evaluate(
    ({ where, text }) => {
      const root =
        where === "flyout" ? [...document.querySelectorAll("svg.blocklyFlyout")].find((s) => s.getBoundingClientRect().width > 0) : document.querySelector("svg.blocklySvg");
      if (!root) return [];
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      return [...root.querySelectorAll("text.blocklyText")]
        .filter((t) => (t.textContent ?? "").replace(/\u00a0/g, " ").trim() === text)
        .map((t) => {
          const g = t.closest("g[data-id]");
          const outline = (g?.querySelector(":scope > path.blocklyPath") ?? g ?? t).getBoundingClientRect();
          const r = t.getBoundingClientRect();
          return { block: { x: outline.x, y: outline.y, w: outline.width, h: outline.height }, at: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, right: r.right, top: r.top };
        })
        .filter((l) => l.at.x > 0 && l.at.y > 0 && l.at.x < viewport.w && l.at.y < viewport.h)
        .sort((a, b) => a.at.y - b.at.y);
    },
    { where, text },
  );
}

async function firstLabel(page: Page, where: "flyout" | "canvas", text: string, minY = 0): Promise<Label> {
  let found: Label | undefined;
  await expect
    .poll(async () => {
      found = (await blockLabels(page, where, text)).find((l) => l.at.y > minY);
      return Boolean(found);
    }, { message: `a “${text}” block in the ${where}`, timeout: 10_000 })
    .toBe(true);
  return found!;
}

/** Clicks a toolbox category and waits for its flyout. */
async function openCategory(page: Page, name: string): Promise<void> {
  await page.locator(".blocklyToolboxCategory", { hasText: name }).first().click();
  await expect(page.locator("svg.blocklyFlyout").filter({ has: page.locator("text.blocklyText") }).first()).toBeVisible();
  await page.waitForTimeout(250); // the flyout slides in
}

/** A real drag: pointer down at `from`, a few small moves (past Blockly's drag threshold), release at `to`. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(150); // let the insertion marker settle on the target connection
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/**
 * Drags the block that owns `grab` so that its top-left corner lands on `corner` (where the
 * connection it should snap to is). Blockly snaps within a few pixels, as it does for a person.
 */
async function dragBlockTo(page: Page, grab: Label, corner: { x: number; y: number }): Promise<void> {
  const offset = { x: grab.at.x - grab.block.x, y: grab.at.y - grab.block.y };
  await drag(page, grab.at, { x: corner.x + offset.x, y: corner.y + offset.y });
}

/** Drops a term from the open flyout into the Evaluation block, above its first term. */
async function dropTermFirst(page: Page, flyoutLabel: Label): Promise<void> {
  const firstTerm = await firstLabel(page, "canvas", "term", 100);
  await dragBlockTo(page, flyoutLabel, { x: firstTerm.block.x, y: firstTerm.block.y });
}

/**
 * The editable field matching `text` that belongs to the term `termId` (inside its outline,
 * including the blocks plugged into it, but not the terms after it). Returns its centre.
 */
async function termField(page: Page, termId: string, text: RegExp): Promise<{ x: number; y: number }> {
  let point: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      point = await page.evaluate(
        ({ id, source, flags }) => {
          const re = new RegExp(source, flags);
          const g = document.querySelector(`svg.blocklySvg g[data-id="${CSS.escape(id)}"]`);
          const outline = g?.querySelector(":scope > path.blocklyPath")?.getBoundingClientRect();
          if (!g || !outline) return null;
          for (const f of g.querySelectorAll(".blocklyEditableField")) {
            if (!re.test((f.textContent ?? "").replace(/\u00a0/g, " ").trim())) continue;
            const r = f.getBoundingClientRect();
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            if (cy >= outline.top && cy <= outline.bottom && cx >= outline.left) return { x: cx, y: cy };
          }
          return null;
        },
        { id: termId, source: text.source, flags: text.flags },
      );
      return point !== null;
    }, { message: `field ${text} of the term`, timeout: 10_000 })
    .toBe(true);
  return point!;
}

/** Clicks a number or text field of the term and types a new value. */
async function typeInField(page: Page, termId: string, current: RegExp, value: string): Promise<void> {
  const at = await termField(page, termId, current);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(".blocklyHtmlInput")).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await expect(page.locator(".blocklyHtmlInput")).toHaveCount(0);
}

/** Opens a dropdown of the term ("pawns ▾", "7th ▾") and picks an option. */
async function chooseInDropdown(page: Page, termId: string, current: RegExp, option: string, shotName?: string): Promise<void> {
  const at = await termField(page, termId, current);
  await page.mouse.click(at.x, at.y);
  const item = page.locator(".blocklyDropDownDiv .blocklyMenuItem", { hasText: new RegExp(`^${escapeRe(option)}$`) });
  await expect(item).toBeVisible();
  if (shotName) await shot(page, shotName);
  await item.click();
  await expect(page.locator(".blocklyDropDownDiv .blocklyMenuItem")).toHaveCount(0);
}

/** Clicks an empty spot of the canvas (gives Blockly keyboard focus without selecting a block). */
async function clickEmptyCanvas(page: Page): Promise<void> {
  const box = await page.locator(".blocks-editor").boundingBox();
  if (!box) throw new Error("block editor not visible");
  await page.mouse.click(box.x + box.width - 140, box.y + box.height - 40);
}

/** The text of the status pill's problem list (opens it). */
async function problems(page: Page): Promise<string> {
  const list = page.locator(".blocks-editor-problems");
  if (!(await list.isVisible())) await blocksPill(page).click();
  await expect(list).toBeVisible();
  const text = (await list.textContent()) ?? "";
  await blocksPill(page).click(); // close it again
  await expect(list).toHaveCount(0);
  return text;
}

// --- the test bench ---------------------------------------------------------------------------

interface EvalRow {
  label: string;
  white: number;
  black: number;
  net: number;
}
interface EvalReading {
  headline: string;
  subtitle: string;
  rows: EvalRow[];
  total: number;
  note: string;
}

const signed = (s: string) => Number(s.replace("−", "-").replace("+", "").trim());

async function openTestBench(page: Page): Promise<void> {
  await page.locator(".workshop-side-tabs .tab, .workshop-stack-tabs .tab", { hasText: "Test" }).first().click();
  await page.locator(".workshop-tool-tabs .tab", { hasText: "Evaluate" }).first().click();
  // Evaluate on demand (one click per position) so every reading belongs to the position set.
  const auto = visibleTool(page).getByRole("checkbox", { name: /Re-evaluate when the position changes/ });
  if (await auto.isChecked()) await auto.uncheck();
}

/** Sets the test position through the FEN field, clicks Evaluate and reads the result. */
async function evaluateAt(page: Page, fen: string): Promise<EvalReading> {
  const field = page.getByRole("textbox", { name: "Position (FEN)" });
  await field.fill(fen);
  await field.press("Enter");
  await expect(field).toHaveValue(fen);
  return evaluateNow(page);
}

/** Clicks Evaluate for the position on the test board and reads the result. */
async function evaluateNow(page: Page): Promise<EvalReading> {
  const tool = visibleTool(page);
  const button = tool.getByRole("button", { name: "Evaluate", exact: true });
  await expect(button).toBeEnabled({ timeout: LONG });
  await button.click();
  await expect(button).toBeEnabled({ timeout: LONG });
  await expect(tool.locator(".workshop-eval-result:not(.stale)")).toBeVisible({ timeout: LONG });
  const rows = await tool.locator(".workshop-trace tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
  return {
    headline: (await tool.locator(".workshop-eval-headline").textContent()) ?? "",
    subtitle: (await tool.locator(".workshop-eval-score > .small").textContent()) ?? "",
    rows: rows.map(([label, white, black, net]) => ({ label: label ?? "", white: Number(white), black: Number(black), net: signed(net ?? "") })),
    total: signed((await tool.locator(".workshop-trace tfoot strong").textContent()) ?? ""),
    note: (await tool.locator(".workshop-eval-result > p.small.faint").last().textContent()) ?? "",
  };
}

function row(reading: EvalReading, label: string): { white: number; black: number; net: number } {
  const r = reading.rows.find((x) => x.label === label);
  if (!r) throw new Error(`no “${label}” row in the breakdown: ${reading.rows.map((x) => x.label).join(", ")}`);
  return { white: r.white, black: r.black, net: r.net };
}

// Positions: a lone pawn / knight for White, and the colour-mirrored twins.
const FEN = {
  whitePawnB7: "4k3/1P6/8/8/8/8/8/4K3 w - - 0 1",
  blackPawnB2: "4k3/8/8/8/8/8/1p6/4K3 b - - 0 1", // mirror of the above: Black's 7th rank
  blackPawnB7: "4k3/1p6/8/8/8/8/8/4K3 w - - 0 1", // rank 7 on the board, but Black's 2nd rank
  whitePawnB2: "4k3/8/8/8/8/8/1P6/4K3 w - - 0 1",
  whiteKnightB6: "4k3/8/1N6/8/8/8/8/4K3 w - - 0 1",
  blackKnightB3: "4k3/8/8/8/8/1n6/8/4K3 b - - 0 1", // mirror: Black's 6th rank
};

/**
 * New engine → Blocks, then the ready-made term "Pawn on our 7th rank" dragged into the
 * Evaluation block, renamed and set to a bonus of 1. Returns the engine id and the term's id.
 */
async function buildSeventhRankEngine(page: Page, name: string): Promise<{ engineId: string; termId: string }> {
  await openLibrary(page);
  const engineId = await createBlocksEngine(page, name);
  // A new blocks engine starts from the starter evaluation (ten terms).
  await expect(blocksPill(page)).toHaveText("10 terms · no problems");

  // The toolbox: "Ready-made terms" holds complete terms; the first one is the user's example.
  await openCategory(page, "Ready-made terms");
  const flyoutText = await page.locator("svg.blocklyFlyout text.blocklyFlyoutLabelText").first().textContent();
  expect(flyoutText?.replace(/\u00a0/g, " ")).toContain("100 points = one pawn");
  const recipe = await firstLabel(page, "flyout", "term");
  await shot(page, "01-ready-made-terms");
  await dropTermFirst(page, recipe);

  // Autosave stores it as the Evaluation block's first term, fully connected.
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("Pawn on our 7th rank: if US PAWN on US rank 7 do ADD 20");
  let stored = await storedBlocks(page, engineId);
  expect(stored.tops).toEqual(["cb_evaluation"]);
  expect(stored.terms).toHaveLength(11);
  const termId = stored.first!.id;
  // The starter evaluation already has a term of that name: the editor says so.
  await expect(blocksPill(page)).toHaveText("1 warning");
  expect(await problems(page)).toContain("Another term is also called “Pawn on our 7th rank”");

  // Name it and set the bonus to 1, keeping "pawns" and "7th".
  await typeInField(page, termId, /^Pawn on our 7th rank$/, "My pawn bonus");
  await typeInField(page, termId, /^20$/, "1");
  await expect(blocksPill(page)).toHaveText("11 terms · no problems");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My pawn bonus: if US PAWN on US rank 7 do ADD 1");
  stored = await storedBlocks(page, engineId);
  expect(stored.code).toContain('traceTerm("My pawn bonus", white, black)');
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/, { timeout: 15_000 });
  return { engineId, termId };
}

// =============================================================================================

test("New engine → Blocks: “+1 if any pawn is on the 7th rank” by drag and drop, built, evaluated, mirrored, then knight / 6th", async ({ page }) => {
  test.setTimeout(180_000);
  const { engineId, termId } = await buildSeventhRankEngine(page, "Seventh Rank");
  await shot(page, "02-term-set-to-1");

  // The units are on the blocks: the Evaluation block says what a point is.
  const canvasText = (await page.locator("svg.blocklySvg").textContent())?.replace(/\u00a0/g, " ") ?? "";
  expect(canvasText).toContain("in points (100 points = 1 pawn)");

  // The generated code: a relative-rank test for "us", 1 centipawn, traced under the term's name.
  await page.locator(".workshop-side-tabs .tab", { hasText: "Generated code" }).click();
  const code = (await storedBlocks(page, engineId)).code;
  expect(code).toMatch(/function term_1_my_pawn_bonus\(pos: Position, us: i32, phase: i32\): i32 \{[\s\S]*?if \(\(pos\.pieces\(us, PAWN\) & relativeRankMask\(us, 6\)\) != 0\) \{\s*mg \+= 1;\s*eg \+= 1;/);
  expect(code).toContain("in centipawns from White's point of view (100 = one pawn)");
  await expect(page.locator(".workshop-pane--code .cm-content")).toContainText("generated by BoardForm");

  // Build and evaluate.
  expect(await build(page)).toMatch(/Up to date/);
  await openTestBench(page);
  const white7 = await evaluateAt(page, FEN.whitePawnB7);
  expect(row(white7, "My pawn bonus")).toEqual({ white: 1, black: 0, net: 1 });
  expect(row(white7, "Pawn on our 7th rank")).toEqual({ white: 10, black: 0, net: 10 }); // the starter's own term, 10 points
  expect(white7.rows.map((r) => r.label)[0]).toBe("My pawn bonus");
  // Units: the headline is in pawns and also given in centipawns; the breakdown says it is in cp.
  expect(white7.headline).toMatch(/^\+\d+\.\d\dpawns$/);
  expect(white7.subtitle).toContain(`${white7.total > 0 ? "+" : ""}${white7.total} cp · White's point of view · White to move`);
  expect(white7.note).toContain("centipawns (cp): 100 cp = one pawn");
  expect(white7.rows.reduce((s, r) => s + r.net, 0)).toBe(white7.total);
  await shot(page, "03-eval-white-pawn-b7");

  // The colour-mirrored position (Presets → Swap colours): Black's pawn on b2 is on Black's 7th
  // rank → the mirrored breakdown and the opposite score.
  await page.getByRole("button", { name: /^Presets/ }).click();
  await page.getByRole("menuitem", { name: /Swap colours/ }).click();
  await expect(page.getByRole("textbox", { name: "Position (FEN)" })).toHaveValue(FEN.blackPawnB2);
  const black2 = await evaluateNow(page);
  expect(row(black2, "My pawn bonus")).toEqual({ white: 0, black: 1, net: -1 });
  expect(black2.total).toBe(-white7.total);
  expect(black2.headline.replace("−", "-")).toBe(white7.headline.replace("+", "-"));
  expect(black2.subtitle).toContain("Black to move");

  // "Our 7th rank" is relative: a black pawn on b7 stands on Black's 2nd rank, a white pawn on b2
  // on White's 2nd — neither earns the bonus.
  expect(row(await evaluateAt(page, FEN.blackPawnB7), "My pawn bonus")).toEqual({ white: 0, black: 0, net: 0 });
  expect(row(await evaluateAt(page, FEN.whitePawnB2), "My pawn bonus")).toEqual({ white: 0, black: 0, net: 0 });

  // Change the piece and the rank with the block's dropdowns.
  await chooseInDropdown(page, termId, /^pawns/, "knights", "04-piece-dropdown");
  await chooseInDropdown(page, termId, /^7th/, "6th");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My pawn bonus: if US KNIGHT on US rank 6 do ADD 1");
  const knightCode = (await storedBlocks(page, engineId)).code;
  expect(knightCode).toMatch(/function term_1_my_pawn_bonus[\s\S]*?if \(\(pos\.pieces\(us, KNIGHT\) & relativeRankMask\(us, 5\)\) != 0\) \{\s*mg \+= 1;/);
  // The Generated code tab follows (it shows the stored eval.ts).
  await page.locator(".workshop-side-tabs .tab", { hasText: "Generated code" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        type Tiled = HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } };
        const content = document.querySelector<Tiled>(".workshop-pane--code .cm-content");
        return content?.cmTile?.root?.view?.state.doc.toString() ?? [...document.querySelectorAll(".workshop-pane--code .cm-line")].map((l) => l.textContent).join("\n");
      }),
    )
    .toContain("pos.pieces(us, KNIGHT) & relativeRankMask(us, 5)");
  await expect(buildPill(page)).toHaveText(/Needs build|changed/);
  await shot(page, "05-knight-6th-generated");

  expect(await build(page)).toMatch(/Up to date/);
  await openTestBench(page);
  expect(row(await evaluateAt(page, FEN.whiteKnightB6), "My pawn bonus")).toEqual({ white: 1, black: 0, net: 1 });
  expect(row(await evaluateAt(page, FEN.blackKnightB3), "My pawn bonus")).toEqual({ white: 0, black: 1, net: -1 });
  expect(row(await evaluateAt(page, FEN.whitePawnB7), "My pawn bonus")).toEqual({ white: 0, black: 0, net: 0 });
  await shot(page, "06-eval-knight-b6-dark");

  // Light theme at 1440 px.
  await setTheme(page, "light");
  await shot(page, "07-eval-knight-b6-light");
});

test("Duplicate Blocky, build the term from four blocks; undo / redo, delete, broken and empty configurations, reload", async ({ page }) => {
  test.setTimeout(180_000);
  await openLibrary(page);
  // The help's advice: duplicate the engine you start from, keep the original as the opponent.
  await card(page, "Blocky").getByRole("button", { name: "More actions for Blocky" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(card(page, "Blocky (copy)")).toBeVisible();
  await card(page, "Blocky (copy)").getByRole("link", { name: "Open" }).click();
  await waitForBlockly(page);
  const engineId = engineIdFromUrl(page);
  await expect(blocksPill(page)).toHaveText("10 terms · no problems");

  // 1. Structure → a Term, dropped into the Evaluation block above "Material".
  await openCategory(page, "Structure");
  await dropTermFirst(page, await firstLabel(page, "flyout", "term"));
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: empty");
  await expect(blocksPill(page)).toHaveText("1 warning");
  expect(await problems(page)).toContain("Term “My term”: This term is empty, so it adds nothing.");
  const termId = (await storedBlocks(page, engineId)).first!.id;

  // 2. Logic → "if", into the term (below its header row, where the statement slot is).
  await openCategory(page, "Logic");
  const term = await firstLabel(page, "canvas", "term", 100);
  const headerRow = (term.at.y - term.block.y) * 2;
  await dragBlockTo(page, await firstLabel(page, "flyout", "if"), { x: term.block.x + 16, y: term.block.y + headerRow });
  await expect.poll(async () => (await storedBlocks(page, engineId)).first?.inputs.DO?.type, { timeout: 15_000 }).toBe("controls_if");
  await expect(blocksPill(page)).toHaveText("2 warnings");
  const emptyIf = await problems(page);
  expect(emptyIf).toContain("“if”: has an empty slot, which counts as false.");
  expect(emptyIf).toContain("“if”: has nothing inside, so it does nothing.");

  // 3. Pieces → "any of our pawns on our 7th rank", into the slot after "if".
  await openCategory(page, "Pieces");
  const ifLabel = await firstLabel(page, "canvas", "if", 100);
  await dragBlockTo(page, await firstLabel(page, "flyout", "any of"), { x: ifLabel.right + 6, y: ifLabel.at.y - 9 });
  await expect.poll(async () => (await storedBlocks(page, engineId)).first?.inputs.DO?.inputs.IF0?.type, { timeout: 15_000 }).toBe("cb_any_on");

  // 4. Add points → "add 10 points", into "do" (grabbed by its left edge, not the dropdown).
  await openCategory(page, "Add points");
  const add = await firstLabel(page, "flyout", "add");
  const grab = { ...add, at: { x: add.block.x + 7, y: add.block.y + add.block.h / 2 } };
  const doLabel = await firstLabel(page, "canvas", "do", 100);
  await dragBlockTo(page, grab, { x: doLabel.right + 8, y: doLabel.top - 2 });
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 10");
  await expect(blocksPill(page)).toHaveText("11 terms · no problems");
  await typeInField(page, termId, /^10$/, "1");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 1");
  await shot(page, "10-four-blocks");

  // Undo / redo with the keyboard.
  await clickEmptyCanvas(page);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 10");
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 1");

  // A broken configuration: the condition pulled out of the "if" is reported clearly.
  const anyOf = await firstLabel(page, "canvas", "any of", 100);
  const editor = (await page.locator(".blocks-editor").boundingBox())!;
  await drag(page, anyOf.at, { x: editor.x + editor.width - 260, y: editor.y + editor.height / 2 });
  await expect(blocksPill(page)).toHaveText("2 warnings");
  const broken = await problems(page);
  expect(broken).toContain("“if”: has an empty slot, which counts as false.");
  expect(broken).toContain("This block is not connected to the Evaluation block, so it has no effect.");
  await shot(page, "11-broken-condition");
  await clickEmptyCanvas(page);
  await page.keyboard.press("Control+Z");
  await expect(blocksPill(page)).toHaveText("11 terms · no problems");
  await expect.poll(async () => (await storedBlocks(page, engineId)).tops, { timeout: 15_000 }).toEqual(["cb_evaluation"]);

  // Delete the term (select it, press Delete), then undo.
  const ourTerm = await firstLabel(page, "canvas", "term", 100);
  await page.mouse.click(ourTerm.at.x, ourTerm.at.y);
  await page.keyboard.press("Delete");
  await expect(blocksPill(page)).toHaveText("10 terms · no problems");
  await expect.poll(async () => (await storedBlocks(page, engineId)).terms[0], { timeout: 15_000 }).toBe("Material");
  await clickEmptyCanvas(page);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 1");

  // An empty workspace: the right-click menu deletes every block (Blockly asks first); the editor
  // explains what to do and the status says every position scores 0. Undo brings it all back.
  await clickEmptyCanvas(page);
  const box = (await page.locator(".blocks-editor").boundingBox())!;
  await page.mouse.click(box.x + box.width - 140, box.y + box.height - 40, { button: "right" });
  const deleteAll = page.getByRole("menuitem", { name: /^Delete \d+ Blocks$/ });
  await expect(deleteAll).toBeVisible();
  // Opened near the canvas' right edge, the menu reaches over the side panel instead of being cut off.
  const menuEdge = await deleteAll.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
    return { right: r.right, editorRight: document.querySelector(".blocks-editor")!.getBoundingClientRect().right, visible: !!hit && el.contains(hit) };
  });
  expect(menuEdge.right).toBeGreaterThan(menuEdge.editorRight);
  expect(menuEdge.visible).toBe(true);
  await deleteAll.click();
  const confirmBox = page.getByRole("button", { name: "OK", exact: true });
  await expect(page.getByText(/^Delete all \d+ blocks\?$/)).toBeVisible();
  await shot(page, "12-delete-all-confirm");
  await confirmBox.click();
  await expect(page.locator(".blocks-editor-empty-card")).toContainText("Build your evaluation");
  await expect(blocksPill(page)).toHaveText("1 warning");
  expect(await problems(page)).toContain("There is no Evaluation block, so every position is scored 0.");
  await expect.poll(async () => (await storedBlocks(page, engineId)).tops, { timeout: 15_000 }).toEqual([]);
  await shot(page, "13-empty-workspace");
  // "Add an empty Evaluation block": the status explains that it needs terms.
  await page.getByRole("button", { name: "Add an empty Evaluation block" }).click();
  await expect(page.locator(".blocks-editor-empty-card")).toHaveCount(0);
  expect(await problems(page)).toContain("has no terms yet, so every position is scored 0.");
  await clickEmptyCanvas(page);
  await page.keyboard.press("Control+Z"); // the added Evaluation block
  await expect(page.locator(".blocks-editor-empty-card")).toBeVisible();
  await clickEmptyCanvas(page);
  await page.keyboard.press("Control+Z"); // the deletion
  await expect(blocksPill(page)).toHaveText("11 terms · no problems");
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("My term: if US PAWN on US rank 7 do ADD 1");
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/, { timeout: 15_000 });

  // A reload keeps everything (it was autosaved).
  await page.reload();
  await waitForBlockly(page);
  await expect(blocksPill(page)).toHaveText("11 terms · no problems");
  expect(describeTerm((await storedBlocks(page, engineId)).first)).toBe("My term: if US PAWN on US rank 7 do ADD 1");
  await termField(page, termId, /^1$/); // shown on the canvas again
  // The original Blocky is untouched.
  const blocky = await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.enginesRepo.list()).find((e) => e.name === "Blocky")?.files?.["eval.ts"] ?? "";
  });
  expect(blocky).not.toContain("My term");
});

test("At 400 px (light theme): a slim toolbox, the term dragged in, no sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await openLibrary(page);
  await setTheme(page, "light");
  const engineId = await createBlocksEngine(page, "Narrow");
  await shot(page, "20-workshop-400-light");

  // The toolbox leaves most of the width to the canvas.
  const toolbox = (await page.locator(".blocklyToolbox").boundingBox())!;
  const editor = (await page.locator(".blocks-editor").boundingBox())!;
  expect(toolbox.width).toBeLessThanOrEqual(150); // 176 px on wider screens
  expect(editor.width - toolbox.width).toBeGreaterThanOrEqual(250);
  // Every category label fits inside its row and the row inside the toolbox.
  const clipped = await page.locator(".blocklyToolboxCategory").evaluateAll((rows) => {
    const right = document.querySelector(".blocklyToolbox")!.getBoundingClientRect().right;
    return rows
      .filter((r) => {
        const label = r.querySelector(".blocklyToolboxCategoryLabel")!.getBoundingClientRect();
        const box = r.getBoundingClientRect();
        return label.right > box.right + 0.5 || box.right > right + 0.5;
      })
      .map((r) => r.textContent);
  });
  expect(clipped).toEqual([]);

  await openCategory(page, "Ready-made terms");
  await shot(page, "21-flyout-400-light");
  await dropTermFirst(page, await firstLabel(page, "flyout", "term"));
  await expect.poll(async () => describeTerm((await storedBlocks(page, engineId)).first), { timeout: 15_000 }).toBe("Pawn on our 7th rank: if US PAWN on US rank 7 do ADD 20");
  await shot(page, "22-dropped-400-light");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // The test bench in the stacked layout evaluates the new engine too.
  await setTheme(page, "dark");
  await page.locator(".workshop-stack-tabs .tab", { hasText: "Test" }).click();
  await openTestBench(page);
  const reading = await evaluateAt(page, FEN.whitePawnB7);
  // Two terms share the name (the editor warned about it): the new one first, then the starter's.
  expect(reading.rows.filter((r) => r.label === "Pawn on our 7th rank").map((r) => r.net)).toEqual([20, 10]);
  await shot(page, "23-eval-400-dark");
});

test("Play your blocks engine at a node limit, then an Arena match against Blocky with standings and a replay", async ({ page }) => {
  test.setTimeout(180_000);
  const { engineId } = await buildSeventhRankEngine(page, "Seventh Rank");
  expect(await build(page)).toMatch(/Up to date/);

  // Play: the Workshop's Play button starts "you vs the engine" at once. To choose a node limit:
  // New game → (abort the empty game) → the setup form.
  await header(page).getByRole("link", { name: "Play" }).click();
  await expect(page).toHaveURL(/#\/play\?engine=/);
  await expect(page.locator(".play-player-status", { hasText: "Your move" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "New game" }).click();
  const abort = page.getByRole("dialog");
  await expect(abort).toContainText("Abort the current game?");
  await abort.getByRole("button", { name: "Abort game" }).click();
  const black = page.locator('.play-sidecard[data-side="b"]');
  await expect(black.getByRole("button", { name: "Black player" })).toContainText("Seventh Rank");
  await expect(page.getByRole("button", { name: "White player" })).toContainText("Human");
  await black.getByLabel("Time per move").fill("");
  await black.getByLabel("Max positions searched (nodes)").fill("3000");
  await shot(page, "30-play-setup-nodes");
  await page.locator(".play-start-button").click();

  const board = '[aria-label="Game board"]';
  const squareAt = async (square: string) => {
    const b = (await page.locator(board).boundingBox())!;
    const s = b.width / 8;
    return { x: b.x + (square.charCodeAt(0) - 97 + 0.5) * s, y: b.y + (8 - Number(square[1]) + 0.5) * s };
  };
  const moves = page.locator(".play-movelist .cb-ml-move:not(.cb-ml-move--empty)");
  const yourMove = page.locator(".play-player-status", { hasText: "Your move" });
  const play = async (from: string, to: string, plies: number) => {
    await expect(yourMove).toBeVisible({ timeout: 60_000 });
    const a = await squareAt(from);
    await page.mouse.click(a.x, a.y);
    const b = await squareAt(to);
    await page.mouse.click(b.x, b.y);
    await expect(moves).toHaveCount(plies, { timeout: 60_000 }); // my move and the engine's reply
  };
  await expect(page.locator(".play-board-col .play-player").first()).toContainText("3k nodes");
  await play("e2", "e4", 2);
  await play("d2", "d4", 4);
  await play("g1", "f3", 6);
  await expect(yourMove).toBeVisible({ timeout: 60_000 });
  // The engine reports its search: within the node limit (the line shows the nodes it used).
  const nodesText = await page.locator(".play-engine").first().locator(".play-engine-stats dd").nth(2).textContent();
  const nodes = Number((nodesText ?? "").replace("k", "e3"));
  expect(nodes).toBeGreaterThan(0);
  expect(nodes).toBeLessThanOrEqual(3_500);
  await shot(page, "31-play-game");
  await page.getByRole("button", { name: "Resign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Resign", exact: true }).click();
  await expect(page.locator(".play-result")).toContainText("Saved to your games");
  const saved = await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.gamesRepo.list()).map((g) => ({ black: g.black, moves: g.moves.length, result: g.result, matchId: g.matchId ?? null }));
  });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ moves: 6, result: "0-1", matchId: null });
  expect(saved[0].black).toMatchObject({ type: "engine", engineId, name: "Seventh Rank" });

  // Arena: from the Workshop's Match button, "Seventh Rank vs Blocky", 2000 nodes, 4 games.
  await page.goto(`/#/engines/${engineId}`);
  await waitForBlockly(page);
  await header(page).getByRole("link", { name: "Match" }).click();
  const dialog = page.locator(".arena-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Seventh Rank");
  await page.getByRole("button", { name: "Engine 2", exact: true }).click();
  await page.locator('li[role="option"]', { hasText: "Blocky" }).first().click();
  await expect(page.getByRole("button", { name: "Engine 2", exact: true })).toContainText("Blocky");
  await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
  const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
  await nodesCap.locator('input[type="checkbox"]').check();
  await nodesCap.locator("input.input").fill("2000");
  await page.getByLabel("Games per pairing").fill("4");
  await expect(page.locator("#arena-name")).toHaveValue("Seventh Rank vs Blocky");
  await shot(page, "32-arena-form");
  await page.getByTestId("arena-form-start").click();
  await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: LONG });

  // Standings: both engines played 4 games and the points add up to 4.
  const standings = page.getByTestId("arena-standings").locator("tbody tr");
  await expect(standings).toHaveCount(2);
  let points = 0;
  for (const name of ["Seventh Rank", "Blocky"]) {
    const cells = (await standings.filter({ hasText: name }).locator("td").allInnerTexts()).map((t) => t.trim());
    const [games, w, d, l] = cells.slice(2, 6).map(Number);
    expect(games, name).toBe(4);
    expect(w + d + l, name).toBe(4);
    expect(Number(cells[6])).toBe(w + d / 2);
    points += Number(cells[6]);
  }
  expect(points).toBe(4);
  await expect(page.getByTestId("arena-result-row")).toHaveCount(4);
  await shot(page, "33-arena-finished");

  // Replay a game: board, move navigation, the evaluation chart.
  await page.getByTestId("arena-result-row").first().click();
  const replay = page.getByTestId("arena-replay");
  await expect(replay).toBeVisible();
  const plyText = replay.locator(".row-wrap .muted", { hasText: "Ply" });
  const total = Number((await plyText.innerText()).split("/")[1].trim());
  expect(total).toBeGreaterThan(5);
  await replay.locator(".cb-ml-move").nth(3).click();
  await expect(plyText).toHaveText(`Ply 4 / ${total}`);
  await page.keyboard.press("ArrowLeft");
  await expect(plyText).toHaveText(`Ply 3 / ${total}`);
  await expect(replay.locator(".arena-replay-chart svg.cb-chart-svg")).toBeVisible();
  await shot(page, "34-arena-replay");
  await page.keyboard.press("Escape");
  await expect(replay).toHaveCount(0);
});
