// Deterministic random openings for self-play diversity.
import { mulberry32 } from "@/utils/misc";
import { ChessGame } from "./game";

/**
 * `n` random legal plies from `startFen` (default: standard start) that never end the game:
 * after every ply the position is neither mate, stalemate nor a rules draw. The same
 * (n, seed, startFen) always gives the same moves. Uses a bounded depth-first search with
 * backtracking; if no such line exists it returns the longest prefix found.
 */
export function randomPlies(n: number, seed: number, startFen?: string): string[] {
  const target = Math.max(0, Math.floor(n));
  const game = new ChessGame(startFen ?? "startpos");
  if (target === 0 || game.isGameOver()) return [];
  const rand = mulberry32(seed);
  const path: string[] = [];
  let best: string[] = [];
  let budget = 20000; // tried moves; protects against pathological positions

  const search = (): boolean => {
    if (path.length === target) return true;
    const moves = game.legalMoves();
    for (let i = moves.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [moves[i], moves[j]] = [moves[j], moves[i]];
    }
    for (const move of moves) {
      if (--budget < 0) return false;
      game.play(move);
      if (!game.isGameOver()) {
        path.push(move);
        if (path.length > best.length) best = path.slice();
        if (search()) return true;
        path.pop();
      }
      game.undo();
      if (budget < 0) return false;
    }
    return false;
  };

  return search() ? path.slice() : best;
}
