// User journey "code": a programmer writes engines by hand in the Workshop's code editor.
//
//   1. Evaluation only — a new Eval code engine, a custom evaluate() typed key by key (with
//      autocompletion and the API reference's Insert), a type error found through the editor and
//      the build log, the fix, the evaluation breakdown and a search; then an example copied from
//      Help → Evaluation code.
//   2. The whole engine — Classic unlocked into a Full code engine: every template file is there and
//      editable, a changed engine name and search constant take effect, perft and the
//      move-generation check, a short Arena match against Classic; then files: a new lib/util.ts
//      imported from main.ts, renamed (the broken import is a clear build error), another entry file
//      and back, deleting with confirmation.
//   3. From scratch — the empty skeleton's comments lead to a first legal move; it plays a game in
//      Play without "produced no move". The minimal variant changed and perft-checked.
//   4. Upload .wasm — the minimal scratch engine compiled to a file, uploaded through the wizard,
//      playing in Play and in the Arena.
//   5. Editor ergonomics — per-file undo, find / replace, Ctrl+S / Ctrl+B, indentation, long files,
//      jumping between errors, the narrow-screen file drawer, read-only template files.
//
// Run: E2E_PORT=5242 npx playwright test e2e/journey-code.spec.ts --reporter=line
// Set E2E_SHOTS=<dir> to also write screenshots of the states the journeys pass through.
//
// Every test gets a fresh browser context (empty IndexedDB): the app seeds the starter engines
// (Blocky, Classic, Sprout, Neuron) on load and `seeded` waits for them. Searches and games use
// depth or node limits so the results do not depend on the machine's speed.
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); String()
// keeps tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type TemplatesModule = typeof import("../src/engine-host/templates");
type EngineRecord = import("../src/types/index").EngineRecord;

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

const ROOT = resolve(import.meta.dirname, "..");
const SHOTS = process.env.E2E_SHOTS ?? "";
const LONG = 180_000;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem("cb.theme", t);
    document.documentElement.dataset.theme = t;
  }, theme);
}

type EngineIds = Record<"Blocky" | "Classic" | "Sprout" | "Neuron", string> & Record<string, string>;

/** Opens the app and waits until the four starter engines exist. Returns name → id. */
async function seeded(page: Page): Promise<EngineIds> {
  await page.goto("/#/engines");
  await expect
    .poll(() => page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).enginesRepo.list()).length), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(4);
  return engineIds(page);
}

async function engineIds(page: Page): Promise<EngineIds> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return Object.fromEntries((await s.enginesRepo.list()).map((e) => [e.name, e.id]));
  }) as Promise<EngineIds>;
}

async function stored(page: Page, id: string): Promise<EngineRecord | null> {
  return page.evaluate(async (id) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const e = await s.enginesRepo.get(id);
    if (!e) return null;
    // ArrayBuffers do not survive the trip out of the page.
    return { ...e, wasm: undefined, build: e.build ? { ...e.build, wasm: undefined } : null } as unknown as EngineRecord;
  }, id);
}

async function storedFile(page: Page, id: string, path: string): Promise<string | null> {
  return (await stored(page, id))?.files?.[path] ?? null;
}

const idFromUrl = (page: Page) => decodeURIComponent(page.url().split("#/engines/")[1]!.split("?")[0]!);

/** Creates an engine through the library's wizard ("#/engines?new=1&kind=…"); returns its id. */
async function createWithWizard(page: Page, kind: "eval" | "full" | "scratch", name: string, variant?: "Empty skeleton" | "Minimal working engine"): Promise<string> {
  await page.goto(`/#/engines?new=1&kind=${kind}`);
  const wizard = page.locator(".modal");
  await wizard.getByLabel("Name", { exact: true }).fill(name);
  if (variant) await wizard.getByRole("radio", { name: new RegExp(variant) }).check();
  await wizard.getByRole("button", { name: "Create engine" }).click();
  await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Engine name")).toHaveValue(name);
  return idFromUrl(page);
}

async function openWorkshop(page: Page, id: string, query = ""): Promise<void> {
  await page.goto(`/#/engines/${id}${query}`);
  await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
}

const header = (page: Page) => page.locator(".workshop-header");
const buildPill = (page: Page) => page.locator(".workshop-header-status .workshop-pill");
const visibleTool = (page: Page) => page.locator(".workshop-tool-body > div:not([hidden])");
const toast = (page: Page, text: string | RegExp) => page.locator(".toast", { hasText: text });
const moreMenu = (page: Page) => header(page).getByRole("button", { name: "More actions" });

async function menuChoose(page: Page, menuButton: Locator, item: string | RegExp): Promise<void> {
  await menuButton.click();
  await page.locator(".workshop-menu-item", { hasText: item }).first().click();
}

/** Clicks a side-panel tab (wide layout) or a stacked tab (narrow layout). */
async function sideTab(page: Page, label: string): Promise<void> {
  await page.locator(".workshop-side-tabs .tab, .workshop-stack-tabs .tab", { hasText: label }).first().click();
}

async function toolTab(page: Page, label: string): Promise<void> {
  await sideTab(page, "Test");
  await page.locator(".workshop-tool-tabs .tab", { hasText: label }).first().click();
}

/** Clicks Build (or runs `trigger`) and waits for the outcome; returns the build pill's text. */
async function build(page: Page, trigger?: () => Promise<void>): Promise<string> {
  const button = header(page).getByRole("button", { name: /^(Build|Building…)$/ });
  await expect(button).toBeEnabled({ timeout: LONG });
  // A failing compile is quick: watch for the "building" pill so we wait for this build.
  await page.evaluate(() => {
    const w = window as unknown as { __cbBuildSeen?: boolean };
    w.__cbBuildSeen = false;
    const status = document.querySelector(".workshop-header-status");
    if (!status) return;
    const observer = new MutationObserver(() => {
      if (status.querySelector(".workshop-pill--accent")) {
        w.__cbBuildSeen = true;
        observer.disconnect();
      }
    });
    observer.observe(status, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await (trigger ? trigger() : button.click());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cbBuildSeen?: boolean }).__cbBuildSeen), { timeout: 15_000 }).toBe(true);
  await expect(page.locator(".workshop-header-status .workshop-pill--accent")).toHaveCount(0, { timeout: LONG });
  await expect(buildPill(page)).toHaveText(/Up to date|error|Build failed|Can't build|Not a working engine/, { timeout: LONG });
  return (await buildPill(page).textContent()) ?? "";
}

// --- the CodeMirror editor ---------------------------------------------------------------------

/** Selector of the editor in the main area. */
const MAIN_EDITOR = ".workshop-main .workshop-code";

/** The text and cursor of the CodeMirror editor inside `scope` (the whole document). */
async function editorState(page: Page, scope: string): Promise<{ text: string; line: number; column: number; selection: string }> {
  return page.evaluate((sel) => {
    type View = {
      state: {
        doc: { toString(): string; lineAt(pos: number): { number: number; from: number } };
        selection: { main: { head: number; from: number; to: number } };
        sliceDoc(from: number, to: number): string;
      };
    };
    type Tiled = HTMLElement & { cmTile?: { root?: { view?: View } }; cmView?: { rootView?: { view?: View } } };
    const content = document.querySelector<Tiled>(`${sel} .cm-content`);
    const view = content?.cmTile?.root?.view ?? content?.cmView?.rootView?.view;
    if (!view) throw new Error(`no editor view in ${sel}`);
    const { head, from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    return { text: view.state.doc.toString(), line: line.number, column: head - line.from + 1, selection: view.state.sliceDoc(from, to) };
  }, scope);
}

const editorText = async (page: Page, scope: string) => (await editorState(page, scope)).text;

/** Focuses the editor inside `scope` without moving its cursor (a click would). */
async function focusEditor(page: Page, scope: string): Promise<void> {
  const content = page.locator(`${scope} .cm-content`).first();
  await content.focus();
  await expect(content).toBeFocused();
}

/** The open autocompletion popup. */
const completions = (page: Page) => page.locator(".cm-tooltip-autocomplete");

/**
 * Types a line the way a person does, key by key, and ends it with Enter. CodeMirror closes
 * brackets and quotes and indents by itself, so the text is written without closing brackets that
 * the editor already added and without leading indentation. A completion popup that is still open
 * at the end of the line is closed first, so Enter makes a new line instead of accepting it.
 */
async function typeLine(page: Page, text: string, opts: { enter?: boolean } = {}): Promise<void> {
  if (text) await page.keyboard.type(text, { delay: 5 });
  if (await completions(page).isVisible()) await page.keyboard.press("Escape");
  if (opts.enter !== false) await page.keyboard.press("Enter");
}

/** Types `prefix`, waits for the popup to offer `label` first, and accepts it with Tab. */
async function complete(page: Page, prefix: string, label: string): Promise<void> {
  await page.keyboard.type(prefix, { delay: 20 });
  await expect(completions(page)).toBeVisible();
  await expect(completions(page).locator("li[aria-selected] .cm-completionLabel")).toHaveText(label);
  await page.keyboard.press("Tab");
  await expect(completions(page)).toHaveCount(0);
}

// --- test bench --------------------------------------------------------------------------------

interface EvalRow {
  label: string;
  white: number;
  black: number;
  net: number;
}

const signed = (s: string) => Number(s.replace("−", "-").replace("+", "").trim());

/** Evaluate tool: clicks Evaluate and waits for a fresh breakdown. */
async function evaluate(page: Page): Promise<{ rows: EvalRow[]; total: number | null }> {
  await toolTab(page, "Evaluate");
  const tool = visibleTool(page);
  const button = tool.getByRole("button", { name: "Evaluate", exact: true });
  await expect(button).toBeEnabled({ timeout: LONG });
  await button.click();
  await expect(button).toBeEnabled({ timeout: LONG });
  await expect(tool.locator(".workshop-eval-result:not(.stale)")).toBeVisible({ timeout: LONG });
  const rows = await tool.locator(".workshop-trace tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
  const totalText = await tool.locator(".workshop-trace tfoot strong").textContent().catch(() => null);
  return {
    rows: rows.map(([label, white, black, net]) => ({ label: label ?? "", white: Number(white), black: Number(black), net: signed(net ?? "") })),
    total: totalText ? signed(totalText) : null,
  };
}

/** Sets the Search tool's limits (missing ones are switched off). */
async function setSearchLimits(page: Page, limits: { depth?: number; nodes?: number }): Promise<void> {
  await toolTab(page, "Search");
  const tool = visibleTool(page);
  const infinite = tool.getByRole("checkbox", { name: /Infinite analysis/ });
  if (await infinite.isChecked()) await infinite.uncheck();
  await tool.getByRole("textbox", { name: "Depth", exact: true }).fill(limits.depth === undefined ? "" : String(limits.depth));
  await tool.getByRole("textbox", { name: "Max positions searched (nodes)", exact: true }).fill(limits.nodes === undefined ? "" : String(limits.nodes));
  await tool.getByRole("textbox", { name: "Time per move", exact: true }).fill("");
}

/** Search tool: Go, wait for the result; returns its text. */
async function search(page: Page): Promise<string> {
  await toolTab(page, "Search");
  const tool = visibleTool(page);
  const go = tool.getByRole("button", { name: "Go", exact: true });
  await expect(go).toBeEnabled({ timeout: LONG });
  await go.click();
  await expect(go).toBeEnabled({ timeout: LONG });
  const result = tool.locator(".workshop-search-result, .callout.danger").first();
  await expect(result).toBeVisible({ timeout: LONG });
  return (await result.textContent()) ?? "";
}

/** Runs perft at `depth` in the Perft tool; returns the stats text. */
async function perft(page: Page, depth: number, expected: string): Promise<void> {
  await toolTab(page, "Perft");
  const box = visibleTool(page).locator(".workshop-subsection").first();
  await box.locator("select").selectOption(String(depth));
  await box.getByRole("button", { name: "Run perft" }).click();
  await expect(box.locator(".workshop-stats")).toContainText(expected, { timeout: LONG });
  await expect(box.locator(".workshop-stats")).toContainText("matches");
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scroll width").toBeLessThanOrEqual(client);
}

// =============================================================================================
// 1. Evaluation only
// =============================================================================================

/** An evaluation that reads past the end of its table (8 pawns, 3 entries). */
const CRASHING_EVAL = `import { Position } from "./position";
import { WHITE, PAWN } from "./types";

const BONUS: StaticArray<i32> = [0, 10, 20];

export function evaluate(pos: Position): i32 {
  return BONUS[pos.count(WHITE, PAWN)];
}
`;

/** What the typed evaluation must look like in the end (CodeMirror adds the closing brackets). */
const TYPED_EVAL = `import { Position } from "./position";
import { WHITE, BLACK, KNIGHT } from "./types";
import { material, mobility, kingShield } from "./evalkit";
import { tracing, traceTerm } from "./trace";

const MOBILITY_WEIGHT: i32 = 4.5;

/** Material, knight mobility and a pawn shield for the king. */
export function evaluate(pos: Position): i32 {
  let score = 0;
  const matW = material(pos, WHITE, 100, 320, 330, 500, 900);
  const matB = material(pos, BLACK, 100, 320, 330, 500, 900);
  if (tracing) traceTerm("my material", matW, matB);
  score += matW - matB;
  const mobW = MOBILITY_WEIGHT * mobility(pos, WHITE, KNIGHT);
  const mobB = MOBILITY_WEIGHT * mobility(pos, BLACK, KNIGHT);
  if (tracing) traceTerm("knight mobility", mobW, mobB);
  score += mobW - mobB;
  const shieldW = 10 * kingShield(pos, WHITE);
  const shieldB = 10 * kingShield(pos, BLACK);
  if (tracing) traceTerm("king shield", shieldW, shieldB);
  score += shieldW - shieldB;
  return score;
}`;

test("Evaluation only: type a custom evaluate(), fix a type error from the build log, test it; a Help example works too", async ({ page }) => {
  test.setTimeout(LONG);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await seeded(page);
  const id = await createWithWizard(page, "eval", "Hand-written");
  await expect(header(page).locator(".cb-kind")).toHaveText("Eval code");
  const editor = MAIN_EDITOR;
  await expect(page.locator(`${editor} .cm-content`)).toBeVisible();
  expect(await editorText(page, editor)).toContain("export function evaluate");

  // Clear the file and type a new evaluation, key by key.
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  expect(await editorText(page, editor)).toBe("");
  await typeLine(page, 'import { Position } from "./position";');
  await typeLine(page, 'import { WHITE, BLACK, KNIGHT } from "./types";');
  await typeLine(page, 'import { material } from "./evalkit";');
  await typeLine(page, 'import { tracing, traceTerm } from "./trace";');
  await typeLine(page, "");
  await typeLine(page, "const MOBILITY_WEIGHT: i32 = 4.5;");
  await typeLine(page, "");
  await typeLine(page, "/** Material, knight mobility and a pawn shield for the king. */");
  await typeLine(page, "export function evaluate(pos: Position): i32 {");
  // The editor closed the brace and indented the new line.
  expect((await editorState(page, editor)).column).toBe(3);
  await typeLine(page, "let score = 0;");
  await typeLine(page, "const matW = material(pos, WHITE, 100, 320, 330, 500, 900);");
  await typeLine(page, "const matB = material(pos, BLACK, 100, 320, 330, 500, 900);");
  await typeLine(page, 'if (tracing) traceTerm("my material", matW, matB);');
  await typeLine(page, "score += matW - matB;");
  // Autocompletion: "mobil" offers evalkit's mobility(); accepting it adds the import.
  await page.keyboard.type("const mobW = MOBILITY_WEIGHT * ");
  await complete(page, "mobil", "mobility");
  await expect.poll(() => editorText(page, editor)).toContain('import { material, mobility } from "./evalkit";');
  await typeLine(page, "(pos, WHITE, KNIGHT);");
  await typeLine(page, "const mobB = MOBILITY_WEIGHT * mobility(pos, BLACK, KNIGHT);");
  await typeLine(page, 'if (tracing) traceTerm("knight mobility", mobW, mobB);');
  await typeLine(page, "score += mobW - mobB;");
  // The API reference: search kingShield, Insert puts "kingShield()" at the cursor (inside the
  // parentheses) and imports it.
  await page.keyboard.type("const shieldW = 10 * ");
  await sideTab(page, "API reference");
  await page.getByLabel("Search the engine API").fill("kingShield");
  const apiItem = page.locator(".workshop-pane--api .cb-api-item", { hasText: "kingShield(" }).first();
  await expect(apiItem).toBeVisible();
  await apiItem.getByRole("button", { name: "Insert" }).click();
  await expect(page.locator(`${editor} .cm-content`)).toBeFocused();
  await expect.poll(() => editorText(page, editor)).toContain('import { material, mobility, kingShield } from "./evalkit";');
  await typeLine(page, "pos, WHITE", { enter: false });
  await page.keyboard.press("End");
  await typeLine(page, ";");
  await typeLine(page, "const shieldB = 10 * kingShield(pos, BLACK);");
  await typeLine(page, 'if (tracing) traceTerm("king shield", shieldW, shieldB);');
  await typeLine(page, "score += shieldW - shieldB;");
  await typeLine(page, "return score;", { enter: false });
  await shot(page, "eval-typed");
  expect(await editorText(page, editor)).toBe(TYPED_EVAL);
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toBe(TYPED_EVAL);

  // The deliberate mistake: an i32 constant initialised with 4.5.
  expect(await build(page)).toMatch(/1 error/);
  await expect(toast(page, /Build failed/)).toBeVisible();
  await expect(page.locator(".workshop-side-tabs .tab.active")).toHaveText(/Build log/);
  const diag = page.locator(".workshop-pane--build .workshop-diag.error").first();
  await expect(diag).toContainText("explicit cast");
  const where = (await diag.locator(".workshop-diag-where").textContent()) ?? "";
  const [, diagLine, diagColumn] = /^eval\.ts:(\d+):(\d+)$/.exec(where.trim()) ?? [];
  expect(Number(diagLine), `diagnostic location ${where}`).toBe(6);
  expect(Number(diagColumn)).toBe(TYPED_EVAL.split("\n")[5].indexOf("4.5") + 1);
  // Underlined in the editor, with a gutter marker.
  await expect(page.locator(`${editor} .cm-lintRange-error`).first()).toHaveText("4.5");
  await expect(page.locator(`${editor} .cm-lint-marker-error`)).toHaveCount(1);
  await shot(page, "eval-error");

  // Clicking the message puts the cursor on the mistake.
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await diag.click();
  await expect.poll(async () => {
    const s = await editorState(page, editor);
    return `${s.line}:${s.column}`;
  }).toBe(`${diagLine}:${diagColumn}`);
  await expect(page.locator(`${editor} .cm-content`)).toBeFocused();
  // Fix it right there: select "4.5" and type 4.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  expect((await editorState(page, editor)).selection).toBe("4.5");
  await page.keyboard.type("4");
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toContain("const MOBILITY_WEIGHT: i32 = 4;");
  expect(await build(page)).toMatch(/Up to date/);
  await expect(page.locator(`${editor} .cm-lintRange-error`)).toHaveCount(0);

  // The breakdown shows the three terms, and they add up.
  const ev = await evaluate(page);
  expect(ev.rows.map((r) => r.label)).toEqual(["my material", "knight mobility", "king shield"]);
  expect(ev.rows.reduce((s, r) => s + r.net, 0)).toBe(ev.total);
  expect(ev.rows[1].white).toBe(4 * 4); // two knights with two safe squares each, × 4
  await shot(page, "eval-breakdown");
  await setTheme(page, "light");
  await shot(page, "eval-breakdown-light");
  await setTheme(page, "dark");
  await setSearchLimits(page, { depth: 4 });
  expect(await search(page)).toContain("Best move");

  // A runtime mistake: a table read past its end. AssemblyScript's message names its own library
  // file, so the Workshop says in words what it means.
  await focusEditor(page, editor);
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(CRASHING_EVAL);
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toBe(CRASHING_EVAL);
  expect(await build(page)).toMatch(/Up to date/);
  await toolTab(page, "Evaluate");
  const evalTool = visibleTool(page);
  await evalTool.getByRole("button", { name: "Evaluate", exact: true }).click();
  await expect(evalTool.locator(".callout.danger")).toContainText("Index out of range", { timeout: LONG });
  await expect(evalTool.locator(".callout.danger")).toContainText("array index was past the end");
  await shot(page, "eval-runtime-error");

  // Help → Evaluation code, in a second tab: copy the "Adding a term" example and paste it over
  // eval.ts. (The system clipboard may turn line ends into CRLF; the editor stores LF.)
  const help = await page.context().newPage();
  await help.goto("/#/help/eval-api?section=adding-a-term");
  const example = help.locator(".help-code-complete").nth(1);
  await expect(example).toContainText("SEVENTH_RANK_BONUS");
  const copied = ((await example.locator("pre code").textContent()) ?? "").replace(/\r\n/g, "\n");
  await example.getByRole("button", { name: "Copy the code" }).click();
  await expect(example.locator(".help-copy-label")).toHaveText("Copied");
  expect((await help.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(copied);
  await page.bringToFront();
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+V");
  await help.close();
  await expect.poll(() => editorText(page, editor)).toBe(copied);
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toBe(copied);
  expect(await build(page)).toMatch(/Up to date/);
  const pasted = await evaluate(page);
  expect(pasted.rows.map((r) => r.label)).toEqual(["material", "pawns on the 7th rank"]);
  expect(pasted.total).toBe(0);
  await setSearchLimits(page, { depth: 3 });
  expect(await search(page)).toContain("Best move");
});

// =============================================================================================
// 2. The whole engine
// =============================================================================================

const tree = (page: Page) => page.locator(".workshop-tree");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A file (or folder) row of the file tree, by its name. */
const treeRow = (page: Page, name: string) => tree(page).locator(".cb-tree-row", { has: page.locator(".cb-tree-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
const activeTab = (page: Page) => page.locator(".workshop-filetab.active");

async function openFile(page: Page, name: string): Promise<void> {
  await treeRow(page, name).click();
  await expect(activeTab(page)).toContainText(name);
}

/** Opens the editor's search panel (Ctrl+F) and replaces every `find` with `replace`. */
async function replaceAll(page: Page, scope: string, find: string, replace: string): Promise<void> {
  await focusEditor(page, scope);
  await page.keyboard.press("Control+F");
  const panel = page.locator(`${scope} .cm-search`);
  await expect(panel).toBeVisible();
  await expect(panel.locator("input[name=search]")).toBeFocused();
  await panel.locator("input[name=search]").fill(find);
  await panel.locator("input[name=replace]").fill(replace);
  await panel.getByRole("button", { name: "Replace all" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
}

/** Depth, score and node count of every iteration of the last search (the time columns left out). */
async function searchProfile(page: Page): Promise<string> {
  const rows = await visibleTool(page)
    .locator(".workshop-info tbody tr")
    .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent).join(" ")));
  expect(rows.length).toBeGreaterThan(3);
  return rows.join(" | ");
}

test("The whole engine: unlock Classic, edit any file, see the change, perft, an Arena match; files and imports", async ({ page }) => {
  test.setTimeout(LONG);
  const ids = await seeded(page);
  const templates = await page.evaluate(async () => ((await import(String("/src/engine-host/templates.ts"))) as TemplatesModule).templateFiles);
  await openWorkshop(page, ids.Classic);
  await menuChoose(page, moreMenu(page), "Unlock the full engine source");
  await expect(page.getByLabel("Engine name")).toHaveValue("Classic (full)");
  await expect(header(page).locator(".cb-kind")).toHaveText("Full code");
  const id = idFromUrl(page);
  expect(id).not.toBe(ids.Classic);

  // Every template file is listed and editable: search, move generation, time management, NNUE, main.ts...
  const editor = MAIN_EDITOR;
  const paths = Object.keys(templates);
  expect(paths).toEqual(expect.arrayContaining(["main.ts", "search.ts", "movegen.ts", "position.ts", "nnue.ts", "eval.ts", "evalkit.ts", "tt.ts"]));
  for (const path of paths) {
    await openFile(page, path);
    await expect(page.locator(`${editor} .cm-content`)).not.toHaveAttribute("aria-readonly", "true");
    await expect.poll(() => editorText(page, editor)).toBe(templates[path]);
  }
  await shot(page, "full-files");

  // The stock search at depth 8, before any change.
  expect(await build(page)).toMatch(/Up to date/);
  await setSearchLimits(page, { depth: 8 });
  expect(await search(page)).toContain("Best move");
  const profileBefore = await searchProfile(page);
  await expect(page.locator(".workshop-engine-status.ready")).toContainText("BoardForm Template 1.0");

  // main.ts: a new name for the engine (find / replace); search.ts: no null-move pruning.
  await openFile(page, "main.ts");
  await replaceAll(page, editor, "BoardForm Template 1.0", "My Full Engine 2.0");
  expect(await editorText(page, editor)).toContain('const ENGINE_NAME: string = "My Full Engine 2.0";');
  await openFile(page, "search.ts");
  await replaceAll(page, editor, "const NULL_MIN_DEPTH: i32 = 3;", "const NULL_MIN_DEPTH: i32 = 99;");
  await expect.poll(() => storedFile(page, id, "search.ts"), { timeout: 10_000 }).toContain("const NULL_MIN_DEPTH: i32 = 99;");
  expect(await storedFile(page, id, "main.ts")).toContain("My Full Engine 2.0");
  expect(await build(page)).toMatch(/Up to date/);
  await expect(page.locator(".workshop-engine-status.ready")).toContainText("My Full Engine 2.0", { timeout: LONG });
  expect(await search(page)).toContain("Best move");
  const profileAfter = await searchProfile(page);
  expect(profileAfter, "the changed search visits a different number of positions").not.toBe(profileBefore);
  await shot(page, "full-changed");

  // Move generation is untouched: perft and the move-generation check.
  await perft(page, 4, "197,281");
  const check = visibleTool(page).locator(".workshop-subsection").nth(1);
  await check.locator("select").selectOption("3");
  await check.getByRole("button", { name: "Check move generation" }).click();
  await expect(check.locator(".callout")).toContainText(/All \d+ counts match/, { timeout: LONG });

  // A short Arena match against Classic, started from the Workshop's Match button.
  await header(page).getByRole("link", { name: "Match" }).click();
  const dialog = page.locator(".arena-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Classic (full)");
  await page.getByRole("button", { name: "Engine 2", exact: true }).click();
  await page.locator('li[role="option"]').filter({ has: page.locator(".cb-ep-name", { hasText: /^Classic$/ }) }).click();
  await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
  const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
  await nodesCap.locator('input[type="checkbox"]').check();
  await nodesCap.locator("input.input").fill("2000");
  await page.getByLabel("Games per pairing").fill("2");
  await page.getByLabel("Games at once").fill("2");
  await page.getByTestId("arena-form-start").click();
  await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
  const matchId = page.url().split("/").pop()!;
  const results = await page.evaluate(async (mid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return ((await s.matchesRepo.get(mid))?.results ?? []).map((r) => r.termination);
  }, matchId);
  expect(results).toHaveLength(2);
  expect(results.filter((t) => t === "engine-error" || t === "timeout")).toEqual([]);
  await shot(page, "full-arena");

  // Files: a new lib/util.ts, used from main.ts.
  await openWorkshop(page, id);
  await tree(page).getByRole("button", { name: "New file" }).click();
  await page.keyboard.type("lib/util");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("util.ts");
  const starter = await editorText(page, editor);
  expect(starter, "the new file's hint uses imports that work from lib/").toContain('from "../position"');
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await typeLine(page, "/** Appended to the engine's name. */");
  await typeLine(page, "export function nameSuffix(): string {");
  await typeLine(page, 'return " (util)";', { enter: false });
  await expect.poll(() => storedFile(page, id, "lib/util.ts"), { timeout: 10_000 }).toContain('export function nameSuffix(): string {\n  return " (util)";\n}');
  await openFile(page, "main.ts");
  await replaceAll(page, editor, 'import { MOVE_NONE } from "./types";', 'import { MOVE_NONE } from "./types"; import { nameSuffix } from "./lib/util";');
  await replaceAll(page, editor, "outString(ENGINE_NAME);", "outString(ENGINE_NAME + nameSuffix());");
  expect(await build(page)).toMatch(/Up to date/);
  await sideTab(page, "Test");
  await page.locator(".workshop-engine-status.idle").getByRole("button", { name: "Start engine" }).click();
  await expect(page.locator(".workshop-engine-status.ready")).toContainText("My Full Engine 2.0 (util)", { timeout: LONG });

  // Renaming lib/util.ts keeps main.ts working: its import is updated.
  await treeRow(page, "util.ts").hover();
  await tree(page).getByRole("button", { name: "Actions for util.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Rename" }).click();
  await page.keyboard.type("names");
  await page.keyboard.press("Enter");
  await expect(treeRow(page, "names.ts")).toBeVisible();
  await expect(toast(page, "Renamed to lib/names.ts")).toContainText("main.ts");
  await expect.poll(() => storedFile(page, id, "main.ts"), { timeout: 10_000 }).toContain('import { nameSuffix } from "./lib/names";');
  expect(await build(page)).toMatch(/Up to date/);

  // Another entry file, and back.
  await openFile(page, "names.ts");
  await page.getByRole("button", { name: "File actions" }).click();
  await page.locator(".workshop-menu-item", { hasText: "Set as entry file" }).click();
  await expect(treeRow(page, "names.ts").locator(".cb-tree-entry")).toBeVisible();
  expect(await build(page)).toMatch(/Not a working engine/);
  await treeRow(page, "main.ts").hover();
  await tree(page).getByRole("button", { name: "Actions for main.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Set as entry file" }).click();
  await expect.poll(async () => (await stored(page, id))?.entry).toBe("main.ts");
  expect(await build(page)).toMatch(/Up to date/);

  // Deleting lib/names.ts asks first (and says who imports it); the broken import is a clear error.
  await treeRow(page, "names.ts").hover();
  await tree(page).getByRole("button", { name: "Actions for names.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Delete" }).click();
  const confirmDialog = page.locator(".modal");
  await expect(confirmDialog).toContainText("main.ts");
  await confirmDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(treeRow(page, "names.ts")).toBeVisible();
  await treeRow(page, "names.ts").hover();
  await tree(page).getByRole("button", { name: "Actions for names.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Delete" }).click();
  await page.locator(".modal").getByRole("button", { name: "Delete file" }).click();
  await expect(treeRow(page, "names.ts")).toHaveCount(0);
  await expect.poll(async () => Object.keys((await stored(page, id))?.files ?? {})).not.toContain("lib/names.ts");
  expect(await build(page)).toMatch(/error/);
  const diag = page.locator(".workshop-pane--build .workshop-diag.error").first();
  await expect(diag).toContainText("main.ts:");
  await shot(page, "full-broken-import");
  await setTheme(page, "light");
  await shot(page, "full-broken-import-light");
  await setTheme(page, "dark");
  const message = (await diag.textContent()) ?? "";
  expect(message).toMatch(/lib\/names/);
  // The message leads to the import line.
  await diag.click();
  await expect(activeTab(page)).toContainText("main.ts");
  await expect(page.locator(`${editor} .cm-activeLine`)).toContainText('from "./lib/names"');
});

// =============================================================================================
// 3. From scratch
// =============================================================================================

/**
 * Selects the text of the first line (from the top) containing `text`, without its indentation:
 * Ctrl+F finds it, Escape closes the search panel, End / Shift+Home select the line.
 */
async function selectLine(page: Page, scope: string, text: string): Promise<void> {
  await focusEditor(page, scope);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+F");
  const field = page.locator(`${scope} .cm-search input[name=search]`);
  await expect(field).toBeFocused();
  // Typed, not filled: the panel takes the query on key presses.
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${scope} .cm-search`)).toHaveCount(0);
  await expect.poll(async () => (await editorState(page, scope)).selection).toBe(text);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
}

/**
 * What a user adds to the empty skeleton to follow its roadmap far enough to play: steps 1-3 —
 * a board read from the position command, legal move generation (castling left out for now) and
 * "make cb_go write the first legal move". It goes below `let positionCommand`.
 */
const FIRST_MOVER = `

// --- Roadmap steps 1-3: a board, legal moves and the first legal move ---------
//
// The board is an array of 64 squares (0 = a1 ... 63 = h8) holding FEN letters
// ("P" = white pawn, "n" = black knight, ...) as character codes; 0 = empty.
const board = new StaticArray<i32>(64);
let side: i32 = 0; // 0 = White to move, 1 = Black
let epSquare: i32 = -1; // en-passant target square, or -1

const KNIGHT_JUMPS: StaticArray<i32> = [17, 15, 10, 6, -6, -10, -15, -17];
const KING_STEPS: StaticArray<i32> = [8, 9, 1, -7, -8, -9, -1, 7];
const ROOK_DIRS: StaticArray<i32> = [8, -8, 1, -1];
const BISHOP_DIRS: StaticArray<i32> = [9, 7, -7, -9];

/** 0 for a white piece (upper case), 1 for a black one. */
function colorOf(piece: i32): i32 {
  return piece < 97 ? 0 : 1;
}

/** The piece letter in lower case: 112 p, 110 n, 98 b, 114 r, 113 q, 107 k. */
function kindOf(piece: i32): i32 {
  return piece | 32;
}

/** The letter of a piece of \`color\`: p becomes P for White. */
function pieceFor(color: i32, letter: i32): i32 {
  return color == 0 ? letter - 32 : letter;
}

/** True if \`to\` is on the board and at most \`maxFiles\` files from \`from\` (no wrapping round the edge). */
function onBoardStep(from: i32, to: i32, maxFiles: i32): bool {
  return to >= 0 && to < 64 && abs<i32>((to & 7) - (from & 7)) <= maxFiles;
}

/** "e4" (at index \`at\` of \`s\`) becomes 28; -1 if it is not a square. */
function squareOf(s: string, at: i32): i32 {
  const file = s.charCodeAt(at) - 97;
  const rank = s.charCodeAt(at + 1) - 49;
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : -1;
}

/** Reads the pieces, the side to move and the en-passant square of a FEN. */
function setFen(placement: string, toMove: string, ep: string): bool {
  for (let i = 0; i < 64; i++) board[i] = 0;
  let rank = 7;
  let file = 0;
  for (let i = 0; i < placement.length; i++) {
    const c = placement.charCodeAt(i);
    if (c == 47) {
      rank--; // "/": the next rank down
      file = 0;
    } else if (c >= 49 && c <= 56) {
      file += c - 48; // "1".."8": empty squares
    } else {
      if (rank < 0 || file > 7) return false;
      board[rank * 8 + file] = c;
      file++;
    }
  }
  side = toMove == "b" ? 1 : 0;
  epSquare = ep == "-" ? -1 : squareOf(ep, 0);
  return true;
}

/** Plays a move (promotion: 0 or a lower-case letter), moving the rook when castling and taking en passant. */
function play(from: i32, to: i32, promotion: i32): void {
  const piece = board[from];
  const kind = kindOf(piece);
  // En passant: a pawn moving diagonally onto an empty square takes the pawn beside it.
  if (kind == 112 && (to - from) % 8 != 0 && board[to] == 0) board[to + (side == 0 ? -8 : 8)] = 0;
  // Castling: the king moves two squares and the rook jumps over it.
  if (kind == 107 && abs<i32>(to - from) == 2) {
    const rookFrom = to > from ? from + 3 : from - 4;
    const rookTo = to > from ? from + 1 : from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = 0;
  }
  board[to] = promotion != 0 ? pieceFor(side, promotion) : piece;
  board[from] = 0;
  epSquare = kind == 112 && abs<i32>(to - from) == 16 ? (from + to) / 2 : -1;
  side ^= 1;
}

/** Sets the board from a position command: "startpos moves e2e4 ..." or "fen <6 fields> moves ...". */
function setup(command: string): bool {
  const words = command.split(" ");
  let i = 0;
  if (words[0] == "startpos") {
    setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR", "w", "-");
    i = 1;
  } else if (words[0] == "fen" && words.length >= 7) {
    if (!setFen(words[1], words[2], words[4])) return false;
    i = 7;
  } else {
    return false;
  }
  if (i < words.length && words[i] == "moves") {
    for (i++; i < words.length; i++) {
      const move = words[i];
      const from = move.length >= 4 ? squareOf(move, 0) : -1;
      const to = move.length >= 4 ? squareOf(move, 2) : -1;
      if (from < 0 || to < 0 || board[from] == 0) return false;
      play(from, to, move.length > 4 ? move.charCodeAt(4) : 0);
    }
  }
  return true;
}

/** Is square \`sq\` attacked by a piece of colour \`by\`? */
function attacked(sq: i32, by: i32): bool {
  // A pawn attacks diagonally forward, so look for one diagonally behind sq.
  const back = by == 0 ? -8 : 8;
  for (let d = -1; d <= 1; d += 2) {
    const from = sq + back + d;
    if (onBoardStep(sq, from, 1) && board[from] == pieceFor(by, 112)) return true;
  }
  for (let i = 0; i < 8; i++) {
    const jump = sq + KNIGHT_JUMPS[i];
    if (onBoardStep(sq, jump, 2) && board[jump] == pieceFor(by, 110)) return true;
    const step = sq + KING_STEPS[i];
    if (onBoardStep(sq, step, 1) && board[step] == pieceFor(by, 107)) return true;
  }
  for (let i = 0; i < 4; i++) {
    if (slidesTo(sq, ROOK_DIRS[i], pieceFor(by, 114), pieceFor(by, 113))) return true;
    if (slidesTo(sq, BISHOP_DIRS[i], pieceFor(by, 98), pieceFor(by, 113))) return true;
  }
  return false;
}

/** Walks from sq in direction dir to the first piece: is it \`a\` or \`b\`? */
function slidesTo(sq: i32, dir: i32, a: i32, b: i32): bool {
  for (let to = sq + dir; onBoardStep(to - dir, to, 1); to += dir) {
    const piece = board[to];
    if (piece != 0) return piece == a || piece == b;
  }
  return false;
}

// Moves are stored as  from | to << 6 | promotion letter << 12.
const moves = new StaticArray<i32>(256);
let moveCount = 0;

function pushMove(from: i32, to: i32, promotion: i32): void {
  moves[moveCount++] = from | (to << 6) | (promotion << 12);
}

/** An empty square, or an enemy piece to capture? */
function canLand(to: i32): bool {
  return board[to] == 0 || colorOf(board[to]) != side;
}

/** Every move that follows the piece rules (it may still leave the own king in check). No castling yet. */
function generate(): void {
  moveCount = 0;
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece == 0 || colorOf(piece) != side) continue;
    const kind = kindOf(piece);
    if (kind == 112) {
      pawnMoves(from);
    } else if (kind == 110 || kind == 107) {
      const jumps = kind == 110 ? KNIGHT_JUMPS : KING_STEPS;
      for (let i = 0; i < 8; i++) {
        const to = from + jumps[i];
        if (onBoardStep(from, to, kind == 110 ? 2 : 1) && canLand(to)) pushMove(from, to, 0);
      }
    } else {
      for (let i = 0; i < 4; i++) {
        if (kind != 98) slide(from, ROOK_DIRS[i]); // rook or queen
        if (kind != 114) slide(from, BISHOP_DIRS[i]); // bishop or queen
      }
    }
  }
}

function slide(from: i32, dir: i32): void {
  for (let to = from + dir; onBoardStep(to - dir, to, 1); to += dir) {
    if (board[to] != 0) {
      if (colorOf(board[to]) != side) pushMove(from, to, 0);
      return;
    }
    pushMove(from, to, 0);
  }
}

function pawnMoves(from: i32): void {
  const up = side == 0 ? 8 : -8;
  const ahead = from + up;
  if (ahead < 0 || ahead >= 64) return;
  if (board[ahead] == 0) {
    pawnMove(from, ahead);
    const startRank = side == 0 ? 1 : 6;
    if ((from >> 3) == startRank && board[ahead + up] == 0) pushMove(from, ahead + up, 0);
  }
  for (let d = -1; d <= 1; d += 2) {
    const to = ahead + d;
    if (!onBoardStep(from, to, 1)) continue;
    if ((board[to] != 0 && colorOf(board[to]) != side) || to == epSquare) pawnMove(from, to);
  }
}

/** A pawn move; on the last rank the pawn becomes a queen. */
function pawnMove(from: i32, to: i32): void {
  const lastRank = side == 0 ? 7 : 0;
  pushMove(from, to, (to >> 3) == lastRank ? 113 : 0);
}

const savedBoard = new StaticArray<i32>(64);

/** Does the move keep the own king out of check? (Plays it, looks, and takes it back.) */
function isLegal(move: i32): bool {
  for (let i = 0; i < 64; i++) savedBoard[i] = board[i];
  const savedSide = side;
  const savedEp = epSquare;
  play(move & 63, (move >> 6) & 63, move >> 12);
  let king = -1;
  for (let i = 0; i < 64; i++) if (board[i] == pieceFor(savedSide, 107)) king = i;
  const legal = king >= 0 && !attacked(king, side);
  for (let i = 0; i < 64; i++) board[i] = savedBoard[i];
  side = savedSide;
  epSquare = savedEp;
  return legal;
}

/** The first legal move of the side to move, or -1 when there is none. */
function firstLegalMove(): i32 {
  generate();
  for (let i = 0; i < moveCount; i++) if (isLegal(moves[i])) return moves[i];
  return -1;
}

/** A move as UCI text, e.g. "e2e4" or "e7e8q". */
function uci(move: i32): string {
  const from = move & 63;
  const to = (move >> 6) & 63;
  let text = String.fromCharCode(97 + (from & 7)) + String.fromCharCode(49 + (from >> 3));
  text += String.fromCharCode(97 + (to & 7)) + String.fromCharCode(49 + (to >> 3));
  if ((move >> 12) != 0) text += String.fromCharCode(move >> 12);
  return text;
}`;

/** Plays one engine-vs-engine game on the Play page at a node limit; returns the saved game. */
async function playEngineGame(page: Page, white: string, black: string, nodes: number): Promise<{ termination: string; result: string; plies: number; banner: string }> {
  await page.goto("/#/play");
  await expect(page.locator(".play-setup")).toBeVisible({ timeout: 30_000 });
  await page.locator(".play-preset", { hasText: "Engine vs engine" }).click();
  for (const [side, name] of [
    ["White", white],
    ["Black", black],
  ] as const) {
    await page.getByRole("button", { name: `${side} player` }).click();
    await page.getByRole("option").filter({ has: page.locator(".cb-ep-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) }).click();
    await expect(page.getByRole("button", { name: `${side} player` })).toContainText(name);
  }
  for (const side of ["w", "b"] as const) {
    const card = page.locator(`.play-sidecard[data-side="${side}"]`);
    await card.getByLabel("Time per move").fill("");
    await card.getByLabel("Max positions searched (nodes)").fill(String(nodes));
  }
  await page.getByLabel("Move delay in milliseconds").focus();
  await page.keyboard.press("Home");
  const before = await page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).gamesRepo.list()).length);
  await page.locator(".play-start-button").click();
  const banner = page.locator(".play-result");
  await expect(banner).toBeVisible({ timeout: 150_000 });
  await expect(banner).toContainText("Saved to your games");
  await expect.poll(async () => page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).gamesRepo.list()).length)).toBe(before + 1);
  const game = await page.evaluate(async () => {
    const games = await ((await import(String("/src/storage/index.ts"))) as StorageModule).gamesRepo.list();
    const g = games.sort((a, b) => b.createdAt - a.createdAt)[0];
    return { termination: g.termination, result: g.result, plies: g.moves.length };
  });
  return { ...game, banner: (await banner.textContent()) ?? "" };
}

const NORMAL_ENDINGS = ["checkmate", "stalemate", "threefold", "fifty-move", "insufficient-material"];

test("From scratch: the empty skeleton's roadmap leads to a legal move and a whole game; the minimal variant changed and perft-checked", async ({ page }) => {
  test.setTimeout(LONG);
  await seeded(page);
  const id = await createWithWizard(page, "scratch", "First mover", "Empty skeleton");
  await expect(header(page).locator(".cb-kind")).toHaveText("Scratch");
  const editor = MAIN_EDITOR;
  const skeleton = await editorText(page, editor);
  // The comments say what to implement, in which order.
  expect(skeleton).toContain("ROADMAP");
  expect(skeleton).toContain("3. Play! Make cb_go write the first legal move.");
  expect(skeleton).toMatch(/TODO \(roadmap steps 3-6\)/);
  await shot(page, "scratch-skeleton");

  // As it is: it builds, but has no move.
  expect(await build(page)).toMatch(/Up to date/);
  await setSearchLimits(page, { depth: 1 });
  expect(await search(page)).toContain("The engine produced no move");

  // Steps 1-3 of the roadmap: the board, legal moves, the first legal move.
  await selectLine(page, editor, 'let positionCommand: string = "startpos";');
  await page.keyboard.press("End");
  await page.keyboard.insertText(FIRST_MOVER);
  await selectLine(page, editor, 'positionCommand.split(" ")');
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  expect((await editorState(page, editor)).selection).toBe("return 1;");
  await page.keyboard.insertText("return setup(positionCommand) ? 1 : 0;");
  await selectLine(page, editor, 'log("cb_go: no search yet');
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.insertText("const move = firstLegalMove();\n  if (move >= 0) return writeOutput(uci(move));");
  await replaceAll(page, editor, "My Engine 0.1", "First Mover 0.1");
  await expect.poll(() => storedFile(page, id, "main.ts"), { timeout: 10_000 }).toContain("return writeOutput(uci(move));");
  const result = await build(page);
  if (!/Up to date/.test(result)) throw new Error(`build failed: ${await page.locator(".workshop-pane--build").textContent()}`);
  await shot(page, "scratch-first-mover");

  // The first legal move from the start: b1 knight to c3.
  const text = await search(page);
  expect(text).toContain("Best move");
  expect(text).toContain("Nc3");
  await expect(page.locator(".workshop-engine-status.ready")).toContainText("First Mover 0.1");

  // A whole game in Play against Classic: lost, but on the board — never "produced no move".
  const game = await playEngineGame(page, "Classic", "First mover", 2000);
  expect(game.banner).not.toContain("produced no move");
  expect(game.termination, game.banner).not.toBe("engine-error");
  expect(NORMAL_ENDINGS).toContain(game.termination);
  await shot(page, "scratch-game");

  // The minimal variant: a different name and knight value, then perft and the move-generation check.
  const minimal = await createWithWizard(page, "scratch", "Minimal mine", "Minimal working engine");
  const source = await editorText(page, editor);
  expect(source).toContain("perft");
  await replaceAll(page, editor, "const PIECE_VALUE: StaticArray<i32> = [100, 320,", "const PIECE_VALUE: StaticArray<i32> = [100, 305,");
  await expect.poll(() => storedFile(page, minimal, "main.ts"), { timeout: 10_000 }).toContain("[100, 305,");
  expect(await build(page)).toMatch(/Up to date/);
  await perft(page, 4, "197,281");
  const check = visibleTool(page).locator(".workshop-subsection").nth(1);
  await check.locator("select").selectOption("4");
  await check.getByRole("button", { name: "Check move generation" }).click();
  await expect(check.locator(".callout")).toContainText(/All \d+ counts match/, { timeout: LONG });
  await shot(page, "scratch-minimal-perft");
  // Both engines are in the library, built.
  await page.goto("/#/engines");
  await expect(page.locator(".engines-card", { hasText: "First mover" })).toBeVisible();
  await shot(page, "scratch-library");
});

// =============================================================================================
// 4. Upload .wasm
// =============================================================================================

/** The scratch-minimal engine compiled to .wasm (scripts/scratch-test.mjs writes it if missing). */
function minimalWasmFile(): string {
  const file = join(ROOT, ".scratch/scratch/scratch-minimal.wasm");
  if (!existsSync(file)) execFileSync(process.execPath, [join(ROOT, "scripts/scratch-test.mjs"), "--quick", "--write-wasm"], { cwd: ROOT, stdio: "ignore", timeout: 170_000 });
  return file;
}

test("Upload .wasm: the compiled minimal engine becomes an engine that plays in Play and in the Arena", async ({ page }) => {
  test.setTimeout(LONG);
  const wasm = minimalWasmFile();
  await seeded(page);
  await page.goto("/#/engines?new=1&kind=wasm");
  const wizard = page.locator(".modal");
  const chooser = page.waitForEvent("filechooser");
  await wizard.getByRole("button", { name: "Choose file…" }).click();
  await (await chooser).setFiles(wasm);
  await expect(wizard).toContainText("it calls itself", { timeout: 60_000 });
  await wizard.getByLabel("Name", { exact: true }).fill("Uploaded minimal");
  await wizard.getByRole("button", { name: "Create engine" }).click();
  await expect(page.locator(".workshop-wasm")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".workshop-wasm .badge", { hasText: "ABI v1 OK" })).toBeVisible({ timeout: 30_000 });
  const id = idFromUrl(page);
  await setSearchLimits(page, { depth: 3 });
  expect(await search(page)).toContain("Best move");
  await shot(page, "wasm-uploaded");

  // In Play, against Classic.
  const game = await playEngineGame(page, "Uploaded minimal", "Classic", 2000);
  expect(game.termination, game.banner).not.toBe("engine-error");
  expect(NORMAL_ENDINGS).toContain(game.termination);

  // In the Arena, against Classic: two games at 2000 nodes.
  await page.goto(`/#/arena?new=1&engines=${id}`);
  const dialog = page.locator(".arena-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Uploaded minimal");
  await page.getByRole("button", { name: "Engine 2", exact: true }).click();
  await page.locator('li[role="option"]').filter({ has: page.locator(".cb-ep-name", { hasText: /^Classic$/ }) }).click();
  await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
  const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
  await nodesCap.locator('input[type="checkbox"]').check();
  await nodesCap.locator("input.input").fill("2000");
  await page.getByLabel("Games per pairing").fill("2");
  await page.getByLabel("Games at once").fill("2");
  await page.getByTestId("arena-form-start").click();
  await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId("arena-detail")).toHaveAttribute("data-status", "finished", { timeout: 150_000 });
  const matchId = page.url().split("/").pop()!;
  const results = await page.evaluate(async (mid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return ((await s.matchesRepo.get(mid))?.results ?? []).map((r) => r.termination);
  }, matchId);
  expect(results).toHaveLength(2);
  expect(results.filter((t) => t === "engine-error" || t === "timeout" || t === "illegal-move")).toEqual([]);
  await shot(page, "wasm-arena");
});

// =============================================================================================
// 5. Editor ergonomics
// =============================================================================================

test("Editor ergonomics: per-file undo, find / replace, Ctrl+S, Ctrl+B, indentation, long files, next error, narrow drawer, read-only files", async ({ page }) => {
  test.setTimeout(LONG);
  const ids = await seeded(page);
  const templates = await page.evaluate(async () => ((await import(String("/src/engine-host/templates.ts"))) as TemplatesModule).templateFiles);
  const id = await createWithWizard(page, "full", "Ergonomic");
  const editor = MAIN_EDITOR;

  // Undo history per file: an edit in search.ts and one in eval.ts are undone separately.
  await openFile(page, "search.ts");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// tuned later");
  await expect.poll(() => editorText(page, editor), { timeout: 2_000 }).toContain("// tuned later");
  await openFile(page, "eval.ts");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// my eval note");
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toContain("// my eval note");
  expect(await storedFile(page, id, "search.ts")).toContain("// tuned later");
  await openFile(page, "search.ts");
  await expect.poll(() => editorText(page, editor)).toContain("// tuned later");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+Z");
  await expect.poll(() => editorText(page, editor)).toBe(templates["search.ts"]);
  // More undos have nothing left to undo here, and never touch eval.ts.
  await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+Z");
  expect(await editorText(page, editor)).toBe(templates["search.ts"]);
  await expect.poll(() => storedFile(page, id, "search.ts"), { timeout: 10_000 }).toBe(templates["search.ts"]);
  expect(await storedFile(page, id, "eval.ts")).toContain("// my eval note");
  // Redo brings it back; eval.ts keeps its own history.
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(() => editorText(page, editor)).toContain("// tuned later");
  await openFile(page, "eval.ts");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+Z");
  await expect.poll(() => editorText(page, editor)).toBe(templates["eval.ts"]);
  await page.keyboard.press("Control+Y");
  await expect.poll(() => editorText(page, editor)).toContain("// my eval note");

  // Find and replace: Ctrl+F finds (matches highlighted), Ctrl+H goes straight to Replace.
  await openFile(page, "search.ts");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+F");
  const panel = page.locator(`${editor} .cm-search`);
  await expect(panel.locator("input[name=search]")).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("RFP_MARGIN");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${editor} .cm-searchMatch`).first()).toBeAttached();
  expect((await editorState(page, editor)).selection).toBe("RFP_MARGIN");
  await shot(page, "ergonomics-find");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Control+H");
  await expect(panel.locator("input[name=replace]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(`${editor} .cm-content`)).toBeFocused();

  // Ctrl+S saves at once (no browser dialog, well before the autosave delay).
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" // saved now");
  const t0 = Date.now();
  await page.keyboard.press("Control+S");
  await expect.poll(() => storedFile(page, id, "search.ts"), { intervals: [25], timeout: 5_000 }).toContain("// saved now");
  expect(Date.now() - t0).toBeLessThan(450);
  await expect(page.locator(".workshop-save")).toHaveText(/Saved/);

  // Ctrl+B from the editor builds; two mistakes, F8 jumps from one to the next.
  await openFile(page, "eval.ts");
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('const firstMistake: i32 = "one";\n\nconst secondMistake: i32 = "two";\n');
  await expect.poll(() => storedFile(page, id, "eval.ts"), { timeout: 10_000 }).toContain("secondMistake");
  expect(await build(page, () => page.keyboard.press("Control+B"))).toMatch(/2 errors/);
  await expect(page.locator(".workshop-pane--build .workshop-diag.error")).toHaveCount(2);
  await expect(page.locator(`${editor} .cm-lint-marker-error`)).toHaveCount(2);
  await focusEditor(page, editor);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F8");
  await expect(page.locator(`${editor} .cm-activeLine`)).toContainText("firstMistake");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F8");
  await expect(page.locator(`${editor} .cm-activeLine`)).toContainText("secondMistake");
  await shot(page, "ergonomics-errors");
  // Undo removes the pasted mistakes; Ctrl+B again.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+Z");
  await expect.poll(() => editorText(page, editor)).not.toContain("Mistake");
  expect(await build(page, () => page.keyboard.press("Control+B"))).toMatch(/Up to date/);

  // Indentation: Tab / Shift+Tab indent and dedent the selected lines by two spaces.
  const beforeIndent = await editorText(page, editor);
  await selectLine(page, editor, "export function evaluate(");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Tab");
  const indented = (await editorText(page, editor)).split("\n");
  const at = indented.findIndex((l) => l.includes("export function evaluate("));
  expect(indented[at].startsWith("  export function evaluate(")).toBe(true);
  expect(indented[at + 1].startsWith("    ")).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await editorText(page, editor)).toBe(beforeIndent);
  // Ctrl+/ comments the selected lines out and back in.
  await page.keyboard.press("Control+/");
  const commented = (await editorText(page, editor)).split("\n");
  expect(commented[at]).toMatch(/^\/\/ ?export function evaluate\(/);
  expect(commented[at + 1].trimStart().startsWith("//")).toBe(true);
  await page.keyboard.press("Control+/");
  expect(await editorText(page, editor)).toBe(beforeIndent);

  // A long file: position.ts, to its end and to a line by number (Ctrl+G).
  await openFile(page, "position.ts");
  const lines = templates["position.ts"].split("\n").length;
  expect(lines).toBeGreaterThan(500);
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await expect.poll(async () => (await editorState(page, editor)).line).toBe(lines);
  await expect(page.locator(`${editor} .cm-gutterElement`, { hasText: new RegExp(`^${lines}$`) }).first()).toBeInViewport();
  await page.keyboard.press("Control+G");
  const goto = page.locator(`${editor} .cm-goto-line input[name=line]`);
  await expect(goto).toBeFocused();
  await page.keyboard.type("400");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await editorState(page, editor)).line).toBe(400);
  await expect(page.locator(`${editor} .cm-activeLine`)).toBeInViewport();

  // The keys are listed next to the file controls.
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  const shortcuts = page.locator(".modal", { hasText: "Keyboard shortcuts" });
  await expect(shortcuts).toContainText("Go to line");
  await expect(shortcuts).toContainText("Next error or warning");
  await shot(page, "ergonomics-shortcuts-dark");
  await shortcuts.getByRole("button", { name: "Done" }).click();
  await expect(shortcuts).toHaveCount(0);

  // A file in a folder, then the narrow layout: the tree is a drawer.
  await tree(page).getByRole("button", { name: "New file" }).click();
  await page.keyboard.type("lib/notes");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("notes.ts");
  // Its first template function from autocompletion gets an import that works from lib/.
  await focusEditor(page, editor);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("export const CORNERS = ");
  await complete(page, "squareDist", "squareDistance");
  await typeLine(page, "(0, 63);", { enter: false });
  await expect.poll(() => editorText(page, editor)).toContain('import { squareDistance } from "../bitboard";');
  await openFile(page, "main.ts");
  await page.setViewportSize({ width: 400, height: 860 });
  await expect(page.locator(".workshop-stack-tabs")).toBeVisible();
  await sideTab(page, "Files");
  await expect(page.locator(".workshop-main")).toBeVisible();
  await expect(tree(page)).toBeHidden();
  await noHorizontalScroll(page);
  const filesButton = page.getByRole("button", { name: "Files", exact: true });
  await filesButton.click();
  await expect(tree(page)).toBeVisible();
  await expect(treeRow(page, "notes.ts")).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "ergonomics-narrow-drawer-dark");
  await setTheme(page, "light");
  await shot(page, "ergonomics-narrow-drawer-light");
  await treeRow(page, "notes.ts").click();
  await expect(tree(page)).toBeHidden();
  await expect(activeTab(page)).toContainText("notes.ts");
  await expect.poll(() => editorText(page, editor)).toContain("// notes.ts");
  // The open file's tab is scrolled into sight in the narrow tab strip.
  const tabInSight = () =>
    page.evaluate(() => {
      const strip = document.querySelector(".workshop-filetabs-scroll")!.getBoundingClientRect();
      const tab = document.querySelector(".workshop-filetab.active")!.getBoundingClientRect();
      return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
    });
  await expect.poll(tabInSight).toBe(true);
  await filesButton.click();
  await treeRow(page, "bitboard.ts").click();
  await expect(activeTab(page)).toContainText("bitboard.ts");
  await expect.poll(tabInSight).toBe(true);
  await filesButton.click();
  await treeRow(page, "notes.ts").click();
  await expect.poll(tabInSight).toBe(true);
  await shot(page, "ergonomics-narrow-editor-light");
  // Keyboard: the drawer opens from its button and Escape closes it, back on the button.
  await filesButton.focus();
  await page.keyboard.press("Enter");
  await expect(tree(page)).toBeVisible();
  await treeRow(page, "main.ts").focus();
  await page.keyboard.press("Escape");
  await expect(tree(page)).toBeHidden();
  await expect(filesButton).toBeFocused();
  await setTheme(page, "dark");
  await page.setViewportSize({ width: 1440, height: 900 });

  // An eval engine's template files are read-only: typing explains why and how to unlock them.
  await openWorkshop(page, ids.Classic);
  await sideTab(page, "Engine source");
  const source = page.locator(".workshop-pane--source");
  await source.locator("select").selectOption("movegen.ts");
  await expect.poll(() => editorText(page, ".workshop-pane--source")).toBe(templates["movegen.ts"]);
  const note = source.locator(".workshop-source-note");
  await expect(note).toContainText("Read-only");
  await expect(note.getByRole("button", { name: "Unlock the full engine source" })).toBeVisible();
  await page.locator(".workshop-pane--source .cm-line").nth(4).click({ position: { x: 24, y: 6 } });
  await page.keyboard.type("x");
  expect(await editorText(page, ".workshop-pane--source")).toBe(templates["movegen.ts"]);
  await expect(note).toHaveClass(/workshop-source-note--nudge/);
  await expect(note).toContainText("movegen.ts can't be edited in this engine.");
  await shot(page, "ergonomics-readonly-dark");
  await setTheme(page, "light");
  await shot(page, "ergonomics-readonly-light");
  await setTheme(page, "dark");
  await expect(note).not.toHaveClass(/workshop-source-note--nudge/, { timeout: 5_000 });
  // Selecting and copying still work in a read-only file.
  await page.keyboard.press("Control+A");
  expect((await editorState(page, ".workshop-pane--source")).selection).toBe(templates["movegen.ts"]);
  // Unlock: a full copy where the same file is editable.
  await note.getByRole("button", { name: "Unlock the full engine source" }).click();
  await expect(header(page).locator(".cb-kind")).toHaveText("Full code");
  await openFile(page, "movegen.ts");
  await expect(page.locator(`${editor} .cm-content`)).not.toHaveAttribute("aria-readonly", "true");
});
