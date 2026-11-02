// MatchRunner with fake engines over fake-indexeddb: persistence, pause / resume, errors.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { useActivityStore } from "@/app/activity";
import { enginesRepo, gamesRepo, matchesRepo } from "@/storage/repos";
import { makeEngine, resetStorage, waitFor } from "@/storage/test-utils";
import type { MatchConfig, MatchRecord } from "@/types";
import { getLiveMatch, matchExtras } from "./live";
import { MatchRunner, type PoolEngine, type RunnerDeps } from "./runner";
import { FakeEngine, type FakeBehaviour } from "./test-utils";
import type { ArenaGameSummary } from "./types";

interface TestDeps extends RunnerDeps {
  loads: string[];
  engines: FakeEngine[];
}

function fakeDeps(behaviour: FakeBehaviour = () => ({}), overrides: Partial<RunnerDeps> = {}): TestDeps {
  const d: TestDeps = {
    loads: [],
    engines: [],
    async prepare() {},
    async load(engineId): Promise<PoolEngine> {
      d.loads.push(engineId);
      const e = new FakeEngine(behaviour, engineId);
      d.engines.push(e);
      return e;
    },
    ...overrides,
  };
  return d;
}

function matchConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    name: "Alpha vs Beta",
    participants: [
      { engineId: "a", limits: { nodes: 1000 }, timeControl: null },
      { engineId: "b", limits: { nodes: 1000 }, timeControl: null },
    ],
    format: "round-robin",
    gamesPerPairing: 4,
    openings: { mode: "book", seed: 5 },
    concurrency: 2,
    adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: 16 },
    saveGames: true,
    ...overrides,
  };
}

async function createMatch(config: MatchConfig, patch: Partial<MatchRecord> = {}): Promise<string> {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  await matchesRepo.put({ id, createdAt: 1, updatedAt: 1, status: "pending", config, totalGames: 0, results: [], ...patch });
  return id;
}

beforeEach(async () => {
  await resetStorage();
  await enginesRepo.put(makeEngine("a", { name: "Alpha" }));
  await enginesRepo.put(makeEngine("b", { name: "Beta" }));
  await enginesRepo.put(makeEngine("c", { name: "Gamma" }));
});

describe("MatchRunner", () => {
  it("plays every game, saves results and games, and reuses engines per slot", async () => {
    const id = await createMatch(matchConfig());
    const deps = fakeDeps();
    let finished: MatchRecord | null = null;
    const runner = new MatchRunner(id, deps, { onFinished: (r) => (finished = r) });
    await runner.run();

    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("finished");
    expect(record.totalGames).toBe(4);
    expect(record.results.map((r) => r.index).sort()).toEqual([0, 1, 2, 3]);
    expect(record.results.every((r) => r.result !== "*" && typeof r.gameId === "string")).toBe(true);
    const x = matchExtras(record);
    expect(x.runningSince).toBeNull();
    expect(x.lastError).toBeNull();
    expect(typeof x.finishedAt).toBe("number");
    expect(x.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(finished).not.toBeNull();

    const games = await gamesRepo.list({ matchId: id });
    expect(games).toHaveLength(4);
    for (const g of games) {
      const summary = record.results.find((r) => r.gameId === g.id)!;
      expect(g.matchId).toBe(id);
      expect(g.moves.length).toBe(summary.plies);
      expect(g.result).toBe(summary.result);
      expect(g.pgn).toContain('[Event "Alpha vs Beta"]');
      expect(g.pgn).toContain(`[Round "${summary.index + 1}"]`);
      expect(g.opening).toBeTruthy(); // book openings
      expect(g.white).toMatchObject({ type: "engine", engineId: summary.whiteId });
    }
    // Colours alternate: game 0 Alpha has White, game 1 Beta.
    const byIndex = (i: number) => record.results.find((r) => r.index === i)!;
    expect(byIndex(0).whiteId).toBe("a");
    expect(byIndex(1).whiteId).toBe("b");

    // Two slots × two engines, each reused for the slot's second game; all terminated.
    expect(deps.loads.sort()).toEqual(["a", "a", "b", "b"]);
    expect(deps.engines.every((e) => e.terminated)).toBe(true);
    expect(deps.engines.every((e) => e.newGames === 2)).toBe(true);

    const live = getLiveMatch(id)!;
    expect(live.running).toBe(false);
    expect(live.games).toEqual([]);
    expect(useActivityStore.getState().activities[`arena:${id}`]).toBeUndefined();
  });

  it("does not save games when saveGames is off", async () => {
    const id = await createMatch(matchConfig({ saveGames: false, gamesPerPairing: 2 }));
    await new MatchRunner(id, fakeDeps()).run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("finished");
    expect(record.results.every((r) => r.gameId === null)).toBe(true);
    expect(await gamesRepo.list({ matchId: id })).toHaveLength(0);
  });

  it("pauses (dropping unfinished games) and resumes with the remaining games", async () => {
    const id = await createMatch(matchConfig({ gamesPerPairing: 6, concurrency: 2, adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: 30 } }));
    const slow: FakeBehaviour = () => ({ delayMs: 2 });
    const first = new MatchRunner(id, fakeDeps(slow));
    const run1 = first.run();
    await first.started;
    await waitFor(() => (getLiveMatch(id)?.games.length ?? 0) > 0, 5000, "live boards");
    // Wait until at least one game is stored, then pause.
    for (let i = 0; i < 400; i++) {
      const r = await matchesRepo.get(id);
      if (r && r.results.length >= 1) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    await first.stop("paused");
    await run1;
    const paused = (await matchesRepo.get(id))!;
    expect(paused.status).toBe("paused");
    const doneBefore = paused.results.length;
    expect(doneBefore).toBeGreaterThanOrEqual(1);
    expect(doneBefore).toBeLessThan(6);
    expect(matchExtras(paused).runningSince).toBeNull();
    expect(await gamesRepo.list({ matchId: id })).toHaveLength(doneBefore);

    const deps2 = fakeDeps();
    await new MatchRunner(id, deps2).run();
    const finished = (await matchesRepo.get(id))!;
    expect(finished.status).toBe("finished");
    const indices = finished.results.map((r) => r.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
    // Games finished before the pause were kept as they were.
    for (const r of paused.results) expect(finished.results.find((x) => x.index === r.index)).toEqual(r);
    expect(await gamesRepo.list({ matchId: id })).toHaveLength(6);
  });

  it("pauses with a clear error when an engine fails to build", async () => {
    const id = await createMatch(matchConfig());
    let error: string | null = null;
    const deps = fakeDeps(undefined, {
      async prepare(engineId) {
        if (engineId === "b") throw new Error('"Beta" failed to compile: eval.ts:3:5 error TS2304: Cannot find name \'x\'.');
      },
    });
    const runner = new MatchRunner(id, deps, { onError: (_r, m) => (error = m) });
    await runner.run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("paused");
    expect(matchExtras(record).lastError).toMatch(/failed to compile/);
    expect(matchExtras(record).lastErrorEngineId).toBe("b");
    expect(error).toMatch(/failed to compile/);
    expect(deps.loads).toEqual([]);
    expect(getLiveMatch(id)?.lastError).toMatch(/failed to compile/);
  });

  it("pauses when an engine of the match was deleted", async () => {
    const id = await createMatch(matchConfig({ participants: [...matchConfig().participants, { engineId: "gone", limits: {}, timeControl: null }] }));
    await new MatchRunner(id, fakeDeps()).run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("paused");
    expect(matchExtras(record).lastError).toMatch(/participant 3\) has been deleted/);
  });

  it("pauses when an engine does not start", async () => {
    const id = await createMatch(matchConfig());
    const deps = fakeDeps(undefined, {
      async load() {
        throw new Error("The engine did not start within 30 s.");
      },
    });
    await new MatchRunner(id, deps).run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("paused");
    expect(matchExtras(record).lastError).toMatch(/Could not start the engines for game 1 .*did not start/);
    expect(matchExtras(record).lastErrorEngineId).toBe("a");
    expect(record.results).toEqual([]);
  });

  it("records engine failures as lost games and keeps going", async () => {
    const id = await createMatch(matchConfig({ gamesPerPairing: 2, concurrency: 1 }));
    // Beta's engine never returns a move.
    const deps = fakeDeps(undefined, {
      async load(engineId) {
        return new FakeEngine(engineId === "b" ? () => ({ bestMove: null }) : () => ({}), engineId);
      },
    });
    await new MatchRunner(id, deps).run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("finished");
    const results = record.results as ArenaGameSummary[];
    expect(results.map((r) => r.termination)).toEqual(["engine-error", "engine-error"]);
    expect(results.find((r) => r.index === 0)!.result).toBe("1-0");
    expect(results.find((r) => r.index === 1)!.result).toBe("0-1");
    expect(results[0].detail).toMatch(/no move/);
  });

  it("stops when the match is deleted", async () => {
    const id = await createMatch(matchConfig({ gamesPerPairing: 20, adjudication: { resignScoreCp: null, resignMoves: 4, drawScoreCp: null, drawMoves: 8, drawMinPly: 80, maxPlies: 200 } }));
    const deps = fakeDeps(() => ({ delayMs: 5 }));
    const runner = new MatchRunner(id, deps);
    const run = runner.run();
    await runner.started;
    await matchesRepo.remove(id);
    await run;
    expect(runner.stopping).toBe(true);
    expect(await matchesRepo.get(id)).toBeUndefined();
    expect(deps.engines.every((e) => e.terminated)).toBe(true);
  });

  it("plays an engine against itself with two instances", async () => {
    const id = await createMatch(
      matchConfig({
        participants: [
          { engineId: "a", limits: { nodes: 500 }, timeControl: null },
          { engineId: "a", limits: { nodes: 5000 }, timeControl: null },
        ],
        concurrency: 1,
        gamesPerPairing: 2,
      }),
    );
    const deps = fakeDeps();
    await new MatchRunner(id, deps).run();
    const record = (await matchesRepo.get(id))!;
    expect(record.status).toBe("finished");
    expect(deps.loads).toEqual(["a", "a"]);
    const games = await gamesRepo.list({ matchId: id });
    expect(games.map((g) => g.white.name).sort()).toEqual(["Alpha (1)", "Alpha (2)"]);
  });

  it("logs engine output, showing the host's repeating info-merge note once per engine", async () => {
    const id = await createMatch(matchConfig({ gamesPerPairing: 2, concurrency: 1 }));
    const deps = fakeDeps(undefined, {
      async load(engineId, opts) {
        // Every search of a fast engine can end with this note from the engine worker.
        const e = new FakeEngine(() => {
          opts.onLog("[host] the engine sent info very often; 12 reports were merged (report once per iteration to avoid this)");
          return {};
        }, engineId);
        opts.onLog("hello from the engine");
        opts.onLog("[host] 3 more log lines from this call were suppressed");
        return e;
      },
    });
    await new MatchRunner(id, deps).run();
    const log = getLiveMatch(id)?.log ?? [];
    const notes = log.filter((l) => l.text.includes("sent info very often"));
    expect(notes.map((l) => l.text.split(":")[0]).sort()).toEqual(["Alpha", "Beta"]);
    expect(notes.every((l) => l.level === "info" && l.text.endsWith("(shown once)"))).toBe(true);
    // Other output is unchanged: engine lines are info, other host notes are warnings.
    expect(log.find((l) => l.text === "Alpha: hello from the engine")?.level).toBe("info");
    expect(log.find((l) => l.text.startsWith("Beta: [host] 3 more"))?.level).toBe("warn");
  });

  it("refuses to start a finished match", async () => {
    const id = await createMatch(matchConfig(), { status: "finished" });
    const runner = new MatchRunner(id, fakeDeps());
    const run = runner.run();
    await expect(runner.started).rejects.toThrow(/already finished/);
    await run;
    expect((await matchesRepo.get(id))!.status).toBe("finished");
  });
});
