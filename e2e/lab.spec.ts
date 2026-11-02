// End-to-end tests of the NNUE Lab (src/training + src/pages/lab) against the real service: the
// self-play workers, the trainer worker, engine builds and IndexedDB.
//
// Run: E2E_PORT=5215 npx playwright test e2e/lab.spec.ts
//
// Every test starts with a fresh browser context (empty IndexedDB): the app seeds the three starter
// engines on first load. Self-play uses node limits, so the games do not depend on the machine's
// speed. Screenshots for manual review are written to .scratch/verify-lab/shots/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DatasetRecord, EngineRecord, NetworkRecord, TrainingRunConfig, TrainingRunRecord } from "../src/types";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type TrainingModule = typeof import("../src/training/index");
type EngineHostModule = typeof import("../src/engine-host/index");
type NnueModule = typeof import("../src/nnue/index");

const SHOTS_DIR = join(process.cwd(), ".scratch", "verify-lab", "shots");
mkdirSync(SHOTS_DIR, { recursive: true });

interface StarterIds {
  classic: string;
  blocky: string;
  sprout: string;
}

// ------------------------------------------------------------------------------------- helpers

/** Collects uncaught page errors and console errors (checked at the end of each test). */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Opens the app and waits until the starter engines are seeded. */
async function openApp(page: Page, hash = "#/lab"): Promise<StarterIds> {
  await page.goto("/" + hash);
  let ids: Partial<StarterIds> = {};
  await expect
    .poll(
      async () => {
        ids = await page.evaluate(async () => {
          const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
          const list = await s.enginesRepo.list();
          const by = (n: string) => list.find((e) => e.name === n)?.id;
          return { classic: by("Classic"), blocky: by("Blocky"), sprout: by("Sprout") };
        });
        return Boolean(ids.classic && ids.blocky && ids.sprout);
      },
      { timeout: 60_000, message: "starter engines are seeded" },
    )
    .toBe(true);
  return ids as StarterIds;
}

async function readRun(page: Page, id: string): Promise<TrainingRunRecord | null> {
  return page.evaluate(async (rid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.runsRepo.get(rid)) ?? null;
  }, id);
}

async function readDataset(page: Page, id: string): Promise<(DatasetRecord & { storedPositions: number; storedChunks: number }) | null> {
  return page.evaluate(async (did) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const rec = await s.datasetsRepo.get(did);
    if (!rec) return null;
    let storedPositions = 0;
    let storedChunks = 0;
    for await (const c of s.datasetsRepo.iterateChunks(did)) {
      storedPositions += c.count;
      storedChunks++;
    }
    return { ...rec, storedPositions, storedChunks };
  }, id);
}

async function listNetworks(page: Page): Promise<NetworkRecord[]> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return s.networksRepo.list();
  });
}

async function listDatasets(page: Page): Promise<DatasetRecord[]> {
  return page.evaluate(async () => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return s.datasetsRepo.list();
  });
}

async function readEngine(page: Page, id: string): Promise<EngineRecord | null> {
  return page.evaluate(async (eid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return (await s.enginesRepo.get(eid)) ?? null;
  }, id);
}

/** Polls the stored run until its status is one of `statuses`. */
async function waitForRun(page: Page, id: string, statuses: TrainingRunRecord["status"][], timeout = 150_000): Promise<TrainingRunRecord> {
  let rec: TrainingRunRecord | null = null;
  await expect
    .poll(
      async () => {
        rec = await readRun(page, id);
        return rec?.status ?? "missing";
      },
      { timeout, intervals: [250, 500, 1000], message: `run reaches ${statuses.join(" / ")}` },
    )
    .toMatch(new RegExp(`^(${statuses.join("|")})$`));
  return rec as unknown as TrainingRunRecord;
}

/** A .cbds file of `count` packed material-balance positions (header + count × 32 bytes). */
async function makeCbds(page: Page, count: number, seed: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ count, seed }) => {
      const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
      const data = n.makeMaterialDataset(count, seed);
      const out = new Uint8Array(16 + data.length);
      const dv = new DataView(out.buffer);
      out.set([67, 66, 68, 83]); // "CBDS"
      dv.setUint32(4, 1, true);
      dv.setUint32(8, count, true);
      out.set(data, 16);
      return Array.from(out);
    },
    { count, seed },
  );
  return Buffer.from(bytes);
}

/** The text dataset format ("FEN | score | result" per line) with `count` valid positions. */
async function makeTextDataset(page: Page, count: number, seed: number): Promise<string> {
  return page.evaluate(
    async ({ count, seed }) => {
      const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
      const data = n.makeMaterialDataset(count, seed);
      const lines = ["# BoardForm e2e dataset", ""];
      for (let i = 0; i < count; i++) {
        const p = n.unpackPosition(data, i * 32);
        lines.push(`${n.packedToFen(data, i * 32)} | ${p.score} | ${p.result === 2 ? "1.0" : p.result === 0 ? "0.0" : "0.5"}`);
      }
      return lines.join("\n") + "\n";
    },
    { count, seed },
  );
}

/** A CBNN network file with random weights. */
async function makeNetworkFile(page: Page, hidden: number, seed: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ hidden, seed }) => {
      const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
      return Array.from(new Uint8Array(n.quantizeNetwork(n.createNetwork(hidden, 1, seed))));
    },
    { hidden, seed },
  );
  return Buffer.from(bytes);
}

/** Imports `count` × `repeat` material positions through the service (fast test setup). */
async function importBigDataset(page: Page, name: string, count: number, repeat: number): Promise<string> {
  return page.evaluate(
    async ({ name, count, repeat }) => {
      const n = (await import(String("/src/nnue/index.ts"))) as NnueModule;
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      const data = n.makeMaterialDataset(count, 7);
      const header = new Uint8Array(16);
      const dv = new DataView(header.buffer);
      header.set([67, 66, 68, 83]);
      dv.setUint32(4, 1, true);
      dv.setUint32(8, count * repeat, true);
      const parts: BlobPart[] = [header];
      for (let i = 0; i < repeat; i++) parts.push(data);
      return t.datasets.importFile(new Blob(parts), { name });
    },
    { name, count, repeat },
  );
}

function runConfig(patch: Partial<TrainingRunConfig> & Pick<TrainingRunConfig, "name">): TrainingRunConfig {
  return {
    network: { mode: "new", hidden: 16, activation: 1 },
    data: { datasetIds: [], selfPlay: null },
    hyper: {
      epochs: 1,
      batchSize: 256,
      learningRate: 0.002,
      lrSchedule: "constant",
      evalWeight: 0.75,
      weightDecay: 0.01,
      validationSplit: 0.1,
      threads: 1,
      seed: 1,
    },
    loop: { enabled: false, cycles: 1, selfPlayWithLatest: false, keepCycles: null, gating: null },
    publishEngine: false,
    ...patch,
  };
}

async function createRun(page: Page, config: TrainingRunConfig, opts: { autoResume?: boolean; start?: boolean } = {}): Promise<string> {
  return page.evaluate(
    async ({ config, opts }) => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      return t.training.createRun(config, opts);
    },
    { config, opts },
  );
}

/**
 * Records (in the page) whether elements matching each check ever appeared, however briefly: on
 * this machine small self-play phases can finish between two polls of a normal assertion. Survives
 * in-app navigation (the hash router keeps the page).
 */
async function watchFor(page: Page, checks: Record<string, { selector: string; text?: string }>): Promise<void> {
  await page.evaluate((checks) => {
    const w = window as unknown as { __labSeen?: Record<string, boolean> };
    const seen: Record<string, boolean> = (w.__labSeen = {});
    const test = () => {
      for (const [key, c] of Object.entries(checks)) {
        if (seen[key]) continue;
        for (const el of document.querySelectorAll(c.selector)) {
          if (!c.text || (el.textContent ?? "").includes(c.text)) {
            seen[key] = true;
            break;
          }
        }
      }
    };
    new MutationObserver(test).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    test();
  }, checks);
}

async function seenSoFar(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => ({ ...((window as unknown as { __labSeen?: Record<string, boolean> }).__labSeen ?? {}) }));
}

/** Clicks `trigger` and feeds the file chooser it opens. */
async function chooseFile(page: Page, trigger: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  await (await chooser).setFiles(file);
}

/** Runs `action` and returns the bytes of the download it starts. */
async function downloadOf(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const pending = page.waitForEvent("download");
  await action();
  const d = await pending;
  const stream = await d.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return { name: d.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

/** Opens an ActionMenu (by its accessible name) and picks an item. */
async function menu(page: Page, button: Locator, item: string): Promise<void> {
  await button.click();
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

/** Same as formatCount in src/utils/format.ts (what the stat tiles show). */
function formatCount(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0) + "M";
}

function toast(page: Page, text: string | RegExp): Locator {
  return page.locator(".toaster .toast", { hasText: text });
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
 * check that nothing scrolls sideways. The window is made as tall as the content so the whole
 * page is in the picture (the app scrolls inside .app-main). Restores the 1440 px dark view.
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

/** The wizard footer's "Next" button. */
async function wizardNext(page: Page): Promise<void> {
  await page.locator(".lab-wizard-footer").getByRole("button", { name: "Next" }).click();
}

async function expectWizardStep(page: Page, label: string): Promise<void> {
  await expect(page.locator(".lab-wstep.current")).toContainText(label);
}

/** A section link of the Lab's own navigation (Overview · Runs · Networks · Datasets). */
function labNav(page: Page, section: string): Locator {
  return page.locator(".lab-nav-link", { hasText: section });
}

function runHeader(page: Page): Locator {
  return page.locator(".lab-run-header");
}

function runStatus(page: Page): Locator {
  return runHeader(page).locator(".lab-status");
}

/** The dashboard's header controls (Start / Pause / Resume / Stop). */
function runControl(page: Page, name: string | RegExp): Locator {
  return page.locator(".lab-run-controls").getByRole("button", { name, exact: typeof name === "string" });
}

// ------------------------------------------------------------------------------------- tests

test.describe("NNUE Lab", () => {
  test("generates a dataset through the UI with live progress, then refuses to delete it while more games are added", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/datasets");
    await expect(page.getByRole("heading", { name: "No datasets yet" })).toBeVisible();
    await captureViews(page, "datasets-empty");

    await page.getByRole("button", { name: "Generate dataset" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate a dataset" });
    await expect(dialog).toBeVisible();
    // The Classic starter is suggested.
    await expect(dialog.getByRole("button", { name: "Engine that plays the games" })).toContainText("Classic");

    // Invalid input: games below 1 is rejected in the field; no search limit is a form problem.
    const games = dialog.locator("#lab-gen-games");
    await games.fill("0");
    await expect(dialog.getByText("At least 1")).toBeVisible();
    await games.fill("20");
    await dialog.getByRole("checkbox", { name: "Max positions searched (nodes)" }).uncheck();
    await dialog.getByRole("button", { name: "Start generating" }).click();
    await expect(dialog.getByText("Set at least one search limit, for example 5,000 nodes.")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Max positions searched (nodes)" }).check();
    await dialog.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("2000");
    await dialog.locator("#lab-gen-name").fill("E2E Classic 2k");
    await shot(page, "datasets-generate-dialog");
    await watchFor(page, {
      jobPanel: { selector: "#lab-ds-job", text: "Generating games" },
      boards: { selector: "#lab-ds-job .lab-board" },
      workers: { selector: "#lab-ds-job .lab-stat", text: "Workers" },
      activity: { selector: ".activity-button", text: "1 running" },
      readyToast: { selector: ".toaster .toast", text: "E2E Classic 2k\" is ready" },
    });
    await dialog.getByRole("button", { name: "Start generating" }).click();

    await expect(page).toHaveURL(/#\/lab\/datasets\/[^/?]+$/);
    const datasetId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(page.getByRole("heading", { name: "E2E Classic 2k" })).toBeVisible();
    // Live progress: the job panel, the header activity and the boards being played (recorded by
    // the watcher: 20 games can take only a few seconds).
    await page.locator("#lab-ds-job .lab-board").first().waitFor({ timeout: 5_000 }).then(
      () => shot(page, "dataset-generating"),
      () => undefined,
    );

    // Finished: the badge and the job panel disappear and the counts match what is stored.
    await expect(page.locator(".lab-detail-header .badge", { hasText: "Generating" })).toHaveCount(0, { timeout: 120_000 });
    await expect(page.locator("#lab-ds-job")).toHaveCount(0);
    await expect.poll(async () => (await seenSoFar(page)).readyToast ?? false, { timeout: 10_000 }).toBe(true);
    expect(await seenSoFar(page)).toEqual({ jobPanel: true, boards: true, workers: true, activity: true, readyToast: true });
    const ds = await readDataset(page, datasetId);
    expect(ds).not.toBeNull();
    expect(ds!.games).toBe(20);
    expect(ds!.positions).toBeGreaterThan(500);
    expect(ds!.storedPositions).toBe(ds!.positions);
    expect(ds!.storedChunks).toBe(ds!.chunks);
    expect(ds!.source.kind).toBe("selfplay");
    expect(ds!.source.limits?.nodes).toBe(2000);
    const card = page.locator(".lab-section > .card");
    await expect(stat(card, "Games")).toHaveText("20");
    await expect(stat(card, "Positions")).toHaveText(formatCount(ds!.positions));
    await expect(page.locator("#lab-ds-samples .lab-sample").first()).toBeVisible();
    await captureViews(page, "dataset-detail");

    // Add many more games, so generation is still running while we try to delete the dataset.
    await menu(page, page.getByRole("button", { name: "More dataset actions" }), "Add more games…");
    const more = page.getByRole("dialog", { name: "Generate a dataset" });
    await expect(more.locator("#lab-gen-target")).toHaveValue(datasetId);
    await more.locator("#lab-gen-games").fill("2000");
    await more.getByRole("button", { name: "Start generating" }).click();
    await expect(more).toHaveCount(0);
    await expect(page.locator(".lab-detail-header .badge", { hasText: "Generating" })).toBeVisible();
    await page.getByRole("button", { name: "More dataset actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    const refusal = await page.evaluate(async (id) => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      try {
        await t.datasets.remove(id);
        return "deleted";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }, datasetId);
    expect(refusal).toContain("still being generated");

    // The datasets list shows it as generating too, with the delete action disabled.
    await labNav(page, "Datasets").click();
    const row = page.locator("tr", { hasText: "E2E Classic 2k" });
    await expect(row.locator(".badge", { hasText: "Generating" })).toBeVisible();
    await row.getByRole("button", { name: "Actions for E2E Classic 2k" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await captureViews(page, "datasets-list-generating");

    // Stop it from the dataset page: what was played is kept.
    await row.getByRole("link", { name: "E2E Classic 2k" }).click();
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(page.locator(".lab-detail-header .badge", { hasText: "Generating" })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/Generation was stopped\. The [\d,]+ games played so far are kept\./)).toBeVisible();
    const after = await readDataset(page, datasetId);
    expect(after!.games).toBeGreaterThanOrEqual(20);
    expect(after!.games).toBeLessThan(2020);
    expect(after!.storedPositions).toBe(after!.positions);

    // Now it can be deleted (with confirmation).
    await menu(page, page.getByRole("button", { name: "More dataset actions" }), "Delete…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete dataset" }).click();
    await expect(page).toHaveURL(/#\/lab\/datasets$/);
    expect(await readDataset(page, datasetId)).toBeNull();
    expect(errors).toEqual([]);
  });

  test("wizard: validation errors, estimate warnings, draft restore and start over", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/new");
    await expectWizardStep(page, "Network");

    // Network: an invalid hidden size blocks the step.
    await page.getByRole("textbox", { name: "Hidden size" }).fill("30");
    await wizardNext(page);
    await expect(page.locator(".lab-wizard-problems")).toContainText("Choose a hidden size: a multiple of 8 between 8 and 2048.");
    await page.getByRole("radiogroup", { name: "Hidden size" }).getByText("32", { exact: true }).click();
    await wizardNext(page);
    await expectWizardStep(page, "Data");

    // Data: no datasets and no self-play.
    await page.getByRole("switch", { name: /Generate self-play games/ }).uncheck();
    await wizardNext(page);
    await expect(page.locator(".lab-wizard-problems")).toContainText("Choose at least one dataset or turn on self-play games.");
    await page.getByRole("switch", { name: /Generate self-play games/ }).check();
    // A new network cannot play the first cycle's games.
    await page.getByRole("button", { name: "Engine that plays the self-play games" }).click();
    await page.getByRole("option", { name: /This run's newest network/ }).click();
    await wizardNext(page);
    await expect(page.locator(".lab-wizard-problems")).toContainText("A new network has nothing to play with in the first cycle.");
    await shot(page, "wizard-data-problems");
    await page.getByRole("button", { name: "Engine that plays the self-play games" }).click();
    await page.getByRole("option", { name: /Classic/ }).click();
    await page.locator("#lab-sp-games").fill("20");
    await wizardNext(page);
    await expectWizardStep(page, "Training");

    // Training: the estimate warns about too few steps and positions and offers better settings.
    const estimate = page.locator(".lab-estimate").first();
    await expect(estimate).toContainText("optimizer steps per cycle");
    await expect(estimate).toContainText("A network usually needs a few hundred thousand positions");
    await expect(estimate.getByRole("button", { name: "Use suggested settings" })).toBeVisible();
    await captureViews(page, "wizard-training");
    await estimate.getByRole("button", { name: "Use suggested settings" }).click();
    await expect(page.getByRole("radiogroup", { name: "Training preset" }).locator(".lab-choice.checked")).toHaveCount(0);
    await expect(page.locator(".badge", { hasText: "Custom settings" })).toBeVisible();
    // Invalid field input is rejected in place.
    await page.locator("#lab-h-epochs").fill("0");
    await expect(page.locator(".lab-wizard-body").getByText("At least 1")).toBeVisible();
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await wizardNext(page);
    await expectWizardStep(page, "Loop & publishing");

    // Loop: gating needs at least 2 games.
    await page.getByRole("switch", { name: "Repeat self-play and training" }).check();
    await page.getByRole("switch", { name: "Only keep networks that play at least as well" }).check();
    await page.locator("#lab-g-games").fill("1");
    await expect(page.locator(".lab-wizard-body").getByText("At least 2")).toBeVisible();
    await page.locator("#lab-g-games").fill("4");
    await page.getByRole("textbox", { name: "Number of cycles" }).fill("1");
    await expect(page.getByText("With one cycle the loop never repeats")).toBeVisible();
    await page.getByRole("textbox", { name: "Number of cycles" }).fill("3");
    await captureViews(page, "wizard-loop");
    await wizardNext(page);
    await expectWizardStep(page, "Review");
    await expect(page.getByText("Ready to create.")).toBeVisible();
    await captureViews(page, "wizard-review");

    // The draft survives a reload.
    await page.waitForTimeout(800);
    await page.reload();
    await expectWizardStep(page, "Review");
    await expect(page.getByText("Picked up where you left off")).toBeVisible();
    await expect(page.locator(".lab-aside-list")).toContainText("3 cycles");
    await expect(page.locator(".lab-aside-list")).toContainText("HL32");

    // "Start over" asks first, then resets everything.
    await page.getByRole("button", { name: "Start over" }).click();
    await page.getByRole("dialog", { name: "Start over?" }).getByRole("button", { name: "Cancel" }).click();
    await expectWizardStep(page, "Review");
    await page.getByRole("button", { name: "Start over" }).click();
    await page.getByRole("dialog", { name: "Start over?" }).getByRole("button", { name: "Start over" }).click();
    await expectWizardStep(page, "Network");
    await expect(page.locator(".lab-aside-list")).toContainText("HL128");
    await expect(page.locator(".lab-aside-list")).toContainText("one cycle");
    expect(errors).toEqual([]);
  });

  test("trains a new HL32 network through the wizard, publishes an engine that plays", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/runs");
    await expect(page.getByRole("heading", { name: "No training runs yet" })).toBeVisible();
    await page.locator(".empty-state").getByRole("link", { name: "New training run" }).click();
    await expectWizardStep(page, "Network");
    await page.getByRole("radiogroup", { name: "Hidden size" }).getByText("32", { exact: true }).click();
    await wizardNext(page);
    await expectWizardStep(page, "Data");
    await page.locator("#lab-sp-games").fill("16");
    await page.locator("#lab-sp-workers").fill("2");
    await page.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("2000");
    await wizardNext(page);
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await page.locator("#lab-h-epochs").fill("3");
    await wizardNext(page);
    await expectWizardStep(page, "Loop & publishing");
    await expect(page.getByRole("switch", { name: "Publish an engine" })).toBeChecked();
    await wizardNext(page);
    await page.locator("#lab-run-name").fill("E2E HL32");
    await watchFor(page, {
      selfplay: { selector: "#lab-run-now .progress, #lab-run-now [role=progressbar], #lab-run-now", text: "Self-play games:" },
      boards: { selector: "#lab-run-now .lab-board" },
      trainBadge: { selector: ".lab-run-header .lab-status", text: "Training" },
      charts: { selector: "#lab-run-charts svg" },
    });
    const create = page.getByRole("button", { name: "Create and start" });
    await expect(create).toBeEnabled();
    await create.click();

    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const runId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(page.getByRole("heading", { name: "E2E HL32" })).toBeVisible();
    // Self-play first (live boards), then training (live losses), then finished.
    await expect(page.locator("#lab-run-now")).toContainText(/Self-play games|Starting games|Getting ready/);
    await page.locator("#lab-run-now .lab-board").first().waitFor({ timeout: 20_000 }).then(
      () => shot(page, "run-selfplay"),
      () => undefined, // already past self-play: the watcher below still saw it
    );
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 120_000 });
    // (3 epochs over ~1.5k positions can finish before the first live training report: the live
    // training view itself is checked by the pause / resume test.)
    expect(await seenSoFar(page)).toEqual({ boards: true, selfplay: true, trainBadge: true, charts: true });
    const run = await readRun(page, runId);
    expect(run!.status).toBe("finished");
    expect(run!.networkHistory).toHaveLength(1);
    expect(run!.points.length).toBeGreaterThan(0);
    expect(run!.engineId).not.toBeNull();

    // Charts, the network history and the sample evaluations.
    await expect(page.locator("#lab-run-charts svg").first()).toBeVisible();
    const history = page.locator("#lab-run-networks tbody tr");
    await expect(history).toHaveCount(1);
    await expect(history.first()).toContainText("E2E HL32 - c1");
    await expect(page.locator("#lab-run-evals")).not.toContainText("Once a network is trained");
    await expect(page.locator(".callout.ok", { hasText: "Finished." })).toBeVisible();
    await captureViews(page, "run-finished");

    // The network: HL32, trained by this run.
    const net = (await listNetworks(page)).find((n) => n.id === run!.networkId);
    expect(net?.hidden).toBe(32);
    expect(net?.stats.trainingRunId).toBe(runId);
    expect(net?.stats.epochs).toBeGreaterThanOrEqual(1);

    // The published engine uses it, builds and plays a move.
    const engine = await readEngine(page, run!.engineId as string);
    expect(engine?.kind).toBe("nnue");
    expect(engine?.networkId).toBe(run!.networkId);
    const played = await page.evaluate(async (engineId) => {
      const h = (await import(String("/src/engine-host/index.ts"))) as EngineHostModule;
      const client = await h.loadEngine(engineId);
      try {
        await client.newGame();
        await client.position("startpos", ["e2e4"]);
        const res = await client.go({ nodes: 4000 });
        const trace = await client.evalTrace();
        return { bestMove: res.bestMove, stopReason: res.stopReason, terms: (trace ?? []).map((t) => t.label) };
      } finally {
        client.terminate();
      }
    }, run!.engineId as string);
    expect(played.stopReason).toBe("done");
    expect(played.bestMove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    expect(played.terms).toContain("NNUE");

    // The runs list and the networks list show the result.
    await labNav(page, "Runs").click();
    const row = page.locator("tr", { hasText: "E2E HL32" });
    await expect(row.locator(".lab-status")).toHaveText("Finished");
    await captureViews(page, "runs-list");
    await labNav(page, "Networks").click();
    await expect(page.locator("tr", { hasText: "E2E HL32 - c1" })).toContainText("In 1 engine");
    await captureViews(page, "networks-list");
    await labNav(page, "Overview").click();
    await captureViews(page, "overview");

    // "Play against the newest network" opens Play against the published engine.
    await page.goto(`/#/lab/runs/${runId}`);
    await page.getByRole("button", { name: "Play against the newest network" }).click();
    await expect(page).toHaveURL(new RegExp(`#/play\\?engine=${run!.engineId}`));
    expect(errors).toEqual([]);
  });

  test("imports and exports networks and datasets, merges datasets, and continues / widens a network via the wizard", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/networks");
    // The starter network is listed; without it the page shows its empty state.
    await expect(page.getByText("Starter network (128 SCReLU)").first()).toBeVisible();
    await page.evaluate(async () => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      await s.networksRepo.remove(s.STARTER_NETWORK_ID);
    });
    await expect(page.getByRole("heading", { name: "No networks yet" })).toBeVisible();
    await captureViews(page, "networks-empty");

    // A broken network file is refused with a clear message.
    await chooseFile(page, page.getByRole("button", { name: "Import .nnue" }).first(), { name: "junk.nnue", mimeType: "application/octet-stream", buffer: Buffer.from("not a network") });
    await expect(toast(page, "Could not import the network")).toBeVisible();
    await expect(toast(page, "Could not import the network")).toContainText("not a network file BoardForm can use");

    // Import a real one (HL16), then export it again: same bytes.
    const netFile = await makeNetworkFile(page, 16, 11);
    await chooseFile(page, page.getByRole("button", { name: "Import .nnue" }).first(), { name: "e2e-net.nnue", mimeType: "application/octet-stream", buffer: netFile });
    await expect(page).toHaveURL(/#\/lab\/networks\/[^/?]+$/);
    const sourceId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(page.getByRole("heading", { name: "e2e-net" })).toBeVisible();
    await expect(page.locator(".lab-detail-header .badge", { hasText: "HL16" })).toBeVisible();
    const exported = await downloadOf(page, () => menu(page, page.getByRole("button", { name: "More network actions" }), "Export .nnue"));
    expect(exported.name).toBe("e2e-net.nnue");
    expect(exported.bytes.equals(netFile)).toBe(true);
    await expect(page.locator("#lab-net-evals")).not.toContainText("Could not");
    await captureViews(page, "network-detail-imported");

    // Datasets: an empty text file is refused; a text file with one bad line imports with a warning.
    await page.goto("/#/lab/datasets");
    await chooseFile(page, page.getByRole("button", { name: "Import" }).first(), { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.from("# nothing here\n") });
    await expect(toast(page, "Could not import the dataset")).toContainText("No positions found");
    const text = (await makeTextDataset(page, 3000, 5)) + "this is not a position\n";
    await chooseFile(page, page.getByRole("button", { name: "Import" }).first(), { name: "e2e-text.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(page).toHaveURL(/#\/lab\/datasets\/[^/?]+$/);
    const textId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(toast(page, /Imported .e2e-text. with problems/)).toContainText("Skipped 1 invalid line");
    await expect(toast(page, "Imported dataset “e2e-text”")).toHaveCount(0); // one toast per import
    const textDs = await readDataset(page, textId);
    expect(textDs!.positions).toBe(3000);
    expect(textDs!.storedPositions).toBe(3000);
    await expect(page.locator("#lab-ds-samples .lab-sample").first()).toBeVisible();

    // Export it as .cbds (16-byte header + 32 bytes per position) and import that file again.
    const cbds = await downloadOf(page, () => menu(page, page.getByRole("button", { name: "More dataset actions" }), "Export .cbds"));
    expect(cbds.name).toBe("e2e-text.cbds");
    expect(cbds.bytes.length).toBe(16 + 32 * 3000);
    expect(cbds.bytes.subarray(0, 4).toString("latin1")).toBe("CBDS");
    await page.goto("/#/lab/datasets");
    await chooseFile(page, page.getByRole("button", { name: "Import" }).first(), { name: "round-trip.cbds", mimeType: "application/octet-stream", buffer: cbds.bytes });
    await expect(page).toHaveURL(/#\/lab\/datasets\/[^/?]+$/);
    const cbdsId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(toast(page, "Imported dataset “round-trip”")).toContainText("3,000 positions.");
    expect((await readDataset(page, cbdsId))!.positions).toBe(3000);
    // A damaged .cbds is refused.
    await page.goto("/#/lab/datasets");
    await chooseFile(page, page.getByRole("button", { name: "Import" }).first(), { name: "broken.cbds", mimeType: "application/octet-stream", buffer: cbds.bytes.subarray(0, 1000) });
    await expect(toast(page, "The .cbds file is damaged")).toContainText("Could not import the dataset");

    // Merge the two datasets.
    await page.goto("/#/lab/datasets");
    await page.getByRole("checkbox", { name: "Select e2e-text" }).check();
    await page.getByRole("checkbox", { name: "Select round-trip" }).check();
    await page.getByRole("button", { name: "Merge" }).click();
    const mergeDialog = page.getByRole("dialog", { name: "Merge 2 datasets" });
    await mergeDialog.locator("#lab-merge-name").fill("E2E merged");
    await mergeDialog.getByRole("button", { name: "Merge" }).click();
    await expect(page.getByRole("heading", { name: "E2E merged" })).toBeVisible();
    const mergedId = decodeURIComponent(page.url().split("/").pop() as string);
    expect((await readDataset(page, mergedId))!.positions).toBe(6000);
    await page.goto("/#/lab/datasets");
    await captureViews(page, "datasets-list");

    // At 400 px the table stacks (no header row): "Select all" moves into the toolbar.
    await page.setViewportSize({ width: 400, height: 860 });
    await page.locator(".lab-table-tools").getByRole("button", { name: "Select all" }).click();
    await expect(page.locator(".lab-table-tools")).toContainText("3 datasets selected");
    await page.waitForTimeout(600);
    await shot(page, "datasets-selected-400");
    await page.locator(".lab-table-tools").getByRole("button", { name: "Clear" }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".lab-table-tools").getByRole("button", { name: "Select all" })).toBeHidden();

    // "Train a network on them" preselects the ticked datasets and turns self-play off.
    await page.getByRole("checkbox", { name: "Select e2e-text" }).check();
    await page.getByRole("checkbox", { name: "Select round-trip" }).check();
    await page.getByRole("link", { name: "Train a network on them" }).click();
    await expectWizardStep(page, "Network");
    await expect(page).toHaveURL(/#\/lab\/new$/);
    await wizardNext(page);
    await expect(page.locator(".lab-pick.checked")).toHaveCount(2);
    await expect(page.locator(".lab-pick.checked", { hasText: "e2e-text" })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Generate self-play games/ })).not.toBeChecked();

    // Continue training the imported network (from its page) on the merged dataset.
    await page.goto(`/#/lab/networks/${sourceId}`);
    await page.getByRole("button", { name: "Continue training" }).click();
    await expect(page).toHaveURL(/#\/lab\/new$/); // the preselection is applied, then removed from the URL
    await expect(page.getByRole("radio", { name: /Continue training a network/ })).toBeChecked();
    await expect(page.locator(".lab-pick.checked")).toContainText("e2e-net");
    await expect(page.locator(".lab-explain")).toContainText("the optimizer starts fresh");
    await wizardNext(page);
    await page.getByRole("switch", { name: /Generate self-play games/ }).uncheck();
    await page.locator(".lab-pick", { hasText: "E2E merged" }).click();
    await wizardNext(page);
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await wizardNext(page);
    await page.getByRole("switch", { name: "Publish an engine" }).uncheck();
    await wizardNext(page);
    await page.locator("#lab-run-name").fill("E2E continue");
    await expect(page.locator(".lab-wizard-body")).toContainText("Continue training an existing network");
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const continueRunId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 120_000 });
    const continued = await readRun(page, continueRunId);
    expect(continued!.engineId).toBeNull();
    const continuedNet = (await listNetworks(page)).find((n) => n.id === continued!.networkId);
    expect(continuedNet?.hidden).toBe(16);
    expect(continuedNet?.parentId).toBe(sourceId);
    expect(continuedNet?.stats.positionsSeen).toBeGreaterThan(0);

    // Widen the same network to HL32 (the default target) via the URL preselection.
    await page.goto(`/#/lab/new?networkId=${encodeURIComponent(sourceId)}&mode=widen`);
    await expect(page.getByRole("radio", { name: /Widen a network/ })).toBeChecked();
    await expect(page.getByRole("radiogroup", { name: "New hidden size" }).locator(".lab-size-chip.checked")).toContainText("32");
    await captureViews(page, "wizard-widen");
    await wizardNext(page);
    await page.getByRole("switch", { name: /Generate self-play games/ }).uncheck();
    await page.locator(".lab-pick", { hasText: "E2E merged" }).click();
    await wizardNext(page);
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await wizardNext(page);
    await wizardNext(page);
    await page.locator("#lab-run-name").fill("E2E widen");
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const widenRunId = decodeURIComponent(page.url().split("/").pop() as string);
    await expect(runStatus(page)).toHaveText("Finished", { timeout: 120_000 });
    const widened = await readRun(page, widenRunId);
    const widenedNet = (await listNetworks(page)).find((n) => n.id === widened!.networkId);
    expect(widenedNet?.hidden).toBe(32);
    expect(widenedNet?.parentId).toBe(sourceId);
    expect(widened!.engineId).not.toBeNull();

    // The widened network's lineage names its parent.
    await page.goto(`/#/lab/networks/${widened!.networkId}`);
    await expect(page.locator("#lab-net-lineage")).toContainText("e2e-net");
    await expect(page.locator("#lab-net-lineage")).toContainText("widened from");
    await captureViews(page, "network-detail-widened");
    expect(errors).toEqual([]);
  });

  test("pause / resume a run; a reload resumes it with auto-resume on and leaves it paused (interrupted) with it off", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab");
    // Long training: 160k positions, HL128, practically unlimited epochs (stopped at the end).
    const datasetId = await importBigDataset(page, "E2E big", 16_000, 10);
    const runId = await createRun(
      page,
      runConfig({
        name: "E2E pause",
        network: { mode: "new", hidden: 128, activation: 1 },
        data: { datasetIds: [datasetId], selfPlay: null },
        hyper: { ...runConfig({ name: "x" }).hyper, epochs: 100_000, batchSize: 1024 },
      }),
      { autoResume: true, start: true },
    );
    await page.goto(`/#/lab/runs/${runId}`);
    await expect(runStatus(page)).toHaveText("Training");
    await expect(page.locator("#lab-run-now")).toContainText("Training: epoch", { timeout: 60_000 });
    await expect(runControl(page, "Pause")).toBeVisible();
    // The live training view: losses, positions per second, learning rate; the header activity.
    await expect(stat(page.locator("#lab-run-now"), "Positions / s")).not.toHaveText("0");
    await expect(page.locator(".activity-button")).toContainText("1 running");
    await captureViews(page, "run-training-live");
    await labNav(page, "Overview").click();
    await expect(page.locator(".lab-page")).toContainText("E2E pause");
    await captureViews(page, "overview-active");
    await page.goBack();
    await expect(runControl(page, "Pause")).toBeVisible();
    // Wait for an epoch-end checkpoint so the pause has trained weights to keep.
    await expect.poll(async () => (await readRun(page, runId))?.resume?.epoch ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    // Pause → paused with a checkpoint cursor; Resume → continues from it.
    await runControl(page, "Pause").click();
    await expect(runStatus(page)).toHaveText("Paused", { timeout: 30_000 });
    const paused = await readRun(page, runId);
    expect(paused!.status).toBe("paused");
    expect(paused!.resume).not.toBeNull();
    await expect(page.locator("#lab-run-now")).toContainText(/Continues at epoch \d+/);
    await expect(page.locator(".callout", { hasText: "Interrupted." })).toHaveCount(0);
    await captureViews(page, "run-paused");
    await runControl(page, "Resume").click();
    await expect(runStatus(page)).toHaveText("Training", { timeout: 30_000 });
    await expect.poll(async () => (await readRun(page, runId))?.log.some((l) => l.message.startsWith("Continuing training from the checkpoint")), { timeout: 30_000 }).toBe(true);

    // Reload with auto-resume on: the new page takes the run over by itself.
    await expect.poll(async () => (await readRun(page, runId))?.resume?.epoch ?? 0, { timeout: 60_000 }).toBeGreaterThan(paused!.resume!.epoch);
    await page.reload();
    await expect(toast(page, "Resumed the training run")).toBeVisible({ timeout: 60_000 });
    await expect(runControl(page, "Pause")).toBeVisible({ timeout: 60_000 });
    await expect(runStatus(page)).toHaveText("Training");
    await expect
      .poll(async () => (await readRun(page, runId))?.log.some((l) => l.message === "Interrupted when the tab was closed; resuming automatically."), { timeout: 30_000 })
      .toBe(true);
    await expect(page.locator("#lab-run-now")).toContainText("Training: epoch", { timeout: 60_000 });

    // Reload with auto-resume off: the run is shown as paused because it was interrupted.
    const autoSwitch = page.getByRole("switch", { name: "Keep training when I reopen the app" });
    await autoSwitch.click();
    await expect(autoSwitch).not.toBeChecked(); // flips at once, the record follows
    await expect.poll(async () => (await readRun(page, runId))?.autoResume, { timeout: 10_000 }).toBe(false);
    await page.reload();
    await expect(runStatus(page)).toHaveText("Paused", { timeout: 30_000 });
    await expect(page.locator(".callout", { hasText: "Interrupted." })).toBeVisible();
    await expect(runControl(page, "Resume")).toBeVisible();
    await expect(runControl(page, "Pause")).toHaveCount(0);
    await captureViews(page, "run-interrupted");

    // Stop it: the best network trained so far is kept.
    await runControl(page, "Stop").click();
    await expect(runStatus(page)).toHaveText("Stopped", { timeout: 30_000 });
    const stopped = await waitForRun(page, runId, ["stopped"]);
    expect(stopped.networkHistory.length).toBe(1);
    const snapshot = (await listNetworks(page)).find((n) => n.id === stopped.networkHistory[0]!.networkId);
    expect(snapshot?.name).toMatch(/^E2E pause - c1 \(stopped, epoch \d+\/100000\)$/);
    await expect(page.locator("#lab-run-networks tbody tr")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("a 2-cycle reinforcement loop with gating finishes and shows the gating results", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/new");
    await page.getByRole("radiogroup", { name: "Hidden size" }).getByText("16", { exact: true }).click();
    await wizardNext(page);
    await page.locator("#lab-sp-games").fill("8");
    await page.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("1000");
    await wizardNext(page);
    await page.getByRole("radiogroup", { name: "Training preset" }).getByText("Quick test").click();
    await wizardNext(page);
    await page.getByRole("switch", { name: "Repeat self-play and training" }).check();
    await page.getByRole("textbox", { name: "Number of cycles" }).fill("2");
    await expect(page.getByRole("switch", { name: "Self-play with the newest network after the first cycle" })).toBeChecked();
    await page.getByRole("switch", { name: "Only keep networks that play at least as well" }).check();
    await page.locator("#lab-g-games").fill("4");
    const gatingLimits = page.locator(".lab-subform").last();
    await gatingLimits.getByRole("textbox", { name: "Max positions searched (nodes)" }).fill("1000");
    await wizardNext(page);
    await page.locator("#lab-run-name").fill("E2E loop");
    await expect(page.locator(".lab-wizard-body")).toContainText("4 games at 1,000 nodes, needs 55%");
    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs\/[^/?]+$/);
    const runId = decodeURIComponent(page.url().split("/").pop() as string);

    await expect(runStatus(page)).toHaveText("Finished", { timeout: 170_000 });
    const run = await readRun(page, runId);
    expect(run!.networkHistory).toHaveLength(2);
    expect(run!.networkHistory[0]!.gating).toBeNull();
    const gate = run!.networkHistory[1]!.gating;
    expect(gate).toBeTruthy();
    expect(gate!.games).toBe(4);
    expect(gate!.accepted).toBe(gate!.score >= 0.55);
    // One generated dataset per cycle; cycle 2 was played by the cycle-1 network.
    const generated = (await listDatasets(page)).filter((d) => d.source.trainingRunId === runId).sort((a, b) => a.name.localeCompare(b.name));
    expect(generated.map((d) => d.name)).toEqual(["E2E loop - cycle 1", "E2E loop - cycle 2"]);
    expect(generated[0]!.games).toBe(8);
    expect(generated[1]!.source.networkId).toBe(run!.networkHistory[0]!.networkId);
    // The published engine uses the newest accepted network.
    const engine = await readEngine(page, run!.engineId as string);
    const expected = gate!.accepted ? run!.networkHistory[1]!.networkId : run!.networkHistory[0]!.networkId;
    expect(engine?.networkId).toBe(expected);

    // The history table: cycle 2 with its gating verdict and score, cycle 1 not gated.
    const rows = page.locator("#lab-run-networks tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(gate!.accepted ? "Accepted" : "Rejected");
    await expect(rows.nth(0)).toContainText(`${Math.round(gate!.score * 100)}% · 4`);
    await expect(rows.nth(1)).toContainText("—");
    await expect(page.locator("#lab-run-log")).toContainText("Gating: the new network scored");
    await captureViews(page, "run-loop-finished");
    expect(errors).toEqual([]);
  });

  test("deletes runs with and without their networks and refuses to delete what an active run uses", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab/runs");
    const small = await importBigDataset(page, "E2E small", 2000, 1);
    // Two quick finished runs.
    const keepNetsRun = await createRun(page, runConfig({ name: "E2E keep networks", data: { datasetIds: [small], selfPlay: null } }));
    const dropNetsRun = await createRun(page, runConfig({ name: "E2E delete networks", data: { datasetIds: [small], selfPlay: null } }));
    const keepRec = await waitForRun(page, keepNetsRun, ["finished"]);
    const dropRec = await waitForRun(page, dropNetsRun, ["finished"]);

    // Delete with its networks.
    const dropRow = page.locator("tr", { hasText: "E2E delete networks" });
    await menu(page, dropRow.getByRole("button", { name: "More actions for E2E delete networks" }), "Delete…");
    const dlg = page.getByRole("dialog", { name: "Delete “E2E delete networks”?" });
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(400); // let the dialog finish fading in
    await shot(page, "run-delete-dialog");
    await dlg.getByRole("checkbox", { name: /Also delete the 1 network it trained/ }).check();
    await dlg.getByRole("button", { name: "Delete run" }).click();
    await expect(dropRow).toHaveCount(0);
    expect(await readRun(page, dropNetsRun)).toBeNull();
    expect((await listNetworks(page)).some((n) => n.id === dropRec.networkId)).toBe(false);
    // The dataset chosen for the run is kept.
    expect(await readDataset(page, small)).not.toBeNull();

    // Delete without its networks.
    const keepRow = page.locator("tr", { hasText: "E2E keep networks" });
    await menu(page, keepRow.getByRole("button", { name: "More actions for E2E keep networks" }), "Delete…");
    const dlg2 = page.getByRole("dialog", { name: "Delete “E2E keep networks”?" });
    await expect(dlg2.getByRole("checkbox", { name: /Also delete the 1 network it trained/ })).not.toBeChecked();
    await dlg2.getByRole("button", { name: "Delete run" }).click();
    await expect(keepRow).toHaveCount(0);
    expect((await listNetworks(page)).some((n) => n.id === keepRec.networkId)).toBe(true);

    // A long run that continues the kept network on the small dataset.
    const longRun = await createRun(
      page,
      runConfig({
        name: "E2E busy",
        network: { mode: "continue", networkId: keepRec.networkId as string },
        data: { datasetIds: [small], selfPlay: null },
        hyper: { ...runConfig({ name: "x" }).hyper, epochs: 1_000_000 },
      }),
    );
    await waitForRun(page, longRun, ["training"]);

    // Deleting its network is refused (with the service's reason).
    await page.goto("/#/lab/networks");
    const netName = (await listNetworks(page)).find((n) => n.id === keepRec.networkId)!.name;
    const netRow = page.locator("tr", { hasText: netName });
    await menu(page, netRow.getByRole("button", { name: `Actions for ${netName}` }), "Delete…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete network" }).click();
    await expect(toast(page, "Could not delete the network")).toContainText("The training run “E2E busy” is using this network".replace(/[“”]/g, '"'));
    expect((await listNetworks(page)).some((n) => n.id === keepRec.networkId)).toBe(true);

    // Deleting its dataset is refused too.
    await page.goto("/#/lab/datasets");
    const dsRow = page.locator("tr", { hasText: "E2E small" });
    await menu(page, dsRow.getByRole("button", { name: "Actions for E2E small" }), "Delete…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete dataset" }).click();
    await expect(toast(page, "Could not delete the dataset")).toContainText("is using this dataset");
    expect(await readDataset(page, small)).not.toBeNull();

    // Deleting the active run from its dashboard stops it first.
    await page.goto(`/#/lab/runs/${longRun}`);
    await expect(runControl(page, "Pause")).toBeVisible();
    await menu(page, page.getByRole("button", { name: "More run actions" }), "Delete run…");
    const dlg3 = page.getByRole("dialog", { name: "Delete “E2E busy”?" });
    await expect(dlg3).toContainText("It is stopped first.");
    await dlg3.getByRole("button", { name: "Delete run" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs$/);
    expect(await readRun(page, longRun)).toBeNull();
    await expect(page.getByRole("heading", { name: "No training runs yet" })).toBeVisible();
    // Now nothing uses the network: it can be deleted.
    await page.goto("/#/lab/networks");
    await menu(page, netRow.getByRole("button", { name: `Actions for ${netName}` }), "Delete…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete network" }).click();
    await expect(netRow).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a second tab sees the run as running elsewhere, and takes it over after the first tab closes", async ({ page, context }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab");
    const datasetId = await importBigDataset(page, "E2E tabs", 16_000, 4);
    const runId = await createRun(
      page,
      runConfig({
        name: "E2E tabs",
        network: { mode: "new", hidden: 64, activation: 1 },
        data: { datasetIds: [datasetId], selfPlay: null },
        hyper: { ...runConfig({ name: "x" }).hyper, epochs: 100_000, batchSize: 1024 },
      }),
    );
    await waitForRun(page, runId, ["training"]);

    const other = await context.newPage();
    const otherErrors = trackErrors(other);
    await other.goto(`/#/lab/runs/${runId}`);
    await expect(other.locator(".callout", { hasText: "Running in another tab." })).toBeVisible({ timeout: 20_000 });
    await expect(other.locator(".lab-run-controls").getByRole("button", { name: /Resume|Start|Pause|Stop/ })).toHaveCount(0);
    await captureViews(other, "run-elsewhere");
    const refused = await other.evaluate(async (id) => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      try {
        await t.training.start(id);
        return "started";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }, runId);
    expect(refused).toContain("another tab");

    // The training tab closes: the run is left "training" in storage, but nobody runs it.
    await page.close();
    await expect(other.locator(".callout", { hasText: "Not running anywhere right now." })).toBeVisible({ timeout: 20_000 });
    await other.locator(".lab-run-controls").getByRole("button", { name: "Resume" }).click();
    await expect(other.locator(".lab-run-controls").getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
    await expect(other.locator(".callout", { hasText: "Not running anywhere right now." })).toHaveCount(0);
    await expect(other.locator("#lab-run-now")).toContainText("Training: epoch", { timeout: 30_000 });
    await other.locator(".lab-run-controls").getByRole("button", { name: "Stop" }).click();
    await expect(other.locator(".lab-run-header .lab-status")).toHaveText("Stopped", { timeout: 30_000 });
    expect([...errors, ...otherErrors]).toEqual([]);
  });

  test("a dataset keeps the games played before the tab was hidden and reloaded mid-generation", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page, "#/lab/datasets");
    const datasetId = await page.evaluate(async (engineId) => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      return t.datasets.generate({
        name: "E2E interrupted",
        selfPlay: { engineId, limits: { nodes: 2000 }, randomPlies: 8, games: 100_000, concurrency: 2, maxPlies: 300, skipPlies: 8 },
      });
    }, ids.classic);
    await page.goto(`/#/lab/datasets/${datasetId}`);
    await expect(page.locator(".lab-detail-header .badge", { hasText: "Generating" })).toBeVisible();
    // Wait for a few games (well inside the 30 s partial-flush interval: nothing is stored yet).
    await expect(stat(page.locator("#lab-ds-job"), "Positions")).not.toHaveText("0", { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const before = await readDataset(page, datasetId);
    expect(before!.storedPositions).toBe(0);
    // The tab is hidden (as when it is closed or switched away from): buffered games are stored.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(async () => (await readDataset(page, datasetId))?.storedPositions ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "E2E interrupted" })).toBeVisible();
    // Generation does not resume by itself; what was stored is consistent and usable.
    await expect(page.locator(".lab-detail-header .badge", { hasText: "Generating" })).toHaveCount(0);
    const after = await readDataset(page, datasetId);
    expect(after!.positions).toBe(after!.storedPositions);
    expect(after!.positions).toBeGreaterThan(0);
    expect(after!.games).toBeGreaterThan(0);
    expect(after!.chunks).toBe(after!.storedChunks);
    await expect(stat(page.locator(".lab-section > .card"), "Games")).toHaveText(String(after!.games));
    await expect(page.locator("#lab-ds-samples .lab-sample").first()).toBeVisible();
    // It can be extended again ("Add more games…") and deleted.
    await page.getByRole("button", { name: "More dataset actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Add more games…" })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: "Delete…" })).toBeEnabled();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("a run that cannot continue shows its error with a Retry button", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page, "#/lab");
    const datasetId = await importBigDataset(page, "E2E err data", 2000, 1);
    const networkId = await page.evaluate(async () => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      return t.networks.createRandom({ name: "E2E doomed", hidden: 16, activation: 1, seed: 3 });
    });
    const runId = await createRun(
      page,
      runConfig({ name: "E2E broken", network: { mode: "continue", networkId }, data: { datasetIds: [datasetId], selfPlay: null } }),
      { start: false },
    );
    // The network it continues is deleted before the run starts (allowed: the run is not active).
    await page.evaluate(async (id) => {
      const t = (await import(String("/src/training/index.ts"))) as TrainingModule;
      await t.networks.remove(id);
    }, networkId);
    await page.goto(`/#/lab/runs/${runId}`);
    await expect(runStatus(page)).toHaveText("Queued");
    await runControl(page, "Start").click();
    await expect(runStatus(page)).toHaveText("Error", { timeout: 30_000 });
    const alert = page.getByRole("alert").filter({ hasText: "This run stopped because of an error." });
    await expect(alert).toContainText("The network this run starts from no longer exists.");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(toast(page, 'Training run "E2E broken" stopped with an error')).toBeVisible();
    await expect(page.locator("#lab-run-log")).toContainText("The network this run starts from no longer exists.");
    await captureViews(page, "run-error");
    // Retrying fails the same way (nothing to continue from) and stays readable.
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(runStatus(page)).toHaveText("Error", { timeout: 30_000 });
    // The run can still be deleted.
    await menu(page, page.getByRole("button", { name: "More run actions" }), "Delete run…");
    await page.getByRole("dialog", { name: "Delete “E2E broken”?" }).getByRole("button", { name: "Delete run" }).click();
    await expect(page).toHaveURL(/#\/lab\/runs$/);
    // The console error is the service's own report of the failed run.
    expect(errors.filter((e) => !e.includes('[training] run "E2E broken" failed'))).toEqual([]);
  });

  test("generating with an engine that does not compile shows the error on the dataset page", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page, "#/lab/datasets");
    await page.evaluate(async (classicId) => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const classic = await s.enginesRepo.get(classicId);
      if (!classic) throw new Error("Classic is missing");
      const now = Date.now();
      await s.enginesRepo.put({
        ...classic,
        id: s.newId(),
        name: "E2E Broken",
        builtin: false,
        tags: [],
        createdAt: now,
        updatedAt: now,
        files: { ...classic.files, "eval.ts": "export function evaluate(): i32 { return oops; }\n" },
        build: null,
      });
    }, ids.classic);
    await page.getByRole("button", { name: "Generate dataset" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate a dataset" });
    await dialog.getByRole("button", { name: "Engine that plays the games" }).click();
    await page.getByRole("option", { name: /E2E Broken/ }).click();
    await dialog.locator("#lab-gen-games").fill("4");
    // Inline check: the random opening must be shorter than the game.
    await dialog.locator("#lab-gen-random").fill("20");
    await dialog.locator("#lab-gen-max").fill("10");
    await dialog.getByRole("button", { name: "Start generating" }).click();
    await expect(dialog.getByText("Make the maximum game length longer than the random opening.")).toBeVisible();
    await dialog.locator("#lab-gen-max").fill("300");
    await dialog.locator("#lab-gen-random").fill("8");
    await dialog.locator("#lab-gen-name").fill("E2E broken data");
    await dialog.getByRole("button", { name: "Start generating" }).click();
    await expect(page).toHaveURL(/#\/lab\/datasets\/[^/?]+$/);
    const datasetId = decodeURIComponent(page.url().split("/").pop() as string);
    const panel = page.locator("#lab-ds-job");
    await expect(panel).toContainText("Generation stopped with an error", { timeout: 60_000 });
    await expect(panel).toContainText("failed to compile");
    await expect(toast(page, 'Generating "E2E broken data" failed')).toBeVisible();
    await captureViews(page, "dataset-error");
    expect((await readDataset(page, datasetId))!.positions).toBe(0);
    await expect(page.getByRole("button", { name: "Train a network on it" })).toBeDisabled();
    // The empty dataset can be deleted.
    await menu(page, page.getByRole("button", { name: "More dataset actions" }), "Delete…");
    await page.getByRole("dialog").getByRole("button", { name: "Delete dataset" }).click();
    await expect(page).toHaveURL(/#\/lab\/datasets$/);
    expect(errors).toEqual([]);
  });
});
