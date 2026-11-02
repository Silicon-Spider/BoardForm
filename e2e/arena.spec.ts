// End-to-end tests of the Arena (src/arena + src/pages/arena) against the real engines.
//
// Run: E2E_PORT=5213 npx playwright test e2e/arena.spec.ts
//
// Every test starts with a fresh browser context (empty IndexedDB): the app seeds the three starter
// engines (Blocky, Classic, Sprout) on first load. Matches use node limits where possible, so the
// games are quick and their length does not depend on the machine's speed.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// App modules are imported inside page.evaluate() from the Vite dev server ("/src/..."); the
// String() wrapper stops tsc from resolving those URLs, the casts give them their real types.
type StorageModule = typeof import("../src/storage/index");
type ArenaModule = typeof import("../src/arena/index");
type TemplatesModule = typeof import("../src/engine-host/templates");

interface StarterIds {
  classic: string;
  blocky: string;
  sprout: string;
}

interface Summary {
  index: number;
  whiteId: string;
  blackId: string;
  result: string;
  termination: string;
  plies: number;
  gameId: string | null;
  detail?: string | null;
}

interface MatchSnapshot {
  status: string;
  totalGames: number;
  results: Summary[];
  interrupted?: boolean;
  lastError?: string | null;
  lastErrorEngineId?: string | null;
  config: { participants: Array<{ engineId: string }> };
}

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
async function openApp(page: Page, hash = "#/arena"): Promise<StarterIds> {
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

async function getMatch(page: Page, id: string): Promise<MatchSnapshot | null> {
  return page.evaluate(async (mid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    return ((await s.matchesRepo.get(mid)) ?? null) as unknown as MatchSnapshot | null;
  }, id);
}

async function savedGames(page: Page, matchId: string) {
  return page.evaluate(async (mid) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const games = await s.gamesRepo.list({ matchId: mid });
    return games.map((g) => ({ id: g.id, result: g.result, termination: g.termination, plies: g.moves.length, pgn: g.pgn }));
  }, matchId);
}

/** Creates a match through the service (faster than the form when the form is not under test). */
async function createMatch(
  page: Page,
  opts: {
    name: string;
    engineIds: string[];
    games: number;
    concurrency: number;
    nodes?: number;
    clock?: { baseMs: number; incMs: number };
    maxPlies?: number | null;
    start?: boolean;
  },
): Promise<string> {
  return page.evaluate(async (o) => {
    const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
    const cfg = m.defaultMatchConfig({ engineIds: o.engineIds, hashMb: 16, maxWorkers: 8 });
    cfg.name = o.name;
    cfg.gamesPerPairing = o.games;
    cfg.concurrency = o.concurrency;
    cfg.participants = cfg.participants.map((p) => ({
      ...p,
      limits: o.nodes ? { nodes: o.nodes } : {},
      timeControl: o.clock ?? null,
    }));
    if (o.maxPlies !== undefined) cfg.adjudication = { ...cfg.adjudication, maxPlies: o.maxPlies };
    return m.arena.createMatch(cfg, { start: o.start ?? true });
  }, opts);
}

/** Adds an engine record directly (e.g. one that does not compile). */
async function addEngine(page: Page, rec: { name: string; kind: "eval" | "scratch"; files: Record<string, string> | "scratch-empty" }): Promise<string> {
  return page.evaluate(async (r) => {
    const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
    const t = (await import(String("/src/engine-host/templates.ts"))) as TemplatesModule;
    const id = s.newId();
    const now = Date.now();
    await s.enginesRepo.put({
      id,
      name: r.name,
      description: "",
      kind: r.kind,
      createdAt: now,
      updatedAt: now,
      color: "#e05a5a",
      options: { hashMb: 16 },
      files: r.files === "scratch-empty" ? t.scratchFiles("empty") : r.files,
      entry: "main.ts",
      templateVersion: t.TEMPLATE_VERSION,
    });
    return id;
  }, rec);
}

const detail = (page: Page) => page.getByTestId("arena-detail");

/** Waits for the match page to show the given status. */
async function waitForStatus(page: Page, status: string, timeout = 150_000): Promise<void> {
  await expect(detail(page)).toHaveAttribute("data-status", status, { timeout });
}

/** Expected standings computed independently from the stored results. */
function expectedStandings(rec: MatchSnapshot) {
  const ids = rec.config.participants.map((p) => p.engineId);
  const rows = ids.map(() => ({ games: 0, w: 0, d: 0, l: 0, points: 0 }));
  for (const r of rec.results) {
    const wi = ids.indexOf(r.whiteId);
    const bi = ids.indexOf(r.blackId);
    const W = rows[wi];
    const B = rows[bi];
    W.games++;
    B.games++;
    if (r.result === "1-0") {
      W.w++;
      B.l++;
      W.points += 1;
    } else if (r.result === "0-1") {
      B.w++;
      W.l++;
      B.points += 1;
    } else {
      W.d++;
      B.d++;
      W.points += 0.5;
      B.points += 0.5;
    }
  }
  return rows;
}

const fmtPoints = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

/** Reads the standings table: engine label → its numeric columns. */
async function readStandings(page: Page) {
  const rows = page.getByTestId("arena-standings").locator("tbody tr");
  const n = await rows.count();
  const out = new Map<string, { games: number; w: number; d: number; l: number; points: string; score: string; elo: string; los: string }>();
  for (let i = 0; i < n; i++) {
    const cells = (await rows.nth(i).locator("td").allInnerTexts()).map((t) => t.trim());
    out.set(cells[1], { games: Number(cells[2]), w: Number(cells[3]), d: Number(cells[4]), l: Number(cells[5]), points: cells[6], score: cells[7], elo: cells[8], los: cells[9] });
  }
  return out;
}

test.describe("Arena", () => {
  test("empty state, new-match form validation, cancel and ?new=1&engines= prefill", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    await expect(page.getByText("No matches yet")).toBeVisible();
    await expect(page.getByTestId("arena-quick")).toBeVisible();

    // The URL form: prefilled with the given engines in that order.
    await page.goto(`/#/arena?new=1&engines=${ids.sprout},${ids.classic}`);
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Sprout");
    await expect(page.getByRole("button", { name: "Engine 2", exact: true })).toContainText("Classic");
    await expect(page.locator("#arena-name")).toHaveValue("Sprout vs Classic");
    await expect(page.getByTestId("arena-form-summary")).toContainText("10 games");

    // Invalid input: a field error, the summary keeps the last valid value, Start shows the problems.
    const games = page.getByLabel("Games per pairing");
    await games.fill("0");
    await expect(dialog.locator(".field-error", { hasText: "At least 1" })).toBeVisible();
    await games.fill("4");
    await expect(page.getByTestId("arena-form-summary")).toContainText("4 games");
    await expect(page.getByTestId("arena-form-total")).toContainText("1 pairing × 4 = 4 games");

    // Three engines → three pairings.
    await page.getByRole("button", { name: "Add engine" }).click();
    await page.getByRole("button", { name: "Start match" }).click();
    await expect(dialog.locator(".arena-form-problems")).toContainText("Choose an engine for every participant");
    await page.getByRole("button", { name: "Engine 3", exact: true }).click();
    await page.locator('li[role="option"]', { hasText: "Blocky" }).first().click();
    await expect(page.getByTestId("arena-form-total")).toContainText("3 pairings × 4 = 12 games");
    await expect(page.locator("#arena-name")).toHaveValue("Round robin (3 engines)");
    await expect(dialog.locator(".arena-form-problems")).toHaveCount(0);

    // An empty name falls back to the automatic one.
    await page.locator("#arena-name").fill("");
    await expect(page.locator("#arena-name")).toHaveAttribute("placeholder", "Round robin (3 engines)");

    // No clock and no search limit: the limits editor warns and Start refuses.
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
    await expect(dialog.locator(".cb-limits-summary")).toContainText("Set a clock or at least one limit");
    await page.getByRole("button", { name: "Start match" }).click();
    await expect(dialog.locator(".arena-form-problems")).toContainText("Set a clock or at least one search limit.");
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "1+0" }).click();
    await expect(dialog.locator(".arena-form-problems")).toHaveCount(0);

    // Cancel closes the dialog, clears the query and creates nothing.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/arena$/);
    const count = await page.evaluate(async () => (await ((await import(String("/src/storage/index.ts"))) as StorageModule).matchesRepo.list()).length);
    expect(count).toBe(0);

    // Escape closes it too.
    await page.getByTestId("arena-new").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Classic vs Blocky at 2000 nodes, 4 games, 2 at once: standings, Elo, saved games, replay, PGN", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    await page.getByTestId("arena-new").click();
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    const pick = async (n: number, name: string) => {
      await page.getByRole("button", { name: `Engine ${n}`, exact: true }).click();
      await page.locator('li[role="option"]', { hasText: name }).first().click();
      await expect(page.getByRole("button", { name: `Engine ${n}`, exact: true })).toContainText(name);
    };
    await pick(1, "Classic");
    await pick(2, "Blocky");
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
    const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
    await nodesCap.locator('input[type="checkbox"]').check();
    await nodesCap.locator("input.input").fill("2000");
    await page.getByLabel("Games per pairing").fill("4");
    await page.getByLabel("Games at once").fill("2");
    await expect(page.getByTestId("arena-form-summary")).toHaveText("4 games · 2 at a time");
    await expect(page.locator("#arena-name")).toHaveValue("Classic vs Blocky");
    await page.getByTestId("arena-form-start").click();

    await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const matchId = page.url().split("/").pop()!;
    await expect(detail(page)).toBeVisible();
    // (At 2000 nodes the games take about a second, too short to look at the live boards here;
    // the round robin and pause tests check them.)
    await waitForStatus(page, "finished");

    const rec = (await getMatch(page, matchId))!;
    expect(rec.status).toBe("finished");
    expect(rec.results).toHaveLength(4);
    expect(rec.results.map((r) => r.index).sort()).toEqual([0, 1, 2, 3]);
    // Colours alternate: each engine has White twice.
    expect(rec.results.filter((r) => r.whiteId === ids.classic)).toHaveLength(2);

    // Standings match the stored results.
    const expected = expectedStandings(rec);
    const table = await readStandings(page);
    const labels = ["Classic", "Blocky"];
    let totalPoints = 0;
    labels.forEach((label, i) => {
      const row = table.get(label)!;
      expect(row, label).toBeTruthy();
      expect(row.games).toBe(4);
      expect(row.w + row.d + row.l).toBe(4);
      expect({ w: row.w, d: row.d, l: row.l }).toEqual({ w: expected[i].w, d: expected[i].d, l: expected[i].l });
      expect(row.points).toBe(fmtPoints(expected[i].points));
      expect(row.score).toBe(`${((expected[i].points / 4) * 100).toFixed(1)}%`);
      // Elo with its margin (or ±∞ for a perfect score).
      expect(row.elo).toMatch(/^([+−]\d+ ± (\d+|∞)|0 ± (\d+|∞)|[+−]∞)$/);
      totalPoints += expected[i].points;
    });
    expect(totalPoints).toBe(4);
    expect(table.get("Classic")!.w).toBe(table.get("Blocky")!.l);
    // The duel summary shows the score, W/D/L and Elo ±.
    await expect(page.getByTestId("arena-score")).toHaveText(`${fmtPoints(expected[0].points)} – ${fmtPoints(expected[1].points)}`);
    await expect(page.locator(".arena-duel-detail")).toContainText(`+${expected[0].w} =${expected[0].d} −${expected[0].l}`);
    await expect(page.locator(".arena-duel-detail")).toContainText("Elo");

    // Games are saved, one per result.
    const games = await savedGames(page, matchId);
    expect(games).toHaveLength(4);
    expect(new Set(rec.results.map((r) => r.gameId))).toEqual(new Set(games.map((g) => g.id)));
    await expect(page.getByTestId("arena-result-row")).toHaveCount(4);

    // Replay: board, move navigation, eval chart.
    await page.getByTestId("arena-result-row").first().click();
    const replay = page.getByTestId("arena-replay");
    await expect(replay).toBeVisible();
    const plyText = replay.locator(".row-wrap .muted", { hasText: "Ply" });
    const total = Number((await plyText.innerText()).split("/")[1].trim());
    expect(total).toBeGreaterThan(5);
    await expect(plyText).toHaveText(`Ply ${total} / ${total}`);
    await replay.locator(".cb-ml-move").nth(3).click();
    await expect(plyText).toHaveText(`Ply 4 / ${total}`);
    await page.keyboard.press("ArrowLeft");
    await expect(plyText).toHaveText(`Ply 3 / ${total}`);
    await expect(replay.locator(".arena-replay-chart svg.cb-chart-svg")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(replay).toHaveCount(0);

    // PGN export: one file with all four games in schedule order.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("arena-export").click()]);
    expect(download.suggestedFilename()).toBe("classic-vs-blocky.pgn");
    const pgn = await readFile(await download.path(), "utf8");
    expect(pgn.match(/^\[Event "/gm)).toHaveLength(4);
    const rounds = [...pgn.matchAll(/^\[Round "(\d+)"\]/gm)].map((m) => m[1]);
    expect(rounds).toEqual(["1", "2", "3", "4"]);
    const pgnResults = [...pgn.matchAll(/^\[Result "([^"]+)"\]/gm)].map((m) => m[1]);
    expect(pgnResults).toEqual([...rec.results].sort((a, b) => a.index - b.index).map((r) => r.result));
    expect(pgn).toContain('[White "Classic"]');
    expect(pgn).toContain('[TimeControl "-"]');

    // Open in Play.
    await page.getByTestId("arena-result-row").first().click();
    await page.getByTestId("arena-open-in-play").click();
    await expect(page).toHaveURL(/#\/play\?game=[0-9a-f-]{36}$/);

    // The list shows the finished match with its score.
    await page.goto("/#/arena");
    const card = page.getByTestId("arena-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".arena-status")).toHaveText("Finished");
    await expect(card.locator(".arena-card-score")).toHaveText(`Classic ${fmtPoints(expected[0].points)} – ${fmtPoints(expected[1].points)} Blocky`);
    expect(errors).toEqual([]);
  });

  test("3-engine round robin on a fast clock: crosstable and standings", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const matchId = await createMatch(page, {
      name: "Starter round robin",
      engineIds: [ids.classic, ids.blocky, ids.sprout],
      games: 2,
      concurrency: 3,
      clock: { baseMs: 3000, incMs: 50 },
    });
    await page.goto(`/#/arena/${matchId}`);
    await expect(page.getByTestId("arena-live")).toBeVisible({ timeout: 90_000 });
    await waitForStatus(page, "finished");
    const rec = (await getMatch(page, matchId))!;
    expect(rec.results).toHaveLength(6);
    // Nobody forfeits on a 3 s + 0.05 s clock.
    expect(rec.results.filter((r) => r.termination === "timeout")).toEqual([]);

    const expected = expectedStandings(rec);
    const labels = ["Classic", "Blocky", "Sprout"];
    const table = await readStandings(page);
    labels.forEach((label, i) => {
      const row = table.get(label)!;
      expect(row.games).toBe(4);
      expect({ w: row.w, d: row.d, l: row.l }).toEqual({ w: expected[i].w, d: expected[i].d, l: expected[i].l });
      expect(row.points).toBe(fmtPoints(expected[i].points));
    });

    // Crosstable: the row engine's points against the column engine, out of 2 games.
    const cross = page.getByTestId("arena-crosstable");
    await expect(cross).toBeVisible();
    const order = (await cross.locator("tbody tr td:first-child").allInnerTexts()).map((t) => t.replace(/^\d+\s*/, "").trim());
    expect(new Set(order)).toEqual(new Set(labels));
    const pid = (label: string) => rec.config.participants[labels.indexOf(label)].engineId;
    for (let r = 0; r < 3; r++) {
      const cells = (await cross.locator("tbody tr").nth(r).locator("td").allInnerTexts()).map((t) => t.trim());
      for (let c = 0; c < 3; c++) {
        if (r === c) continue;
        const me = pid(order[r]);
        const them = pid(order[c]);
        let pts = 0;
        for (const g of rec.results) {
          if (g.whiteId === me && g.blackId === them) pts += g.result === "1-0" ? 1 : g.result === "1/2-1/2" ? 0.5 : 0;
          if (g.blackId === me && g.whiteId === them) pts += g.result === "0-1" ? 1 : g.result === "1/2-1/2" ? 0.5 : 0;
        }
        expect(cells[c + 1], `${order[r]} vs ${order[c]}`).toBe(`${fmtPoints(pts)}/2`);
      }
    }
    // Ranked by points: the first row has the most.
    const firstPoints = expected[labels.indexOf(order[0])].points;
    expect(Math.max(...expected.map((e) => e.points))).toBe(firstPoints);
    expect(errors).toEqual([]);
  });

  test("pause, resume, reload (interrupted), resume to the end", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const matchId = await createMatch(page, { name: "Pause test", engineIds: [ids.classic, ids.blocky], games: 8, concurrency: 1, nodes: 5000 });
    await page.goto(`/#/arena/${matchId}`);
    await waitForStatus(page, "running", 60_000);
    // Wait for the first finished game.
    await expect.poll(async () => (await getMatch(page, matchId))!.results.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(1);

    await page.getByTestId("arena-pause").click();
    await waitForStatus(page, "paused", 20_000);
    const paused = (await getMatch(page, matchId))!;
    expect(paused.status).toBe("paused");
    expect(paused.interrupted).toBeFalsy();
    await expect(page.getByTestId("arena-start")).toHaveText(/Resume/);
    await expect(page.getByTestId("arena-live")).toHaveCount(0);
    const afterPause = paused.results.length;
    // Nothing more is played while paused.
    await page.waitForTimeout(1500);
    expect((await getMatch(page, matchId))!.results.length).toBe(afterPause);

    await page.getByTestId("arena-start").click();
    await waitForStatus(page, "running", 30_000);
    await expect(page.getByTestId("arena-live")).toBeVisible({ timeout: 60_000 });

    // Reload in the middle of a game: the match becomes "interrupted".
    await page.reload();
    await waitForStatus(page, "interrupted", 30_000);
    await expect(page.getByTestId("arena-interrupted")).toBeVisible();
    const interrupted = (await getMatch(page, matchId))!;
    expect(interrupted.status).toBe("paused");
    expect(interrupted.interrupted).toBe(true);

    await page.getByTestId("arena-interrupted").getByRole("button", { name: "Resume" }).click();
    await waitForStatus(page, "running", 30_000);
    await expect(page.getByTestId("arena-interrupted")).toHaveCount(0);
    await waitForStatus(page, "finished");
    const done = (await getMatch(page, matchId))!;
    expect(done.results.map((r) => r.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await savedGames(page, matchId)).toHaveLength(8);
    expect(errors).toEqual([]);
  });

  test("abort, then delete the match with its games", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const matchId = await createMatch(page, { name: "Abort test", engineIds: [ids.classic, ids.blocky], games: 30, concurrency: 2, nodes: 5000 });
    await page.goto(`/#/arena/${matchId}`);
    await waitForStatus(page, "running", 60_000);
    await expect.poll(async () => (await getMatch(page, matchId))!.results.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(1);

    // Abort asks first; cancelling keeps it running.
    await page.getByTestId("arena-abort").click();
    const confirmBox = page.locator(".cb-modal", { hasText: "Abort the match?" });
    await expect(confirmBox).toBeVisible();
    await confirmBox.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmBox).toHaveCount(0);
    await expect(detail(page)).toHaveAttribute("data-status", "running");

    await page.getByTestId("arena-abort").click();
    await page.locator(".cb-modal", { hasText: "Abort the match?" }).getByRole("button", { name: "Abort match" }).click();
    await waitForStatus(page, "aborted", 20_000);
    await expect(page.getByTestId("arena-start")).toHaveCount(0);
    await expect(page.getByTestId("arena-pause")).toHaveCount(0);
    await expect(page.getByTestId("arena-abort")).toHaveCount(0);
    const aborted = (await getMatch(page, matchId))!;
    expect(aborted.status).toBe("aborted");
    const played = aborted.results.length;
    expect(played).toBeGreaterThanOrEqual(1);
    expect(played).toBeLessThan(30);
    await page.waitForTimeout(1000);
    expect((await getMatch(page, matchId))!.results.length).toBe(played);
    expect(await savedGames(page, matchId)).toHaveLength(played);

    // Delete: confirmation with "also delete its saved games" (on by default).
    await page.getByTestId("arena-delete").click();
    const del = page.locator(".cb-modal", { hasText: "Delete “Abort test”?" });
    await expect(del).toBeVisible();
    await expect(del.getByTestId("arena-delete-games")).toBeChecked();
    await del.getByRole("button", { name: "Delete match" }).click();
    await expect(page).toHaveURL(/#\/arena$/);
    await expect(page.getByText("No matches yet")).toBeVisible();
    expect(await getMatch(page, matchId)).toBeNull();
    expect(await savedGames(page, matchId)).toHaveLength(0);

    // A deleted match's link shows "not found".
    await page.goto(`/#/arena/${matchId}`);
    await expect(page.getByText("Match not found")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("delete a running match from the list, keeping its games", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const matchId = await createMatch(page, { name: "Delete while running", engineIds: [ids.classic, ids.blocky], games: 30, concurrency: 2, nodes: 5000 });
    await page.goto("/#/arena");
    const card = page.getByTestId("arena-card");
    await expect(card.locator(".arena-status")).toHaveText("Running", { timeout: 60_000 });
    await expect.poll(async () => (await getMatch(page, matchId))!.results.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(1);
    await card.getByRole("button", { name: "Delete Delete while running" }).click();
    const del = page.locator(".cb-modal", { hasText: "Delete “Delete while running”?" });
    await expect(del).toContainText("it is stopped first");
    await del.getByTestId("arena-delete-games").uncheck();
    await del.getByRole("button", { name: "Delete match" }).click();
    await expect(page.getByText("No matches yet")).toBeVisible({ timeout: 20_000 });
    expect(await getMatch(page, matchId)).toBeNull();
    const kept = (await savedGames(page, matchId)).length;
    expect(kept).toBeGreaterThanOrEqual(1);
    // The runner is gone: no more games are written, and the header activity is cleared.
    await page.waitForTimeout(2500);
    expect((await savedGames(page, matchId)).length).toBe(kept);
    expect(await page.evaluate(async (mid) => ((await import(String("/src/arena/index.ts"))) as ArenaModule).arena.isRunning(mid), matchId)).toBe(false);
    expect(errors).toEqual([]);
  });

  test("adjudication: a 20-ply limit draws every game with termination max-moves", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    await page.goto(`/#/arena?new=1&engines=${ids.classic},${ids.blocky}`);
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Classic");
    await dialog.locator(".arena-form-shared button[role=radio]", { hasText: "No clock" }).click();
    const nodesCap = dialog.locator(".arena-form-shared .cb-limits-cap", { hasText: "nodes" });
    await nodesCap.locator('input[type="checkbox"]').check();
    await nodesCap.locator("input.input").fill("2000");
    await page.getByLabel("Games per pairing").fill("4");
    await page.getByLabel("Games at once").fill("2");
    // Resign adjudication off, ply limit on at 20.
    await dialog.getByLabel("Resign when both engines see one side clearly winning").uncheck();
    await dialog.getByLabel("Draw games that get too long").check();
    const after = dialog.locator(".arena-adj-rule", { hasText: "Draw games that get too long" }).getByLabel("After");
    await after.fill("5");
    await expect(dialog.locator(".field-error", { hasText: "At least 10" })).toBeVisible();
    await after.fill("20");
    await page.getByTestId("arena-form-start").click();
    await expect(page).toHaveURL(/#\/arena\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const matchId = page.url().split("/").pop()!;
    await waitForStatus(page, "finished");

    const rec = (await getMatch(page, matchId))!;
    expect(rec.results).toHaveLength(4);
    for (const r of rec.results) {
      expect(r.result).toBe("1/2-1/2");
      expect(r.termination).toBe("max-moves");
      expect(r.plies).toBe(20);
    }
    await expect(page.locator(".arena-settings-list")).toContainText("draw after 20 plies");
    await expect(page.locator(".arena-settings-list")).not.toContainText("resign at");
    await expect(page.locator(".arena-ending").first()).toHaveText("Move limit reached");
    await expect(page.getByTestId("arena-score")).toHaveText("2 – 2");
    const games = await savedGames(page, matchId);
    expect(games.every((g) => g.pgn.includes('[Termination "adjudication"]'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test("an engine that fails to build pauses the match with a clear error", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const broken = await addEngine(page, {
      name: "Broken Eval",
      kind: "eval",
      // A typical mistake: an undefined name (the signature matches the template's).
      files: { "eval.ts": 'import { Position } from "./position";\n\nexport function evaluate(pos: Position): i32 {\n  return notDefinedAnywhere;\n}\n' },
    });
    const matchId = await createMatch(page, { name: "Build error test", engineIds: [ids.classic, broken], games: 2, concurrency: 1, nodes: 2000 });
    await page.goto(`/#/arena/${matchId}`);
    const callout = page.getByTestId("arena-error");
    await expect(callout).toBeVisible({ timeout: 120_000 });
    await expect(callout).toContainText("The match stopped because of an error.");
    await expect(callout.locator(".arena-error-text")).toContainText("notDefinedAnywhere");
    await expect(callout.getByRole("link", { name: "Open Broken Eval" })).toHaveAttribute("href", `#/engines/${broken}`);
    await waitForStatus(page, "paused", 10_000);
    const rec = (await getMatch(page, matchId))!;
    expect(rec.status).toBe("paused");
    expect(rec.results).toHaveLength(0);
    expect(rec.lastErrorEngineId).toBe(broken);
    expect(rec.lastError).toBeTruthy();

    // Resuming without fixing it fails the same way (and does not loop).
    await callout.getByRole("button", { name: "Resume" }).click();
    await expect(callout).toBeVisible({ timeout: 120_000 });
    await waitForStatus(page, "paused", 120_000);
    expect((await getMatch(page, matchId))!.results).toHaveLength(0);

    // The error shows on the list card too.
    await page.goto("/#/arena");
    await expect(page.getByTestId("arena-card").locator(".text-danger")).toContainText("notDefinedAnywhere");
    // Compile errors are reported by the app on purpose (toasts / console); only crashes count here.
    expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
  });

  test("an empty-skeleton engine loses by engine error and the match goes on", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const empty = await addEngine(page, { name: "Empty Skeleton", kind: "scratch", files: "scratch-empty" });
    const matchId = await createMatch(page, { name: "Skeleton test", engineIds: [ids.classic, empty], games: 4, concurrency: 2, nodes: 2000 });
    await page.goto(`/#/arena/${matchId}`);
    await waitForStatus(page, "finished", 120_000);
    const rec = (await getMatch(page, matchId))!;
    expect(rec.results).toHaveLength(4);
    for (const r of rec.results) {
      expect(r.termination).toBe("engine-error");
      expect(r.result).toBe(r.whiteId === empty ? "0-1" : "1-0");
      expect(r.detail).toContain("produced no move");
    }
    await expect(page.getByTestId("arena-score")).toHaveText("4 – 0");
    await expect(page.getByTestId("arena-error")).toHaveCount(0);
    const endings = await page.locator(".arena-ending").allInnerTexts();
    expect(endings.every((t) => /^(White|Black)'s engine failed$/.test(t.trim()))).toBe(true);
    // The reason and the engine's own log output reach the match log.
    const log = page.getByTestId("arena-log");
    await expect(log).toContainText("produced no move");
    await expect(log).toContainText("Empty Skeleton: cb_go: no search yet (empty skeleton)");
    expect(errors.filter((e) => e.startsWith("pageerror"))).toEqual([]);
  });

  test("a match whose engine was deleted offers a rematch instead of Resume", async ({ page }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const copy = await page.evaluate(async (classic) => {
      const s = (await import(String("/src/storage/index.ts"))) as StorageModule;
      const src = (await s.enginesRepo.get(classic))!;
      const id = s.newId();
      await s.enginesRepo.put({ ...src, id, name: "Classic Copy", builtin: false, tags: [], createdAt: Date.now(), updatedAt: Date.now() });
      return id;
    }, ids.classic);
    const matchId = await createMatch(page, { name: "Doomed match", engineIds: [copy, ids.blocky], games: 4, concurrency: 1, nodes: 2000, start: false });
    await page.goto(`/#/arena/${matchId}`);
    await waitForStatus(page, "pending", 30_000);
    await expect(page.getByTestId("arena-start")).toBeVisible();

    await page.evaluate(async (id) => ((await import(String("/src/storage/index.ts"))) as StorageModule).enginesRepo.remove(id), copy);
    const notice = page.getByTestId("arena-missing-engine");
    await expect(notice).toContainText("An engine in this match was deleted");
    await expect(page.getByTestId("arena-start")).toHaveCount(0);
    await expect(page.getByTestId("arena-standings")).toContainText("Deleted engine");

    // The list card offers no Start either.
    await page.goto("/#/arena");
    const card = page.getByTestId("arena-card");
    await expect(card.locator(".arena-chip--missing")).toHaveText("Deleted engine");
    await expect(card.getByRole("button", { name: "Start" })).toHaveCount(0);

    // Rematch: the form keeps the settings and asks for another engine.
    await page.goto(`/#/arena/${matchId}`);
    await notice.getByRole("button", { name: "Rematch" }).click();
    const dialog = page.locator(".arena-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#arena-name")).toHaveValue("Doomed match (2)");
    await expect(page.getByRole("button", { name: "Engine 1", exact: true })).toContainText("Missing engine");
    await page.getByTestId("arena-form-start").click();
    await expect(dialog.locator(".arena-form-problems")).toContainText("An engine in this list was deleted");
    await page.getByRole("button", { name: "Engine 1", exact: true }).click();
    await page.locator('li[role="option"]', { hasText: "Sprout" }).first().click();
    await expect(dialog.locator(".arena-form-problems")).toHaveCount(0);
    await page.getByTestId("arena-form-start").click();
    await expect(page).not.toHaveURL(new RegExp(matchId));
    await waitForStatus(page, "finished");
    await expect(page.getByTestId("arena-standings")).toContainText("Sprout");
    expect(errors).toEqual([]);
  });

  test("two tabs: the other tab sees the match running, can pause it, and recovers it when the runner's tab closes", async ({ page, context }) => {
    const errors = trackErrors(page);
    const ids = await openApp(page);
    const matchId = await createMatch(page, { name: "Two tabs", engineIds: [ids.classic, ids.blocky], games: 8, concurrency: 1, clock: { baseMs: 20_000, incMs: 200 } });
    await page.goto(`/#/arena/${matchId}`);
    await waitForStatus(page, "running", 60_000);

    const other = await context.newPage();
    const otherErrors = trackErrors(other);
    await other.goto(`/#/arena/${matchId}`);
    await waitForStatus(other, "remote", 30_000);
    await expect(other.getByTestId("arena-remote")).toBeVisible();
    // Starting it from the second tab is refused.
    const refused = await other.evaluate(async (mid) => {
      const m = (await import(String("/src/arena/index.ts"))) as ArenaModule;
      return m.arena.start(mid).then(
        () => "started",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    }, matchId);
    expect(refused).toBe("This match is running in another tab.");

    // Pause from the second tab pauses the runner in the first.
    await other.getByTestId("arena-pause").click();
    await waitForStatus(page, "paused", 20_000);
    await waitForStatus(other, "paused", 20_000);

    // Resume in the first tab, then close it: the second tab marks the match interrupted.
    await page.getByTestId("arena-start").click();
    await waitForStatus(page, "running", 30_000);
    await waitForStatus(other, "remote", 30_000);
    await page.close();
    await waitForStatus(other, "interrupted", 30_000);
    const rec = (await getMatch(other, matchId))!;
    expect(rec.status).toBe("paused");
    expect(rec.interrupted).toBe(true);
    // ...and can run it from there.
    await other.getByTestId("arena-start").click();
    await waitForStatus(other, "running", 30_000);
    await other.getByTestId("arena-pause").click();
    await waitForStatus(other, "paused", 20_000);
    expect(errors).toEqual([]);
    expect(otherErrors).toEqual([]);
  });
});
