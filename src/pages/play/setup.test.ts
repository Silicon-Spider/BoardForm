import { describe, expect, it } from "vitest";
import { ChessGame, OPENINGS, START_FEN } from "@/chess";
import type { EngineRecord } from "@/types";
import {
  BLITZ_CLOCK,
  DEFAULT_ENGINE_LIMITS,
  DEFAULT_SETUP,
  HUMAN_SIDE,
  applyPreset,
  checkStart,
  engineSide,
  intentFromQuery,
  normalizeSetup,
  openingStart,
  playersFor,
  previewFen,
  resolveStart,
  setSideClock,
  swapSides,
  validateSetup,
  withDefaultEngines,
} from "./setup";
import type { GameSetup } from "./types";

function engine(id: string, name: string, extra: Partial<EngineRecord> = {}): EngineRecord {
  return { id, name, description: "", kind: "eval", createdAt: 0, updatedAt: 0, color: "#123456", options: { hashMb: 32 }, ...extra };
}

const engines = [engine("a", "Blocky", { builtin: true, kind: "blocks" }), engine("b", "Classic", { builtin: true }), engine("c", "Sprout", { builtin: true, kind: "scratch" })];

describe("normalizeSetup", () => {
  it("returns the default for garbage", () => {
    expect(normalizeSetup(null)).toEqual(DEFAULT_SETUP);
    expect(normalizeSetup("x")).toEqual(DEFAULT_SETUP);
  });

  it("repairs invalid fields", () => {
    const s = normalizeSetup({
      white: { player: "engine", engineId: "b", limits: { depth: -3, nodes: 5000 }, timeControl: { baseMs: 0 }, hashMb: 100000 },
      black: { player: "nobody" },
      start: { kind: "random", plies: 999 },
      sameClock: "yes",
    });
    expect(s.white).toEqual({ player: "engine", engineId: "b", limits: { nodes: 5000 }, timeControl: null, hashMb: 512 });
    expect(s.black.player).toBe("engine");
    expect(s.start).toEqual({ kind: "random", plies: 20 });
    expect(s.sameClock).toBe(true);
  });
});

describe("engines in the setup", () => {
  it("fills missing engines with Classic", () => {
    const s = withDefaultEngines({ ...DEFAULT_SETUP, black: engineSide("deleted") }, engines);
    expect(s.black.engineId).toBe("b");
    expect(s.white).toBe(DEFAULT_SETUP.white);
  });

  it("validates engines, limits and the start position", () => {
    expect(validateSetup(withDefaultEngines(DEFAULT_SETUP, engines), engines)).toEqual([]);
    const noLimits: GameSetup = { ...DEFAULT_SETUP, black: { ...engineSide("b"), limits: {} } };
    expect(validateSetup(noLimits, engines)).toEqual(["Set a clock or at least one search limit for Black."]);
    expect(validateSetup({ ...noLimits, black: { ...noLimits.black, timeControl: BLITZ_CLOCK } }, engines)).toEqual([]);
    expect(validateSetup({ ...DEFAULT_SETUP, black: engineSide("zzz") }, engines)).toEqual(["Choose an engine for Black."]);
    expect(validateSetup({ ...DEFAULT_SETUP, black: engineSide("b"), start: { kind: "fen", fen: "nonsense" } }, engines)[0]).toMatch(/not valid/);
  });

  it("names players and resolves hash sizes", () => {
    const setup: GameSetup = { ...DEFAULT_SETUP, black: { ...engineSide("b"), hashMb: 64 } };
    const p = playersFor(setup, engines, 16);
    expect(p.w).toMatchObject({ kind: "human", name: "You" });
    expect(p.b).toMatchObject({ kind: "engine", name: "Classic", engineId: "b", engineKind: "eval", hashMb: 64, limits: DEFAULT_ENGINE_LIMITS });
    expect(playersFor({ ...setup, black: engineSide("b") }, engines, 16).b.hashMb).toBe(32);
    const same = playersFor({ ...setup, white: engineSide("b"), black: engineSide("b") }, engines, 16);
    expect([same.w.name, same.b.name]).toEqual(["Classic (White)", "Classic (Black)"]);
    const humans = playersFor({ ...setup, black: HUMAN_SIDE }, engines, 16);
    expect([humans.w.name, humans.b.name]).toEqual(["White player", "Black player"]);
  });
});

describe("presets, clocks and swapping", () => {
  it("applies the quick presets", () => {
    const base = withDefaultEngines(DEFAULT_SETUP, engines);
    expect(applyPreset(base, "human-black", engines)).toMatchObject({ white: { player: "engine", engineId: "b" }, black: { player: "human" } });
    const blitz = applyPreset(base, "blitz", engines);
    expect(blitz.white).toMatchObject({ player: "human", timeControl: BLITZ_CLOCK });
    expect(blitz.black).toMatchObject({ player: "engine", timeControl: BLITZ_CLOCK, limits: {} });
    const ee = applyPreset(base, "engines", engines);
    expect(ee.white.engineId).toBe("b");
    expect(ee.black.player).toBe("engine");
    expect(ee.black.engineId).not.toBe("b");
  });

  it("links clocks when sameClock is on", () => {
    const tc = { baseMs: 60_000, incMs: 0 };
    const linked = setSideClock({ ...DEFAULT_SETUP, sameClock: true }, "w", tc);
    expect(linked.white.timeControl).toEqual(tc);
    expect(linked.black.timeControl).toEqual(tc);
    const separate = setSideClock({ ...DEFAULT_SETUP, sameClock: false }, "b", tc);
    expect(separate.white.timeControl).toBeNull();
    expect(separate.black.timeControl).toEqual(tc);
  });

  it("swaps colours for a rematch", () => {
    const s = swapSides({ ...DEFAULT_SETUP, black: engineSide("b") });
    expect(s.white.player).toBe("engine");
    expect(s.black.player).toBe("human");
  });
});

describe("start positions", () => {
  it("resolves standard, FEN, opening and random starts", () => {
    expect(resolveStart({ kind: "standard" }, 1)).toEqual({ startFen: START_FEN, moves: [], opening: null });
    const fen = "4k3/8/8/8/8/8/4P3/4K3 b - - 0 1";
    expect(resolveStart({ kind: "fen", fen }, 1).startFen).toBe(fen);
    const o = openingStart(OPENINGS[0].name)!;
    const r = resolveStart(o, 1);
    expect(r.moves).toEqual(OPENINGS[0].moves);
    expect(r.opening).toContain(OPENINGS[0].name);
    const random = resolveStart({ kind: "random", plies: 8 }, 42);
    expect(random.moves).toHaveLength(8);
    expect(ChessGame.fromMoves(START_FEN, random.moves)).not.toBeNull();
    expect(resolveStart({ kind: "random", plies: 8 }, 42).moves).toEqual(random.moves);
  });

  it("rejects finished or invalid positions and previews openings", () => {
    expect(checkStart({ kind: "fen", fen: "" })).toMatch(/Enter a FEN/);
    // Fool's mate: White is checkmated.
    expect(checkStart({ kind: "fen", fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3" })).toMatch(/already over/);
    expect(checkStart({ kind: "opening", name: "x", eco: "", moves: ["e2e5"] })).toMatch(/illegal/);
    expect(previewFen(openingStart(OPENINGS[0].name)!)).toBe(ChessGame.fromMoves("startpos", OPENINGS[0].moves)!.fen());
  });
});

describe("query parameters", () => {
  const base = withDefaultEngines(DEFAULT_SETUP, engines);

  it("?engine=<id>: you play White against it, and the game starts", () => {
    const i = intentFromQuery(new URLSearchParams("engine=c"), base, engines);
    expect(i.autostart).toBe(true);
    expect(i.setup?.white.player).toBe("human");
    expect(i.setup?.black).toMatchObject({ player: "engine", engineId: "c" });
  });

  it("?white & ?black, with a FEN", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    const i = intentFromQuery(new URLSearchParams({ white: "b", black: "a", fen }), base, engines);
    expect(i.autostart).toBe(true);
    expect(i.setup?.white).toMatchObject({ player: "engine", engineId: "b" });
    expect(i.setup?.black).toMatchObject({ player: "engine", engineId: "a" });
    expect(i.setup?.start).toEqual({ kind: "fen", fen });
  });

  it("reports unknown engines and invalid FENs without starting", () => {
    const i = intentFromQuery(new URLSearchParams("engine=nope"), base, engines);
    expect(i.autostart).toBe(false);
    expect(i.problems[0]).toMatch(/no longer exists/);
    const j = intentFromQuery(new URLSearchParams("engine=b&fen=garbage"), base, engines);
    expect(j.autostart).toBe(false);
    expect(j.problems[0]).toMatch(/not a valid FEN/);
  });

  it("?fen alone prefills the setup; ?analysis and ?game select the other views", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    const i = intentFromQuery(new URLSearchParams({ fen }), base, engines);
    expect(i.autostart).toBe(false);
    expect(i.setup?.start).toEqual({ kind: "fen", fen });
    const a = intentFromQuery(new URLSearchParams({ analysis: "a", fen }), base, engines);
    expect(a).toMatchObject({ analysisEngineId: "a", analysisFen: fen, setup: null });
    expect(intentFromQuery(new URLSearchParams("game=xyz"), base, engines).gameId).toBe("xyz");
  });
});
