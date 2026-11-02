// End-to-end tests of the Engine Library (#/engines), Settings (#/settings) and Help (#/help).
//
// Run: E2E_PORT=5214 npx playwright test e2e/library.spec.ts
//
// Every test starts with a fresh browser context (empty IndexedDB): the app seeds the three starter
// engines (Blocky, Classic, Sprout) on first load, and each test waits for them. Engines created
// through the wizard are compiled with buildEngine() from the page, so the tests do not depend on
// the Workshop UI.
import { access, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type HostModule = typeof import("../src/engine-host/index");
type TemplatesModule = typeof import("../src/engine-host/templates");
type NnueModule = typeof import("../src/nnue/index");
type ArenaModule = typeof import("../src/arena/index");
type TrainingModule = typeof import("../src/training/index");

const UUID_URL = /#\/engines\/([0-9a-f-]{36})$/;
const STARTERS = [
  { name: "Blocky", kind: "Blocks" },
  { name: "Classic", kind: "Eval code" },
  { name: "Sprout", kind: "Scratch" },
  { name: "Neuron", kind: "NNUE" },
] as const;
const HELP_TOPICS = ["getting-started", "blocks", "eval-api", "full-engine", "scratch", "abi", "nnue", "play-and-arena", "limits", "storage"];

/** Summary of a stored engine (binary fields replaced by their sizes). */
interface EngineSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  color: string;
  builtin: boolean;
  tags: string[];
  parentId: string | null;
  networkId: string | null;
  hashMb: number;
  entry: string | null;
  templateVersion: number | null;
  generatorVersion: number | null;
  fileNames: string[];
  filesJson: string;
  hasBlocks: boolean;
  wasmBytes: number | null;
  built: boolean;
  createdAt: number;
  updatedAt: number;
}

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

const cards = (page: Page): Locator => page.locator(".engines-card:not(.engines-card--skeleton)");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const card = (page: Page, name: string): Locator =>
  cards(page).filter({ has: page.locator(".engines-card-name", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
const cardNames = (page: Page) => page.locator(".engines-card-name").allTextContents();
const approach = (page: Page, title: string): Locator =>
  page.locator(".engines-approach").filter({ has: page.locator(".engines-approach-title", { hasText: new RegExp(`^${escapeRe(title)}$`) }) });
const dialog = (page: Page): Locator => page.getByRole("dialog");
const toast = (page: Page, text: string | RegExp): Locator => page.locator(".toast").filter({ hasText: text });
const selectLabelled = (page: Page, label: string): Locator =>
  page.locator(".engines-select").filter({ has: page.locator(".engines-select-label", { hasText: new RegExp(`^${label}$`) }) }).locator("select");
const kindSelectOf = (page: Page): Locator => selectLabelled(page, "Kind");
const sortSelectOf = (page: Page): Locator => selectLabelled(page, "Sort");

/** Waits until the app has seeded the starter engines (on pages that do not show them). */
async function waitForSeeded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          return (await s.enginesRepo.list()).filter((e) => e.builtin).length;
        }),
      { timeout: 60_000, message: "starter engines are seeded" },
    )
    .toBeGreaterThanOrEqual(3);
}

/** Opens the library and waits until the starter engines are seeded and shown. */
async function openLibrary(page: Page, hash = "#/engines"): Promise<void> {
  await page.goto("/" + hash);
  await expect(cards(page).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await cardNames(page)).filter((n) => STARTERS.some((s) => s.name === n)).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(STARTERS.length);
}

async function engineList(page: Page): Promise<EngineSummary[]> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.enginesRepo.list()).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      color: r.color,
      builtin: !!r.builtin,
      tags: r.tags ?? [],
      parentId: r.parentId ?? null,
      networkId: r.networkId ?? null,
      hashMb: r.options?.hashMb ?? -1,
      entry: r.entry ?? null,
      templateVersion: r.templateVersion ?? null,
      generatorVersion: r.generatorVersion ?? null,
      fileNames: r.files ? Object.keys(r.files).sort() : [],
      filesJson: JSON.stringify(r.files ?? null),
      hasBlocks: r.blocks !== undefined && r.blocks !== null,
      wasmBytes: r.wasm ? r.wasm.byteLength : null,
      built: !!r.build,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });
}

async function engineRecord(page: Page, id: string): Promise<EngineSummary> {
  const found = (await engineList(page)).find((e) => e.id === id);
  if (!found) throw new Error(`engine ${id} is not stored`);
  return found;
}

/** Compiles the engine with buildEngine() (the Workshop is another area). */
async function buildById(page: Page, id: string): Promise<{ ok: boolean; size: number; errors: string[] }> {
  return page.evaluate(async (engineId) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
    const record = await s.enginesRepo.get(engineId);
    if (!record) return { ok: false, size: 0, errors: ["missing record"] };
    const out = await h.buildEngine(record);
    return {
      ok: out.ok,
      size: out.engine.build?.sizeBytes ?? out.engine.wasm?.byteLength ?? 0,
      errors: (out.result?.diagnostics ?? []).filter((d) => d.severity === "error").slice(0, 3).map((d) => `${d.file}:${d.line} ${d.message}`),
    };
  }, id);
}

/** Starts the engine in a worker and searches the start position (proves the build really plays). */
async function quickSearch(page: Page, id: string): Promise<{ bestMove: string | null; stopReason: string; trace: string[] | null }> {
  return page.evaluate(async (engineId) => {
    const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
    const client = await h.loadEngine(engineId, { hashMb: 1 });
    try {
      await client.newGame();
      await client.position("startpos", []);
      const result = await client.go({ depth: 2 });
      const trace = client.capabilities.trace ? await client.evalTrace() : null;
      return { bestMove: result.bestMove, stopReason: result.stopReason, trace: trace ? trace.map((t) => t.label) : null };
    } finally {
      client.terminate();
    }
  }, id);
}

/** The id of the engine the Workshop shows (after the wizard / an import navigated there). */
async function currentEngineId(page: Page): Promise<string> {
  await expect(page).toHaveURL(UUID_URL, { timeout: 20_000 });
  return decodeURIComponent(UUID_URL.exec(page.url())![1]);
}

async function openWizard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New engine" }).first().click();
  await expect(page.locator(".engines-approaches")).toBeVisible();
  await expect(dialog(page)).toContainText("Step 1 of 2");
}

async function createFromWizard(page: Page): Promise<string> {
  const create = dialog(page).getByRole("button", { name: "Create engine" });
  await expect(create).toBeEnabled();
  const name = (await page.getByLabel("Name", { exact: true }).inputValue()).trim();
  await create.click();
  const id = await currentEngineId(page);
  await expect(toast(page, `Created “${name}”`).last()).toBeVisible();
  return id;
}

/** Back to the library through the app's nav bar (as a user would). */
async function backToLibrary(page: Page): Promise<void> {
  await page.locator(".app-nav-link", { hasText: "Engines" }).click();
  await expect(page).toHaveURL(/#\/engines$/);
  await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
}

async function chooseFile(page: Page, trigger: () => Promise<void>, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), trigger()]);
  await chooser.setFiles(file);
}

/** A valid engine module: the scratch-minimal build from .scratch/, or Sprout compiled right now. */
async function validWasmFile(page: Page, testInfo: TestInfo): Promise<string> {
  const prebuilt = ".scratch/scratch/scratch-minimal.wasm";
  try {
    await access(prebuilt);
    return prebuilt;
  } catch {
    const bytes = await page.evaluate(async () => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
      const sprout = (await s.enginesRepo.list()).find((e) => e.name === "Sprout");
      if (!sprout) throw new Error("Sprout is missing");
      const out = await h.buildEngine(sprout);
      if (!out.engine.build) throw new Error("Sprout did not build");
      return Array.from(new Uint8Array(out.engine.build.wasm));
    });
    const file = testInfo.outputPath("scratch-minimal.wasm");
    await writeFile(file, Buffer.from(bytes));
    return file;
  }
}

/** No horizontal scrolling of the page or of the app's main area. */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".app-main");
    return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, main ? main.scrollWidth - main.clientWidth : 0);
  });
  expect(overflow, `horizontal overflow on ${where}`).toBeLessThanOrEqual(0);
}

// ------------------------------------------------------------------------------------------------
// Engine library

test("library: starter engines, search, kind filter and sort (remembered)", async ({ page }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  await expect(cards(page)).toHaveCount(4);
  for (const s of STARTERS) {
    const c = card(page, s.name);
    await expect(c.locator(".engines-card-badges")).toContainText(s.kind);
    await expect(c.locator(".engines-card-badges")).toContainText("Starter");
    await expect(c.locator(".engines-card-meta")).toContainText("Not built yet");
  }
  expect(await cardNames(page)).toEqual(["Blocky", "Classic", "Sprout", "Neuron"]);
  await expect(page.locator(".engines-count")).toHaveText("4 engines");
  await expect(card(page, "Neuron").locator(".engines-card-meta")).toContainText("Starter network (128 SCReLU)");

  // A fifth engine, older than the starters, so every sort order gives a different list.
  await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const t = (await import(String("/src/engine-host/templates.ts"))) as TemplatesModule;
    const day = 86_400_000;
    await s.enginesRepo.put({
      id: s.newId(),
      name: "Aardvark",
      description: "An old full-code engine",
      kind: "full",
      color: "#a78bfa",
      createdAt: Date.now() - day,
      updatedAt: Date.now() - day,
      options: { hashMb: 16 },
      files: { ...t.templateFiles },
      entry: "main.ts",
      templateVersion: t.TEMPLATE_VERSION,
      networkId: null,
      build: null,
      tags: ["zoo"],
    });
  });
  await expect(cards(page)).toHaveCount(5);
  expect(await cardNames(page)).toEqual(["Blocky", "Classic", "Sprout", "Neuron", "Aardvark"]);

  // Search: names, descriptions and tags, any case; "/" focuses the box, Esc clears it.
  const search = page.getByRole("searchbox", { name: "Search engines" });
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.type("sprout");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator(".engines-count")).toHaveText("1 of 5 engines");
  await search.fill("SINGLE-FILE");
  expect(await cardNames(page)).toEqual(["Sprout"]);
  await search.fill("starter");
  await expect(cards(page)).toHaveCount(4);
  await search.fill("zoo");
  expect(await cardNames(page)).toEqual(["Aardvark"]);
  await search.fill("zzz nothing");
  await expect(page.getByText("No engines match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(cards(page)).toHaveCount(5);
  await search.fill("classic");
  await search.press("Escape");
  await expect(search).toHaveValue("");

  // The search survives opening an engine and coming Back, and a reload.
  await search.fill("classic");
  await expect(cards(page)).toHaveCount(1);
  await expect(page).toHaveURL(/#\/engines\?q=classic$/);
  await card(page, "Classic").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(UUID_URL);
  await page.goBack();
  await expect(search).toHaveValue("classic");
  await expect(cards(page)).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search engines" })).toHaveValue("classic");
  await expect(cards(page)).toHaveCount(1);
  // The nav link opens the plain library again.
  await backToLibrary(page);
  await expect(page.getByRole("searchbox", { name: "Search engines" })).toHaveValue("");
  await expect(cards(page)).toHaveCount(5);

  // Kind filter (with counts) and its empty state.
  const kindSelect = kindSelectOf(page);
  const sortSelect = sortSelectOf(page);
  await expect(kindSelect.locator("option")).toHaveText(["All kinds (5)", "Blocks (1)", "Eval code (1)", "Full code (1)", "Scratch (1)", "NNUE (1)", "WASM (0)"]);
  await kindSelect.selectOption("eval");
  expect(await cardNames(page)).toEqual(["Classic"]);
  await kindSelect.selectOption("nnue");
  expect(await cardNames(page)).toEqual(["Neuron"]);
  await kindSelect.selectOption("wasm");
  await expect(page.getByText("You have no WASM engines yet.")).toBeVisible();
  await page.getByRole("button", { name: "New WASM engine" }).click();
  await expect(dialog(page)).toContainText("Step 2 of 2");
  await expect(dialog(page).locator(".engines-wizard-chosen")).toContainText("Upload .wasm");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/new=1/);

  // Sort orders.
  await kindSelect.selectOption("all");
  await sortSelect.selectOption("name");
  expect(await cardNames(page)).toEqual(["Aardvark", "Blocky", "Classic", "Neuron", "Sprout"]);
  await sortSelect.selectOption("kind");
  expect(await cardNames(page)).toEqual(["Blocky", "Classic", "Aardvark", "Sprout", "Neuron"]);
  await sortSelect.selectOption("created");
  expect(await cardNames(page)).toEqual(["Blocky", "Classic", "Sprout", "Neuron", "Aardvark"]);

  // Filter and sort are remembered across a reload.
  await sortSelect.selectOption("name");
  await kindSelect.selectOption("full");
  await expect(cards(page)).toHaveCount(1);
  await page.reload();
  await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(kindSelectOf(page)).toHaveValue("full");
  await expect(sortSelectOf(page)).toHaveValue("name");
  expect(await cardNames(page)).toEqual(["Aardvark"]);
  expect(errors).toEqual([]);
});

test("wizard: blocks, evaluation-code and full-code engines open in the Workshop and build", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await openLibrary(page);

  // Blocks, with the suggested name.
  await openWizard(page);
  await approach(page, "Blocks").click();
  await expect(dialog(page)).toContainText("Step 2 of 2");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("My blocks engine");
  const blocksId = await createFromWizard(page);
  const blocks = await engineRecord(page, blocksId);
  expect(blocks).toMatchObject({ kind: "blocks", name: "My blocks engine", builtin: false, hasBlocks: true, generatorVersion: 2, entry: "main.ts", networkId: null, parentId: null });
  expect(blocks.fileNames).toEqual(["eval.ts"]);
  expect(blocks.createdAt).toBe(blocks.updatedAt);
  expect(blocks.hashMb).toBe(16);
  const b1 = await buildById(page, blocksId);
  expect(b1.ok, b1.errors.join("\n")).toBe(true);

  // Evaluation code, with a typed name, description and colour; Back to step 1 and on again.
  await backToLibrary(page);
  await openWizard(page);
  await approach(page, "Full engine code").click();
  await dialog(page).getByRole("button", { name: "Back" }).click();
  await expect(dialog(page)).toContainText("Step 1 of 2");
  await approach(page, "Evaluation code").click();
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("   ");
  await expect(dialog(page).getByRole("button", { name: "Create engine" })).toBeDisabled();
  await expect(dialog(page)).toContainText("Give your engine a name.");
  await name.fill("Classic");
  await expect(dialog(page)).toContainText("You already have an engine called “Classic”");
  await name.fill("Eval Tester");
  await page.getByLabel("Description").fill("Checks the eval path");
  await page.getByRole("radio", { name: "Violet" }).check({ force: true });
  const evalId = await createFromWizard(page);
  const evalRec = await engineRecord(page, evalId);
  expect(evalRec).toMatchObject({ kind: "eval", name: "Eval Tester", description: "Checks the eval path", color: "#a78bfa", entry: "main.ts" });
  expect(evalRec.fileNames).toEqual(["eval.ts"]);
  const b2 = await buildById(page, evalId);
  expect(b2.ok, b2.errors.join("\n")).toBe(true);

  // Full engine code: the whole template tree.
  await backToLibrary(page);
  await openWizard(page);
  await approach(page, "Full engine code").click();
  const fullId = await createFromWizard(page);
  const full = await engineRecord(page, fullId);
  const templateNames = await page.evaluate(async () => Object.keys(((await import(String("/src/engine-host/templates.ts"))) as TemplatesModule).templateFiles).sort());
  expect(full.kind).toBe("full");
  expect(full.fileNames).toEqual(templateNames);
  const b3 = await buildById(page, fullId);
  expect(b3.ok, b3.errors.join("\n")).toBe(true);
  const played = await quickSearch(page, fullId);
  expect(played.bestMove).toMatch(/^[a-h][1-8][a-h][1-8]$/);

  // The library shows all three with their build state.
  await backToLibrary(page);
  await expect(cards(page)).toHaveCount(7);
  for (const n of ["My blocks engine", "Eval Tester", "My engine"]) await expect(card(page, n).locator(".engines-card-meta")).toContainText("Built ·");
  expect(errors).toEqual([]);
});

test("wizard: scratch (minimal and empty) and NNUE engines; a reload keeps the wizard open", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await openLibrary(page);

  for (const variant of ["Minimal working engine", "Empty skeleton"] as const) {
    await openWizard(page);
    await approach(page, "From scratch").click();
    if (variant === "Empty skeleton") await dialog(page).getByText("Empty skeleton", { exact: true }).click();
    await expect(dialog(page).locator(".engines-option.is-selected")).toContainText(variant);
    const id = await createFromWizard(page);
    const r = await engineRecord(page, id);
    const expected = await page.evaluate(
      async (v: "empty" | "minimal") => JSON.stringify(((await import(String("/src/engine-host/templates.ts"))) as TemplatesModule).scratchFiles(v)),
      variant === "Empty skeleton" ? ("empty" as const) : ("minimal" as const),
    );
    expect(r).toMatchObject({ kind: "scratch", entry: "main.ts", templateVersion: null });
    expect(r.filesJson).toBe(expected);
    const b = await buildById(page, id);
    expect(b.ok, b.errors.join("\n")).toBe(true);
    if (variant === "Minimal working engine") expect((await quickSearch(page, id)).bestMove).toMatch(/^[a-h][1-8][a-h][1-8]$/);
    await backToLibrary(page);
  }

  // NNUE without a network: it builds and uses the fallback evaluation. The starter network is
  // offered, but "None" can be chosen.
  await openWizard(page);
  await approach(page, "NNUE").click();
  await expect(dialog(page).locator(".engines-option", { hasText: "Starter network (128 SCReLU)" })).toBeVisible();
  await dialog(page).locator(".engines-option", { hasText: "Uses the fallback evaluation" }).click();
  await expect(dialog(page).locator(".engines-option.is-selected")).toContainText("None");
  const nnueId = await createFromWizard(page);
  const nnue = await engineRecord(page, nnueId);
  expect(nnue).toMatchObject({ kind: "nnue", networkId: null, entry: "main.ts" });
  const b = await buildById(page, nnueId);
  expect(b.ok, b.errors.join("\n")).toBe(true);
  const run = await quickSearch(page, nnueId);
  expect(run.bestMove).toMatch(/^[a-h][1-8][a-h][1-8]$/);
  expect(run.trace).toContain("Fallback (no network)");
  await backToLibrary(page);
  await expect(card(page, "My NNUE engine").locator(".engines-card-meta")).toContainText("No network yet · fallback evaluation");

  // The wizard state lives in the URL: a reload in the middle keeps it open at the same step.
  await page.goto("/#/engines?new=1&kind=scratch");
  await expect(dialog(page)).toContainText("Step 2 of 2");
  await page.reload();
  await expect(dialog(page)).toContainText("Step 2 of 2", { timeout: 30_000 });
  await expect(dialog(page).locator(".engines-wizard-chosen")).toContainText("From scratch");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/engines$/);
  expect(errors).toEqual([]);
});

test("wizard: .wasm upload accepts a working module and rejects invalid files", async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  const wasmPath = await validWasmFile(page, testInfo);
  const wasmSize = (await readFile(wasmPath)).byteLength;

  await openWizard(page);
  await approach(page, "Upload .wasm").click();
  const create = dialog(page).getByRole("button", { name: "Create engine" });
  await expect(create).toBeDisabled();
  await expect(dialog(page)).toContainText("Choose a working .wasm module.");

  // Not WebAssembly at all.
  await chooseFile(page, () => dialog(page).getByRole("button", { name: "Choose file…" }).click(), {
    name: "notes.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from("hello, this is not wasm"),
  });
  await expect(dialog(page)).toContainText("This module can't be used as an engine.", { timeout: 30_000 });
  await expect(dialog(page)).toContainText("Not a valid WebAssembly module");
  await expect(create).toBeDisabled();

  // Valid WebAssembly, but no engine inside (an empty module).
  await chooseFile(page, () => dialog(page).getByRole("button", { name: "Choose another…" }).click(), {
    name: "empty.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  });
  await expect(dialog(page)).toContainText("This module can't be used as an engine.", { timeout: 30_000 });
  await expect(dialog(page).locator(".engines-wasm-list").first()).toContainText(/cb_/);
  await expect(create).toBeDisabled();

  // A working engine: its name, capabilities and a name suggestion from cb_name.
  await chooseFile(page, () => dialog(page).getByRole("button", { name: "Choose another…" }).click(), wasmPath);
  await expect(dialog(page)).toContainText("Ready to use", { timeout: 30_000 });
  const reported = (await dialog(page).locator(".engines-wasm-verdict strong").textContent()) ?? "";
  expect(reported.length).toBeGreaterThan(0);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(reported);
  await expect(dialog(page).locator(".engines-cap.is-yes", { hasText: "Perft" })).toBeVisible();
  await expect(dialog(page).locator(".engines-cap.is-no", { hasText: "NNUE" })).toBeVisible();
  const id = await createFromWizard(page);
  const r = await engineRecord(page, id);
  expect(r).toMatchObject({ kind: "wasm", wasmBytes: wasmSize, networkId: null, name: reported });
  const b = await buildById(page, id);
  expect(b.ok).toBe(true);
  expect((await quickSearch(page, id)).bestMove).toMatch(/^[a-h][1-8][a-h][1-8]$/);
  await backToLibrary(page);
  await expect(card(page, reported).locator(".engines-card-meta")).toContainText("Uploaded module");

  // A module that can load NNUE networks (the stock NNUE engine) offers the network choice.
  const nnue = await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
    const h = (await import(String("/src/engine-host/index.ts"))) as HostModule;
    const id = s.newId();
    const float = n.createNetwork(32, 1, 3);
    const quantized = n.quantizeNetwork(float);
    const now = Date.now();
    await s.networksRepo.put({ id, name: "Upload net", description: "", createdAt: now, updatedAt: now, hidden: 32, activation: 1, parentId: null, stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null }, sizeBytes: quantized.byteLength });
    await s.networksRepo.putData({ id, quantized, float, optimizer: null });
    return { networkId: id, wasm: Array.from(new Uint8Array(await h.getStockNnueWasm())) };
  });
  const nnueWasm = testInfo.outputPath("stock-nnue.wasm");
  await writeFile(nnueWasm, Buffer.from(nnue.wasm));
  await openWizard(page);
  await approach(page, "Upload .wasm").click();
  await chooseFile(page, () => dialog(page).getByRole("button", { name: "Choose file…" }).click(), nnueWasm);
  await expect(dialog(page)).toContainText("Ready to use", { timeout: 30_000 });
  await expect(dialog(page).locator(".engines-cap.is-yes", { hasText: "NNUE" })).toBeVisible();
  await dialog(page).locator(".engines-option", { hasText: "Upload net" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Uploaded NNUE");
  const nnueId = await createFromWizard(page);
  expect(await engineRecord(page, nnueId)).toMatchObject({ kind: "wasm", networkId: nnue.networkId });
  expect((await quickSearch(page, nnueId)).trace).toContain("NNUE");
  expect(errors).toEqual([]);
});

test("wizard: copy an engine; ?new=1&kind=nnue&networkId= preselects a network", async ({ page }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  const classicId = (await engineList(page)).find((e) => e.name === "Classic")!.id;

  await openWizard(page);
  await approach(page, "Copy an existing engine").click();
  await expect(dialog(page)).toContainText("Choose the engine to copy.");
  await expect(dialog(page).getByRole("button", { name: "Create engine" })).toBeDisabled();
  await dialog(page).locator(".cb-ep-button").click();
  await page.locator(".cb-ep-option", { hasText: "Classic" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Classic (copy)");
  await expect(page.getByLabel("Description")).toHaveValue(/classic tapered evaluation/);
  const copyId = await createFromWizard(page);
  const [copy, original] = [await engineRecord(page, copyId), await engineRecord(page, classicId)];
  expect(copy).toMatchObject({ kind: "eval", name: "Classic (copy)", builtin: false, parentId: classicId, tags: [] });
  expect(copy.filesJson).toBe(original.filesJson);

  // A network stored the way the Lab stores them; the wizard opened from a link preselects it.
  const netId = await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
    const id = s.newId();
    const float = n.createNetwork(32, 1, 7);
    const quantized = n.quantizeNetwork(float);
    const now = Date.now();
    await s.networksRepo.put({ id, name: "Test net", description: "", createdAt: now, updatedAt: now, hidden: 32, activation: 1, parentId: null, stats: { positionsSeen: 123_456, epochs: 3, trainLoss: 0.05, valLoss: 0.0612 }, sizeBytes: quantized.byteLength });
    await s.networksRepo.putData({ id, quantized, float, optimizer: null });
    return id;
  });
  await page.goto(`/#/engines?new=1&kind=nnue&networkId=${netId}`);
  await expect(dialog(page).locator(".engines-option.is-selected")).toContainText("Test net");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Test net engine");
  const nnueId = await createFromWizard(page);
  expect(await engineRecord(page, nnueId)).toMatchObject({ kind: "nnue", networkId: netId });
  const b = await buildById(page, nnueId);
  expect(b.ok, b.errors.join("\n")).toBe(true);
  const run = await quickSearch(page, nnueId);
  expect(run.trace).toContain("NNUE");

  // The card names the network, and says so when the network is deleted.
  await backToLibrary(page);
  await expect(card(page, "Test net engine").locator(".engines-meta-network")).toContainText("Test net");
  await page.evaluate(async (id) => ((await import(String("/src/storage/index.ts"))) as StorageModule).networksRepo.remove(id), netId);
  await expect(card(page, "Test net engine").locator(".engines-card-meta")).toContainText("Network missing");

  // A link to a network that no longer exists falls back to "None".
  await page.goto(`/#/engines?new=1&kind=nnue&networkId=${netId}`);
  await expect(dialog(page).locator(".engines-option.is-selected")).toContainText("None");
  await expect(dialog(page)).toContainText("The selected network no longer exists");
  expect(errors).toEqual([]);
});

test("library: duplicate, export, import round trip, and delete with confirmation", async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await openLibrary(page);

  // Duplicate from the card menu: a highlighted "(copy)" card.
  await card(page, "Classic").getByRole("button", { name: "More actions for Classic" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(toast(page, "Created “Classic (copy)”")).toBeVisible();
  await expect(card(page, "Classic (copy)")).toBeVisible();
  await expect(card(page, "Classic (copy)")).toHaveClass(/engines-card--new/);
  await expect(card(page, "Classic (copy)").locator(".engines-card-badges")).not.toContainText("Starter");
  const list = await engineList(page);
  const copy = list.find((e) => e.name === "Classic (copy)")!;
  const classic = list.find((e) => e.name === "Classic")!;
  expect(copy).toMatchObject({ builtin: false, parentId: classic.id, kind: "eval" });
  expect(copy.filesJson).toBe(classic.filesJson);
  // Keyboard: the menu opens with ArrowDown and closes with Escape, focus back on the button.
  const menuButton = card(page, "Classic (copy)").getByRole("button", { name: "More actions for Classic (copy)" });
  await menuButton.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  // Export the copy, then import the file: a new engine with the same sources.
  await menuButton.click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export" }).click()]);
  expect(download.suggestedFilename()).toBe("classic-copy.engine.json");
  const exported = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(exported);
  const json = JSON.parse(await readFile(exported, "utf8")) as { format: string; engine: { name: string; build: unknown } };
  expect(json.format).toBe("boardform-engine");
  expect(json.engine.name).toBe("Classic (copy)");
  expect(json.engine.build).toBeNull();
  await expect(toast(page, "Exported “Classic (copy)”")).toBeVisible();

  await chooseFile(page, () => page.getByRole("button", { name: "Import engine" }).click(), exported);
  const importedId = await currentEngineId(page);
  await expect(toast(page, "Imported “Classic (copy) (imported)”")).toBeVisible();
  const imported = await engineRecord(page, importedId);
  expect(imported).toMatchObject({ name: "Classic (copy) (imported)", kind: "eval", builtin: false, built: false });
  expect(imported.filesJson).toBe(copy.filesJson);
  const b = await buildById(page, importedId);
  expect(b.ok, b.errors.join("\n")).toBe(true);

  // Importing something that is not an engine file shows why, and changes nothing.
  await backToLibrary(page);
  await expect(cards(page)).toHaveCount(6);
  await chooseFile(page, () => page.getByRole("button", { name: "Import engine" }).click(), {
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "boardform-backup", version: 1, stores: {} })),
  });
  await expect(toast(page, "Could not import the engine")).toContainText("restore it from Settings");
  await chooseFile(page, () => page.getByRole("button", { name: "Import engine" }).click(), {
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{ not json"),
  });
  await expect(toast(page, "Could not import the engine").last()).toContainText("not readable JSON");
  await expect(page).toHaveURL(/#\/engines$/);
  await expect(cards(page)).toHaveCount(6);

  // Delete asks first: Cancel keeps it, confirming removes it.
  const target = card(page, "Classic (copy) (imported)");
  await target.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(dialog(page)).toContainText("Delete “Classic (copy) (imported)”?");
  await expect(dialog(page)).toContainText("Saved games and match results that include it are kept.");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(target).toBeVisible();
  await target.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete engine" }).click();
  await expect(toast(page, "Deleted “Classic (copy) (imported)”")).toBeVisible();
  await expect(target).toHaveCount(0);
  expect((await engineList(page)).some((e) => e.id === importedId)).toBe(false);

  // Deleting a starter engine mentions how to get it back.
  await card(page, "Sprout").getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(dialog(page)).toContainText("Restore starter engines");
  await dialog(page).getByRole("button", { name: "Delete engine" }).click();
  await expect(card(page, "Sprout")).toHaveCount(0);
  await page.reload();
  await expect(cards(page)).toHaveCount(4, { timeout: 30_000 });
  expect(await cardNames(page)).not.toContain("Sprout");
  expect(errors).toEqual([]);
});

test("library: a card's Open, Play and Match buttons lead to working pages", async ({ page }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  const classicId = (await engineList(page)).find((e) => e.name === "Classic")!.id;
  const healthy = async () => {
    await expect(page.locator(".app-main")).not.toContainText("Something went wrong on this page");
    await expect(page.locator(".app-main")).not.toContainText("Page not found");
  };
  // The name and the Open button both open the Workshop.
  await card(page, "Classic").locator(".engines-card-link").click();
  await expect(page).toHaveURL(new RegExp(`#/engines/${classicId}$`));
  await healthy();
  await backToLibrary(page);
  await card(page, "Classic").getByRole("link", { name: "Play" }).click();
  await expect(page).toHaveURL(new RegExp(`#/play\\?engine=${classicId}$`));
  await healthy();
  await expect(page.locator(".app-main")).toContainText("Classic");
  await backToLibrary(page);
  await card(page, "Classic").getByRole("link", { name: "Match" }).click();
  await expect(page).toHaveURL(new RegExp(`#/arena\\?new=1&engines=${classicId}$`));
  await healthy();
  await expect(dialog(page)).toContainText("Classic");
  expect(errors).toEqual([]);
});

test("library: changes made in another tab show up without a reload", async ({ page, context }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  const other = await context.newPage();
  const otherErrors = trackErrors(other);
  await openLibrary(other);
  // Create in the second tab.
  await other.goto("/#/engines?new=1&kind=scratch");
  await other.getByLabel("Name", { exact: true }).fill("From the other tab");
  await createFromWizard(other);
  await expect(card(page, "From the other tab")).toBeVisible({ timeout: 15_000 });
  // Rename and delete there, too.
  const id = (await engineList(other)).find((e) => e.name === "From the other tab")!.id;
  await other.evaluate(async (engineId) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    await s.enginesRepo.update(engineId, { name: "Renamed elsewhere" });
  }, id);
  await expect(card(page, "Renamed elsewhere")).toBeVisible({ timeout: 15_000 });
  await other.goto("/#/engines");
  await card(other, "Renamed elsewhere").getByRole("button", { name: /More actions/ }).click();
  await other.getByRole("menuitem", { name: "Delete" }).click();
  await dialog(other).getByRole("button", { name: "Delete engine" }).click();
  await expect(card(page, "Renamed elsewhere")).toHaveCount(0, { timeout: 15_000 });
  await expect(cards(page)).toHaveCount(4);
  await other.close();
  expect([...errors, ...otherErrors]).toEqual([]);
});

test("library: empty state, restore starter engines without duplicates", async ({ page }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  // Remove every engine.
  await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    for (const e of await s.enginesRepo.list()) await s.enginesRepo.remove(e.id);
  });
  await expect(page.getByText("No engines yet")).toBeVisible();
  await expect(page.locator(".engines-empty-way")).toHaveCount(6);
  // Each way opens the wizard at its second step.
  await page.locator(".engines-empty-way", { hasText: "From scratch" }).click();
  await expect(dialog(page)).toContainText("Step 2 of 2");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Restore starter engines" }).click();
  await expect(toast(page, "Starter engines restored")).toBeVisible();
  await expect(cards(page)).toHaveCount(4);
  // Neuron comes back with its network (which was never deleted, so it is not duplicated).
  expect((await engineList(page)).find((e) => e.name === "Neuron")?.networkId).toBe("starter-network-hl128");

  // Restoring again while the starters are untouched adds nothing.
  await page.goto("/#/settings?section=storage");
  const restore = page.locator(".settings-row", { hasText: "Restore starter engines" }).getByRole("button", { name: "Restore starter engines" });
  await restore.click();
  await expect(toast(page, "Your starter engines are all here")).toBeVisible();
  expect((await engineList(page)).map((e) => e.name).sort()).toEqual(["Blocky", "Classic", "Neuron", "Sprout"]);

  // An edited starter is kept, and a fresh copy comes back next to it; a deleted one comes back.
  await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const list = await s.enginesRepo.list();
    const classic = list.find((e) => e.name === "Classic")!;
    await s.enginesRepo.update(classic.id, { files: { "eval.ts": classic.files!["eval.ts"] + "\n// my change\n" } });
    await s.enginesRepo.remove(list.find((e) => e.name === "Sprout")!.id);
  });
  await restore.click();
  await expect(page.locator(".toast .small", { hasText: /^Classic and Sprout are back in your library\.$/ })).toBeVisible();
  const names = (await engineList(page)).map((e) => e.name).sort();
  expect(names).toEqual(["Blocky", "Classic", "Classic", "Neuron", "Sprout"]);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// Settings

test("settings: theme, board colours, hash size and workers persist and apply", async ({ page }) => {
  const errors = trackErrors(page);
  await openLibrary(page);
  await page.goto("/#/settings");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  const themes = page.getByRole("radiogroup", { name: "Colour theme" });
  await themes.getByRole("radio", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("radiogroup", { name: "Colour theme" }).getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  // System follows the device, also when it changes.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("radiogroup", { name: "Colour theme" }).getByRole("radio", { name: "System" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Follows your device — currently dark.")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("Follows your device — currently light.")).toBeVisible();
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  // Arrow keys move the choice.
  await page.getByRole("radiogroup", { name: "Colour theme" }).getByRole("radio", { name: "System" }).focus();
  await page.keyboard.press("Home");
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Board colours apply to boards elsewhere in the app.
  await page.getByRole("radiogroup", { name: "Board colours" }).getByRole("radio", { name: "Green" }).click();
  await expect(page.locator(".settings-preview .cb-sq-light").first()).toHaveCSS("fill", "rgb(238, 238, 210)");
  await page.getByRole("switch", { name: "Show coordinates" }).uncheck({ force: true });
  await expect(page.locator(".settings-preview .cb-coords")).toHaveCount(0);
  // The preview board plays the arrow's move, and Reset goes back to the start.
  const resetBoard = page.locator(".settings-preview").getByRole("button", { name: "Reset" });
  await expect(resetBoard).toBeDisabled();
  await page.locator(".settings-preview").getByRole("button", { name: "Play a move" }).click();
  await expect(resetBoard).toBeEnabled();
  await resetBoard.click();
  await expect(resetBoard).toBeDisabled();
  // Animation and the other switches are stored with the board preferences.
  await expect(page.locator(".settings-preview .cb-arrows")).toHaveCount(1);
  await page.getByRole("radiogroup", { name: "Piece animation" }).getByRole("radio", { name: "Off" }).click();
  await page.getByRole("switch", { name: "Show legal-move dots" }).uncheck({ force: true });
  await page.getByRole("switch", { name: "Show engine arrows" }).uncheck({ force: true });
  await expect
    .poll(() => page.evaluate(async () => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.get<Record<string, unknown>>("prefs.board", {})))
    .toMatchObject({ theme: "green", showCoordinates: false, animationMs: 0, showLegalMoves: false, showEngineArrows: false });
  await expect(page.locator(".settings-preview .cb-arrows")).toHaveCount(0);
  await page.goto("/#/dev/board");
  const devBoard = page.getByTestId("dev-board-main");
  await expect(devBoard.locator(".cb-sq-light").first()).toHaveCSS("fill", "rgb(238, 238, 210)");
  await expect(devBoard.locator(".cb-sq-dark").first()).toHaveCSS("fill", "rgb(118, 150, 86)");
  await page.reload();
  await expect(page.getByTestId("dev-board-main").locator(".cb-sq-light").first()).toHaveCSS("fill", "rgb(238, 238, 210)");
  // The Play page board follows the colours and the coordinates switch.
  await page.goto("/#/play");
  const playBoard = page.locator(".cb-board").first();
  await expect(playBoard.locator(".cb-sq-light")).toHaveCSS("fill", "rgb(238, 238, 210)");
  await expect(playBoard.locator(".cb-coords")).toHaveCount(0);

  // Default hash size: invalid input explains itself, a valid one is saved and used by new engines.
  await page.goto("/#/settings?section=engines");
  const hash = page.getByLabel("Default hash size");
  await expect(hash).toHaveValue("16");
  // Typing an invalid size digit by digit saves none of the steps on the way ("2", "20", "200").
  await hash.fill("");
  await hash.pressSequentially("2000", { delay: 30 });
  await expect(page.getByText("A whole number from 1 to 512.")).toBeVisible();
  await hash.blur();
  await expect(hash).toHaveValue("16");
  await hash.fill("0");
  await expect(page.getByText("A whole number from 1 to 512.")).toBeVisible();
  await hash.fill("1024");
  await expect(page.getByText("A whole number from 1 to 512.")).toBeVisible();
  await hash.fill("64");
  await expect(page.getByText("A whole number from 1 to 512.")).toHaveCount(0);
  await hash.blur();
  // Background workers: the slider saves, "Reset to" goes back to the default.
  const workers = page.getByLabel("Background workers");
  await workers.focus();
  await page.keyboard.press("Home");
  await expect(page.locator(".settings-workers-value")).toHaveText("1");
  // Both are written to IndexedDB (the write finishes a moment after the change).
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
        return { hash: await s.settingsRepo.get("prefs.defaultHashMb", 0), workers: await s.settingsRepo.get("prefs.maxWorkers", 0) };
      }),
    )
    .toEqual({ hash: 64, workers: 1 });
  await page.reload();
  await expect(page.getByLabel("Default hash size")).toHaveValue("64");
  await expect(page.locator(".settings-workers-value")).toHaveText("1");
  await expect(page.getByRole("switch", { name: "Show coordinates" })).not.toBeChecked();
  const reset = page.locator(".settings-link-button", { hasText: /^Reset to \d+$/ });
  if (await reset.count()) {
    await reset.click();
    await expect(reset).toHaveCount(0);
  }
  await expect(page.locator(".settings-row", { hasText: "Instant engine stop" })).toContainText("Available");

  // A new engine gets the default hash size.
  await page.goto("/#/engines?new=1&kind=eval");
  const id = await createFromWizard(page);
  expect((await engineRecord(page, id)).hashMb).toBe(64);
  expect(errors).toEqual([]);
});

test("settings: backup export, delete all data, import restores, storage estimate", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await openLibrary(page);
  // Something worth backing up: an engine of our own and a changed setting.
  await page.goto("/#/engines?new=1&kind=scratch");
  await page.getByLabel("Name", { exact: true }).fill("Backup probe");
  const probeId = await createFromWizard(page);
  await page.evaluate(async () => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.set("library.sort", "name"));

  await page.goto("/#/settings?section=storage");
  // Storage estimate and counts.
  const usage = page.locator(".settings-row", { hasText: "Storage used" });
  await expect(usage).toContainText(/(of .* this browser allows for the site|used; the browser does not say)/);
  const counts = page.locator(".settings-counts");
  await expect(counts.locator(".settings-count", { hasText: "Engines" })).toContainText("5");
  await usage.getByRole("button", { name: "Refresh" }).click();
  await expect(usage).toContainText(/(of .* this browser allows for the site|used; the browser does not say)/);
  const persistRow = page.locator(".settings-row", { hasText: "Keep my data" });
  await expect(persistRow).toContainText(/Protected|Not protected/);
  const keep = persistRow.getByRole("button", { name: "Keep my data" });
  if (await keep.count()) {
    await keep.click();
    await expect(page.locator(".toast", { hasText: /Your data is protected|The browser did not grant persistent storage/ })).toBeVisible();
  }

  // Export a backup (without games), and cancel one on the way.
  const exportButton = page.getByRole("button", { name: "Export backup" });
  await page.getByLabel("Include saved games").uncheck();
  const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
  expect(download.suggestedFilename()).toMatch(/^boardform-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backupPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(backupPath);
  await expect(toast(page, "Backup saved")).toBeVisible();
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as { format: string; options: { includeGames: boolean }; stores: Record<string, unknown[]> };
  expect(backup.format).toBe("boardform-backup");
  expect(backup.options.includeGames).toBe(false);
  expect(backup.stores.engines).toHaveLength(5);
  expect(backup.stores.games).toBeUndefined();

  // Delete all data: the button stays disabled until DELETE is typed; Cancel changes nothing.
  await page.getByRole("button", { name: "Delete all data…" }).click();
  const confirmDelete = dialog(page).getByRole("button", { name: "Delete everything" });
  await expect(confirmDelete).toBeDisabled();
  await dialog(page).getByLabel("Type DELETE to confirm").fill("delete");
  await expect(confirmDelete).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  expect((await engineList(page)).length).toBe(5);
  await page.getByRole("button", { name: "Delete all data…" }).click();
  await dialog(page).getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog(page).getByRole("button", { name: "Delete everything" }).click();
  await expect(toast(page, "All data deleted")).toBeVisible({ timeout: 30_000 });
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => (await engineList(page)).map((e) => e.name).sort()).toEqual(["Blocky", "Classic", "Neuron", "Sprout"]);
  await expect(counts.locator(".settings-count", { hasText: "Engines" })).toContainText("4");
  expect(await page.evaluate(async () => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.get("library.sort", "unset"))).toBe("unset");
  // The theme survives.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // A wrong file is rejected without changing anything.
  await chooseFile(page, () => page.getByRole("button", { name: "Import backup…" }).click(), {
    name: "engine.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "boardform-engine", version: 1, engine: {} })),
  });
  await dialog(page).getByRole("button", { name: "Restore backup" }).click();
  await expect(page.locator(".settings-import .callout.danger")).toContainText("engine.json could not be restored.");
  await expect(page.locator(".settings-import .callout.danger")).toContainText("Nothing was changed.");
  expect((await engineList(page)).length).toBe(4);

  // Cancelling the confirmation does nothing either.
  await chooseFile(page, () => page.getByRole("button", { name: "Import backup…" }).click(), backupPath);
  await expect(dialog(page)).toContainText("Restore this backup?");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  expect((await engineList(page)).length).toBe(4);

  // The real restore brings everything back, then offers to remove the starters seeded meanwhile.
  await chooseFile(page, () => page.getByRole("button", { name: "Import backup…" }).click(), backupPath);
  await dialog(page).getByRole("button", { name: "Restore backup" }).click();
  await expect(toast(page, "Backup restored")).toBeVisible({ timeout: 30_000 });
  const result = page.locator(".settings-import-result");
  await expect(result).toContainText("5 engines");
  // Neuron has a fixed id, so the backup's copy replaced the fresh one: only three duplicates.
  await expect(result).toContainText("untouched duplicates of the starter engines (3 engines)");
  expect((await engineList(page)).length).toBe(8);
  await result.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(toast(page, "Removed 3 duplicate starter engines")).toBeVisible();
  const after = await engineList(page);
  expect(after.map((e) => e.name).sort()).toEqual(["Backup probe", "Blocky", "Classic", "Neuron", "Sprout"]);
  expect(after.some((e) => e.id === probeId)).toBe(true);
  expect(await page.evaluate(async () => ((await import(String("/src/storage/index.ts"))) as StorageModule).settingsRepo.get("library.sort", "unset"))).toBe("name");
  const b = await buildById(page, probeId);
  expect(b.ok, b.errors.join("\n")).toBe(true);

  // The library shows the restored engines, sorted the restored way.
  await backToLibrary(page);
  expect(await cardNames(page)).toEqual(["Backup probe", "Blocky", "Classic", "Neuron", "Sprout"]);
  expect(errors).toEqual([]);
});

test("settings: delete all data stops a running match and dataset generation first", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await openLibrary(page);
  const ids = await page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const a = (await import(String("/src/arena/index.ts"))) as ArenaModule;
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    const list = await s.enginesRepo.list();
    const classic = list.find((e) => e.name === "Classic")!.id;
    const sprout = list.find((e) => e.name === "Sprout")!.id;
    const cfg = a.defaultMatchConfig({ engineIds: [classic, sprout], hashMb: 8, maxWorkers: 2 });
    cfg.name = "Busy match";
    cfg.gamesPerPairing = 40;
    cfg.concurrency = 2;
    cfg.participants = cfg.participants.map((p) => ({ ...p, limits: { nodes: 3000 }, timeControl: null }));
    const matchId = await a.arena.createMatch(cfg, { start: true });
    const datasetId = await t.datasets.generate({
      name: "Busy dataset",
      selfPlay: { engineId: sprout, limits: { nodes: 500 }, randomPlies: 4, games: 200, concurrency: 1, maxPlies: 160, skipPlies: 4 },
    });
    return { matchId, datasetId };
  });
  // Wait until both are really working (the header shows the background work).
  await expect(page.locator(".activity")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        page.evaluate(async ({ matchId, datasetId }) => {
          const a = (await import(String("/src/arena/index.ts"))) as ArenaModule;
          const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
          return a.arena.isRunning(matchId) && t.datasets.isGenerating(datasetId);
        }, ids),
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.goto("/#/settings?section=danger");
  await page.getByRole("button", { name: "Delete all data…" }).click();
  await expect(dialog(page)).toContainText("Running training, dataset generation and matches are stopped first.");
  await dialog(page).getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog(page).getByLabel("Type DELETE to confirm").press("Enter");
  await expect(toast(page, "All data deleted")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".activity")).toHaveCount(0, { timeout: 30_000 });

  // Nothing the stopped jobs were doing writes into the emptied database afterwards.
  await page.waitForTimeout(4000);
  const left = await page.evaluate(async ({ matchId, datasetId }) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const a = (await import(String("/src/arena/index.ts"))) as ArenaModule;
    const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
    return {
      engines: (await s.enginesRepo.list()).map((e) => e.name).sort(),
      matches: (await s.matchesRepo.list()).length,
      games: (await s.gamesRepo.list()).length,
      datasets: (await s.datasetsRepo.list()).length,
      chunks: await s.datasetsRepo.chunkCount(datasetId),
      running: a.arena.isRunning(matchId) || t.datasets.isGenerating(datasetId),
    };
  }, ids);
  expect(left).toEqual({ engines: ["Blocky", "Classic", "Neuron", "Sprout"], matches: 0, games: 0, datasets: 0, chunks: 0, running: false });
  // The pages that showed them are empty and healthy.
  await page.goto("/#/arena");
  await expect(page.locator(".app-main")).not.toContainText("Busy match");
  await page.goto("/#/lab/datasets");
  await expect(page.locator(".app-main")).not.toContainText("Busy dataset");
  await expect(page.locator(".app-main")).not.toContainText("Something went wrong on this page");
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// Help

test("help: every topic renders, links resolve, TOC scrolls, search filters, copy works", async ({ page, context }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/help");
  await waitForSeeded(page);
  await expect(page.locator(".help-main h1")).toHaveText("Learn BoardForm");

  // Every topic renders, and every internal link in it points somewhere real.
  const anchorsByTopic = new Map<string, string[]>();
  const links = new Set<string>();
  for (const topic of HELP_TOPICS) {
    await page.goto(`/#/help/${topic}`);
    await expect(page.locator("#help-article-title")).not.toBeEmpty();
    await expect(page.locator(".help-prose h2").first()).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);
    anchorsByTopic.set(topic, await page.locator(".help-prose [data-anchor]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.anchor ?? "")));
    for (const href of await page.locator(".help-prose a[href^='#/']").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))) links.add(href);
  }
  expect(links.size).toBeGreaterThan(20);
  const appRoutes = new Set<string>();
  for (const link of links) {
    const [path, search = ""] = link.slice(1).split("?");
    const helpMatch = /^\/help(?:\/([^/]+))?$/.exec(path);
    if (helpMatch) {
      if (helpMatch[1]) expect(HELP_TOPICS, `link ${link}`).toContain(helpMatch[1]);
      const section = new URLSearchParams(search).get("section");
      if (section) expect(anchorsByTopic.get(helpMatch[1] ?? "") ?? [], `section of ${link}`).toContain(section);
    } else {
      appRoutes.add(link.slice(1));
    }
  }
  for (const route of appRoutes) {
    await page.goto(`/#${route}`);
    await expect(page.locator(".app-main")).not.toContainText("Page not found");
    await expect(page.locator(".app-main")).not.toContainText("Something went wrong on this page");
    // Links to a Settings section open the page at that section.
    const settingsSection = /^\/settings\?section=([a-z]+)$/.exec(route)?.[1];
    if (settingsSection) await expect(page.locator(`#settings-${settingsSection}`)).toBeInViewport();
  }
  expect([...appRoutes].some((r) => r.startsWith("/settings?section="))).toBe(true);

  // The table of contents scrolls to its section and records it in the URL; links inside a topic too.
  await page.goto("/#/help/storage");
  const toc = page.getByRole("navigation", { name: "On this page" });
  await toc.getByRole("link", { name: "Clearing data" }).click();
  await expect(page).toHaveURL(/#\/help\/storage\?section=clearing-data$/);
  await expect(page.locator('[data-anchor="clearing-data"]')).toBeInViewport();
  await expect(toc.getByRole("link", { name: "Clearing data" })).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "Back to top" }).click();
  await expect(page.locator("#help-article-title")).toBeInViewport();
  // A deep link opens at its section, a cross-topic link changes topic.
  await page.goto("/#/help/limits?section=choosing-fair-limits-for-matches");
  await expect(page.locator('[data-anchor="choosing-fair-limits-for-matches"]')).toBeInViewport();
  await page.goto("/#/help/getting-started");
  await page.locator(".help-prose a[href='#/help/storage']").first().click();
  await expect(page.locator("#help-article-title")).toHaveText("Saving and backups");

  // Search filters the topics and opens the best hit with Enter.
  const searchBox = page.getByRole("searchbox", { name: "Search the help" });
  await page.locator("#help-article-title").click();
  await page.keyboard.press("/");
  await expect(searchBox).toBeFocused();
  await page.keyboard.type("perft");
  await expect(page.locator(".help-results-count")).toContainText(/topics? match/);
  await expect(page.locator(".help-result-topic", { hasText: "From scratch" })).toBeVisible();
  await expect(page.locator(".help-result mark").first()).toHaveText(/perft/i);
  await searchBox.fill("qwxyzzy");
  await expect(page.locator(".help-results-count")).toHaveText("No matches");
  await searchBox.fill("restore starter engines");
  await expect(page.locator(".help-result-topic", { hasText: "Saving and backups" })).toBeVisible();
  // Enter opens the first section of the best hit.
  const best = (await page.locator(".help-result").first().locator("a").nth(1).getAttribute("href")) ?? "";
  expect(best).toMatch(/^#\/help\/[a-z-]+\?section=[a-z0-9-]+$/);
  await searchBox.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${escapeRe(best)}$`));
  await expect(page.locator(`[data-anchor="${new URLSearchParams(best.split("?")[1]).get("section")}"]`)).toBeInViewport();
  await searchBox.fill("");
  await expect(page.locator(".help-nav")).toBeVisible();

  // Copy buttons put the code on the clipboard.
  await page.goto("/#/help/eval-api");
  const block = page.locator(".help-code").first();
  const code = (await block.locator("code").textContent()) ?? "";
  expect(code.length).toBeGreaterThan(10);
  await block.getByRole("button", { name: "Copy the code" }).click();
  await expect(block.locator(".help-copy-label")).toHaveText("Copied");
  // (The Windows clipboard turns line ends into CRLF.)
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(code);
  await expect(block.locator(".help-copy-label")).toHaveText("Copy", { timeout: 5000 });

  // An unknown topic explains itself.
  await page.goto("/#/help/no-such-topic");
  await expect(page.locator(".help-main")).toContainText(/not found|doesn.t exist|no help topic/i);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// Layout

test("layout: library, wizard, settings and help fit a 400 px window in both themes", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 400, height: 860 });
  await openLibrary(page);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("cb.theme", t), theme);
    await page.goto("/#/engines");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page, `library (${theme})`);
    await page.screenshot({ path: testInfo.outputPath(`library-400-${theme}.png`) });
    await openWizard(page);
    await expectNoHorizontalOverflow(page, `wizard (${theme})`);
    await approach(page, "Upload .wasm").click();
    await expectNoHorizontalOverflow(page, `wizard wasm (${theme})`);
    await page.screenshot({ path: testInfo.outputPath(`wizard-400-${theme}.png`) });
    await page.keyboard.press("Escape");
    for (const section of ["appearance", "engines", "storage", "danger", "about"]) {
      await page.goto(`/#/settings?section=${section}`);
      await expect(page.locator(`#settings-${section}`)).toBeInViewport();
      await expectNoHorizontalOverflow(page, `settings ${section} (${theme})`);
    }
    await page.screenshot({ path: testInfo.outputPath(`settings-400-${theme}.png`) });
    for (const topic of ["", "/getting-started", "/scratch", "/abi", "/storage"]) {
      await page.goto(`/#/help${topic}`);
      await expect(page.locator(".help-main")).toBeVisible();
      await expectNoHorizontalOverflow(page, `help${topic} (${theme})`);
    }
    await page.screenshot({ path: testInfo.outputPath(`help-400-${theme}.png`) });
  }

  // On a narrow window the help has a topic picker and a search panel instead of the sidebar.
  await page.goto("/#/help");
  await page.getByLabel("Help topic", { exact: true }).selectOption("limits");
  await expect(page).toHaveURL(/#\/help\/limits$/);
  await expect(page.locator("#help-article-title")).toBeVisible();
  await page.getByRole("button", { name: "Search the help" }).click();
  const panel = page.locator("#help-mobile-search");
  await panel.getByRole("searchbox", { name: "Search the help" }).fill("perft");
  await panel.locator(".help-result-topic", { hasText: "From scratch" }).click();
  await expect(page).toHaveURL(/#\/help\/scratch$/);
  await expect(panel).toHaveCount(0);
  // The table of contents folds into the article.
  await page.locator(".help-toc-inline summary").click();
  await page.locator(".help-toc-inline").getByRole("link").nth(1).click();
  await expect(page).toHaveURL(/#\/help\/scratch\?section=/);
  await expectNoHorizontalOverflow(page, "help scratch section (narrow)");
  expect(errors).toEqual([]);
});
