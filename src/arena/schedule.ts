// Match schedule: which participants meet, with which colours and openings.
//
// The schedule is a pure function of the MatchConfig (including the opening seed), so a match
// that is resumed after a pause or a reload plays exactly the games it would have played anyway:
// games are identified by their `index`, and MatchRecord.results lists the indices already done.
//
// Order: games come in "pair rounds". In pair round r every pairing plays its games 2r and 2r+1,
// which are the same opening with the colours swapped. So standings stay balanced while a long
// match is running, and both games of a colour-swapped pair tend to run at the same time.
import { pickOpenings, randomPlies } from "@/chess";
import type { MatchConfig } from "@/types";

export interface ScheduledPairing {
  /** Participant indices (MatchConfig.participants). `a` has White in the first game. */
  a: number;
  b: number;
}

/** A game without its opening (cheap: no opening book or random-move search involved). */
export interface ScheduledSlot {
  /** Index in the match schedule (MatchGameSummary.index). */
  index: number;
  /** Participant indices. */
  white: number;
  black: number;
  /** Pairing number (index into pairingsOf(config)). */
  pairing: number;
  /** Game number within its pairing, 0 .. gamesPerPairing-1 (odd = colours swapped). */
  game: number;
  /** Opening slot: both games of a colour-swapped pair share it. */
  openingSlot: number;
}

export interface ScheduledGame extends ScheduledSlot {
  /** "startpos" or a FEN. */
  startFen: string;
  /** Opening moves (UCI) played before the engines take over. */
  openingMoves: string[];
  /** Book opening name, "Random opening (8 plies)", or null for the start position. */
  opening: string | null;
  eco: string | null;
}

/** Default opening seed when a config has none (createMatch always stores one). */
export const DEFAULT_OPENING_SEED = 1;

/** Round robin: every pair (i < j); gauntlet: participant 0 against each of the others. */
export function pairingsOf(config: Pick<MatchConfig, "participants" | "format">): ScheduledPairing[] {
  const n = config.participants.length;
  const out: ScheduledPairing[] = [];
  if (config.format === "gauntlet") {
    for (let j = 1; j < n; j++) out.push({ a: 0, b: j });
  } else {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push({ a: i, b: j });
  }
  return out;
}

export function gamesPerPairingOf(config: Pick<MatchConfig, "gamesPerPairing">): number {
  const g = Math.floor(config.gamesPerPairing);
  return Number.isFinite(g) && g > 0 ? g : 1;
}

/** Number of games the config schedules. */
export function countGames(config: Pick<MatchConfig, "participants" | "format" | "gamesPerPairing">): number {
  return pairingsOf(config).length * gamesPerPairingOf(config);
}

/** The pairing schedule without openings (fast; used by standings and the UI). */
export function buildSlots(config: Pick<MatchConfig, "participants" | "format" | "gamesPerPairing">): ScheduledSlot[] {
  const pairings = pairingsOf(config);
  const perPairing = gamesPerPairingOf(config);
  const pairRounds = Math.ceil(perPairing / 2);
  const out: ScheduledSlot[] = [];
  for (let r = 0; r < pairRounds; r++) {
    for (let p = 0; p < pairings.length; p++) {
      const openingSlot = r * pairings.length + p;
      for (let game = 2 * r; game < Math.min(perPairing, 2 * r + 2); game++) {
        const swapped = game % 2 === 1;
        const { a, b } = pairings[p];
        out.push({ index: out.length, white: swapped ? b : a, black: swapped ? a : b, pairing: p, game, openingSlot });
      }
    }
  }
  return out;
}

/** Mixes a seed with an opening slot into an independent 32-bit seed (murmur3 finalizer). */
export function slotSeed(seed: number, slot: number): number {
  let h = (Math.floor(seed) ^ Math.imul(slot + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export interface SlotOpening {
  openingMoves: string[];
  opening: string | null;
  eco: string | null;
}

/**
 * The opening of one opening slot. Book: entry `slot` of the seeded shuffle of the book (the
 * shuffle does not depend on how many openings are drawn, so this equals
 * pickOpenings(n, seed)[slot] for every n > slot). Random plies: randomPlies with a per-slot seed.
 */
export function openingForSlot(config: Pick<MatchConfig, "openings">, slot: number): SlotOpening {
  const mode = config.openings?.mode ?? "none";
  const seed = config.openings?.seed ?? DEFAULT_OPENING_SEED;
  if (mode === "book") {
    const o = pickOpenings(slot + 1, seed)[slot];
    return o ? { openingMoves: o.moves.slice(), opening: o.name, eco: o.eco } : { openingMoves: [], opening: null, eco: null };
  }
  if (mode === "random-plies") {
    const plies = Math.max(0, Math.floor(config.openings.randomPlies ?? 0));
    const moves = plies > 0 ? randomPlies(plies, slotSeed(seed, slot)) : [];
    return { openingMoves: moves, opening: moves.length > 0 ? `Random opening (${moves.length} plies)` : null, eco: null };
  }
  return { openingMoves: [], opening: null, eco: null };
}

/** A scheduled slot with its opening filled in. */
export function withOpening(config: Pick<MatchConfig, "openings">, slot: ScheduledSlot): ScheduledGame {
  const o = openingForSlot(config, slot.openingSlot);
  return { ...slot, startFen: "startpos", openingMoves: o.openingMoves, opening: o.opening, eco: o.eco };
}

/** The full schedule: every game with colours and opening. Deterministic for a given config. */
export function buildSchedule(config: MatchConfig): ScheduledGame[] {
  const cache = new Map<number, SlotOpening>();
  return buildSlots(config).map((s) => {
    let o = cache.get(s.openingSlot);
    if (!o) {
      o = openingForSlot(config, s.openingSlot);
      cache.set(s.openingSlot, o);
    }
    return { ...s, startFen: "startpos", openingMoves: o.openingMoves.slice(), opening: o.opening, eco: o.eco };
  });
}
