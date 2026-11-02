import { describe, expect, it } from "vitest";
import { ChessGame, START_FEN, parsePgn } from "@/chess";
import {
  DRAW_OFFER_MIN_PLY,
  buildGameRecord,
  endByAbort,
  endByAgreement,
  endByEngineError,
  endByIllegalMove,
  endByResign,
  endByRules,
  endByTimeout,
  engineDrawDecision,
  evalForRecord,
  materialBalance,
  pgnTimeControl,
  scoreOf,
  terminationLabel,
  toWhiteScore,
} from "./rules";
import type { PlayerMeta } from "./types";

const names = { w: "You", b: "Classic" };

describe("game endings", () => {
  it("maps rule outcomes", () => {
    expect(endByRules({ result: "1-0", termination: "checkmate" })).toMatchObject({ winner: "w", title: "White wins", reason: "Checkmate." });
    expect(endByRules({ result: "1/2-1/2", termination: "stalemate" })).toMatchObject({ winner: null, title: "Draw", reason: "Stalemate." });
    expect(endByRules({ result: "1/2-1/2", termination: "threefold" }).reason).toBe("Threefold repetition.");
  });

  it("resignation, agreement and abort", () => {
    expect(endByResign("w", names)).toEqual({ result: "0-1", termination: "resign", winner: "b", title: "Black wins", reason: "You resigned." });
    expect(endByAgreement()).toMatchObject({ result: "1/2-1/2", termination: "draw-agreed", winner: null });
    expect(endByAbort()).toMatchObject({ result: "*", termination: "aborted", winner: null });
  });

  it("engine failures lose the game", () => {
    expect(endByIllegalMove("b", "e7e2", names)).toMatchObject({ result: "1-0", termination: "illegal-move", winner: "w", reason: "Classic played an illegal move (e7e2)." });
    expect(endByEngineError("b", "produced no move", names)).toMatchObject({ result: "1-0", termination: "engine-error", reason: "Classic produced no move." });
    expect(endByEngineError("w", "crashed", names).result).toBe("0-1");
  });

  it("a flag fall loses, unless the opponent cannot mate", () => {
    expect(endByTimeout("w", START_FEN, names)).toMatchObject({ result: "0-1", termination: "timeout", winner: "b", reason: "You ran out of time." });
    // Black has king + knight only: White's flag fall is a draw.
    const fen = "4k3/8/8/8/8/2n5/8/R3K3 w - - 0 1";
    expect(endByTimeout("w", fen, names)).toMatchObject({ result: "1/2-1/2", termination: "timeout", winner: null });
    // White still has a rook: Black's flag fall loses.
    expect(endByTimeout("b", fen, names)).toMatchObject({ result: "1-0", winner: "w" });
  });

  it("has labels for every termination", () => {
    expect(terminationLabel("timeout")).toBe("Time forfeit");
    expect(terminationLabel("engine-error")).toBe("Engine error");
  });
});

describe("draw offers", () => {
  it("are declined before move 20 of each side", () => {
    const d = engineDrawDecision({ cp: 0, mate: null }, DRAW_OFFER_MIN_PLY - 1);
    expect(d.accept).toBe(false);
    expect(d.reason).toMatch(/too early/);
  });

  it("are accepted within ±30 cp from ply 40", () => {
    expect(engineDrawDecision({ cp: 30, mate: null }, 40).accept).toBe(true);
    expect(engineDrawDecision({ cp: -30, mate: null }, 41).accept).toBe(true);
    expect(engineDrawDecision({ cp: 0, mate: null }, 120).accept).toBe(true);
  });

  it("are declined with a better or worse score, a mate, or no score", () => {
    expect(engineDrawDecision({ cp: 31, mate: null }, 60)).toMatchObject({ accept: false, reason: expect.stringMatching(/better/) });
    expect(engineDrawDecision({ cp: -80, mate: null }, 60).accept).toBe(false);
    expect(engineDrawDecision({ cp: null, mate: 3 }, 60)).toMatchObject({ accept: false, reason: expect.stringMatching(/mate/) });
    expect(engineDrawDecision(null, 60)).toMatchObject({ accept: false, reason: expect.stringMatching(/not evaluated/) });
  });
});

describe("scores", () => {
  it("reads search infos", () => {
    const base = { depth: 5, seldepth: 7, nodes: 1000, timeMs: 10, nps: 100_000, pv: [] };
    expect(scoreOf({ ...base, scoreCp: 42, mate: null })).toEqual({ cp: 42, mate: null });
    expect(scoreOf({ ...base, scoreCp: null, mate: -2 })).toEqual({ cp: null, mate: -2 });
    expect(scoreOf(null)).toBeNull();
  });

  it("converts to White's view and to record evals (mate = ±10000)", () => {
    expect(toWhiteScore({ cp: 50, mate: null }, "b")).toEqual({ cp: -50, mate: null });
    expect(toWhiteScore({ cp: null, mate: 2 }, "b")).toEqual({ cp: null, mate: -2 });
    expect(evalForRecord({ cp: 50, mate: null }, "w")).toBe(50);
    expect(evalForRecord({ cp: 50, mate: null }, "b")).toBe(-50);
    expect(evalForRecord({ cp: null, mate: 3 }, "b")).toBe(-10_000);
    expect(evalForRecord({ cp: null, mate: -1 }, "b")).toBe(10_000);
    expect(evalForRecord(null, "w")).toBeNull();
  });
});

describe("material", () => {
  it("is balanced at the start", () => {
    expect(materialBalance(START_FEN)).toEqual({ w: { pieces: [], lead: 0 }, b: { pieces: [], lead: 0 } });
  });

  it("lists the net captured pieces and the lead", () => {
    // White is up a knight, Black is up a pawn: White leads by 2.
    const fen = "r1bqkb1r/ppppp1pp/8/8/8/8/PPPPPP2/R1BQKBNR w KQkq - 0 1";
    const m = materialBalance(fen);
    expect(m.w.pieces).toEqual(["bN"]);
    expect(m.b.pieces).toEqual(["wP"]);
    expect(m.w.lead).toBe(2);
    expect(m.b.lead).toBe(0);
  });
});

describe("records", () => {
  const human: PlayerMeta = { kind: "human", name: "You", engineId: null, engineKind: null, color: null, hashMb: null, limits: {}, timeControl: { baseMs: 300_000, incMs: 3000 } };
  const engine: PlayerMeta = {
    kind: "engine",
    name: "Classic",
    engineId: "eng-1",
    engineKind: "eval",
    color: "#5b9cf5",
    hashMb: 16,
    limits: { movetimeMs: 200 },
    timeControl: { baseMs: 300_000, incMs: 3000 },
  };

  it("formats PGN time controls", () => {
    expect(pgnTimeControl(null)).toBe("-");
    expect(pgnTimeControl({ baseMs: 300_000, incMs: 3000 })).toBe("300+3");
    expect(pgnTimeControl({ baseMs: 60_000, incMs: 0 })).toBe("60+0");
    expect(pgnTimeControl({ baseMs: 5_400_000, incMs: 30_000, movesPerControl: 40 })).toBe("40/5400+30");
  });

  it("builds a GameRecord with SAN, PGN, evals and times", () => {
    const moves = ["f2f3", "e7e5", "g2g4", "d8h4"];
    const end = endByRules(ChessGame.fromMoves("startpos", moves)!.outcome()!);
    const record = buildGameRecord({
      id: "g1",
      createdAt: Date.UTC(2026, 10, 2, 12),
      players: { w: human, b: engine },
      startFen: START_FEN,
      moves,
      opening: null,
      evals: [null, -20, null, -10_000],
      times: [1200.4, 300, 800, 250],
      end,
    });
    expect(record).toMatchObject({
      id: "g1",
      white: { type: "human", name: "You" },
      black: { type: "engine", engineId: "eng-1", name: "Classic" },
      startFen: START_FEN,
      moves,
      san: ["f3", "e5", "g4", "Qh4#"],
      result: "0-1",
      termination: "checkmate",
      matchId: null,
      timeControl: { white: human.timeControl, black: engine.timeControl },
      evals: [null, -20, null, -10_000],
      times: [1200, 300, 800, 250],
    });
    expect(record.pgn).toContain('[White "You"]');
    expect(record.pgn).toContain('[Black "Classic"]');
    expect(record.pgn).toContain('[Result "0-1"]');
    expect(record.pgn).toContain('[TimeControl "300+3"]');
    expect(record.pgn).toContain('[BlackType "program"]');
    expect(record.pgn).toContain("2. g4 Qh4# 0-1");
    // The PGN reads back to the same moves.
    expect(parsePgn(record.pgn)?.moves).toEqual(moves);
  });

  it("pads short eval / time lists and keeps FEN starts", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    const record = buildGameRecord({
      id: "g2",
      createdAt: 0,
      players: { w: engine, b: { ...engine, timeControl: null } },
      startFen: fen,
      moves: ["e2e4"],
      opening: null,
      evals: [],
      times: [],
      end: endByAbort(),
    });
    expect(record.startFen).toBe(fen);
    expect(record.evals).toEqual([null]);
    expect(record.times).toEqual([0]);
    expect(record.result).toBe("*");
    expect(record.pgn).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]');
    expect(record.pgn).toContain('[WhiteTimeControl "300+3"]');
    expect(record.pgn).toContain('[BlackTimeControl "-"]');
  });
});
