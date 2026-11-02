// Match configuration: defaults, normalization and validation (shared by the service and the form).
import type { AdjudicationConfig, EngineLimits, MatchConfig, ParticipantConfig, TimeControl } from "@/types";
import { DEFAULT_ADJUDICATION } from "./adjudication";
import { countGames } from "./schedule";

/** Most games one match may schedule. */
export const MAX_MATCH_GAMES = 10_000;
export const MAX_GAMES_PER_PAIRING = 1_000;
export const MAX_RANDOM_PLIES = 40;
export const DEFAULT_RANDOM_PLIES = 8;

/** Default per-engine clock for new matches: 1 minute, no increment (the "1+0" preset). */
export const DEFAULT_TIME_CONTROL: TimeControl = { baseMs: 60_000, incMs: 0 };

/** The quick match's clock: 10 s + 0.1 s per move. */
export const QUICK_TIME_CONTROL: TimeControl = { baseMs: 10_000, incMs: 100 };

/** Simultaneous games offered by default: min(4, floor(maxWorkers / 2)), at least 1. */
export function defaultConcurrency(maxWorkers: number): number {
  return Math.max(1, Math.min(4, Math.floor(maxWorkers / 2)));
}

export function defaultParticipant(engineId: string, hashMb?: number): ParticipantConfig {
  return { engineId, limits: {}, timeControl: { ...DEFAULT_TIME_CONTROL }, ...(hashMb ? { hashMb } : {}) };
}

export function defaultMatchConfig(opts: { engineIds?: string[]; hashMb?: number; maxWorkers?: number } = {}): MatchConfig {
  return {
    name: "",
    participants: (opts.engineIds ?? []).map((id) => defaultParticipant(id, opts.hashMb)),
    format: "round-robin",
    gamesPerPairing: 10,
    openings: { mode: "book", randomPlies: DEFAULT_RANDOM_PLIES, seed: randomSeed() },
    concurrency: defaultConcurrency(opts.maxWorkers ?? 4),
    adjudication: { ...DEFAULT_ADJUDICATION },
    saveGames: true,
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000) + 1;
}

const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);

function cleanLimits(l: EngineLimits | undefined): EngineLimits {
  const out: EngineLimits = {};
  if (l?.depth && l.depth > 0) out.depth = Math.round(l.depth);
  if (l?.nodes && l.nodes > 0) out.nodes = Math.round(l.nodes);
  if (l?.movetimeMs && l.movetimeMs > 0) out.movetimeMs = Math.round(l.movetimeMs);
  return out;
}

function cleanTimeControl(tc: TimeControl | null | undefined): TimeControl | null {
  if (!tc || !(tc.baseMs > 0)) return null;
  const out: TimeControl = { baseMs: Math.round(tc.baseMs), incMs: Math.max(0, Math.round(tc.incMs || 0)) };
  if (tc.movesPerControl && tc.movesPerControl > 0) out.movesPerControl = Math.round(tc.movesPerControl);
  return out;
}

function cleanAdjudication(a: AdjudicationConfig | undefined): AdjudicationConfig {
  const d = DEFAULT_ADJUDICATION;
  const nullable = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.abs(v)) : null);
  return {
    resignScoreCp: a ? nullable(a.resignScoreCp) : d.resignScoreCp,
    resignMoves: Math.max(1, int(a?.resignMoves, d.resignMoves)),
    drawScoreCp: a ? nullable(a.drawScoreCp) : d.drawScoreCp,
    drawMoves: Math.max(1, int(a?.drawMoves, d.drawMoves)),
    drawMinPly: Math.max(0, int(a?.drawMinPly, d.drawMinPly)),
    maxPlies: a ? (nullable(a.maxPlies) || null) : d.maxPlies,
  };
}

/** A tidy copy: whole numbers, unset caps removed, a fixed opening seed, trimmed name. */
export function normalizeMatchConfig(config: MatchConfig): MatchConfig {
  const mode = config.openings?.mode === "book" || config.openings?.mode === "random-plies" ? config.openings.mode : "none";
  return {
    name: (config.name ?? "").trim(),
    participants: config.participants.map((p) => {
      const out: ParticipantConfig = { engineId: p.engineId, limits: cleanLimits(p.limits), timeControl: cleanTimeControl(p.timeControl) };
      if (p.hashMb && p.hashMb > 0) out.hashMb = Math.round(p.hashMb);
      return out;
    }),
    format: config.format === "gauntlet" ? "gauntlet" : "round-robin",
    gamesPerPairing: Math.max(1, int(config.gamesPerPairing, 2)),
    openings: {
      mode,
      ...(mode === "random-plies" ? { randomPlies: Math.max(1, int(config.openings.randomPlies, DEFAULT_RANDOM_PLIES)) } : {}),
      seed: Math.abs(int(config.openings?.seed, randomSeed())),
    },
    concurrency: Math.max(1, int(config.concurrency, 1)),
    adjudication: cleanAdjudication(config.adjudication),
    saveGames: config.saveGames !== false,
  };
}

/** Problems with a config, written for the user; [] = OK. `maxConcurrency` = the worker budget. */
export function validateMatchConfig(config: MatchConfig, opts: { maxConcurrency?: number } = {}): string[] {
  const problems: string[] = [];
  if (!config.name.trim()) problems.push("Give the match a name.");
  if (config.participants.length < 2) problems.push("Add at least two engines.");
  if (config.participants.some((p) => !p.engineId)) problems.push("Choose an engine for every participant.");
  const g = config.gamesPerPairing;
  if (!Number.isInteger(g) || g < 1 || g > MAX_GAMES_PER_PAIRING) problems.push(`Games per pairing must be a whole number from 1 to ${MAX_GAMES_PER_PAIRING}.`);
  if (config.participants.length >= 2 && countGames(config) > MAX_MATCH_GAMES) {
    problems.push(`This match would have ${countGames(config).toLocaleString()} games; the limit is ${MAX_MATCH_GAMES.toLocaleString()}.`);
  }
  if (config.openings.mode === "random-plies") {
    const n = config.openings.randomPlies ?? 0;
    if (!Number.isInteger(n) || n < 1 || n > MAX_RANDOM_PLIES) problems.push(`Random openings need 1 to ${MAX_RANDOM_PLIES} plies.`);
  }
  const maxC = opts.maxConcurrency ?? 64;
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > maxC) {
    problems.push(`Games at once must be from 1 to ${maxC}.`);
  }
  for (const p of config.participants) {
    if (p.hashMb !== undefined && (!Number.isFinite(p.hashMb) || p.hashMb < 1 || p.hashMb > 512)) {
      problems.push("Hash sizes must be from 1 to 512 MB.");
      break;
    }
  }
  const a = config.adjudication;
  if (a.maxPlies !== null && (!Number.isInteger(a.maxPlies) || a.maxPlies < 10)) problems.push("The ply limit must be at least 10.");
  if (a.resignScoreCp !== null && (!(a.resignScoreCp > 0) || a.resignMoves < 1)) problems.push("Resign adjudication needs a positive score and at least one move.");
  if (a.drawScoreCp !== null && (a.drawScoreCp < 0 || a.drawMoves < 1 || a.drawMinPly < 0)) problems.push("Draw adjudication needs a score of 0 or more and at least one move.");
  return problems;
}
