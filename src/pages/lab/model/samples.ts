// Standard positions used to show what a network "thinks" (sample evaluations on the run
// dashboard and the network page). A healthy network scores the balanced ones near 0 and the
// lopsided ones clearly in the right direction.

export interface SamplePosition {
  id: string;
  name: string;
  fen: string;
  /** What a sensible evaluation looks like (White's point of view). */
  expect: "equal" | "white" | "black";
}

export const SAMPLE_POSITIONS: readonly SamplePosition[] = [
  { id: "start", name: "Starting position", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", expect: "equal" },
  {
    id: "italian",
    name: "Italian Game",
    fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    expect: "equal",
  },
  { id: "knight-up", name: "White is a knight up", fen: "r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", expect: "white" },
  { id: "queen-down", name: "White is missing the queen", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", expect: "black" },
  { id: "rook-ending", name: "Rook against a lone king", fen: "8/8/8/4k3/8/8/8/R3K3 w - - 0 1", expect: "white" },
  { id: "pawn-ending", name: "King and pawn ending", fen: "8/8/4k3/8/8/4K3/4P3/8 w - - 0 1", expect: "white" },
];

export const SAMPLE_FENS: readonly string[] = SAMPLE_POSITIONS.map((p) => p.fen);

/**
 * Whether an evaluation (White POV, cp) points the way the position's `expect` says:
 * "equal" within ±150 cp, otherwise at least +/−50 cp in the right direction. null = unknown.
 */
export function evalAgrees(expect: SamplePosition["expect"], cp: number | null): boolean | null {
  if (cp === null || !Number.isFinite(cp)) return null;
  if (expect === "equal") return Math.abs(cp) <= 150;
  return expect === "white" ? cp >= 50 : cp <= -50;
}
