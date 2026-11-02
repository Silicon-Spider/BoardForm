// End-to-end tests of the app shell: nav bar (every width from 320 px), background-work indicator,
// toasts, document titles, favicon, page-not-found, skip link, theme sync between tabs and the
// localStorage cleanup of "Delete all data".
//
// Run: E2E_PORT=5231 npx playwright test e2e/shell.spec.ts
import { expect, test, type Locator, type Page } from "@playwright/test";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type ToastModule = typeof import("../src/app/toast");
type ActivityModule = typeof import("../src/app/activity");
type StorageModule = typeof import("../src/storage/index");

const DESTINATIONS = [
  { label: "Engines", hash: "#/engines", nav: "Main" },
  { label: "Play", hash: "#/play", nav: "Main" },
  { label: "Arena", hash: "#/arena", nav: "Main" },
  { label: "NNUE Lab", hash: "#/lab", nav: "Main" },
  { label: "Help", hash: "#/help", nav: "Help and settings" },
  { label: "Settings", hash: "#/settings", nav: "Help and settings" },
] as const;

/** Collects uncaught page errors and console errors (checked at the end of each test). */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const navLink = (page: Page, d: (typeof DESTINATIONS)[number]): Locator =>
  page.getByRole("navigation", { name: d.nav }).getByRole("link", { name: d.label, exact: true });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Waits until the app has seeded the starter engines. */
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
    .toBeGreaterThanOrEqual(4);
}

/** The element is rendered, not covered by overflow clipping, and entirely inside the viewport. */
async function expectFullyInViewport(page: Page, locator: Locator, what: string): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = await locator.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, what).not.toBeNull();
  expect(box!.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${what}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what}: right edge`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height, `${what}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
  // The link text is not cut off (no ellipsis/clipping inside the link).
  const clipped = await locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped, `${what}: content clipped`).toBe(false);
}

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const nav = document.querySelector(".app-nav")!;
    return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, nav.scrollWidth - nav.clientWidth);
  });
  expect(overflow, `horizontal overflow at ${where}`).toBeLessThanOrEqual(0);
}

async function setActivities(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const a = (await import(String("/src/app/activity.ts"))) as ActivityModule;
    for (const id of Object.keys(a.useActivityStore.getState().activities)) a.clearActivity(id);
    for (let i = 1; i <= n; i++) {
      a.setActivity({ id: `e2e:${i}`, kind: "training", label: `E2E job ${i}`, detail: `Cycle ${i}`, progress: i / (n + 1), href: "/lab/runs" });
    }
  }, count);
}

/** Checks every destination at the current width: visible, inside the viewport, works, marked current. */
async function checkAllDestinations(page: Page, where: string): Promise<void> {
  await expectNoHorizontalOverflow(page, where);
  for (const d of DESTINATIONS) {
    const link = navLink(page, d);
    await expectFullyInViewport(page, link, `${d.label} at ${where}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${escapeRe(d.hash)}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    // Exactly one link is marked as the current page.
    await expect(page.locator('.app-nav [aria-current="page"]')).toHaveCount(1);
  }
  await expectFullyInViewport(page, page.locator(".app-brand"), `brand at ${where}`);
  await expect(page.locator(".app-brand")).toContainText("BoardForm");
}

// ------------------------------------------------------------------------------------------------

test("app shell loads, is cross-origin isolated, and navigates", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".app-brand")).toContainText("BoardForm");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  for (const [label, hash] of [
    ["Play", "#/play"],
    ["Arena", "#/arena"],
    ["NNUE Lab", "#/lab"],
    ["Engines", "#/engines"],
  ] as const) {
    await page.locator(".app-nav-link", { hasText: label }).click();
    await expect(page).toHaveURL(new RegExp(hash.replace("/", "\/") + "$"));
  }
  await waitForSeeded(page);
  expect(errors).toEqual([]);
});

test("header: every destination is reachable from 320 px to 1440 px, with and without background work", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackErrors(page);
  await page.goto("/#/engines");
  await waitForSeeded(page);

  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/#/engines");
    await setActivities(page, 0);
    await expect(page.locator(".activity")).toHaveCount(0);
    await checkAllDestinations(page, `${width} px`);

    // With background work running the indicator joins the bar; nothing is pushed out.
    await setActivities(page, 2);
    const indicator = page.locator(".activity-button");
    await expectFullyInViewport(page, indicator, `activity indicator at ${width} px`);
    await expect(indicator).toContainText("2 running"); // "running" stays readable by screen readers
    await checkAllDestinations(page, `${width} px with activity`);

    // The panel opens inside the viewport and its links work.
    await indicator.click();
    await expect(indicator).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: "Background work" });
    await expectFullyInViewport(page, panel, `activity panel at ${width} px`);
    await expect(panel.getByRole("link")).toHaveCount(2);
    await panel.getByRole("link", { name: /E2E job 1/ }).click();
    await expect(page).toHaveURL(/#\/lab\/runs$/);
    await expect(panel).toHaveCount(0);
    // Escape closes it and gives focus back to the button.
    await indicator.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(indicator).toBeFocused();
    await setActivities(page, 0);
  }

  // Wider layouts: one row; everything still visible with activity shown.
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await setActivities(page, 3);
    await expectFullyInViewport(page, page.locator(".activity-button"), `activity indicator at ${width} px`);
    await checkAllDestinations(page, `${width} px with activity`);
    // Single row: the nav is no taller than its 56 px bar.
    expect((await page.locator(".app-nav").boundingBox())!.height).toBeLessThanOrEqual(57);
  }
  await setActivities(page, 0);
  expect(errors).toEqual([]);
});

test("header: keyboard users get a skip link and visible focus on every nav link", async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 400, height: 720 });
  await page.goto("/#/arena");
  await expect(page.locator(".app-brand")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // First Tab: the skip link appears; Enter moves focus to the page content.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("button", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  // It slides in (a short transition) when focused.
  await expect.poll(async () => (await skip.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await expectFullyInViewport(page, skip, "skip link");
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  // Tab through the bar: every destination takes focus and shows a focus ring.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen: string[] = [];
  for (let i = 0; i < 12 && seen.length < DESTINATIONS.length; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest(".app-nav") || !el.classList.contains("app-nav-link")) return null;
      const style = getComputedStyle(el);
      return { name: (el.textContent ?? "").trim(), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    if (!info) continue;
    expect(info.outline, `focus ring on ${info.name}`).not.toBe("none");
    expect(info.width, `focus ring on ${info.name}`).toBeGreaterThanOrEqual(2);
    seen.push(info.name);
  }
  expect(seen.sort()).toEqual(DESTINATIONS.map((d) => d.label).sort());
  // Enter on a focused link navigates.
  await navLink(page, DESTINATIONS[1]).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/play$/);
  expect(errors).toEqual([]);
});

test("toasts: at most three at once (two on narrow screens), identical ones merge, hover pauses", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/#/engines");
  await waitForSeeded(page);
  const toasts = page.locator(".toaster .toast");
  const shown = page.locator(".toaster .toast:not([hidden])");
  const raise = (n: number, prefix: string) =>
    page.evaluate(
      async ({ n, prefix }) => {
        const t = (await import(String("/src/app/toast.tsx"))) as ToastModule;
        t.dismissAllToasts();
        for (let i = 1; i <= n; i++) {
          t.toast(`${prefix} ${i} was paused`, { kind: "error", detail: "The engine “Broken eval” crashed: unreachable executed at eval.ts:42. Open it in the Workshop to fix it.", timeoutMs: 60_000 });
        }
      },
      { n, prefix },
    );

  // Wide screen: the three newest show; the rest fold into "+3 more".
  await raise(6, "Match");
  await expect(toasts).toHaveCount(6);
  await expect(shown).toHaveCount(3);
  await expect(shown.last()).toContainText("Match 6 was paused");
  await expect(shown.first()).toContainText("Match 4 was paused");
  await expect(shown.first()).toHaveAttribute("role", "alert");
  const more = page.getByRole("button", { name: "+3 more" });
  await expect(more).toBeVisible();
  await more.click();
  await expect(shown).toHaveCount(6);
  await page.getByRole("button", { name: "Show fewer" }).click();
  await expect(shown).toHaveCount(3);

  // Narrow screen: two show, compact, and they leave most of the screen free.
  await page.setViewportSize({ width: 400, height: 720 });
  await expect(shown).toHaveCount(2);
  await expect(page.getByRole("button", { name: "+4 more" })).toBeVisible();
  const box = (await page.locator(".toaster").boundingBox())!;
  expect(box.height, "toast stack height at 400 px").toBeLessThan(720 * 0.4);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(400);
  // Dismiss buttons work and the next folded toast takes the free place.
  await shown.last().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toasts).toHaveCount(5);
  await expect(shown).toHaveCount(2);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(toasts).toHaveCount(0);

  // A long detail is clamped to two lines on a narrow screen; "More" opens it.
  await page.evaluate(async () => {
    const t = (await import(String("/src/app/toast.tsx"))) as ToastModule;
    const detail = Array.from({ length: 12 }, (_, i) => `eval.ts:${40 + i}: error TS2304: Cannot find name 'pawnBonus${i}'.`).join("\n");
    t.toast("Build failed", { kind: "error", detail, timeoutMs: 60_000 });
  });
  const clampedHeight = (await shown.first().boundingBox())!.height;
  expect(clampedHeight).toBeLessThan(120);
  await shown.first().getByRole("button", { name: "More" }).click();
  await expect(shown.first().getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  expect((await shown.first().boundingBox())!.height).toBeGreaterThan(clampedHeight + 40);
  await page.evaluate(async () => ((await import(String("/src/app/toast.tsx"))) as ToastModule).dismissAllToasts());
  await page.setViewportSize({ width: 1440, height: 900 });

  // The same news three times: one toast that counts it.
  await page.evaluate(async () => {
    const t = (await import(String("/src/app/toast.tsx"))) as ToastModule;
    for (let i = 0; i < 3; i++) t.toast("Classic vs Blocky finished", { kind: "success", detail: "Classic 6 – 4 Blocky" });
  });
  await expect(toasts).toHaveCount(1);
  await expect(toasts.locator(".toast-count")).toHaveText("×3");

  // Hovering pauses the countdown; leaving lets it finish.
  await page.evaluate(async () => {
    const t = (await import(String("/src/app/toast.tsx"))) as ToastModule;
    t.dismissAllToasts();
    t.toast("Short-lived notice", { timeoutMs: 1200 });
  });
  await shown.first().hover();
  await page.waitForTimeout(2500);
  await expect(shown).toHaveCount(1);
  await page.mouse.move(5, 300);
  await expect(toasts).toHaveCount(0, { timeout: 5000 });
  expect(errors).toEqual([]);
});

test("titles, favicon and page not found", async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto("/#/engines");
  await waitForSeeded(page);
  for (const [hash, title] of [
    ["#/engines", /^Engines · BoardForm$/],
    ["#/play", /^Play · BoardForm$/],
    ["#/arena", /^Arena · BoardForm$/],
    ["#/lab", /^NNUE Lab · BoardForm$/],
    ["#/lab/networks", /^Networks · NNUE Lab · BoardForm$/],
    ["#/help", /^Help · BoardForm$/],
    ["#/help/blocks", / · Help · BoardForm$/],
    ["#/settings", /^Settings · BoardForm$/],
    ["#/engines/starter-engine-neuron", /^Neuron · Workshop · BoardForm$/],
    ["#/no/such/page", /^Page not found · BoardForm$/],
  ] as const) {
    await page.goto("/" + hash);
    await expect(page, hash).toHaveTitle(title);
  }
  // Leaving a page with its own title gives the next page its default title back.
  await page.locator(".app-nav-link", { hasText: "Arena" }).click();
  await expect(page).toHaveTitle("Arena · BoardForm");

  // Page not found: explains and offers a way back.
  await page.goto("/#/no/such/page");
  const main = page.locator(".app-main");
  await expect(main.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(main).toContainText("#/no/such/page");
  await main.getByRole("link", { name: "Go to your engines" }).click();
  await expect(page).toHaveURL(/#\/engines$/);

  // Favicon and browser-chrome colour.
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(icon).toBe("/favicon.svg");
  const res = await request.get(icon!);
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("svg");
  expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#161a20");
  expect(errors).toEqual([]);
});

test("theme: a change in one tab reaches the other open tabs without a reload", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const errors = [...trackErrors(a), ...trackErrors(b)];
  await a.goto("/#/settings?section=appearance");
  await b.goto("/#/settings?section=appearance");
  await waitForSeeded(a);
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");

  await a.getByRole("radio", { name: "Light", exact: true }).click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(b.locator("html")).toHaveAttribute("data-theme", "light");
  // The other tab's Settings page shows the new choice too.
  await expect(b.getByRole("radio", { name: "Light", exact: true })).toHaveAttribute("aria-checked", "true");
  expect(await b.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#ffffff");

  await b.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors.filter((e) => !e.includes("Failed to load resource"))).toEqual([]);
});

test("Delete all data also clears the crash-recovery copies in localStorage, but keeps the theme", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/#/settings?section=danger");
  await waitForSeeded(page);
  await page.evaluate(() => {
    localStorage.setItem("cb.theme", "light");
    localStorage.setItem("cb.workshop.unsaved.starter-engine-classic", JSON.stringify({ at: Date.now(), patch: { name: "Ghost" } }));
    localStorage.setItem("cb.play.snapshot", JSON.stringify({ id: "ghost-game" }));
    localStorage.setItem("someone-else", "keep me");
  });

  await page.getByRole("button", { name: "Delete all data…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".toast", { hasText: "All data deleted" })).toBeVisible({ timeout: 60_000 });

  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(keys).toEqual(["cb.theme", "someone-else"]);
  expect(await page.evaluate(() => localStorage.getItem("cb.theme"))).toBe("light");
  expect(errors).toEqual([]);
});
