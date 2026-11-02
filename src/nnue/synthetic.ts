// Synthetic training data: random piece placements labelled with their material balance.
// Used by the tests and benchmarks, and handy as a quick smoke test of the trainer ("can the
// network learn material?") without generating self-play games first.
import { mulberry32 } from "@/utils/misc";
import type { BoardPiece } from "./fen";
import { PACKED_SIZE, packBoard, type PackedResult } from "./pack";

/** Centipawn values P, N, B, R, Q, K used for the labels. */
export const SYNTHETIC_PIECE_VALUES: readonly number[] = [100, 300, 320, 500, 900, 0];

/** Material balance (cp, White POV) of a piece list. */
export function materialBalance(pieces: readonly BoardPiece[]): number {
  let s = 0;
  for (const p of pieces) {
    const color = p.piece >= 6 ? 1 : 0;
    const v = SYNTHETIC_PIECE_VALUES[p.piece - 6 * color] ?? 0;
    s += color === 0 ? v : -v;
  }
  return s;
}

/**
 * A random (not necessarily legal) position: both kings plus random material for each side
 * (≤ 8 pawns on ranks 2–7, ≤ 2 minor pieces of each kind, ≤ 2 rooks, ≤ 1 queen) on distinct
 * squares, and a random side to move.
 */
export function randomPosition(rnd: () => number): { pieces: BoardPiece[]; stm: 0 | 1 } {
  const used = new Uint8Array(64);
  const pieces: BoardPiece[] = [];
  const place = (piece: number, lo: number, hi: number) => {
    for (let tries = 0; tries < 200; tries++) {
      const sq = lo + Math.floor(rnd() * (hi - lo + 1));
      if (used[sq] === 0) {
        used[sq] = 1;
        pieces.push({ sq, piece });
        return;
      }
    }
  };
  const maxCount = [8, 2, 2, 2, 1];
  for (let color = 0; color < 2; color++) {
    place(color * 6 + 5, 0, 63); // king
    for (let type = 0; type < 5; type++) {
      const n = Math.floor(rnd() * ((maxCount[type] as number) + 1));
      for (let i = 0; i < n; i++) {
        if (type === 0) place(color * 6, 8, 55); // pawns never on the back ranks
        else place(color * 6 + type, 0, 63);
      }
    }
  }
  return { pieces, stm: rnd() < 0.5 ? 0 : 1 };
}

/** Result label from the material balance: ±200 cp or more counts as a win. */
export function materialResult(balance: number): PackedResult {
  return balance >= 200 ? 2 : balance <= -200 ? 0 : 1;
}

/**
 * `count` packed positions labelled with their material balance (score, White POV) and the
 * matching result. Deterministic for a given seed.
 */
export function makeMaterialDataset(count: number, seed: number): Uint8Array<ArrayBuffer> {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(count * PACKED_SIZE);
  for (let i = 0; i < count; i++) {
    const { pieces, stm } = randomPosition(rnd);
    const bal = materialBalance(pieces);
    packBoard(pieces, stm, bal, materialResult(bal), out, i * PACKED_SIZE);
  }
  return out;
}
