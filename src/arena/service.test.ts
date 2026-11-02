// The arena service's record handling: createMatch, start-up recovery of interrupted matches,
// Web Lock behaviour across "tabs" (Node 24 has navigator.locks), abort and delete.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { gamesRepo, matchesRepo } from "@/storage/repos";
import { makeGame, resetStorage } from "@/storage/test-utils";
import type { MatchConfig, MatchRecord } from "@/types";
import { matchExtras } from "./live";
import { arena, initArenaService } from "./service";

const config = (): MatchConfig => ({
  name: "  Alpha vs Beta ",
  participants: [
    { engineId: "a", limits: { nodes: 1000 }, timeControl: null },
    { engineId: "b", limits: { nodes: 1000 }, timeControl: null },
  ],
  format: "round-robin",
  gamesPerPairing: 6,
  openings: { mode: "book" },
  concurrency: 2,
  adjudication: { resignScoreCp: 900, resignMoves: 4, drawScoreCp: 10, drawMoves: 8, drawMinPly: 80, maxPlies: 400 },
  saveGames: true,
});

async function putRecord(id: string, patch: Partial<MatchRecord> & Record<string, unknown>): Promise<void> {
  await matchesRepo.put({ id, createdAt: 1, updatedAt: 10_000, status: "pending", config: config(), totalGames: 6, results: [], ...patch } as MatchRecord);
}

const hold = (id: string) => {
  // Simulates another tab running the match: hold its lock until release() is called.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    void navigator.locks.request(`chess-builder:match:${id}`, () => {
      resolve();
      return new Promise<void>((r) => (release = r));
    });
  });
  return { held, release: () => release() };
};

beforeAll(async () => {
  await resetStorage();
});

describe("arena service", () => {
  it("createMatch validates and stores a normalized pending match", async () => {
    await expect(arena.createMatch({ ...config(), participants: config().participants.slice(0, 1) })).rejects.toThrow(/at least two engines/);
    const id = await arena.createMatch(config());
    const r = (await matchesRepo.get(id))!;
    expect(r.status).toBe("pending");
    expect(r.config.name).toBe("Alpha vs Beta");
    expect(r.totalGames).toBe(6);
    expect(typeof r.config.openings.seed).toBe("number");
    expect(arena.isRunning(id)).toBe(false);
  });

  it("marks matches left running as paused (interrupted), except those another tab runs", async () => {
    await putRecord("orphan", { status: "running", runningSince: 4_000, elapsedMs: 1_000 });
    await putRecord("busy", { status: "running", runningSince: 4_000 });
    const other = hold("busy");
    await other.held;

    initArenaService();
    for (let i = 0; i < 200; i++) {
      if ((await matchesRepo.get("orphan"))!.status === "paused") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const orphan = (await matchesRepo.get("orphan"))!;
    expect(orphan.status).toBe("paused");
    expect(matchExtras(orphan).interrupted).toBe(true);
    expect(matchExtras(orphan).runningSince).toBeNull();
    // 1 s from before + (updatedAt 10 000 − runningSince 4 000).
    expect(matchExtras(orphan).elapsedMs).toBe(7_000);

    expect((await matchesRepo.get("busy"))!.status).toBe("running");
    await expect(arena.start("busy")).rejects.toThrow(/running in another tab/);

    // The other tab "crashes": its lock is released and the match is recovered.
    other.release();
    for (let i = 0; i < 200; i++) {
      if ((await matchesRepo.get("busy"))!.status === "paused") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const busy = (await matchesRepo.get("busy"))!;
    expect(busy.status).toBe("paused");
    expect(matchExtras(busy).interrupted).toBe(true);
  });

  it("watches matches that another tab starts later", async () => {
    const other = hold("later");
    await other.held;
    await putRecord("later", { status: "running", runningSince: 9_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect((await matchesRepo.get("later"))!.status).toBe("running");
    other.release();
    for (let i = 0; i < 200; i++) {
      if ((await matchesRepo.get("later"))!.status === "paused") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await matchesRepo.get("later"))!.status).toBe("paused");
  });

  it("refuses to start a finished match", async () => {
    await putRecord("done", { status: "finished" });
    await expect(arena.start("done")).rejects.toThrow(/already finished/);
    await expect(arena.start("missing")).rejects.toThrow(/no longer exists/);
  });

  it("aborts a paused match and deletes a match with its games", async () => {
    await putRecord("p", { status: "paused" });
    await arena.abort("p");
    expect((await matchesRepo.get("p"))!.status).toBe("aborted");

    await putRecord("d", { status: "finished" });
    await gamesRepo.put(makeGame("g1", 1, "d"));
    await gamesRepo.put(makeGame("g2", 2, "d"));
    await gamesRepo.put(makeGame("g3", 3, "other"));
    await arena.deleteMatch("d", { deleteGames: true });
    expect(await matchesRepo.get("d")).toBeUndefined();
    expect(await gamesRepo.list({ matchId: "d" })).toEqual([]);
    expect(await gamesRepo.list({ matchId: "other" })).toHaveLength(1);

    await putRecord("k", { status: "finished" });
    await gamesRepo.put(makeGame("g4", 4, "k"));
    await arena.deleteMatch("k");
    expect(await gamesRepo.list({ matchId: "k" })).toHaveLength(1);
  });
});
