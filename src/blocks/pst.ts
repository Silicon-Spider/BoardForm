// Piece-square table values and presets. Pure data, no Blockly.
//
// Storage order everywhere (field values, generated StaticArrays) is LERF from White's point of
// view: index 0 = a1, 7 = h1, 8 = a2 … 63 = h8 (docs/ENGINE_TEMPLATE.md). Black uses the
// vertically mirrored entry (sq ^ 56), which `pst()` / `pstSum()` in evalkit.ts do for us.
// The tables below are written the way a board is printed (rank 8 first) and converted.

export const PST_SIZE = 64;
/** Values outside this range are clamped (centipawns). */
export const PST_MIN = -2000;
export const PST_MAX = 2000;

/** Converts 64 values written rank 8 first (as on a printed board) to LERF order. */
export function boardViewToLerf(rows8to1: readonly number[]): number[] {
  const out = new Array<number>(PST_SIZE).fill(0);
  for (let i = 0; i < PST_SIZE; i++) out[i ^ 56] = rows8to1[i] ?? 0;
  return out;
}

/** Converts LERF values to rank-8-first order (for display). */
export function lerfToBoardView(lerf: readonly number[]): number[] {
  return boardViewToLerf(lerf); // the mapping is its own inverse
}

/** Normalises anything into 64 clamped integers, or returns null when it is not a usable table. */
export function normalizePst(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== PST_SIZE) return null;
  const out = new Array<number>(PST_SIZE);
  for (let i = 0; i < PST_SIZE; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = Math.max(PST_MIN, Math.min(PST_MAX, Math.round(n)));
  }
  return out;
}

/** Chebyshev distance from the four central squares: 0 (d4/e4/d5/e5) … 3 (edge). */
function centerDistance(sq: number): number {
  const f = sq & 7;
  const r = sq >> 3;
  const df = Math.max(3 - f, f - 4);
  const dr = Math.max(3 - r, r - 4);
  return Math.max(df, dr);
}

function fromFn(fn: (sq: number) => number): number[] {
  return Array.from({ length: PST_SIZE }, (_, sq) => fn(sq));
}

// PeSTO tables by Ronald Friederich (Rofchade), as published on the Chess Programming Wiki
// ("PeSTO's Evaluation Function"). Written rank 8 first, White's point of view.
// prettier-ignore
const PESTO_BOARD_VIEW = {
  PAWN_MG: [
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
  ],
  PAWN_EG: [
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
  ],
  KNIGHT_MG: [
   -167, -89, -34, -49,  61, -97, -15,-107,
    -73, -41,  72,  36,  23,  62,   7, -17,
    -47,  60,  37,  65,  84, 129,  73,  44,
     -9,  17,  19,  53,  37,  69,  18,  22,
    -13,   4,  16,  13,  28,  19,  21,  -8,
    -23,  -9,  12,  10,  19,  17,  25, -16,
    -29, -53, -12,  -3,  -1,  18, -14, -19,
   -105, -21, -58, -33, -17, -28, -19, -23,
  ],
  KNIGHT_EG: [
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
  ],
  BISHOP_MG: [
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
  ],
  BISHOP_EG: [
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
  ],
  ROOK_MG: [
     32,  42,  32,  51,  63,   9,  31,  43,
     27,  32,  58,  62,  80,  67,  26,  44,
     -5,  19,  26,  36,  17,  45,  61,  16,
    -24, -11,   7,  26,  24,  35,  -8, -20,
    -36, -26, -12,  -1,   9,  -7,   6, -23,
    -45, -25, -16, -17,   3,   0,  -5, -33,
    -44, -16, -20,  -9,  -1,  11,  -6, -71,
    -19, -13,   1,  17,  16,   7, -37, -26,
  ],
  ROOK_EG: [
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
  ],
  QUEEN_MG: [
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
  ],
  QUEEN_EG: [
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
  ],
  KING_MG: [
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
  ],
  KING_EG: [
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
  ],
} as const;

export type PestoKey = keyof typeof PESTO_BOARD_VIEW;

/** PeSTO piece-square table in LERF order (key like "KNIGHT_MG"). */
export function pestoTable(key: PestoKey): number[] {
  return boardViewToLerf(PESTO_BOARD_VIEW[key]);
}

/** PeSTO's tuned material values (they belong together with the PeSTO tables). */
export const PESTO_MATERIAL = {
  mg: { P: 82, N: 337, B: 365, R: 477, Q: 1025 },
  eg: { P: 94, N: 281, B: 297, R: 512, Q: 936 },
} as const;

export interface PstPreset {
  id: string;
  label: string;
  group: "Shapes" | "PeSTO middlegame" | "PeSTO endgame";
  values: () => number[];
}

const PESTO_PIECES: [string, string][] = [
  ["PAWN", "Pawns"],
  ["KNIGHT", "Knights"],
  ["BISHOP", "Bishops"],
  ["ROOK", "Rooks"],
  ["QUEEN", "Queens"],
  ["KING", "King"],
];

export const PST_PRESETS: PstPreset[] = [
  { id: "ZERO", label: "All zero", group: "Shapes", values: () => new Array<number>(PST_SIZE).fill(0) },
  {
    id: "CENTER",
    label: "Centralization (+20 center … −10 edge)",
    group: "Shapes",
    values: () => fromFn((sq) => (3 - centerDistance(sq)) * 10 - 10),
  },
  {
    id: "ADVANCE",
    label: "Advancement (+10 per rank, 2nd = 0)",
    group: "Shapes",
    values: () => fromFn((sq) => {
      const r = sq >> 3;
      return r === 0 || r === 7 ? 0 : (r - 1) * 10;
    }),
  },
  {
    id: "EDGE",
    label: "Avoid the edges (−15 on the rim)",
    group: "Shapes",
    values: () => fromFn((sq) => (centerDistance(sq) === 3 ? -15 : 0)),
  },
  {
    id: "SHELTER",
    label: "King shelter (corners good, center bad)",
    group: "Shapes",
    values: () =>
      fromFn((sq) => {
        const f = sq & 7;
        const r = sq >> 3;
        if (r === 0) return f === 1 || f === 2 || f === 6 ? 25 : f === 3 || f === 4 || f === 5 ? -5 : 10;
        if (r === 1) return f >= 2 && f <= 5 ? -15 : 0;
        return -20 - Math.min(r - 2, 3) * 10;
      }),
  },
  ...PESTO_PIECES.map(([key, label]): PstPreset => ({
    id: `PESTO_${key}_MG`,
    label: `${label} (PeSTO middlegame)`,
    group: "PeSTO middlegame",
    values: () => pestoTable(`${key}_MG` as PestoKey),
  })),
  ...PESTO_PIECES.map(([key, label]): PstPreset => ({
    id: `PESTO_${key}_EG`,
    label: `${label} (PeSTO endgame)`,
    group: "PeSTO endgame",
    values: () => pestoTable(`${key}_EG` as PestoKey),
  })),
];

/** Values of a preset (unknown ids give the all-zero table). */
export function presetValues(id: string | undefined | null): number[] {
  const p = PST_PRESETS.find((x) => x.id === id);
  return p ? p.values() : new Array<number>(PST_SIZE).fill(0);
}

/** Copies the queenside (files a–d) onto the kingside, mirrored. */
export function mirrorLeftToRight(lerf: readonly number[]): number[] {
  const out = [...lerf];
  for (let sq = 0; sq < PST_SIZE; sq++) {
    const f = sq & 7;
    if (f >= 4) out[sq] = lerf[(sq & 56) | (7 - f)] ?? 0;
  }
  return out;
}

/** Averages each square with its left-right mirror image (rounding toward zero). */
export function symmetrize(lerf: readonly number[]): number[] {
  return lerf.map((v, sq) => Math.trunc((v + (lerf[sq ^ 7] ?? 0)) / 2));
}
