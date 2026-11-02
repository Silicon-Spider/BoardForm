// Game setup: defaults, quick presets, validation, defensive parsing of stored setups and query
// parameters (docs/ARCHITECTURE.md §6), and turning a start position into concrete moves.
// Pure functions, unit-tested in setup.test.ts.
import { ChessGame, OPENINGS, START_FEN, randomPlies, validateFen } from "@/chess";
import type { EngineLimits, EngineRecord, TimeControl } from "@/types";
import { SIDE_NAMES, type GameSetup, type PlayerMeta, type ResolvedStart, type Side, type SideSetup, type StartPosition } from "./types";

/** An engine's per-move cap when nothing else is set: one second per move. */
export const DEFAULT_ENGINE_LIMITS: EngineLimits = { movetimeMs: 1000 };
export const RANDOM_PLIES_DEFAULT = 8;
export const RANDOM_PLIES_MIN = 1;
export const RANDOM_PLIES_MAX = 20;
export const HASH_MIN_MB = 1;
export const HASH_MAX_MB = 512;

export const HUMAN_SIDE: SideSetup = { player: "human", engineId: null, limits: {}, timeControl: null, hashMb: null };

export function engineSide(engineId: string | null, limits: EngineLimits = DEFAULT_ENGINE_LIMITS, timeControl: TimeControl | null = null): SideSetup {
  return { player: "engine", engineId, limits: { ...limits }, timeControl, hashMb: null };
}

export const DEFAULT_SETUP: GameSetup = {
  white: HUMAN_SIDE,
  black: engineSide(null),
  start: { kind: "standard" },
  sameClock: true,
};

// --- defensive parsing -----------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const posNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function parseTimeControl(v: unknown): TimeControl | null {
  if (!isObj(v)) return null;
  const baseMs = posNum(v.baseMs);
  if (!baseMs) return null;
  const incMs = typeof v.incMs === "number" && Number.isFinite(v.incMs) && v.incMs >= 0 ? v.incMs : 0;
  const tc: TimeControl = { baseMs: Math.round(baseMs), incMs: Math.round(incMs) };
  const moves = posNum(v.movesPerControl);
  if (moves) tc.movesPerControl = Math.round(moves);
  return tc;
}

export function parseLimits(v: unknown): EngineLimits {
  if (!isObj(v)) return {};
  const out: EngineLimits = {};
  const depth = posNum(v.depth);
  const nodes = posNum(v.nodes);
  const movetimeMs = posNum(v.movetimeMs);
  if (depth) out.depth = Math.round(depth);
  if (nodes) out.nodes = Math.round(nodes);
  if (movetimeMs) out.movetimeMs = Math.round(movetimeMs);
  return out;
}

function parseSide(v: unknown, fallback: SideSetup): SideSetup {
  if (!isObj(v)) return fallback;
  const player = v.player === "engine" ? "engine" : v.player === "human" ? "human" : fallback.player;
  const hash = posNum(v.hashMb);
  return {
    player,
    engineId: typeof v.engineId === "string" && v.engineId ? v.engineId : null,
    limits: parseLimits(v.limits),
    timeControl: parseTimeControl(v.timeControl),
    hashMb: hash ? Math.min(HASH_MAX_MB, Math.max(HASH_MIN_MB, Math.round(hash))) : null,
  };
}

export function parseStart(v: unknown): StartPosition {
  if (!isObj(v)) return { kind: "standard" };
  switch (v.kind) {
    case "fen":
      return typeof v.fen === "string" ? { kind: "fen", fen: v.fen } : { kind: "standard" };
    case "opening": {
      if (typeof v.name !== "string" || !Array.isArray(v.moves) || !v.moves.every((m) => typeof m === "string")) return { kind: "standard" };
      return { kind: "opening", name: v.name, eco: typeof v.eco === "string" ? v.eco : "", moves: v.moves as string[] };
    }
    case "random": {
      const plies = posNum(v.plies) ?? RANDOM_PLIES_DEFAULT;
      return { kind: "random", plies: Math.min(RANDOM_PLIES_MAX, Math.max(RANDOM_PLIES_MIN, Math.round(plies))) };
    }
    default:
      return { kind: "standard" };
  }
}

/** A stored or hand-made setup, repaired so every field is valid. */
export function normalizeSetup(raw: unknown): GameSetup {
  if (!isObj(raw)) return DEFAULT_SETUP;
  return {
    white: parseSide(raw.white, DEFAULT_SETUP.white),
    black: parseSide(raw.black, DEFAULT_SETUP.black),
    start: parseStart(raw.start),
    sameClock: typeof raw.sameClock === "boolean" ? raw.sameClock : true,
  };
}

// --- engines ---------------------------------------------------------------------------------

/** The engine a new game uses when none was chosen: the starter "Classic", else the first one. */
export function defaultEngineId(engines: readonly EngineRecord[]): string | null {
  if (engines.length === 0) return null;
  const classic = engines.find((e) => e.builtin && e.name === "Classic");
  return (classic ?? [...engines].sort((a, b) => a.name.localeCompare(b.name))[0]).id;
}

/** Fills engine sides that have no (existing) engine with the default engine. */
export function withDefaultEngines(setup: GameSetup, engines: readonly EngineRecord[] | undefined): GameSetup {
  if (!engines) return setup;
  const ids = new Set(engines.map((e) => e.id));
  const fallback = defaultEngineId(engines);
  const fix = (s: SideSetup): SideSetup => (s.player === "engine" && (!s.engineId || !ids.has(s.engineId)) ? { ...s, engineId: fallback } : s);
  const white = fix(setup.white);
  const black = fix(setup.black);
  return white === setup.white && black === setup.black ? setup : { ...setup, white, black };
}

export function hasAnyLimit(s: SideSetup): boolean {
  return !!(s.timeControl || s.limits.depth || s.limits.nodes || s.limits.movetimeMs);
}

/** Problems that prevent starting the game (empty = ready). */
export function validateSetup(setup: GameSetup, engines: readonly EngineRecord[] | undefined): string[] {
  const problems: string[] = [];
  for (const [side, s] of [["w", setup.white], ["b", setup.black]] as Array<[Side, SideSetup]>) {
    if (s.player !== "engine") continue;
    const name = SIDE_NAMES[side];
    if (!engines) problems.push("Engines are still loading.");
    else if (!s.engineId || !engines.some((e) => e.id === s.engineId)) problems.push(`Choose an engine for ${name}.`);
    if (!hasAnyLimit(s)) problems.push(`Set a clock or at least one search limit for ${name}.`);
  }
  const start = checkStart(setup.start);
  if (start) problems.push(start);
  return [...new Set(problems)];
}

// --- start position --------------------------------------------------------------------------

/** Why a start position cannot be used, or null. */
export function checkStart(start: StartPosition): string | null {
  if (start.kind === "fen") {
    if (!start.fen.trim()) return "Enter a FEN or choose another start position.";
    const v = validateFen(start.fen);
    if (!v.ok) return `The FEN is not valid: ${v.error ?? "unknown problem"}.`;
    const game = new ChessGame(start.fen);
    const outcome = game.outcome();
    if (outcome) return `The game is already over in that position (${outcome.termination.replace(/-/g, " ")}).`;
  }
  if (start.kind === "opening") {
    const game = ChessGame.fromMoves("startpos", start.moves);
    if (!game) return `The opening "${start.name}" has an illegal move.`;
  }
  return null;
}

/** Concrete start FEN and pre-played moves. `seed` picks the random opening. */
export function resolveStart(start: StartPosition, seed: number): ResolvedStart {
  switch (start.kind) {
    case "standard":
      return { startFen: START_FEN, moves: [], opening: null };
    case "fen":
      return { startFen: new ChessGame(start.fen).startFen, moves: [], opening: null };
    case "opening":
      return { startFen: START_FEN, moves: [...start.moves], opening: start.eco ? `${start.name} (${start.eco})` : start.name };
    case "random":
      return { startFen: START_FEN, moves: randomPlies(start.plies, seed >>> 0), opening: null };
  }
}

/** FEN of the position where play begins (after book moves), for previews. */
export function previewFen(start: StartPosition): string {
  try {
    switch (start.kind) {
      case "fen":
        return validateFen(start.fen).ok ? new ChessGame(start.fen).fen() : START_FEN;
      case "opening":
        return ChessGame.fromMoves("startpos", start.moves)?.fen() ?? START_FEN;
      default:
        return START_FEN;
    }
  } catch {
    return START_FEN;
  }
}

export function describeStart(start: StartPosition): string {
  switch (start.kind) {
    case "standard":
      return "Standard start position";
    case "fen":
      return "Custom position (FEN)";
    case "opening":
      return start.eco ? `${start.name} (${start.eco})` : start.name;
    case "random":
      return `Random opening (${start.plies} ${start.plies === 1 ? "ply" : "plies"})`;
  }
}

export function openingStart(name: string): StartPosition | null {
  const o = OPENINGS.find((x) => x.name === name);
  return o ? { kind: "opening", name: o.name, eco: o.eco, moves: [...o.moves] } : null;
}

// --- presets ---------------------------------------------------------------------------------

export type PresetId = "human-white" | "human-black" | "engines" | "blitz";

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; detail: string }> = [
  { id: "human-white", label: "You vs engine", detail: "You play White · engine 1 s per move" },
  { id: "human-black", label: "You vs engine", detail: "You play Black · engine 1 s per move" },
  { id: "blitz", label: "Blitz 5+3", detail: "You play White · both on a 5+3 clock" },
  { id: "engines", label: "Engine vs engine", detail: "Watch two engines · 1 s per move" },
];

export const BLITZ_CLOCK: TimeControl = { baseMs: 300_000, incMs: 3_000 };

/** The setup for a quick preset. Engines: the ones already chosen, else sensible defaults. */
export function applyPreset(setup: GameSetup, preset: PresetId, engines: readonly EngineRecord[]): GameSetup {
  const chosen = [setup.white, setup.black].filter((s) => s.player === "engine" && s.engineId && engines.some((e) => e.id === s.engineId)).map((s) => s.engineId!);
  const first = chosen[0] ?? defaultEngineId(engines);
  const second = chosen.find((id) => id !== first) ?? engines.find((e) => e.id !== first)?.id ?? first;
  const keepHash = (id: string | null): number | null => [setup.white, setup.black].find((s) => s.engineId === id)?.hashMb ?? null;
  const engine = (id: string | null, tc: TimeControl | null, limits: EngineLimits): SideSetup => ({ ...engineSide(id, limits, tc), hashMb: keepHash(id) });
  switch (preset) {
    case "human-white":
      return { ...setup, sameClock: true, white: HUMAN_SIDE, black: engine(first, null, DEFAULT_ENGINE_LIMITS) };
    case "human-black":
      return { ...setup, sameClock: true, white: engine(first, null, DEFAULT_ENGINE_LIMITS), black: HUMAN_SIDE };
    case "blitz":
      return { ...setup, sameClock: true, white: { ...HUMAN_SIDE, timeControl: BLITZ_CLOCK }, black: engine(first, BLITZ_CLOCK, {}) };
    case "engines":
      return { ...setup, sameClock: true, white: engine(first, null, DEFAULT_ENGINE_LIMITS), black: engine(second, null, DEFAULT_ENGINE_LIMITS) };
  }
}

/** Colours swapped (rematch). */
export function swapSides(setup: GameSetup): GameSetup {
  return { ...setup, white: setup.black, black: setup.white };
}

/** Sets one side's clock (and the other's when the clocks are linked). */
export function setSideClock(setup: GameSetup, side: Side, tc: TimeControl | null): GameSetup {
  const key = side === "w" ? "white" : "black";
  const next: GameSetup = { ...setup, [key]: { ...setup[key], timeControl: tc } };
  if (setup.sameClock) {
    const otherKey = side === "w" ? "black" : "white";
    next[otherKey] = { ...setup[otherKey], timeControl: tc };
  }
  return next;
}

// --- players ---------------------------------------------------------------------------------

/** Display names and engine details of both players, fixed when the game starts. */
export function playersFor(setup: GameSetup, engines: readonly EngineRecord[], defaultHashMb: number): Record<Side, PlayerMeta> {
  const humans = (setup.white.player === "human" ? 1 : 0) + (setup.black.player === "human" ? 1 : 0);
  const meta = (s: SideSetup, side: Side): PlayerMeta => {
    if (s.player === "human") {
      return {
        kind: "human",
        name: humans === 2 ? `${SIDE_NAMES[side]} player` : "You",
        engineId: null,
        engineKind: null,
        color: null,
        hashMb: null,
        limits: {},
        timeControl: s.timeControl,
      };
    }
    const e = engines.find((x) => x.id === s.engineId);
    return {
      kind: "engine",
      name: e?.name || "Engine",
      engineId: s.engineId,
      engineKind: e?.kind ?? null,
      color: e?.color ?? null,
      hashMb: s.hashMb ?? e?.options?.hashMb ?? defaultHashMb,
      limits: { ...s.limits },
      timeControl: s.timeControl,
    };
  };
  const players = { w: meta(setup.white, "w"), b: meta(setup.black, "b") };
  // The same engine on both sides: tell them apart.
  if (players.w.kind === "engine" && players.b.kind === "engine" && players.w.name === players.b.name) {
    players.w = { ...players.w, name: `${players.w.name} (White)` };
    players.b = { ...players.b, name: `${players.b.name} (Black)` };
  }
  return players;
}

// --- query parameters ------------------------------------------------------------------------

export interface QueryIntent {
  /** Play-mode setup to prefill (null = the query has no game parameters). */
  setup: GameSetup | null;
  /** Start the game right away (an opponent was given). */
  autostart: boolean;
  /** ?analysis=<engineId>. */
  analysisEngineId: string | null;
  /** ?fen for the analysis board (with ?analysis). */
  analysisFen: string | null;
  /** ?game=<gameId>. */
  gameId: string | null;
  /** Problems to show (unknown engine, invalid FEN). */
  problems: string[];
}

export const QUERY_KEYS = ["engine", "white", "black", "fen", "analysis", "game"] as const;

export function hasPlayQuery(query: URLSearchParams): boolean {
  return QUERY_KEYS.some((k) => query.has(k));
}

/** Interprets #/play query parameters on top of the last setup. */
export function intentFromQuery(query: URLSearchParams, base: GameSetup, engines: readonly EngineRecord[]): QueryIntent {
  const intent: QueryIntent = { setup: null, autostart: false, analysisEngineId: null, analysisFen: null, gameId: null, problems: [] };
  const known = (id: string) => engines.some((e) => e.id === id);
  const fen = query.get("fen")?.trim() || null;
  let fenOk = false;
  if (fen) {
    const v = validateFen(fen);
    if (v.ok) fenOk = true;
    else intent.problems.push(`The position in the link is not a valid FEN: ${v.error ?? "unknown problem"}.`);
  }

  const gameId = query.get("game");
  if (gameId) {
    intent.gameId = gameId;
    return intent;
  }

  const analysis = query.get("analysis");
  if (analysis !== null) {
    if (analysis && known(analysis)) intent.analysisEngineId = analysis;
    else if (analysis) intent.problems.push("The engine in the link no longer exists. Choose another one.");
    intent.analysisFen = fenOk ? fen : null;
    // ?analysis without a usable engine still opens the analysis board.
    if (!intent.analysisEngineId) intent.analysisEngineId = null;
    return intent;
  }

  const engine = query.get("engine");
  const white = query.get("white");
  const black = query.get("black");
  // Limits carried over from the last setup when it already had an engine on that side.
  const engineFor = (id: string, side: "white" | "black"): SideSetup => {
    const prev = base[side].player === "engine" ? base[side] : base[side === "white" ? "black" : "white"];
    const limits = prev.player === "engine" && (prev.timeControl || Object.keys(prev.limits).length) ? prev.limits : DEFAULT_ENGINE_LIMITS;
    const tc = prev.player === "engine" ? prev.timeControl : null;
    return { ...engineSide(id, limits, tc) };
  };
  let setup: GameSetup | null = null;
  let complete = false;
  if (engine) {
    if (known(engine)) {
      setup = { ...base, white: { ...HUMAN_SIDE, timeControl: base.white.player === "human" ? base.white.timeControl : null }, black: engineFor(engine, "black") };
      complete = true;
    } else intent.problems.push("The engine in the link no longer exists. Choose another opponent.");
  } else if (white || black) {
    const sideFrom = (value: string | null, side: "white" | "black"): SideSetup | null => {
      if (!value) return base[side];
      if (value === "human") return { ...HUMAN_SIDE, timeControl: base[side].player === "human" ? base[side].timeControl : null };
      if (known(value)) return engineFor(value, side);
      intent.problems.push(`The ${side} engine in the link no longer exists.`);
      return null;
    };
    const w = sideFrom(white, "white");
    const b = sideFrom(black, "black");
    setup = { ...base, white: w ?? base.white, black: b ?? base.black };
    complete = !!w && !!b && !!white && !!black;
  }
  if (fen) {
    setup = { ...(setup ?? base), start: fenOk ? { kind: "fen", fen } : (setup ?? base).start };
  }
  intent.setup = setup;
  intent.autostart = !!setup && complete && (!fen || fenOk);
  return intent;
}
