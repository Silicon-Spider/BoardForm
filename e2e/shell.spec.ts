import { expect, test } from "@playwright/test";

test("app shell loads, is cross-origin isolated, and navigates", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.locator(".app-brand")).toContainText("Chess Builder");
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
  expect(errors).toEqual([]);
});
