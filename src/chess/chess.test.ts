import { describe, expect, it } from "vitest";
import {
  ChessGame,
  OPENINGS,
  START_FEN,
  mirrorFen,
  normalizeFen,
  parseFenBoard,
  parsePgn,
  pickOpenings,
  randomPlies,
  sanToUci,
  uciLineToSan,
  uciToSan,
  validateFen,
  enPassantCandidates,
} from "@/chess";

function playAll(game: ChessGame, moves: string[]): void {
  for (const m of moves) {
    const r = game.play(m);
    if (!r) throw new Error(`illegal move ${m} in ${game.fen()}`);
  }
}

describe("FEN helpers", () => {
  it("normalizes startpos and short FENs", () => {
    expect(normalizeFen("startpos")).toBe(START_FEN);
    expect(normalizeFen("  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR   w KQkq - ")).toBe(START_FEN);
    expect(normalizeFen("8/8/8/8/8/8/8/K6k")).toBe("8/8/8/8/8/8/8/K6k w - - 0 1");
  });

  it("parses the board tolerantly", () => {
    const b = parseFenBoard(START_FEN);
    expect(b.filter(Boolean)).toHaveLength(32);
    expect(b[4]).toBe("wK"); // e1
    expect(b[60]).toBe("bK"); // e8
    expect(parseFenBoard("zzz").filter(Boolean)).toHaveLength(0);
    expect(() => parseFenBoard("9/x/K7K7K/////////// w")).not.toThrow();
  });

  it("validates FENs with friendly errors", () => {
    expect(validateFen(START_FEN)).toEqual({ ok: true });
    expect(validateFen("startpos").ok).toBe(true);
    expect(validateFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -").ok).toBe(true);
    const noKing = validateFen("8/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(noKing.ok).toBe(false);
    expect(noKing.error).toMatch(/black king/i);
    // Black (to move) gives check to the white king: illegal.
    const wrongCheck = validateFen("4k3/4r3/8/8/8/8/8/4K3 b - - 0 1");
    expect(wrongCheck.ok).toBe(false);
    expect(wrongCheck.error).toMatch(/White is in check/);
    // Side to move in check is fine.
    expect(validateFen("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1").ok).toBe(true);
    expect(validateFen("4k3/8/8/8/8/8/8/4K3 w K - 0 1").error).toMatch(/castling/i);
    expect(validateFen("4k3/8/8/8/8/8/8/4K3 w - e6 0 1").error).toMatch(/en-passant/i);
    expect(validateFen("4k2P/8/8/8/8/8/8/4K3 w - - 0 1").ok).toBe(false);
    expect(validateFen("4k3/8/8/8/8/8/8/4K3 w K- - 0 1").ok).toBe(false);
  });

  it("explains each kind of invalid FEN accurately", () => {
    const err = (fen: string) => {
      const r = validateFen(fen);
      expect(r.ok, fen).toBe(false);
      return r.error ?? "";
    };
    // Field count and the piece placement field.
    expect(err("not a fen")).toBe('The board needs 8 ranks separated by "/" — this one has 1');
    expect(err("8/8/8/8")).toMatch(/needs 8 ranks .* has 4/);
    expect(err("rnbqkbnr/pppppppp/8/8/8/7/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe("Rank 3 has 7 squares — it needs 8");
    expect(err("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRR w KQkq - 0 1")).toBe("Rank 1 has 9 squares — it needs 8");
    expect(err("rnbqkbnr/ppppxppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toMatch(/^Unknown piece letter "x" in rank 7/);
    expect(err("rnbqkbnr/pppppppp/44/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toMatch(/^Rank 6 has two numbers in a row \("44"\)/);
    expect(err("rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toMatch(/^Rank 6 has "9"/);
    expect(err("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 extra")).toMatch(/^This has 7 fields .* a FEN has 6/);
    // Kings and pawns.
    expect(err("8/8/8/8/8/8/8/4K3 w - - 0 1")).toBe("There is no black king — each side needs exactly one");
    expect(err("4k3/8/8/8/8/8/8/8 w - - 0 1")).toMatch(/^There is no white king/);
    expect(err("4k3/8/8/8/8/8/8/2K1K3 w - - 0 1")).toMatch(/^There are 2 white kings/);
    expect(err("4k2P/8/8/8/8/8/8/4K3 w - - 0 1")).toBe("There is a white pawn on h8 — pawns can't stand on the 1st or 8th rank");
    expect(err("4k3/8/8/8/8/8/8/p3K3 w - - 0 1")).toMatch(/black pawn on a1/);
    // Side to move.
    expect(err("4k3/8/8/8/8/8/8/4K3 x - - 0 1")).toBe('The side to move (2nd field) must be "w" or "b", not "x"');
    // Castling.
    expect(err("4k3/8/8/8/8/8/8/4K3 w K- - 0 1")).toMatch(/^Castling rights \(3rd field\) must be "-" or letters from KQkq, not "K-"/);
    expect(err("r3k2r/8/8/8/8/8/8/R3K2R w KKq - 0 1")).toBe('Castling right "K" appears twice');
    expect(err("4k3/8/8/8/8/8/8/4K3 w K - 0 1")).toBe('Castling right "K" needs the white king on e1 and a rook on h1');
    // En passant.
    expect(err("4k3/8/8/8/8/8/8/4K3 w - e9 0 1")).toMatch(/^The en-passant square \(4th field\) must be "-" or a square/);
    expect(err("4k3/8/8/8/4P3/8/8/4K3 w - e3 0 1")).toMatch(/^With White to move, the en-passant square must be on the 6th rank/);
    expect(err("4k3/8/8/8/8/8/8/4K3 w - e6 0 1")).toBe("En-passant square e6 needs a black pawn on e5 that just moved two squares");
    expect(validateFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1").ok).toBe(true);
    // Move counters.
    expect(err("4k3/8/8/8/8/8/8/4K3 w - - x 1")).toMatch(/^The half-move clock \(5th field\) must be a whole number/);
    expect(err("4k3/8/8/8/8/8/8/4K3 w - - 1.5 1")).toMatch(/half-move clock/);
    expect(err("4k3/8/8/8/8/8/8/4K3 w - - 0 0")).toMatch(/^The move number \(6th field\) must be a whole number, 1 or more, not "0"/);
    expect(err("4k3/8/8/8/8/8/8/4K3 w - - 0 -3")).toMatch(/move number/);
    // Positions that can't arise.
    expect(err("8/8/8/8/8/8/4k3/4K3 w - - 0 1")).toBe("The kings can't stand next to each other (e1 and e2)");
    expect(err("4k3/4R3/8/8/8/8/8/4K3 w - - 0 1")).toMatch(/^Black is in check but it is White's turn/);
    // Very long junk is shortened in messages.
    expect(err(`4k3/8/8/8/8/8/8/4K3 ${"y".repeat(100)} - - 0 1`).length).toBeLessThan(100);
  });

  it("finds en-passant candidates", () => {
    const fen = "rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
    expect(enPassantCandidates(parseFenBoard(fen), "w")).toEqual(["d6"]);
  });
});

describe("ChessGame", () => {
  it("tracks plies, move numbers, history and FENs", () => {
    const g = new ChessGame();
    expect(g.startFen).toBe(START_FEN);
    expect(g.ply()).toBe(0);
    expect(g.turn()).toBe("w");
    expect(g.play("e2e4")).toEqual({ uci: "e2e4", san: "e4" });
    expect(g.play({ from: "e7", to: "e5" })).toEqual({ uci: "e7e5", san: "e5" });
    expect(g.play("Nf3")).toEqual({ uci: "g1f3", san: "Nf3" });
    expect(g.ply()).toBe(3);
    expect(g.moveNumber()).toBe(2);
    expect(g.turn()).toBe("b");
    expect(g.history()).toEqual({ uci: ["e2e4", "e7e5", "g1f3"], san: ["e4", "e5", "Nf3"] });
    expect(g.lastMove()).toEqual({ from: "g1", to: "f3" });
    expect(g.fenAt(0)).toBe(START_FEN);
    expect(g.fenAt(1)).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    expect(g.fenAt(99)).toBe(g.fen());
    expect(g.undo()).toEqual({ uci: "g1f3", san: "Nf3" });
    expect(g.fen()).toBe(g.fenAt(2));
    expect(g.ply()).toBe(2);
  });

  it("rejects illegal and malformed moves without changing state", () => {
    const g = new ChessGame();
    const before = g.fen();
    expect(g.play("e2e5")).toBeNull();
    expect(g.play("e2e4q")).toBeNull(); // promotion suffix on a non-promotion
    expect(g.play("--")).toBeNull(); // null move
    expect(g.play("Qh5")).toBeNull();
    expect(g.play({ from: "z9", to: "e4" })).toBeNull();
    expect(g.fen()).toBe(before);
    expect(g.isLegal("e2e4")).toBe(true);
    expect(g.isLegal("Nf3")).toBe(true);
    expect(g.isLegal("e2e5")).toBe(false);
    expect(() => new ChessGame("not a fen")).toThrow(/Invalid FEN/);
  });

  it("lists legal moves and destinations", () => {
    const g = new ChessGame();
    expect(g.legalMoves()).toHaveLength(20);
    const map = g.legalMovesMap();
    expect(map.size).toBe(10);
    expect([...(map.get("g1") ?? [])].sort()).toEqual(["f3", "h3"]);
    // Promotions collapse to a single destination.
    const p = new ChessGame("8/4P3/8/8/8/8/k7/4K3 w - - 0 1");
    expect(p.legalMoves().filter((m) => m.startsWith("e7e8"))).toHaveLength(4);
    expect(p.legalMovesMap().get("e7")).toEqual(["e8"]);
  });

  it("converts castling, promotion and en passant between UCI and SAN", () => {
    const castle = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(uciToSan(castle, "e1g1")).toBe("O-O");
    expect(uciToSan(castle, "e1c1")).toBe("O-O-O");
    expect(uciToSan(castle.replace(" w ", " b "), "e8g8")).toBe("O-O");
    expect(sanToUci(castle, "O-O")).toBe("e1g1");
    expect(sanToUci(castle, "0-0-0")).toBe("e1c1");
    // King-takes-own-rook castling notation is accepted and normalised.
    const g = new ChessGame(castle);
    expect(g.play("e1h1")).toEqual({ uci: "e1g1", san: "O-O" });

    const promo = "3r4/4P3/8/8/8/8/k7/4K3 w - - 0 1";
    expect(uciToSan(promo, "e7e8q")).toBe("e8=Q");
    expect(uciToSan(promo, "e7e8n")).toBe("e8=N");
    expect(uciToSan(promo, "e7d8q")).toBe("exd8=Q");
    expect(uciToSan(promo, "e7e8")).toBeNull();
    expect(sanToUci(promo, "e8=Q")).toBe("e7e8q");
    expect(sanToUci(promo, "exd8=R")).toBe("e7d8r");
    expect(new ChessGame(promo).play({ from: "e7", to: "e8", promotion: "q" })?.uci).toBe("e7e8q");

    const ep = new ChessGame();
    playAll(ep, ["e2e4", "c7c5", "e4e5", "d7d5"]);
    expect(ep.fen().split(" ")[3]).toBe("d6");
    expect(uciToSan(ep.fen(), "e5d6")).toBe("exd6");
    expect(sanToUci(ep.fen(), "exd6")).toBe("e5d6");
    ep.play("e5d6");
    expect(ep.pieceAt("d5")).toBeNull();
    expect(ep.pieceAt("d6")).toBe("wP");

    expect(uciToSan(START_FEN, "e2e5")).toBeNull();
    expect(uciToSan("bad fen", "e2e4")).toBeNull();
    expect(sanToUci(START_FEN, "Ke2")).toBeNull();
    expect(uciLineToSan(START_FEN, ["e2e4", "e7e5", "g1f3", "zzzz", "b8c6"])).toEqual(["e4", "e5", "Nf3"]);
  });

  it("detects checkmate", () => {
    const g = new ChessGame();
    playAll(g, ["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(g.inCheck()).toBe(true);
    expect(g.checkSquare()).toBe("e1");
    expect(g.outcome()).toEqual({ result: "0-1", termination: "checkmate" });
    expect(g.isGameOver()).toBe(true);
    expect(g.history().san[3]).toBe("Qh4#");
  });

  it("detects stalemate", () => {
    const g = new ChessGame("7k/8/6K1/5Q2/8/8/8/8 w - - 0 1");
    expect(g.outcome()).toBeNull();
    g.play("f5f7");
    expect(g.outcome()).toEqual({ result: "1/2-1/2", termination: "stalemate" });
  });

  it("detects threefold repetition (also in clones)", () => {
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    const g = new ChessGame();
    playAll(g, shuffle);
    expect(g.outcome()).toBeNull();
    playAll(g, shuffle.slice(0, 3));
    const c = g.clone();
    c.play("f6g8");
    expect(c.outcome()).toEqual({ result: "1/2-1/2", termination: "threefold" });
    expect(g.outcome()).toBeNull(); // original untouched
    g.play("f6g8");
    expect(g.outcome()?.termination).toBe("threefold");
  });

  it("detects the fifty-move rule", () => {
    const g = new ChessGame("8/8/8/4k3/8/8/4K3/4R3 w - - 99 80");
    expect(g.outcome()).toBeNull();
    g.play("e1a1");
    expect(g.outcome()).toEqual({ result: "1/2-1/2", termination: "fifty-move" });
  });

  it("detects insufficient material", () => {
    expect(new ChessGame("8/8/8/4k3/8/8/4K3/4B3 w - - 0 1").outcome()?.termination).toBe("insufficient-material");
    const g = new ChessGame("8/8/8/4k3/8/3n4/4K3/8 w - - 0 1");
    expect(g.outcome()?.termination).toBe("insufficient-material");
    const g2 = new ChessGame("8/8/8/4k3/8/3r4/4K3/8 w - - 0 1");
    expect(g2.outcome()).toBeNull();
    g2.play("e2d3");
    expect(g2.outcome()).toEqual({ result: "1/2-1/2", termination: "insufficient-material" });
  });

  it("applies outcome precedence", () => {
    // Mate with the fifty-move counter expired: checkmate wins.
    expect(new ChessGame("R5k1/5ppp/8/8/8/8/8/6K1 b - - 100 60").outcome()).toEqual({
      result: "1-0",
      termination: "checkmate",
    });
    // Stalemate with only a bishop left: stalemate before insufficient material.
    expect(new ChessGame("7k/5B2/6K1/8/8/8/8/8 b - - 0 1").outcome()?.termination).toBe("stalemate");
  });

  it("writes PGN that parses back", () => {
    const g = new ChessGame();
    playAll(g, ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]);
    const pgn = g.pgn({ White: 'The "Engine"', Black: "Human", Date: "2026.11.01", Event: "Test" });
    expect(pgn).toContain('[White "The \\"Engine\\""]');
    expect(pgn).toContain('[Result "*"]');
    expect(pgn).toMatch(/1\. e4 e5 2\. Nf3 Nc6 3\. Bb5 a6 \*/);
    const parsed = parsePgn(pgn);
    expect(parsed?.moves).toEqual(g.history().uci);
    expect(parsed?.headers.White).toBe('The "Engine"');
    expect(parsed?.startFen).toBe(START_FEN);

    const fromFen = new ChessGame("4k3/8/8/8/8/8/4P3/4K3 b - - 0 7");
    playAll(fromFen, ["e8d7", "e2e4"]);
    const pgn2 = fromFen.pgn({}, "1/2-1/2");
    expect(pgn2).toContain('[SetUp "1"]');
    expect(pgn2).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 7"]');
    expect(pgn2).toMatch(/7\.\.\. Kd7 8\. e4 1\/2-1\/2/);
    expect(parsePgn(pgn2)?.moves).toEqual(["e8d7", "e2e4"]);
  });

  it("builds games from move lists", () => {
    expect(ChessGame.fromMoves("startpos", ["e2e4", "e7e5"])?.ply()).toBe(2);
    expect(ChessGame.fromMoves("startpos", ["e2e4", "e2e4"])).toBeNull();
    expect(ChessGame.fromMoves("nonsense", [])).toBeNull();
    const g = ChessGame.fromMoves("startpos", ["e2e4", "e7e5", "g1f3"])!;
    g.truncate(1);
    expect(g.history().uci).toEqual(["e2e4"]);
  });
});

describe("parsePgn", () => {
  it("ignores comments, variations, NAGs, glyphs and move numbers", () => {
    const pgn = `[Event "Test"]
[Site "?"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 {best by test} e5 2. Nf3 (2. f4 exf4 (2... d5 3. exd5)) 2... Nc6 $1 3.Bb5!? a6 ; a comment
4. Ba4 Nf6?! 5. 0-0 1-0`;
    const r = parsePgn(pgn);
    expect(r).not.toBeNull();
    expect(r!.headers).toMatchObject({ Event: "Test", White: "A", Black: "B", Result: "1-0" });
    expect(r!.startFen).toBe(START_FEN);
    expect(r!.moves).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1"]);
  });

  it("honours FEN/SetUp tags and black-to-move starts", () => {
    const r = parsePgn(`[SetUp "1"]
[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 1"]

1... Kd7 2. e4 Ke6 3. e5 *`);
    expect(r?.startFen).toBe("4k3/8/8/8/8/8/4P3/4K3 b - - 0 1");
    expect(r?.moves).toEqual(["e8d7", "e2e4", "d7e6", "e4e5"]);
  });

  it("reads movetext without headers and stops at the next game", () => {
    const r = parsePgn("1.d4 d5 2.c4 e6 1/2-1/2\n\n[Event \"Next\"]\n\n1. e4 *");
    expect(r?.moves).toEqual(["d2d4", "d7d5", "c2c4", "e7e6"]);
    expect(r?.headers).toEqual({});
  });

  it("returns null for illegal moves, bad FENs and empty input", () => {
    expect(parsePgn("1. e4 e4 *")).toBeNull();
    expect(parsePgn('[FEN "nonsense"]\n\n1. e4 *')).toBeNull();
    expect(parsePgn("   ")).toBeNull();
    expect(parsePgn("1. e4 -- 2. d4 *")).toBeNull();
  });
});

describe("mirrorFen", () => {
  it("mirrors start, en-passant and castling fields", () => {
    expect(mirrorFen(START_FEN)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1");
    expect(mirrorFen("rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3")).toBe(
      "rnbqkbnr/pppp1ppp/8/8/2PPp3/8/PP2PPPP/RNBQKBNR b KQkq d3 0 3",
    );
    expect(mirrorFen("r3k3/8/8/8/8/8/8/4K2R w Kq - 0 1")).toBe("4k2r/8/8/8/8/8/8/R3K3 b Qk - 0 1");
  });

  it("is an involution and preserves legal moves", () => {
    const flip = (uci: string) =>
      uci[0] + String(9 - Number(uci[1])) + uci[2] + String(9 - Number(uci[3])) + uci.slice(4);
    for (let seed = 1; seed <= 40; seed++) {
      const moves = randomPlies(1 + (seed % 23), seed * 7919);
      const g = ChessGame.fromMoves("startpos", moves)!;
      const fen = g.fen();
      const m = mirrorFen(fen);
      expect(mirrorFen(m)).toBe(fen);
      expect(validateFen(m).ok).toBe(true);
      const mg = new ChessGame(m);
      expect(mg.legalMoves().length).toBe(g.legalMoves().length);
      expect(new Set(mg.legalMoves())).toEqual(new Set(g.legalMoves().map(flip)));
      expect(mg.inCheck()).toBe(g.inCheck());
    }
  });
});

describe("openings", () => {
  it("has at least 50 legal, well-formed lines", () => {
    expect(OPENINGS.length).toBeGreaterThanOrEqual(50);
    const names = new Set<string>();
    for (const o of OPENINGS) {
      expect(o.eco).toMatch(/^[A-E]\d\d$/);
      expect(o.moves.length).toBeGreaterThanOrEqual(6);
      expect(o.moves.length).toBeLessThanOrEqual(12);
      expect(names.has(o.name)).toBe(false);
      names.add(o.name);
      const g = ChessGame.fromMoves("startpos", o.moves);
      expect(g, `${o.name} must be legal`).not.toBeNull();
      expect(g!.isGameOver()).toBe(false);
      for (const m of o.moves) expect(m).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    }
  });

  it("picks deterministically and cycles", () => {
    const a = pickOpenings(10, 42).map((o) => o.name);
    const b = pickOpenings(10, 42).map((o) => o.name);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(10);
    expect(pickOpenings(10, 43).map((o) => o.name)).not.toEqual(a);
    const many = pickOpenings(OPENINGS.length * 2 + 3, 7);
    expect(many).toHaveLength(OPENINGS.length * 2 + 3);
    expect(new Set(many.slice(0, OPENINGS.length).map((o) => o.name)).size).toBe(OPENINGS.length);
    for (let i = 0; i < OPENINGS.length + 3; i++) expect(many[i + OPENINGS.length].name).toBe(many[i].name);
    expect(pickOpenings(0, 1)).toEqual([]);
  });
});

describe("randomPlies", () => {
  it("returns legal, deterministic lines that never end the game", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const line = randomPlies(10, seed);
      expect(line).toHaveLength(10);
      expect(randomPlies(10, seed)).toEqual(line);
      seen.add(line.join(" "));
      const g = new ChessGame();
      for (const m of line) {
        expect(g.play(m)).not.toBeNull();
        expect(g.isGameOver()).toBe(false);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(randomPlies(0, 1)).toEqual([]);
  });

  it("avoids game-ending moves from a custom start", () => {
    // Many white moves stalemate or mate here; none may be chosen.
    const start = "7k/8/6K1/5Q2/8/8/8/8 w - - 0 1";
    for (let seed = 1; seed <= 15; seed++) {
      const line = randomPlies(6, seed, start);
      expect(line).toHaveLength(6);
      const g = new ChessGame(start);
      for (const m of line) {
        expect(g.play(m)).not.toBeNull();
        expect(g.isGameOver()).toBe(false);
      }
    }
  });
});
