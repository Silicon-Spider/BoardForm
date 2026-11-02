// End-to-end tests of the Workshop (#/engines/:id): every engine kind (blocks, eval, nnue, full,
// scratch, wasm), building with errors and fixes, the test bench tools (evaluate + breakdown,
// search, perft, move-generation check, console), the file tree, conversions, deleting, autosave
// (debounce, navigating away, reload, Ctrl+S), the resizable split, the narrow layout and themes.
//
// Run: E2E_PORT=5211 npx playwright test e2e/workshop.spec.ts
// Set E2E_SHOTS=<dir> to also write screenshots of the states the tests pass through.
//
// Every test gets a fresh browser context (empty IndexedDB), so the app seeds the three starter
// engines (Blocky, Classic, Sprout) on load; `seeded` waits for them. Other engines are written
// straight into IndexedDB through the app's own modules (Vite serves the sources in dev). Searches
// use node or depth limits so results do not depend on the machine's speed.
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type * as EngineHostTemplates from "../src/engine-host/templates.ts";
import type * as NnueModule from "../src/nnue/index.ts";
import type * as StorageModule from "../src/storage/index.ts";
import type { EngineRecord } from "../src/types/index.ts";

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

type EngineIds = Record<"Blocky" | "Classic" | "Sprout", string> & Record<string, string>;

/** Opens the app and waits until the starter engines exist. Returns name → id. */
async function seeded(page: Page): Promise<EngineIds> {
  await page.goto("/#/engines");
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
          return (await s.enginesRepo.list()).length;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(3);
  return page.evaluate(async () => {
    const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
    return Object.fromEntries((await s.enginesRepo.list()).map((e) => [e.name, e.id]));
  }) as Promise<EngineIds>;
}

interface EngineSpec {
  kind: "eval" | "nnue" | "full" | "scratch-empty" | "scratch-minimal" | "wasm";
  name: string;
  wasmBase64?: string;
  networkId?: string | null;
  templateVersion?: number;
}

/** Writes a new engine record into IndexedDB (like the library's wizard would) and returns its id. */
async function createEngine(page: Page, spec: EngineSpec): Promise<string> {
  return page.evaluate(async (spec) => {
    const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
    const t = (await import("/src/engine-host/templates.ts" as string)) as typeof EngineHostTemplates;
    const now = Date.now();
    const kind = spec.kind === "scratch-empty" || spec.kind === "scratch-minimal" ? "scratch" : spec.kind;
    const files =
      spec.kind === "scratch-empty" ? t.scratchFiles("empty") : spec.kind === "scratch-minimal" ? t.scratchFiles("minimal") : spec.kind === "wasm" ? undefined : t.defaultFilesFor(kind);
    const record: EngineRecord = {
      id: s.newId(),
      name: spec.name,
      description: `Test ${spec.kind} engine`,
      kind,
      createdAt: now,
      updatedAt: now,
      color: "#a78bfa",
      files,
      entry: "main.ts",
      templateVersion: spec.templateVersion ?? t.TEMPLATE_VERSION,
      networkId: spec.networkId ?? null,
      options: { hashMb: 16 },
      build: null,
      parentId: null,
      tags: [],
    };
    if (spec.wasmBase64) {
      const bin = atob(spec.wasmBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      record.wasm = bytes.buffer;
    }
    await s.enginesRepo.put(record);
    return record.id;
  }, spec);
}

/** Writes a random CBNN network (hidden 32, SCReLU) into IndexedDB and returns its id. */
async function createNetwork(page: Page, name: string, seed: number): Promise<string> {
  return page.evaluate(
    async ([name, seed]) => {
      const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
      const nn = (await import("/src/nnue/index.ts" as string)) as typeof NnueModule;
      const net = nn.createNetwork(32, 1, seed);
      const quantized = nn.quantizeNetwork(net);
      const id = s.newId();
      const now = Date.now();
      await s.networksRepo.put({
        id,
        name,
        description: "",
        createdAt: now,
        updatedAt: now,
        hidden: 32,
        activation: 1,
        parentId: null,
        stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
        sizeBytes: quantized.byteLength,
      });
      await s.networksRepo.putData({ id, quantized, float: net, optimizer: null });
      return id;
    },
    [name, seed] as const,
  );
}

async function stored(page: Page, id: string): Promise<EngineRecord | null> {
  return page.evaluate(async (id) => {
    const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
    const e = await s.enginesRepo.get(id);
    if (!e) return null;
    // ArrayBuffers do not survive the trip out of the page: report their size only.
    return { ...e, wasm: undefined, build: e.build ? { ...e.build, wasm: undefined } : null } as unknown as EngineRecord;
  }, id);
}

async function storedFile(page: Page, id: string, path: string): Promise<string | null> {
  return (await stored(page, id))?.files?.[path] ?? null;
}

async function getSetting<T>(page: Page, key: string): Promise<T | null> {
  return page.evaluate(async (k) => {
    const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
    return s.settingsRepo.get<unknown>(k, null);
  }, key) as Promise<T | null>;
}

async function openWorkshop(page: Page, id: string, query = ""): Promise<void> {
  await page.goto(`/#/engines/${id}${query}`);
  await expect(page.locator(".workshop-header")).toBeVisible({ timeout: 30_000 });
}

const header = (page: Page) => page.locator(".workshop-header");
const buildPill = (page: Page) => page.locator(".workshop-header-status .workshop-pill");
const saveState = (page: Page) => page.locator(".workshop-save");
const visibleTool = (page: Page) => page.locator(".workshop-tool-body > div:not([hidden])");
const toast = (page: Page, text: string | RegExp) => page.locator(".toast", { hasText: text });

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
  // The pill may still show the previous state for a moment, and a failing compile is quick:
  // watch for the "building" pill so we wait for this build, not the last one.
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

/** Opens a "⋯" style menu and chooses an item. */
async function menuChoose(page: Page, menuButton: Locator, item: string | RegExp): Promise<void> {
  await menuButton.click();
  await page.locator(".workshop-menu-item", { hasText: item }).first().click();
}

const moreMenu = (page: Page) => header(page).getByRole("button", { name: "More actions" });

/** The text of the CodeMirror editor inside `scope` (the whole document, not only the rendered lines). */
async function editorText(page: Page, scope: string): Promise<string> {
  return page.evaluate((sel) => {
    type Tiled = HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } };
    const content = document.querySelector<Tiled>(`${sel} .cm-content`);
    const view = content?.cmTile?.root?.view;
    if (view) return view.state.doc.toString();
    return [...document.querySelectorAll(`${sel} .cm-line`)].map((l) => l.textContent ?? "").join("\n");
  }, scope);
}

/** Types `text` at the end of the CodeMirror document inside `scope`. */
async function appendToEditor(page: Page, scope: string, text: string): Promise<void> {
  await page.locator(`${scope} .cm-content`).first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape"); // close a completion popup, if any
}

/** Replaces the line the cursor is on with `text` (selects it with Home / Shift+End). */
async function replaceCursorLine(page: Page, text: string): Promise<void> {
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Shift+Home"); // a second Home also takes the indentation
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape");
}

interface EvalRow {
  label: string;
  white: number;
  black: number;
  net: number;
}
interface EvalReading {
  score: string;
  rows: EvalRow[];
  total: number | null;
  text: string;
}

const signed = (s: string) => Number(s.replace("−", "-").replace("+", "").trim());

async function readEval(page: Page): Promise<EvalReading> {
  const tool = visibleTool(page);
  const rows = await tool.locator(".workshop-trace tbody tr").evaluateAll((trs) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")),
  );
  const totalText = await tool.locator(".workshop-trace tfoot strong").textContent().catch(() => null);
  return {
    score: (await tool.locator(".workshop-eval-big").textContent()) ?? "",
    rows: rows.map(([label, white, black, net]) => ({ label: label ?? "", white: Number(white), black: Number(black), net: signed(net ?? "") })),
    total: totalText ? signed(totalText) : null,
    text: (await tool.locator(".workshop-eval-result").textContent()) ?? "",
  };
}

/** Evaluate tool: clicks Evaluate and waits for a fresh result. */
async function evaluate(page: Page): Promise<EvalReading> {
  await toolTab(page, "Evaluate");
  const tool = visibleTool(page);
  const button = tool.getByRole("button", { name: "Evaluate", exact: true });
  await expect(button).toBeEnabled({ timeout: LONG });
  await button.click();
  await expect(button).toBeEnabled({ timeout: LONG });
  await expect(tool.locator(".workshop-eval-result:not(.stale)")).toBeVisible({ timeout: LONG });
  return readEval(page);
}

/** Sets the Search tool's limits (missing ones are switched off). */
async function setSearchLimits(page: Page, limits: { depth?: number; nodes?: number; movetimeS?: number }): Promise<void> {
  await toolTab(page, "Search");
  const tool = visibleTool(page);
  const fields: Array<[string, number | undefined]> = [
    ["Depth", limits.depth],
    ["Max positions searched (nodes)", limits.nodes],
    ["Time per move", limits.movetimeS],
  ];
  // Infinite analysis disables the limits: switch it off first.
  const infinite = tool.getByRole("checkbox", { name: /Infinite analysis/ });
  if (await infinite.isChecked()) await infinite.uncheck();
  // The compact limits editor: an empty field means "no cap".
  for (const [label, value] of fields) await tool.getByRole("textbox", { name: label, exact: true }).fill(value === undefined ? "" : String(value));
}

/** Search tool: Go, wait for the result block; returns its text. */
async function search(page: Page): Promise<string> {
  await toolTab(page, "Search");
  const tool = visibleTool(page);
  const go = tool.getByRole("button", { name: "Go", exact: true });
  await expect(go).toBeEnabled({ timeout: LONG });
  await go.click();
  await expect(go).toBeEnabled({ timeout: LONG });
  await expect(tool.locator(".workshop-search-result, .callout.danger").first()).toBeVisible({ timeout: LONG });
  return (await tool.locator(".workshop-search-result, .callout.danger").first().textContent()) ?? "";
}

/** The scratch-minimal engine as a .wasm module (written by scripts/scratch-test.mjs if missing). */
function minimalWasmBase64(): string {
  const file = join(ROOT, ".scratch/scratch/scratch-minimal.wasm");
  if (!existsSync(file)) execFileSync(process.execPath, [join(ROOT, "scripts/scratch-test.mjs"), "--quick", "--write-wasm"], { cwd: ROOT, stdio: "ignore", timeout: 170_000 });
  return readFileSync(file).toString("base64");
}

/** Plays a move on the test board by clicking the two squares (White at the bottom). */
async function boardMove(page: Page, from: string, to: string): Promise<void> {
  const board = page.locator('[aria-label="Test position"]').first();
  const box = await board.boundingBox();
  if (!box) throw new Error("test board not visible");
  const at = (sq: string) => {
    const col = sq.charCodeAt(0) - 97;
    const row = 8 - Number(sq[1]);
    return { x: box.x + ((col + 0.5) * box.width) / 8, y: box.y + ((row + 0.5) * box.height) / 8 };
  };
  const a = at(from);
  const b = at(to);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
}

/**
 * Asserts that every item of the open Workshop menu can really be seen and clicked: inside the
 * window and not covered or clipped by anything (elementFromPoint finds the item itself).
 */
async function expectMenuFullyVisible(page: Page): Promise<void> {
  const problems = await page.locator(".workshop-menu-list .workshop-menu-item").evaluateAll((items) =>
    items.flatMap((item) => {
      const r = item.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40);
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const inside = r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight;
      return inside && hit && item.contains(hit) ? [] : [`${item.textContent} (${Math.round(r.left)},${Math.round(r.top)})`];
    }),
  );
  expect(problems, "menu items that cannot be seen").toEqual([]);
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "page scroll width").toBeLessThanOrEqual(client);
}

// ---------------------------------------------------------------------------------------------
// Blocks

test("Blocky: a block value edited in Blockly autosaves, rebuilds and changes the evaluation", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Blocky);
  await expect(page.locator(".blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });
  const codeBefore = (await storedFile(page, ids.Blocky, "eval.ts")) ?? "";
  expect(codeBefore).toContain("generated by Chess Builder");

  const before = await evaluate(page);
  const materialBefore = before.rows.find((r) => /^material$/i.test(r.label));
  expect(materialBefore, "Material term in the breakdown").toBeTruthy();
  await shot(page, "blocky-before");

  // The first editable number on the canvas is the pawn's middlegame value (82).
  await page.locator(".blocklyEditableField").filter({ hasText: /^82$/ }).first().click();
  await expect(page.locator(".blocklyHtmlInput")).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("300");
  await page.keyboard.press("Enter");

  // Autosave: the workspace and the regenerated eval.ts are stored together.
  await expect.poll(async () => (await storedFile(page, ids.Blocky, "eval.ts")) !== codeBefore, { timeout: 15_000 }).toBe(true);
  await expect(saveState(page)).toHaveText(/Saved/);
  const record = await stored(page, ids.Blocky);
  expect(JSON.stringify(record?.blocks)).toMatch(/"MG_P":"?300"?/);
  expect(record?.files?.["eval.ts"]).toContain("300");
  await expect(buildPill(page)).toHaveText(/Needs build/);

  // The Generated code tab shows the new code.
  await sideTab(page, "Generated code");
  await expect.poll(() => editorText(page, ".workshop-pane--code")).toContain("300");
  expect(await editorText(page, ".workshop-pane--code")).toBe(record?.files?.["eval.ts"]);
  await shot(page, "blocky-generated");

  expect(await build(page)).toMatch(/Up to date/);
  const after = await evaluate(page);
  const materialAfter = after.rows.find((r) => /^material$/i.test(r.label));
  expect(materialAfter!.white).toBeGreaterThan(materialBefore!.white);
  expect(materialAfter!.black).toBeGreaterThan(materialBefore!.black);

  // Reload: the edit is still there.
  await page.reload();
  await expect(page.locator(".blocklyEditableField").filter({ hasText: /^300$/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(buildPill(page)).toHaveText(/Up to date/);

  // Ctrl+B right after an edit (within the block editor's debounce) builds that edit.
  await page.locator(".blocklyEditableField").filter({ hasText: /^300$/ }).first().click();
  await expect(page.locator(".blocklyHtmlInput")).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("120");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+B");
  await expect(toast(page, /Build succeeded/)).toBeVisible({ timeout: LONG });
  await page.waitForTimeout(800);
  expect(await storedFile(page, ids.Blocky, "eval.ts")).toContain("120");
  await expect(buildPill(page)).toHaveText(/Up to date/);

  // A block edit followed at once by a reload (inside the block editor's debounce) is kept.
  await page.locator(".blocklyEditableField").filter({ hasText: /^120$/ }).first().click();
  await expect(page.locator(".blocklyHtmlInput")).toBeVisible();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("150");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  await page.reload();
  await expect(page.locator(".blocklyEditableField").filter({ hasText: /^150$/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => storedFile(page, ids.Blocky, "eval.ts")).toContain("150");
});

// ---------------------------------------------------------------------------------------------
// Eval-only code (Classic)

test("Classic: a compile error is listed and marked, clicking it reveals the line, the fix builds", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Classic);
  const editor = ".workshop-main .workshop-eval";
  await expect(page.locator(`${editor} .cm-content`)).toBeVisible();
  const original = await editorText(page, editor);
  expect(original).toContain("export function evaluate");

  await appendToEditor(page, editor, '\nconst broken: i32 = "oops";\n');
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts"), { timeout: 10_000 }).toContain("broken");
  const lineNo = (await editorText(page, editor)).split("\n").findIndex((l) => l.includes("broken")) + 1;

  const pill = await build(page);
  expect(pill).toMatch(/1 error/);
  await expect(toast(page, /Build failed/)).toBeVisible();
  // The build log opens with the error; the editor marks it.
  await expect(page.locator(".workshop-side-tabs .tab.active")).toHaveText(/Build log/);
  const diag = page.locator(".workshop-pane--build .workshop-diag.error").first();
  await expect(diag).toContainText(`eval.ts:${lineNo}:`);
  await expect(page.locator(".workshop-side-tabs .tab", { hasText: "Build log" })).toContainText("1");
  await expect(page.locator(`${editor} .cm-lintRange-error`).first()).toBeAttached();
  await expect(page.locator(`${editor} .cm-lint-marker-error`).first()).toBeAttached();
  await shot(page, "classic-error");

  // The test bench says the engine does not compile and leads back to the errors.
  await toolTab(page, "Evaluate");
  await visibleTool(page).getByRole("button", { name: "Evaluate", exact: true }).click();
  const status = page.locator(".workshop-engine-status.error");
  await expect(status).toContainText("The engine does not compile.", { timeout: LONG });
  await shot(page, "classic-error-bench");
  await status.getByRole("button", { name: "Show errors" }).click();
  await expect(page.locator(".workshop-side-tabs .tab.active")).toHaveText(/Build log/);

  // Scroll the editor to the top, then reveal the line from the build log.
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press("Control+Home");
  await diag.click();
  await expect(page.locator(`${editor} .cm-activeLine`)).toContainText("broken");
  await expect(page.locator(`${editor} .cb-code-flash`)).toContainText("broken");

  // Fix it where the cursor is and build again.
  await replaceCursorLine(page, "const fixed: i32 = 42;");
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts"), { timeout: 10_000 }).toContain("fixed");
  await expect(page.locator(".workshop-pane--build")).toContainText(/You changed the code since this build/);
  expect(await build(page)).toMatch(/Up to date/);
  await expect(page.locator(".workshop-pane--build .workshop-buildlog-summary")).toContainText("Build succeeded");
  await expect(page.locator(`${editor} .cm-lintRange-error`)).toHaveCount(0);
  await expect(page.locator(".workshop-side-tabs .tab", { hasText: "Build log" }).locator(".badge, .tab-badge")).toHaveCount(0);

  // Reset to the template (asks first).
  await page.getByRole("button", { name: /Reset eval.ts to the template/ }).click();
  await page.locator(".modal").getByRole("button", { name: "Cancel" }).click();
  expect(await storedFile(page, ids.Classic, "eval.ts")).toContain("fixed");
  await page.getByRole("button", { name: /Reset eval.ts to the template/ }).click();
  await page.locator(".modal").getByRole("button", { name: "Reset eval.ts" }).click();
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts")).not.toContain("fixed");
  await expect(page.getByRole("button", { name: /Reset eval.ts to the template/ })).toBeDisabled();

  // The engine source tab shows the template files read-only.
  await sideTab(page, "Engine source");
  await page.locator(".workshop-pane--source select").selectOption("search.ts");
  await expect.poll(() => editorText(page, ".workshop-pane--source")).toContain("search.ts");
  await expect(page.locator(".workshop-pane--source .cm-content")).toHaveAttribute("aria-readonly", "true");
  const sourceText = await editorText(page, ".workshop-pane--source");
  await page.locator(".workshop-pane--source .cm-content").click();
  await page.keyboard.type("xyz");
  expect(await editorText(page, ".workshop-pane--source")).toBe(sourceText);

  // API reference: Insert puts the snippet at the cursor of eval.ts and adds the import.
  await page.locator(`${editor} .cm-content`).click();
  await page.keyboard.press("Control+End");
  await sideTab(page, "API reference");
  await page.getByLabel("Search the engine API").fill("countOn");
  await page.locator(".workshop-pane--api").getByRole("button", { name: "Insert" }).first().click();
  await expect.poll(async () => (await editorText(page, editor)).match(/countOn/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts")).toMatch(/countOn\(/);

  // Export downloads an engine file.
  const download = page.waitForEvent("download");
  await menuChoose(page, moreMenu(page), "Export");
  expect((await download).suggestedFilename()).toMatch(/\.engine\.json$/);
  await expect(toast(page, "Engine exported")).toBeVisible();
});

test("Classic: evaluate with breakdown, node-limited search, perft 1–4, move-generation check, stopping an infinite search", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Classic);

  // Evaluate (the engine is built and started on the first test action).
  const ev = await evaluate(page);
  expect(ev.rows.length).toBeGreaterThan(5);
  expect(ev.total).not.toBeNull();
  const sum = ev.rows.reduce((s, r) => s + r.net, 0);
  expect(sum, "the breakdown's rows add up to its total").toBe(ev.total);
  for (const r of ev.rows) expect(r.net).toBe(r.white - r.black);
  expect(ev.text).toContain("White's point of view");
  await expect(page.locator(".workshop-engine-status.ready")).toBeVisible();
  await shot(page, "classic-eval");

  // The evaluation follows the board: 1. e4 changes it (auto re-evaluate).
  const tool = visibleTool(page);
  await boardMove(page, "e2", "e4");
  await expect(page.locator(".workshop-turn")).toHaveText(/Black to move/);
  await expect(tool.locator(".workshop-eval-result:not(.stale)")).toBeVisible();
  await expect(tool.locator(".workshop-eval-score")).toContainText("Black to move");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // Search with a node limit.
  await setSearchLimits(page, { nodes: 20_000 });
  const result = await search(page);
  expect(result).toContain("Best move");
  await expect(visibleTool(page).locator(".workshop-info tbody tr").first()).toBeVisible();
  await shot(page, "classic-search");

  // Perft 1–4 from the start position.
  await toolTab(page, "Perft");
  const perft = visibleTool(page).locator(".workshop-subsection").first();
  for (const [depth, nodes] of [
    [1, "20"],
    [2, "400"],
    [3, "8,902"],
    [4, "197,281"],
  ] as const) {
    await perft.locator("select").selectOption(String(depth));
    await perft.getByRole("button", { name: "Run perft" }).click();
    await expect(perft.locator(".workshop-stats")).toContainText(nodes, { timeout: LONG });
    await expect(perft.locator(".workshop-stats")).toContainText("matches");
  }

  // Move-generation check (up to depth 4: six positions).
  const check = visibleTool(page).locator(".workshop-subsection").nth(1);
  await check.locator("select").selectOption("4");
  await check.getByRole("button", { name: "Check move generation" }).click();
  await expect(check.locator(".callout")).toContainText(/All \d+ counts match/, { timeout: LONG });
  await expect(check.locator(".workshop-cell--fail")).toHaveCount(0);
  await shot(page, "classic-check");

  // A long perft can be stopped, and the engine keeps working afterwards.
  await perft.locator("select").selectOption("7");
  await perft.getByRole("button", { name: "Run perft" }).click();
  await page.waitForTimeout(800);
  await perft.getByRole("button", { name: "Stop" }).click();
  await expect(perft.locator(".callout")).toHaveText("Stopped.", { timeout: 15_000 });
  await perft.locator("select").selectOption("2");
  await perft.getByRole("button", { name: "Run perft" }).click();
  await expect(perft.locator(".workshop-stats")).toContainText("400", { timeout: LONG });

  // Bench at a small depth: six positions, each with a best move.
  await toolTab(page, "Bench");
  const bench = visibleTool(page);
  await bench.locator("select").selectOption("5");
  await bench.getByRole("button", { name: "Run bench" }).click();
  await expect(bench.locator(".workshop-benchtable tbody tr")).toHaveCount(6, { timeout: LONG });
  await expect(bench.getByRole("button", { name: "Run bench" })).toBeEnabled({ timeout: LONG });
  await expect(bench.locator(".workshop-benchtable")).not.toContainText("no move");

  // The position: an invalid FEN is refused with a message; the mate-in-2 preset is solved.
  const fen = page.getByLabel("Position (FEN)");
  await fen.fill("not a fen");
  await fen.press("Enter");
  await expect(page.locator(".workshop-fen .field-error")).toBeVisible();
  await fen.fill("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1");
  await fen.press("Enter");
  await expect(page.locator(".workshop-fen .field-error")).toBeVisible();
  await fen.press("Escape");
  await expect(page.locator(".workshop-fen .field-error")).toHaveCount(0);
  await page.getByRole("button", { name: /Presets/ }).click();
  await expectMenuFullyVisible(page);
  await page.keyboard.press("Escape");
  await menuChoose(page, page.getByRole("button", { name: /Presets/ }), "Mate in 2");
  await expect(fen).toHaveValue("r6k/6pp/7N/8/2Q5/8/8/6K1 w - - 0 1");
  await setSearchLimits(page, { depth: 5 });
  const mate = await search(page);
  expect(mate).toContain("Qg8+");
  expect(mate).toMatch(/M2|#2|mate in 2/i);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // Infinite analysis, then Stop.
  await toolTab(page, "Search");
  const searchTool = visibleTool(page);
  await searchTool.getByRole("checkbox", { name: /Infinite analysis/ }).check();
  await searchTool.getByRole("button", { name: "Go", exact: true }).click();
  await expect(searchTool.locator(".workshop-info tbody tr").nth(2)).toBeVisible({ timeout: 60_000 });
  await expect(searchTool.locator(".workshop-search-status")).toBeVisible();
  await page.waitForTimeout(500);
  await searchTool.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(searchTool.locator(".workshop-search-result")).toContainText("Stopped — showing the best move found so far.", { timeout: 15_000 });
  await expect(searchTool.locator(".workshop-bestmove")).toBeVisible();
  await expect(searchTool.getByRole("button", { name: "Go", exact: true })).toBeEnabled();

  // Console: the host's notes are there.
  await toolTab(page, "Console");
  await expect(visibleTool(page).locator(".workshop-console-line").first()).toBeVisible();
  await expect(visibleTool(page).locator(".workshop-console")).toContainText("engine started");
});

// ---------------------------------------------------------------------------------------------
// Full engine (all template files) — created through the library's wizard

test("Full engine from the wizard: search.ts error and fix, file tree create / rename / delete, entry file", async ({ page }) => {
  await seeded(page);
  await page.goto("/#/engines?new=1&kind=full");
  const wizard = page.locator(".modal");
  await wizard.getByLabel("Name", { exact: true }).fill("Fully mine");
  await wizard.getByRole("button", { name: "Create engine" }).click();
  await expect(page.locator(".workshop-files")).toBeVisible({ timeout: 30_000 });
  const id = decodeURIComponent(page.url().split("#/engines/")[1]!.split("?")[0]!);
  const tree = page.locator(".workshop-tree");
  const row = (name: string) => tree.locator(".cb-tree-row", { has: page.locator(".cb-tree-name", { hasText: new RegExp(`^${name.replace(".", "\\.")}$`) }) });
  await expect(row("search.ts")).toBeVisible();
  await expect(row("main.ts").locator(".cb-tree-entry")).toBeVisible();
  await expect(page.locator(".workshop-filetab.active")).toContainText("main.ts");

  // search.ts: introduce an error, build, follow the diagnostic from another file, fix it.
  await row("search.ts").click();
  await expect(page).toHaveURL(/file=search\.ts/);
  await expect(page.locator(".workshop-filetab.active")).toContainText("search.ts");
  const editor = ".workshop-files-editor";
  await expect.poll(() => editorText(page, editor)).toContain("export function");
  await appendToEditor(page, editor, '\nconst broken: i32 = "oops";\n');
  await expect.poll(() => storedFile(page, id, "search.ts"), { timeout: 10_000 }).toContain("broken");
  await expect(page.locator(".workshop-filetab.active .workshop-dirty-dot")).toHaveCount(0);
  expect(await build(page)).toMatch(/1 error/);
  await expect(page.locator(".workshop-filetab.active .badge-danger")).toHaveText("1");
  await expect(row("search.ts").locator(".cb-tree-errors")).toBeVisible();
  await row("types.ts").click();
  await expect(page.locator(".workshop-filetab.active")).toContainText("types.ts");
  await sideTab(page, "Build log");
  await page.locator(".workshop-pane--build .workshop-diag.error").first().click();
  await expect(page.locator(".workshop-filetab.active")).toContainText("search.ts");
  await expect(page.locator(`${editor} .cm-activeLine`)).toContainText("broken");
  await shot(page, "full-error");
  await replaceCursorLine(page, "const fine: i32 = 1;");
  await expect.poll(() => storedFile(page, id, "search.ts"), { timeout: 10_000 }).toContain("fine");
  expect(await build(page)).toMatch(/Up to date/);
  await expect(row("search.ts").locator(".cb-tree-errors")).toHaveCount(0);

  // New file from the tree (with a folder; ".ts" is added).
  await tree.getByRole("button", { name: "New file" }).click();
  await page.keyboard.type("lib/helpers");
  await page.keyboard.press("Enter");
  await expect(page.locator(".workshop-filetab.active")).toContainText("helpers.ts");
  await expect.poll(async () => Object.keys((await stored(page, id))?.files ?? {})).toContain("lib/helpers.ts");
  // An invalid name is refused with a message.
  await tree.getByRole("button", { name: "New file" }).click();
  await page.keyboard.type("bad name");
  await page.keyboard.press("Enter");
  await expect(tree.locator(".cb-tree-edit-msg.is-error")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tree.locator(".cb-tree-input")).toHaveCount(0);

  // Rename through the row's actions menu.
  await row("helpers.ts").hover();
  await tree.getByRole("button", { name: "Actions for helpers.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Rename" }).click();
  await expect(tree.locator(".cb-tree-input")).toBeFocused();
  await page.keyboard.type("util");
  await page.keyboard.press("Enter");
  await expect(row("util.ts")).toBeVisible();
  await expect(page.locator(".workshop-filetab.active")).toContainText("util.ts");
  await expect.poll(async () => Object.keys((await stored(page, id))?.files ?? {})).toContain("lib/util.ts");
  expect(Object.keys((await stored(page, id))?.files ?? {})).not.toContain("lib/helpers.ts");

  // Rename through the File menu dialog (validation first). The menu is fully visible.
  await page.getByRole("button", { name: "File actions" }).click();
  await expectMenuFullyVisible(page);
  await page.keyboard.press("Escape");
  await menuChoose(page, page.getByRole("button", { name: "File actions" }), /Rename lib\/util\.ts/);
  const input = page.locator("#workshop-path-input");
  await expect(input).toHaveValue("lib/util.ts");
  await input.fill("main.ts");
  await page.locator(".modal").getByRole("button", { name: "Rename" }).click();
  await expect(page.locator(".modal .field-error")).toBeVisible();
  await input.fill("lib/tools.ts");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(row("tools.ts")).toBeVisible();

  // Entry file: make tools.ts the entry (the build then fails: it has no cb_* exports), then back to main.ts.
  await menuChoose(page, page.getByRole("button", { name: "File actions" }), "Set as entry file");
  await expect(row("tools.ts").locator(".cb-tree-entry")).toBeVisible();
  await expect.poll(async () => (await stored(page, id))?.entry).toBe("lib/tools.ts");
  // The entry file cannot be deleted.
  await page.getByRole("button", { name: "File actions" }).click();
  await expect(page.locator(".workshop-menu-item", { hasText: "Delete lib/tools.ts" })).toBeDisabled();
  await page.keyboard.press("Escape");
  // It compiles (to an empty module), but that is not an engine: the Workshop says so.
  expect(await build(page)).toMatch(/Not a working engine/);
  await expect(toast(page, "not a working engine yet")).toBeVisible();
  await expect(page.locator(".workshop-pane--build .workshop-buildlog-abi")).toContainText("cb_go");
  await shot(page, "full-wrong-entry");
  await row("main.ts").hover();
  await tree.getByRole("button", { name: "Actions for main.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Set as entry file" }).click();
  await expect.poll(async () => (await stored(page, id))?.entry).toBe("main.ts");
  expect(await build(page)).toMatch(/Up to date/);

  // Delete tools.ts from the tree (asks first; Cancel keeps it).
  await row("tools.ts").hover();
  await tree.getByRole("button", { name: "Actions for tools.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Delete" }).click();
  await page.locator(".modal").getByRole("button", { name: "Cancel" }).click();
  await expect(row("tools.ts")).toBeVisible();
  await row("tools.ts").hover();
  await tree.getByRole("button", { name: "Actions for tools.ts" }).click();
  await page.locator(".cb-tree-menu-item", { hasText: "Delete" }).click();
  await page.locator(".modal").getByRole("button", { name: "Delete file" }).click();
  await expect(row("tools.ts")).toHaveCount(0);
  await expect.poll(async () => Object.keys((await stored(page, id))?.files ?? {})).not.toContain("lib/tools.ts");
  await expect(buildPill(page)).toHaveText(/Needs build/);
  expect(await build(page)).toMatch(/Up to date/);

  // Everything survives a reload, including the open file from ?file=.
  await page.goto(`/#/engines/${id}?file=search.ts`);
  await expect(page.locator(".workshop-filetab.active")).toContainText("search.ts");
  await expect.poll(() => editorText(page, editor)).toContain("const fine: i32 = 1;");
  await expect(buildPill(page)).toHaveText(/Up to date/);
});

// ---------------------------------------------------------------------------------------------
// From scratch

test("Sprout and an empty skeleton: build, search, perft; the skeleton produces no move and logs its TODO", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Sprout);
  await expect(page.locator(".workshop-files")).toBeVisible();
  expect(await build(page)).toMatch(/Up to date/);
  await setSearchLimits(page, { depth: 3 });
  expect(await search(page)).toContain("Best move");
  await toolTab(page, "Perft");
  const perft = visibleTool(page).locator(".workshop-subsection").first();
  await perft.locator("select").selectOption("3");
  await perft.getByRole("button", { name: "Run perft" }).click();
  await expect(perft.locator(".workshop-stats")).toContainText("8,902", { timeout: LONG });

  const empty = await createEngine(page, { kind: "scratch-empty", name: "Empty skeleton" });
  await openWorkshop(page, empty);
  expect(await build(page)).toMatch(/Up to date/);
  await setSearchLimits(page, { depth: 2 });
  const text = await search(page);
  expect(text).toContain("The engine produced no move");
  expect(text).toContain("20 legal moves");
  expect(text).not.toMatch(/checkmate|stalemate/);
  await shot(page, "empty-no-move");
  await toolTab(page, "Console");
  await expect(visibleTool(page).locator(".workshop-console")).toContainText("TODO");
  // It has no evaluation exports: Evaluate says so instead of showing an empty result.
  await toolTab(page, "Evaluate");
  await expect(visibleTool(page).locator(".callout.warn")).toContainText("cannot evaluate positions");
  await expect(visibleTool(page).getByRole("button", { name: "Evaluate", exact: true })).toBeDisabled();
  await shot(page, "empty-evaluate");
});

// ---------------------------------------------------------------------------------------------
// NNUE

test("NNUE engine: fallback warning without a network; with a network the NNUE term is evaluated", async ({ page }) => {
  await seeded(page);
  const id = await createEngine(page, { kind: "nnue", name: "Neural" });
  await openWorkshop(page, id);
  await expect(page.locator(".workshop-networkbar")).toContainText("No networks yet");
  const before = await evaluate(page);
  await expect(visibleTool(page).locator(".callout.warn")).toContainText("No network loaded");
  expect(before.rows.map((r) => r.label)).toContain("Fallback (no network)");
  await shot(page, "nnue-fallback");

  const netId = await createNetwork(page, "Random net", 7);
  const select = page.locator(".workshop-networkbar select");
  await expect(select.locator(`option[value="${netId}"]`)).toBeAttached();
  await select.selectOption(netId);
  await expect.poll(async () => (await stored(page, id))?.networkId).toBe(netId);
  await expect(page.locator(".workshop-networkbar")).toContainText("32 hidden");
  // The engine restarts with the network.
  await expect(page.locator(".workshop-engine-status.ready")).toBeVisible({ timeout: LONG });
  const after = await evaluate(page);
  expect(after.rows.map((r) => r.label)).toEqual(["NNUE"]);
  await expect(visibleTool(page).locator(".callout.warn", { hasText: "No network loaded" })).toHaveCount(0);
  expect(after.score).not.toBe(before.score);
  await shot(page, "nnue-network");

  // A deleted network is reported in the Workshop instead of failing silently.
  await page.evaluate(async (netId) => {
    const s = (await import("/src/storage/index.ts" as string)) as typeof StorageModule;
    await s.networksRepo.remove(netId);
  }, netId);
  await expect(page.locator(".workshop-networkbar")).toContainText("was deleted");
});

// ---------------------------------------------------------------------------------------------
// Uploaded .wasm

test("A .wasm engine: inspection, test bench, replacing the module", async ({ page }) => {
  const wasmBase64 = minimalWasmBase64();
  await seeded(page);
  const id = await createEngine(page, { kind: "wasm", name: "Uploaded", wasmBase64 });
  await openWorkshop(page, id);
  const main = page.locator(".workshop-wasm");
  await expect(main.locator(".badge", { hasText: "ABI v1 OK" })).toBeVisible({ timeout: 30_000 });
  await expect(main).toContainText("cb_go");
  await expect(main).toContainText("Optional features");
  await expect(header(page).getByRole("button", { name: /^Build/ })).toHaveCount(0);
  await expect(buildPill(page)).toContainText("Module ·");
  // The engine starts by itself to read its name.
  await expect(page.locator(".workshop-engine-status.ready")).toBeVisible({ timeout: 60_000 });
  await shot(page, "wasm-main");

  await setSearchLimits(page, { depth: 3 });
  expect(await search(page)).toContain("Best move");
  await toolTab(page, "Perft");
  const perft = visibleTool(page).locator(".workshop-subsection").first();
  await perft.locator("select").selectOption("3");
  await perft.getByRole("button", { name: "Run perft" }).click();
  await expect(perft.locator(".workshop-stats")).toContainText("8,902", { timeout: LONG });

  // Replace module: a file that is not WebAssembly is refused, a real module is accepted.
  const dir = join(ROOT, ".scratch/verify-workshop");
  mkdirSync(dir, { recursive: true });
  const junk = join(dir, "not-a-module.wasm");
  writeFileSync(junk, "hello, I am not wasm");
  let chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: /Replace module/ }).click();
  await (await chooser).setFiles(junk);
  await expect(toast(page, "This module cannot be used as an engine")).toBeVisible();
  chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: /Replace module/ }).click();
  await (await chooser).setFiles(join(ROOT, ".scratch/scratch/scratch-minimal.wasm"));
  await expect(toast(page, /Module replaced/)).toBeVisible();

  // A .wasm engine without a module: a clear empty state, and the test engine explains why it cannot start.
  const emptyId = await createEngine(page, { kind: "wasm", name: "No module yet" });
  await openWorkshop(page, emptyId);
  await expect(page.locator(".workshop-wasm .empty-state")).toContainText("No WebAssembly module");
  await expect(page.locator(".workshop-wasm").getByRole("button", { name: /Choose a \.wasm file/ })).toBeVisible();
  await page.locator(".workshop-engine-status").getByRole("button", { name: "Start engine" }).click();
  await expect(page.locator(".workshop-engine-status.error")).toContainText("There is no module yet: choose a .wasm file first.");
  await shot(page, "wasm-empty");
  chooser = page.waitForEvent("filechooser");
  await page.locator(".workshop-wasm").getByRole("button", { name: /Choose a \.wasm file/ }).click();
  await (await chooser).setFiles(join(ROOT, ".scratch/scratch/scratch-minimal.wasm"));
  await expect(toast(page, /Module added/)).toBeVisible();
  await expect(page.locator(".workshop-engine-status.ready")).toBeVisible({ timeout: 60_000 });
});

// ---------------------------------------------------------------------------------------------
// Conversions, duplicate, delete

const idFromUrl = (page: Page) => decodeURIComponent(page.url().split("#/engines/")[1]!.split("?")[0]!);

test("Convert blocks → code and eval → full engine, duplicate, delete", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Blocky);
  await expect(page.locator(".blocklyEditableField").first()).toBeVisible({ timeout: 60_000 });

  // Blocks → a new eval engine with the generated code.
  await menuChoose(page, moreMenu(page), "Convert to code");
  await expect(page.getByLabel("Engine name")).toHaveValue("Blocky (code)");
  await expect(header(page).locator(".cb-kind")).toHaveText("Eval code");
  await expect(toast(page, "Created “Blocky (code)”")).toBeVisible();
  const codeId = idFromUrl(page);
  expect(codeId).not.toBe(ids.Blocky);
  const code = await stored(page, codeId);
  expect(code?.kind).toBe("eval");
  expect(code?.parentId).toBe(ids.Blocky);
  expect(code?.files?.["eval.ts"]).toContain("converted from the blocks of “Blocky”");
  await expect.poll(() => editorText(page, ".workshop-main .workshop-eval")).toContain("converted from the blocks");
  expect((await stored(page, ids.Blocky))?.kind).toBe("blocks");
  expect(await build(page)).toMatch(/Up to date/);
  const ev = await evaluate(page);
  expect(ev.rows.map((r) => r.label)).toContain("Material");

  // Eval → a new full engine with every template file (its build stays valid).
  await menuChoose(page, moreMenu(page), "Unlock the full engine source");
  await expect(page.getByLabel("Engine name")).toHaveValue("Blocky (code) (full)");
  await expect(header(page).locator(".cb-kind")).toHaveText("Full code");
  const fullId = idFromUrl(page);
  await expect(page.locator(".workshop-tree")).toContainText("search.ts");
  const full = await stored(page, fullId);
  expect(full?.files?.["eval.ts"]).toBe(code?.files?.["eval.ts"]);
  expect(Object.keys(full?.files ?? {}).length).toBeGreaterThan(8);
  await expect(buildPill(page)).toHaveText(/Up to date/);
  await sideTab(page, "Settings");
  await expect(page.locator(".workshop-settings")).toContainText("Made from");
  await expect(page.locator(".workshop-settings").getByRole("link", { name: "Blocky (code)" })).toBeVisible();

  // Duplicate, then delete the copy (Cancel first).
  await menuChoose(page, moreMenu(page), "Duplicate");
  await expect(page.getByLabel("Engine name")).toHaveValue("Blocky (code) (full) (copy)");
  const copyId = idFromUrl(page);
  expect(copyId).not.toBe(fullId);
  await menuChoose(page, moreMenu(page), "Delete engine");
  const dialog = page.locator(".modal");
  await expect(dialog).toContainText("Delete “Blocky (code) (full) (copy)”?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await stored(page, copyId)).not.toBeNull();
  await menuChoose(page, moreMenu(page), "Delete engine");
  await page.locator(".modal").getByRole("button", { name: "Delete engine" }).click();
  await expect(page).toHaveURL(/#\/engines$/);
  await expect(toast(page, "Deleted “Blocky (code) (full) (copy)”")).toBeVisible();
  await expect.poll(() => stored(page, copyId)).toBeNull();
  // The deleted engine's link shows a friendly "not found".
  await page.goto(`/#/engines/${copyId}`);
  await expect(page.locator(".empty-state")).toContainText("Engine not found");
});

// ---------------------------------------------------------------------------------------------
// Autosave

test("Autosave: Ctrl+S, navigating away and reloading right after typing, renaming, settings", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Classic);
  const editor = ".workshop-main .workshop-eval";
  await expect(page.locator(`${editor} .cm-content`)).toBeVisible();

  // Ctrl+S saves at once (well before the 500 ms debounce) instead of opening the browser's dialog.
  await appendToEditor(page, editor, "\n// saved with ctrl+s\n");
  await expect(saveState(page)).toHaveText(/Saving/);
  const t0 = Date.now();
  await page.keyboard.press("Control+S");
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts"), { intervals: [25], timeout: 5_000 }).toContain("ctrl+s");
  expect(Date.now() - t0).toBeLessThan(450);
  await expect(saveState(page)).toHaveText(/Saved/);

  // Leaving right after typing.
  await appendToEditor(page, editor, "\n// left right away\n");
  await page.getByRole("link", { name: "Back to your engines" }).click();
  await expect(page).toHaveURL(/#\/engines$/);
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts")).toContain("left right away");

  // Reloading right after typing.
  await openWorkshop(page, ids.Classic);
  await appendToEditor(page, editor, "\n// reloaded right away\n");
  await page.reload();
  await expect(header(page)).toBeVisible();
  await expect.poll(() => editorText(page, editor)).toContain("reloaded right away");
  expect(await storedFile(page, ids.Classic, "eval.ts")).toContain("left right away");

  // The safety net for writes the browser cuts off: while the page goes away, the unsaved edits
  // are copied to localStorage at once; the copy is removed when the write has finished...
  const backupKey = `cb.workshop.unsaved.${ids.Classic}`;
  await appendToEditor(page, editor, "\n// safety net\n");
  const copied = await page.evaluate((key) => {
    window.dispatchEvent(new Event("pagehide"));
    return localStorage.getItem(key);
  }, backupKey);
  expect(copied).toContain("safety net");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), backupKey)).toBeNull();
  expect(await storedFile(page, ids.Classic, "eval.ts")).toContain("safety net");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  // ...and a copy left behind by a write that never finished is applied when the engine opens.
  const current = (await storedFile(page, ids.Classic, "eval.ts")) ?? "";
  await page.evaluate(
    ([key, files]) => localStorage.setItem(key, JSON.stringify({ at: Date.now() + 1000, patch: { files } })),
    [backupKey, { "eval.ts": `${current}\n// restored after a crash\n` }] as const,
  );
  await page.reload();
  await expect.poll(() => editorText(page, editor)).toContain("restored after a crash");
  await expect.poll(() => storedFile(page, ids.Classic, "eval.ts")).toContain("restored after a crash");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), backupKey)).toBeNull();

  // The header's name field: Enter commits, Escape restores, an empty name is not accepted.
  const name = page.getByLabel("Engine name");
  await name.fill("Classic Plus");
  await name.press("Enter");
  await expect.poll(async () => (await stored(page, ids.Classic))?.name).toBe("Classic Plus");
  await expect(page).toHaveTitle(/Classic Plus/);
  await name.fill("Something else");
  await name.press("Escape");
  await expect(name).toHaveValue("Classic Plus");
  await name.fill("   ");
  await name.press("Enter");
  await expect(name).toHaveValue("Classic Plus");
  await expect.poll(async () => (await stored(page, ids.Classic))?.name).toBe("Classic Plus");

  // Settings: description, colour, tags, hash size.
  await sideTab(page, "Settings");
  const settings = page.locator(".workshop-settings");
  await settings.getByLabel("Description").fill("My favourite");
  await settings.getByRole("radio", { name: "#ef6363" }).click();
  await settings.getByLabel("Tags").fill("fast, Fast, experiment");
  await settings.getByLabel("Tags").blur();
  await settings.getByLabel("Hash table").selectOption("64");
  await expect
    .poll(async () => {
      const e = await stored(page, ids.Classic);
      return [e?.description, e?.color, e?.tags?.join("|"), e?.options?.hashMb];
    })
    .toEqual(["My favourite", "#ef6363", "fast|experiment", 64]);
  await expect(settings.locator(".badge", { hasText: "experiment" })).toBeVisible();
  await page.reload();
  await sideTab(page, "Settings");
  await expect(page.locator(".workshop-settings").getByLabel("Hash table")).toHaveValue("64");
  await expect(page.locator(".workshop-settings").getByLabel("Description")).toHaveValue("My favourite");
});

// ---------------------------------------------------------------------------------------------
// Interruptions

test("Interruptions: reloading during a build and during an infinite search, leaving mid-search", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Classic);

  // Reload while the first build is running: nothing breaks, building again works.
  await header(page).getByRole("button", { name: "Build" }).click();
  await expect(page.locator(".workshop-header-status .workshop-pill--accent")).toBeVisible();
  await page.reload();
  await expect(header(page)).toBeVisible();
  await expect(buildPill(page)).toHaveText(/Not built yet|Needs build|Up to date/);
  expect(await build(page)).toMatch(/Up to date/);

  // Reload during an infinite analysis.
  await toolTab(page, "Search");
  let tool = visibleTool(page);
  await tool.getByRole("checkbox", { name: /Infinite analysis/ }).check();
  await tool.getByRole("button", { name: "Go", exact: true }).click();
  await expect(tool.locator(".workshop-info tbody tr").first()).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await toolTab(page, "Search");
  tool = visibleTool(page);
  await expect(tool.getByRole("button", { name: "Go", exact: true })).toBeEnabled();
  await expect(tool.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect(page.locator(".workshop-engine-status.idle")).toBeVisible();

  // Leave during an infinite analysis, then come back.
  await tool.getByRole("button", { name: "Go", exact: true }).click();
  await expect(tool.locator(".workshop-info tbody tr").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "Back to your engines" }).click();
  await expect(page).toHaveURL(/#\/engines$/);
  await expect(page.locator(".workshop")).toHaveCount(0);
  await openWorkshop(page, ids.Classic);
  await expect(page.locator(".workshop-engine-status.idle")).toBeVisible();
  await toolTab(page, "Search");
  await expect(visibleTool(page).locator(".workshop-info")).toHaveCount(0);
  await expect(visibleTool(page).locator(".callout.danger")).toHaveCount(0);
  await setSearchLimits(page, { nodes: 5_000 });
  expect(await search(page)).toContain("Best move");

  // A build failure toast belongs to this engine: it goes when the Workshop is left.
  await appendToEditor(page, ".workshop-main .workshop-eval", '\nconst broken: i32 = "oops";\n');
  expect(await build(page)).toMatch(/1 error/);
  await expect(toast(page, /Build failed/)).toBeVisible();
  await page.getByRole("link", { name: "Back to your engines" }).click();
  await expect(page).toHaveURL(/#\/engines$/);
  await expect(toast(page, /Build failed/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// Layout: split, narrow window, themes

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem("cb.theme", t);
    document.documentElement.dataset.theme = t;
  }, theme);
}

test("Layout: the resizable split, the narrow stacked layout and both themes", async ({ page }) => {
  const ids = await seeded(page);
  await openWorkshop(page, ids.Sprout);
  const side = page.locator(".workshop-side");
  const splitter = page.getByRole("separator", { name: "Resize the side panel" });
  await expect(splitter).toBeVisible();
  const width = async () => Math.round((await side.boundingBox())!.width);
  const w0 = await width();
  expect(Math.abs(w0 - 480)).toBeLessThanOrEqual(2);

  // Drag 150 px to the left: the side panel grows; the width is remembered.
  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 75, box.y + 300, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 300, { steps: 4 });
  await page.mouse.up();
  const w1 = await width();
  expect(Math.abs(w1 - (w0 + 150))).toBeLessThanOrEqual(3);
  await expect.poll(() => getSetting<number>(page, "workshop.sideWidth")).toBe(w1);
  await page.reload();
  await expect(splitter).toBeVisible();
  await expect.poll(width).toBe(w1);
  // Keyboard: Home = narrowest; ArrowLeft widens; double-click resets.
  await splitter.focus();
  await page.keyboard.press("Home");
  await expect.poll(width).toBe(340);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(372);
  await splitter.dblclick();
  await expect.poll(width).toBe(480);
  // It can never squeeze the editor below its minimum.
  await splitter.focus();
  await page.keyboard.press("End");
  const mainWidth = Math.round((await page.locator(".workshop-main").boundingBox())!.width);
  expect(mainWidth).toBeGreaterThanOrEqual(375);
  await splitter.dblclick();
  await shot(page, "layout-wide-dark");
  await setTheme(page, "light");
  await shot(page, "layout-wide-light");
  await noHorizontalScroll(page);

  // Narrow window: one strip of tabs (editor + tools), no splitter, no horizontal page scroll.
  await page.setViewportSize({ width: 400, height: 860 });
  const stack = page.locator(".workshop-stack-tabs");
  await expect(stack).toBeVisible();
  await expect(splitter).toHaveCount(0);
  await expect(stack.locator(".tab.active")).toHaveText(/Files/);
  await expect(page.locator(".workshop-main")).toBeVisible();
  await expect(page.locator(".workshop-side")).toBeHidden();
  await noHorizontalScroll(page);
  await shot(page, "narrow-editor-light");
  // The file tree is a drawer: choosing a file, Escape or a press on the editor closes it.
  const filesButton = page.getByRole("button", { name: "Files", exact: true });
  await filesButton.click();
  await expect(page.locator(".workshop-tree")).toBeVisible();
  await shot(page, "narrow-drawer-light");
  await page.locator(".workshop-tree .cb-tree-row", { hasText: "main.ts" }).click();
  await expect(page.locator(".workshop-tree")).toBeHidden();
  await filesButton.click();
  await page.locator(".workshop-tree .cb-tree-row", { hasText: "main.ts" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workshop-tree")).toBeHidden();
  await expect(filesButton).toBeFocused();
  await filesButton.click();
  await page.mouse.click(372, 600); // on the editor, right of the drawer
  await expect(page.locator(".workshop-tree")).toBeHidden();
  // The File menu is not clipped by the tab strip.
  await page.getByRole("button", { name: "File actions" }).click();
  await expectMenuFullyVisible(page);
  await page.keyboard.press("Escape");
  // The Test tab.
  await sideTab(page, "Test");
  await expect(page.locator(".workshop-main")).toBeHidden();
  await expect(page.locator(".workshop-bench")).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "narrow-test-light");
  await setTheme(page, "dark");
  await toolTab(page, "Perft");
  await noHorizontalScroll(page);
  await shot(page, "narrow-perft-dark");
  await sideTab(page, "Build log");
  await shot(page, "narrow-buildlog-dark");
  await sideTab(page, "Settings");
  await noHorizontalScroll(page);
  await shot(page, "narrow-settings-dark");
  // A very long name does not push the page sideways.
  await page.getByLabel("Engine name").fill("A remarkably long engine name that keeps going and going");
  await page.getByLabel("Engine name").press("Enter");
  await noHorizontalScroll(page);
  await shot(page, "narrow-long-name-dark");
  // The header's menu still fits.
  await moreMenu(page).click();
  await expect(page.locator(".workshop-menu-list")).toBeVisible();
  await expectMenuFullyVisible(page);
  await shot(page, "narrow-menu-dark");
  await page.keyboard.press("Escape");
  await expect(page.locator(".workshop-menu-list")).toHaveCount(0);
});
