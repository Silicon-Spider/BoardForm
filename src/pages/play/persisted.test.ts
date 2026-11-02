import { describe, expect, it } from "vitest";
import { START_FEN } from "@/chess";
import { newestGame, parsePersistedGame } from "./persisted";
import { DEFAULT_SETUP } from "./setup";
import type { PersistedGame } from "./types";

const game = (extra: Partial<PersistedGame> = {}): PersistedGame => ({
  v: 1,
  id: "g1",
  createdAt: 1000,
  setup: DEFAULT_SETUP,
  players: {
    w: { kind: "human", name: "You", engineId: null, engineKind: null, color: null, hashMb: null, limits: {}, timeControl: { baseMs: 60_000, incMs: 0 } },
    b: { kind: "engine", name: "Classic", engineId: "e1", engineKind: "eval", color: "#fff", hashMb: 16, limits: { movetimeMs: 500 }, timeControl: { baseMs: 60_000, incMs: 0 } },
  },
  startFen: START_FEN,
  bookPlies: 0,
  opening: null,
  moves: ["e2e4", "e7e5"],
  evals: [null, 12],
  times: [900, 500],
  clock: { w: 59_100, b: 59_500 },
  scores: { w: null, b: { cp: 12, mate: null } },
  end: null,
  savedGameId: null,
  saveSkipped: false,
  updatedAt: 5000,
  ...extra,
});

describe("parsePersistedGame", () => {
  it("accepts a stored game and round-trips it", () => {
    const g = game();
    expect(parsePersistedGame(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it("rejects garbage, illegal moves and engine players without an engine", () => {
    expect(parsePersistedGame(null)).toBeNull();
    expect(parsePersistedGame({ v: 2 })).toBeNull();
    expect(parsePersistedGame({ ...game(), moves: ["e2e5"] })).toBeNull();
    expect(parsePersistedGame({ ...game(), players: { ...game().players, b: { ...game().players.b, engineId: null } } })).toBeNull();
  });

  it("repairs missing clocks and pads short lists", () => {
    const p = parsePersistedGame({ ...game(), clock: {}, evals: [], times: undefined })!;
    expect(p.clock).toEqual({ w: 60_000, b: 60_000 });
    expect(p.evals).toEqual([null, null]);
    expect(p.times).toEqual([0, 0]);
  });
});

describe("newestGame (emergency snapshot)", () => {
  it("prefers a newer snapshot of the same game", () => {
    const stored = game();
    const snap = game({ updatedAt: 9000, clock: { w: 55_000, b: 59_500 } });
    expect(newestGame(stored, snap)).toBe(snap);
    expect(newestGame(snap, stored)).toBe(snap);
  });

  it("ignores snapshots of other games, and snapshots when nothing is stored", () => {
    expect(newestGame(game(), game({ id: "other", updatedAt: 9999 }))?.id).toBe("g1");
    expect(newestGame(null, game({ updatedAt: 9999 }))).toBeNull();
    expect(newestGame(game(), null)?.id).toBe("g1");
  });
});
