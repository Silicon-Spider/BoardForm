import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/utils/misc";
import { extractFeatures, extractPackedFeatures, featureIndex } from "./features";
import { FenError, NNUE_START_FEN, parseFenBoard } from "./fen";
import {
  PACKED_SIZE,
  decodePackedFeatures,
  packBoard,
  packPosition,
  packedToFen,
  setPackedResult,
  unpackPosition,
  validatePacked,
  type PackedResult,
} from "./pack";

/** FENs from random playouts (deterministic). */
function randomPlayoutFens(games: number, seed: number): string[] {
  const rnd = mulberry32(seed);
  const fens: string[] = [];
  for (let g = 0; g < games; g++) {
    const chess = new Chess();
    for (let ply = 0; ply < 160 && !chess.isGameOver(); ply++) {
      const moves = chess.moves();
      chess.move(moves[Math.floor(rnd() * moves.length)] as string);
      fens.push(chess.fen());
    }
  }
  return fens;
}

const TYPE_INDEX: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

/** Straightforward implementation of the feature formula on top of chess.js. */
function naiveFeatures(fen: string): { white: number[]; black: number[]; stm: 0 | 1 } {
  const chess = new Chess(fen);
  const white: number[] = [];
  const black: number[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const sq = (cell.square.charCodeAt(1) - 49) * 8 + (cell.square.charCodeAt(0) - 97);
      const type = TYPE_INDEX[cell.type] as number;
      white.push((cell.color === "w" ? 0 : 384) + type * 64 + sq);
      black.push((cell.color === "b" ? 0 : 384) + type * 64 + (sq ^ 56));
    }
  }
  return { white: white.sort((a, b) => a - b), black: black.sort((a, b) => a - b), stm: chess.turn() === "w" ? 0 : 1 };
}

const sorted = (a: ArrayLike<number>, n: number) => Array.from(a).slice(0, n).sort((x, y) => x - y);

const FENS = randomPlayoutFens(40, 2024);

describe("FEN parser", () => {
  it("parses the start position and 'startpos'", () => {
    const a = parseFenBoard(NNUE_START_FEN);
    const b = parseFenBoard("startpos");
    expect(a.pieces.length).toBe(32);
    expect(a.stm).toBe(0);
    expect(b).toEqual(a);
    expect(parseFenBoard("8/8/8/8/8/8/8/K6k b - - 0 1")).toEqual({ pieces: [{ sq: 0, piece: 5 }, { sq: 7, piece: 11 }], stm: 1 });
  });

  it("rejects malformed FENs", () => {
    for (const bad of ["", "8/8/8/8/8/8/8 w - - 0 1", "9/8/8/8/8/8/8/8 w", "8/8/8/8/8/8/8/7 w", "8/8/8/8/8/8/8/8x w", "8/8/8/8/8/8/8/8 x", "8/8/8/8/8/8/8/ppppppppp w"]) {
      expect(() => parseFenBoard(bad), bad).toThrow(FenError);
    }
  });
});

describe("features", () => {
  it(`match a naive chess.js implementation on ${FENS.length} playout positions`, () => {
    expect(FENS.length).toBeGreaterThan(2000);
    for (const fen of FENS) {
      const f = extractFeatures(fen);
      const n = naiveFeatures(fen);
      expect(sorted(f.white, f.count)).toEqual(n.white);
      expect(sorted(f.black, f.count)).toEqual(n.black);
      expect(f.stm).toBe(n.stm);
    }
  });

  it("follow the documented formula (own pieces first, Black's board flipped)", () => {
    // White pawn e2 (sq 12): White POV own pawn → 12; Black POV enemy pawn on flipped e7 → 384 + 52.
    expect(featureIndex(0, 0, 0, 12)).toBe(12);
    expect(featureIndex(1, 0, 0, 12)).toBe(384 + (12 ^ 56));
    // Black king e8 (sq 60): White POV enemy king → 384 + 5·64 + 60; Black POV own king on e1 → 5·64 + 4.
    expect(featureIndex(0, 1, 5, 60)).toBe(384 + 320 + 60);
    expect(featureIndex(1, 1, 5, 60)).toBe(320 + 4);
    const f = extractFeatures("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1");
    expect(sorted(f.white, f.count)).toEqual([12, 320 + 4, 384 + 320 + 60].sort((a, b) => a - b));
  });
});

describe("pack / unpack", () => {
  it(`round-trips ${FENS.length} playout positions`, () => {
    const rnd = mulberry32(5);
    const buf = new Uint8Array(FENS.length * PACKED_SIZE);
    const labels: Array<{ score: number; result: PackedResult }> = [];
    FENS.forEach((fen, i) => {
      const score = Math.round((rnd() - 0.5) * 4000) || 0; // avoid -0 labels
      const result = Math.floor(rnd() * 3) as PackedResult;
      labels.push({ score, result });
      const ret = packPosition(fen, score, result, buf, i * PACKED_SIZE);
      expect(ret).toBe(buf);
    });
    FENS.forEach((fen, i) => {
      const off = i * PACKED_SIZE;
      expect(validatePacked(buf, off)).toBeNull();
      const u = unpackPosition(buf, off);
      const board = parseFenBoard(fen);
      const expectedPieces = [...board.pieces].sort((a, b) => a.sq - b.sq);
      expect(u.pieces).toEqual(expectedPieces);
      let occ = 0n;
      for (const p of expectedPieces) occ |= 1n << BigInt(p.sq);
      expect(u.occupancy).toBe(occ);
      expect(u.score).toBe(labels[i]?.score);
      expect(u.result).toBe(labels[i]?.result);
      expect(u.stm).toBe(board.stm);
      // Board + side to move survive packedToFen (castling / ep are not stored).
      expect(packedToFen(buf, off).split(" ").slice(0, 2)).toEqual(fen.split(" ").slice(0, 2));
      // Reserved bytes are zero.
      expect([...buf.subarray(off + 28, off + 32)]).toEqual([0, 0, 0, 0]);
    });
  });

  it("feature extraction from packed bytes equals FEN extraction", () => {
    const buf = new Uint8Array(PACKED_SIZE);
    const w = new Int32Array(32);
    const b = new Int32Array(32);
    for (const fen of FENS) {
      packPosition(fen, 0, 1, buf, 0);
      const fromFen = extractFeatures(fen);
      const fromPacked = extractPackedFeatures(buf, 0);
      expect(fromPacked.count).toBe(fromFen.count);
      expect(fromPacked.stm).toBe(fromFen.stm);
      expect(sorted(fromPacked.white, fromPacked.count)).toEqual(sorted(fromFen.white, fromFen.count));
      expect(sorted(fromPacked.black, fromPacked.count)).toEqual(sorted(fromFen.black, fromFen.count));
      const n = decodePackedFeatures(buf, 0, w, b);
      expect(n).toBe(fromFen.count);
      expect(Array.from(w.subarray(0, n))).toEqual(Array.from(fromPacked.white.subarray(0, n)));
    }
  });

  it("uses the documented byte layout", () => {
    // White king a1 (sq 0, code 5), black king h8 (sq 63, code 11), white queen d1 (sq 3, code 4).
    const buf = packPosition("7k/8/8/8/8/8/8/K2Q4 b - - 0 1", -123, 0);
    expect([...buf.subarray(0, 8)]).toEqual([0b1001, 0, 0, 0, 0, 0, 0, 0x80]);
    // nibbles in ascending square order: a1 K(5), d1 Q(4), h8 k(11)
    expect(buf[8]).toBe(5 | (4 << 4));
    expect(buf[9]).toBe(11);
    expect(new DataView(buf.buffer).getInt16(24, true)).toBe(-123);
    expect(buf[26]).toBe(0);
    expect(buf[27]).toBe(1);
  });

  it("handles squares in the high occupancy half and the sign bit", () => {
    const buf = packPosition("k6K/8/8/8/8/8/8/7P w - - 0 1", 0, 1);
    const n = decodePackedFeatures(buf, 0, new Int32Array(32), new Int32Array(32));
    expect(n).toBe(3);
    const u = unpackPosition(buf, 0);
    expect(u.pieces.map((p) => p.sq)).toEqual([7, 56, 63]);
    const buf31 = packPosition("8/8/8/8/7P/8/8/8 w - - 0 1", 0, 1); // h4 = sq 31
    expect(unpackPosition(buf31).pieces).toEqual([{ sq: 31, piece: 0 }]);
  });

  it("clamps and rounds scores, validates inputs", () => {
    expect(unpackPosition(packPosition(NNUE_START_FEN, 99999, 2)).score).toBe(32000);
    expect(unpackPosition(packPosition(NNUE_START_FEN, -99999, 0)).score).toBe(-32000);
    expect(unpackPosition(packPosition(NNUE_START_FEN, 12.6, 1)).score).toBe(13);
    expect(() => packPosition(NNUE_START_FEN, NaN, 1)).toThrow(RangeError);
    expect(() => packPosition(NNUE_START_FEN, 0, 3 as PackedResult)).toThrow(RangeError);
    expect(() => packPosition(NNUE_START_FEN, 0, 1, new Uint8Array(40), 10)).toThrow(RangeError);
    expect(() => packPosition("pppppppp/pppppppp/pppppppp/pppppppp/pppppppp/8/8/8 w - - 0 1", 0, 1)).toThrow(/more than 32/);
    expect(() => packBoard([{ sq: 3, piece: 0 }, { sq: 3, piece: 1 }], 0, 0, 1)).toThrow(/two pieces/);
  });

  it("setPackedResult patches only the result byte", () => {
    const buf = packPosition(NNUE_START_FEN, 42, 1);
    const before = buf.slice();
    setPackedResult(buf, 0, 2);
    expect(buf[26]).toBe(2);
    buf[26] = before[26] as number;
    expect(buf).toEqual(before);
  });

  it("detects corrupt records", () => {
    const buf = packPosition(NNUE_START_FEN, 0, 1);
    const bad = buf.slice();
    bad[8] = 0xff; // piece code 15
    expect(validatePacked(bad, 0)).toMatch(/piece code/);
    expect(() => unpackPosition(bad, 0)).toThrow(RangeError);
    const bad2 = buf.slice();
    bad2[26] = 3;
    expect(validatePacked(bad2, 0)).toMatch(/result/);
    const bad3 = buf.slice();
    bad3[27] = 2;
    expect(validatePacked(bad3, 0)).toMatch(/side to move/);
    const bad4 = buf.slice();
    bad4.fill(0xff, 0, 8); // 64 pieces
    expect(validatePacked(bad4, 0)).toMatch(/64 pieces/);
  });
});
