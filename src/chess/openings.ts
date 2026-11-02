// Opening book for engine matches and self-play: well-known, roughly balanced main lines
// (6-12 plies, UCI). Every line is checked for legality in chess.test.ts.
import { mulberry32 } from "@/utils/misc";

export interface Opening {
  name: string;
  /** ECO code, e.g. "C84". */
  eco: string;
  /** Moves from the standard start position, UCI. */
  moves: string[];
}

// [name, ECO, space-separated UCI moves]
const BOOK: ReadonlyArray<[string, string, string]> = [
  ["Ruy Lopez: Closed", "C84", "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7"],
  ["Ruy Lopez: Open", "C80", "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f6e4"],
  ["Ruy Lopez: Berlin Defence, 4.d3", "C65", "e2e4 e7e5 g1f3 b8c6 f1b5 g8f6 d2d3 f8c5"],
  ["Ruy Lopez: Exchange Variation, Gligoric", "C69", "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5c6 d7c6 e1g1 f7f6"],
  ["Italian Game: Giuoco Piano", "C53", "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6"],
  ["Italian Game: Two Knights, Modern Bishop's Opening", "C55", "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8e7 e1g1 e8g8"],
  ["Scotch Game: Classical Variation", "C45", "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 f8c5 d4b3 c5b6"],
  ["Scotch Game: Four Knights", "C47", "e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 d2d4 e5d4 f3d4 f8b4 d4c6 b7c6"],
  ["Four Knights Game: Spanish, Symmetrical", "C49", "e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1 e8g8"],
  ["Petrov's Defence: Classical Attack", "C42", "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5"],
  ["Philidor Defence: Lion Variation", "C41", "e2e4 e7e5 g1f3 d7d6 d2d4 g8f6 b1c3 b8d7 f1c4 f8e7"],
  ["Vienna Game: Mieses Variation", "C26", "e2e4 e7e5 b1c3 g8f6 g2g3 d7d5 e4d5 f6d5 f1g2 d5c3 b2c3 f8d6"],
  ["Bishop's Opening: Berlin Defence", "C24", "e2e4 e7e5 f1c4 g8f6 d2d3 c7c6 g1f3 d7d5 c4b3 f8d6"],
  ["King's Gambit Declined: Classical", "C30", "e2e4 e7e5 f2f4 f8c5 g1f3 d7d6 c2c3 g8f6"],
  ["Sicilian Defence: Najdorf Variation", "B90", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6"],
  ["Sicilian Defence: Dragon Variation", "B70", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6"],
  ["Sicilian Defence: Scheveningen Variation", "B80", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e6"],
  ["Sicilian Defence: Classical Variation", "B56", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 b8c6"],
  ["Sicilian Defence: Sveshnikov Variation", "B33", "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5 d4b5 d7d6"],
  ["Sicilian Defence: Taimanov Variation", "B47", "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 b8c6 b1c3 d8c7"],
  ["Sicilian Defence: Kan Variation", "B42", "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 a7a6 f1d3 g8f6"],
  ["Sicilian Defence: Four Knights Variation", "B45", "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 g8f6 b1c3 b8c6"],
  ["Sicilian Defence: Accelerated Dragon", "B34", "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g7g6 b1c3 f8g7"],
  ["Sicilian Defence: Alapin Variation", "B22", "e2e4 c7c5 c2c3 g8f6 e4e5 f6d5 d2d4 c5d4 g1f3 b8c6"],
  ["Sicilian Defence: Rossolimo Variation", "B31", "e2e4 c7c5 g1f3 b8c6 f1b5 g7g6 e1g1 f8g7 f1e1 g8f6"],
  ["Sicilian Defence: Moscow Variation", "B52", "e2e4 c7c5 g1f3 d7d6 f1b5 c8d7 b5d7 d8d7 e1g1 b8c6"],
  ["Sicilian Defence: Closed Variation", "B25", "e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 d2d3 d7d6"],
  ["French Defence: Winawer, Main Line", "C18", "e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3 b4c3 b2c3 g8e7"],
  ["French Defence: Classical Variation", "C14", "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7 g5e7 d8e7"],
  ["French Defence: Tarrasch, Open Variation", "C08", "e2e4 e7e6 d2d4 d7d5 b1d2 c7c5 e4d5 e6d5 g1f3 g8f6"],
  ["French Defence: Advance Variation", "C02", "e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3 b8c6 g1f3 d8b6"],
  ["French Defence: Exchange Variation", "C01", "e2e4 e7e6 d2d4 d7d5 e4d5 e6d5 g1f3 g8f6 f1d3 f8d6"],
  ["Caro-Kann Defence: Classical Variation", "B18", "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6"],
  ["Caro-Kann Defence: Advance Variation", "B12", "e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5"],
  ["Caro-Kann Defence: Panov-Botvinnik Attack", "B14", "e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4 g8f6 b1c3 e7e6"],
  ["Caro-Kann Defence: Exchange Variation", "B13", "e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 f1d3 b8c6 c2c3 g8f6"],
  ["Caro-Kann Defence: Two Knights Attack", "B11", "e2e4 c7c6 b1c3 d7d5 g1f3 c8g4 h2h3 g4f3 d1f3 e7e6"],
  ["Pirc Defence: Classical Variation", "B08", "e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2 e8g8"],
  ["Modern Defence: Standard Line", "B06", "e2e4 g7g6 d2d4 f8g7 b1c3 d7d6 c1e3 a7a6"],
  ["Alekhine's Defence: Modern Variation", "B04", "e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 c8g4 f1e2 e7e6"],
  ["Scandinavian Defence: Main Line", "B01", "e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c7c6"],
  ["Scandinavian Defence: Modern Variation", "B01", "e2e4 d7d5 e4d5 g8f6 d2d4 f6d5 g1f3 g7g6"],
  ["Queen's Gambit Declined: Orthodox Defence", "D63", "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8 g1f3 b8d7"],
  ["Queen's Gambit Declined: Exchange Variation", "D35", "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c4d5 e6d5 c1g5 c7c6"],
  ["Queen's Gambit Declined: Ragozin Defence", "D38", "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 g1f3 f8b4 c4d5 e6d5 c1g5 b8d7"],
  ["Queen's Gambit Declined: Semi-Tarrasch", "D41", "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 g1f3 c7c5 c4d5 f6d5"],
  ["Tarrasch Defence", "D32", "d2d4 d7d5 c2c4 e7e6 b1c3 c7c5 c4d5 e6d5 g1f3 b8c6"],
  ["Queen's Gambit Accepted: Classical", "D26", "d2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5"],
  ["Slav Defence: Czech Variation", "D17", "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5"],
  ["Slav Defence: Exchange Variation", "D13", "d2d4 d7d5 c2c4 c7c6 c4d5 c6d5 b1c3 g8f6 g1f3 b8c6"],
  ["Semi-Slav Defence: Normal Variation", "D45", "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3 b8d7"],
  ["London System", "D02", "d2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 c7c5 c2c3 b8c6"],
  ["Colle System", "D05", "d2d4 d7d5 g1f3 g8f6 e2e3 e7e6 f1d3 c7c5 c2c3 b8c6"],
  ["King's Indian Defence: Classical Variation", "E92", "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5"],
  ["King's Indian Defence: Samisch Variation", "E81", "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 f2f3 e8g8"],
  ["King's Indian Defence: Fianchetto Variation", "E60", "d2d4 g8f6 c2c4 g7g6 g1f3 f8g7 g2g3 e8g8 f1g2 d7d6"],
  ["Nimzo-Indian Defence: Rubinstein Variation", "E48", "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5"],
  ["Nimzo-Indian Defence: Classical Variation", "E32", "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 d1c2 e8g8 a2a3 b4c3 c2c3 b7b6"],
  ["Queen's Indian Defence: Fianchetto Variation", "E15", "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8a6 b2b3 f8b4 c1d2 b4e7"],
  ["Bogo-Indian Defence", "E11", "d2d4 g8f6 c2c4 e7e6 g1f3 f8b4 c1d2 d8e7 g2g3 b8c6"],
  ["Catalan Opening: Open Defence", "E05", "d2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 d5c4 g1f3 f8e7"],
  ["Catalan Opening: Closed Variation", "E07", "d2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 f8e7 g1f3 e8g8 e1g1 b8d7"],
  ["Grunfeld Defence: Exchange Variation", "D85", "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3 b2c3 f8g7"],
  ["Grunfeld Defence: Russian Variation", "D97", "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5 g1f3 f8g7 d1b3 d5c4 b3c4 e8g8"],
  ["Benoni Defence: Modern Variation", "A70", "d2d4 g8f6 c2c4 c7c5 d4d5 e7e6 b1c3 e6d5 c4d5 d7d6 e2e4 g7g6"],
  ["Old Indian Defence: Main Line", "A55", "d2d4 g8f6 c2c4 d7d6 b1c3 e7e5 g1f3 b8d7 e2e4 f8e7"],
  ["Dutch Defence: Leningrad Variation", "A87", "d2d4 f7f5 c2c4 g8f6 g2g3 g7g6 f1g2 f8g7 g1f3 e8g8 e1g1 d7d6"],
  ["Dutch Defence: Stonewall Variation", "A90", "d2d4 f7f5 c2c4 g8f6 g2g3 e7e6 f1g2 d7d5 g1f3 c7c6 e1g1 f8d6"],
  ["Trompowsky Attack", "A45", "d2d4 g8f6 c1g5 e7e6 e2e4 h7h6 g5f6 d8f6"],
  ["Torre Attack", "A46", "d2d4 g8f6 g1f3 e7e6 c1g5 c7c5 e2e3 h7h6 g5h4 b7b6"],
  ["English Opening: Symmetrical Variation", "A37", "c2c4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 g1f3 e7e6"],
  ["English Opening: Four Knights, Kingside Fianchetto", "A29", "c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6"],
  ["English Opening: Reversed Dragon", "A22", "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6"],
  ["English Opening: Anglo-Grunfeld", "A16", "c2c4 g8f6 b1c3 d7d5 c4d5 f6d5 g2g3 g7g6 f1g2 d5c3 b2c3 f8g7"],
  ["English Opening: Neo-Catalan Declined", "A14", "g1f3 d7d5 c2c4 e7e6 g2g3 g8f6 f1g2 f8e7 e1g1 e8g8"],
  ["King's Indian Attack", "A07", "g1f3 d7d5 g2g3 g8f6 f1g2 c7c6 e1g1 c8g4 d2d3 b8d7"],
  ["Bird's Opening", "A03", "f2f4 d7d5 g1f3 g8f6 e2e3 g7g6 b2b3 f8g7 c1b2 e8g8"],
  ["Nimzo-Larsen Attack: Modern Variation", "A01", "b2b3 e7e5 c1b2 b8c6 e2e3 d7d5 f1b5 f8d6"],
];

export const OPENINGS: Opening[] = BOOK.map(([name, eco, moves]) => ({ name, eco, moves: moves.split(" ") }));

/**
 * Deterministic selection of `count` openings for a seed (a seeded shuffle of the book).
 * When `count` exceeds the book size the shuffled order repeats.
 */
export function pickOpenings(count: number, seed: number): Opening[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0 || OPENINGS.length === 0) return [];
  const rand = mulberry32(seed);
  const order = OPENINGS.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Opening[] = [];
  for (let i = 0; i < n; i++) out.push(order[i % order.length]);
  return out;
}
