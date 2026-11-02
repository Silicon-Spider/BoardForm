// Test positions used by the Workshop's test bench: board presets, the perft reference suite
// ("Check move generation") and the bench positions. Pure data, no React.
import { START_FEN } from "@/chess";

export interface PresetPosition {
  id: string;
  name: string;
  fen: string;
  /** One-line hint shown in the preset menu. */
  hint: string;
}

/** Positions offered by the "Presets" menu above the test board. */
export const PRESET_POSITIONS: readonly PresetPosition[] = [
  { id: "start", name: "Start position", fen: START_FEN, hint: "The initial position" },
  {
    id: "middlegame",
    name: "Middlegame",
    fen: "r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 8",
    hint: "Queen's Gambit, both sides castled",
  },
  { id: "endgame", name: "Rook endgame", fen: "8/5pk1/6p1/8/3R4/6P1/5PK1/1r6 w - - 0 40", hint: "Rook and pawns each" },
  {
    id: "kiwipete",
    name: "Kiwipete",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    hint: "Tricky perft position: castling, pins, en passant",
  },
  // A forcing mate (1. Qg8+ Rxg8 2. Nf7#, smothered). Quiet zugzwang mates are a poor test here:
  // null-move pruning, which most engines use, can hide them.
  { id: "mate2", name: "Mate in 2", fen: "r6k/6pp/7N/8/2Q5/8/8/6K1 w - - 0 1", hint: "White to play and mate in two" },
];

export interface PerftCase {
  id: string;
  name: string;
  fen: string;
  /** counts[d - 1] = number of leaf nodes at depth d. */
  counts: readonly number[];
}

/**
 * Perft reference results (chessprogramming.org "Perft Results": the initial position, Kiwipete
 * and positions 3–6). A correct legal move generator reproduces every number exactly.
 */
export const PERFT_SUITE: readonly PerftCase[] = [
  { id: "startpos", name: "Start position", fen: START_FEN, counts: [20, 400, 8_902, 197_281, 4_865_609, 119_060_324] },
  {
    id: "kiwipete",
    name: "Kiwipete",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    counts: [48, 2_039, 97_862, 4_085_603, 193_690_690],
  },
  { id: "pos3", name: "Position 3", fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", counts: [14, 191, 2_812, 43_238, 674_624, 11_030_083] },
  {
    id: "pos4",
    name: "Position 4",
    fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    counts: [6, 264, 9_467, 422_333, 15_833_292],
  },
  {
    id: "pos5",
    name: "Position 5",
    fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    counts: [44, 1_486, 62_379, 2_103_487, 89_941_194],
  },
  {
    id: "pos6",
    name: "Position 6",
    fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    counts: [46, 2_079, 89_890, 3_894_594, 164_075_551],
  },
];

/** Depths the move-generation check offers ("up to depth N"). */
export const CHECK_DEPTHS = [2, 3, 4, 5] as const;

/** Total leaf nodes the check visits for "up to depth N" (a rough cost estimate for the UI). */
export function perftSuiteNodes(maxDepth: number): number {
  let total = 0;
  for (const c of PERFT_SUITE) for (let d = 1; d <= Math.min(maxDepth, c.counts.length); d++) total += c.counts[d - 1];
  return total;
}

/** Expected count, or null when the table has no reference for that depth. */
export function expectedPerft(c: PerftCase, depth: number): number | null {
  return depth >= 1 && depth <= c.counts.length ? c.counts[depth - 1] : null;
}

export interface BenchPosition {
  name: string;
  fen: string;
}

/** Fixed positions for the bench (a fixed-depth search over each, from a fresh game). */
export const BENCH_POSITIONS: readonly BenchPosition[] = [
  { name: "Start position", fen: START_FEN },
  { name: "Italian Game", fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4" },
  { name: "Queen's Gambit", fen: "r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 8" },
  { name: "Kiwipete", fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1" },
  { name: "Position 6", fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10" },
  { name: "Rook endgame", fen: "8/5pk1/6p1/8/3R4/6P1/5PK1/1r6 w - - 0 40" },
];

export const BENCH_DEPTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const PERFT_DEPTHS = [1, 2, 3, 4, 5, 6, 7] as const;
