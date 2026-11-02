// Defensive reading of the in-progress game stored under the "play.current" setting. Anything
// malformed (an older app version, a hand-edited backup) is rejected rather than crashing the page.
import { ChessGame } from "@/chess";
import type { EngineKind, GameResult, Termination } from "@/types";
import { normalizeSetup, parseLimits, parseTimeControl } from "./setup";
import type { GameEnd, PersistedGame, PlayerMeta, Score, Side } from "./types";

export const CURRENT_GAME_KEY = "play.current";

/**
 * Emergency copy of the running game, written synchronously to localStorage when the page is
 * hidden or closed: an IndexedDB write started while the page unloads (reload, closing the tab)
 * may never complete, and then the clock that was running would get its thinking time back.
 * On the next visit it is used only when it is newer than the stored game with the same id.
 */
const SNAPSHOT_KEY = "cb.play.snapshot";

export function writeSnapshot(game: PersistedGame): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(game));
  } catch {
    /* storage full or blocked: the regular IndexedDB copy still exists */
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

/** Reads and removes the emergency copy. */
export function takeSnapshot(): unknown {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    localStorage.removeItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The stored game, or the emergency copy when it is a newer state of the same game. */
export function newestGame(stored: PersistedGame | null, snapshot: PersistedGame | null): PersistedGame | null {
  if (!stored || !snapshot || snapshot.id !== stored.id) return stored;
  return snapshot.updatedAt > stored.updatedAt ? snapshot : stored;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const KINDS: readonly EngineKind[] = ["blocks", "eval", "full", "scratch", "nnue", "wasm"];
const RESULTS: readonly GameResult[] = ["1-0", "0-1", "1/2-1/2", "*"];
const TERMINATIONS: readonly Termination[] = [
  "checkmate",
  "stalemate",
  "threefold",
  "fifty-move",
  "insufficient-material",
  "timeout",
  "resign",
  "draw-agreed",
  "adjudication",
  "illegal-move",
  "engine-error",
  "max-moves",
  "aborted",
  "unterminated",
];

function parsePlayer(v: unknown): PlayerMeta | null {
  if (!isObj(v) || (v.kind !== "human" && v.kind !== "engine") || !isStr(v.name)) return null;
  const engineId = isStr(v.engineId) && v.engineId ? v.engineId : null;
  if (v.kind === "engine" && !engineId) return null;
  return {
    kind: v.kind,
    name: v.name,
    engineId,
    engineKind: KINDS.includes(v.engineKind as EngineKind) ? (v.engineKind as EngineKind) : null,
    color: isStr(v.color) ? v.color : null,
    hashMb: num(v.hashMb),
    limits: parseLimits(v.limits),
    timeControl: parseTimeControl(v.timeControl),
  };
}

function parseScore(v: unknown): Score | null {
  if (!isObj(v)) return null;
  const cp = num(v.cp);
  const mate = num(v.mate);
  return cp === null && mate === null ? null : { cp, mate };
}

function parseEnd(v: unknown): GameEnd | null {
  if (!isObj(v)) return null;
  if (!RESULTS.includes(v.result as GameResult) || !TERMINATIONS.includes(v.termination as Termination)) return null;
  return {
    result: v.result as GameResult,
    termination: v.termination as Termination,
    winner: v.winner === "w" || v.winner === "b" ? v.winner : null,
    title: isStr(v.title) ? v.title : "Game over",
    reason: isStr(v.reason) ? v.reason : "",
  };
}

function parseClock(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, n);
}

/** The stored game, or null when there is none or it cannot be used. */
export function parsePersistedGame(raw: unknown): PersistedGame | null {
  if (!isObj(raw) || raw.v !== 1 || !isStr(raw.id) || !isStr(raw.startFen) || !Array.isArray(raw.moves)) return null;
  if (!raw.moves.every(isStr)) return null;
  const players = isObj(raw.players) ? { w: parsePlayer(raw.players.w), b: parsePlayer(raw.players.b) } : null;
  if (!players || !players.w || !players.b) return null;
  if (!ChessGame.fromMoves(raw.startFen, raw.moves as string[])) return null;
  const moves = raw.moves as string[];
  const fit = <T,>(list: unknown, map: (x: unknown) => T, fill: T): T[] =>
    Array.from({ length: moves.length }, (_, i) => (Array.isArray(list) && i < list.length ? map(list[i]) : fill));
  const clock = isObj(raw.clock) ? raw.clock : {};
  const scores = isObj(raw.scores) ? raw.scores : {};
  const p: PersistedGame = {
    v: 1,
    id: raw.id,
    createdAt: num(raw.createdAt) ?? Date.now(),
    setup: normalizeSetup(raw.setup),
    players: { w: players.w, b: players.b },
    startFen: raw.startFen,
    bookPlies: Math.max(0, Math.min(moves.length, Math.round(num(raw.bookPlies) ?? 0))),
    opening: isStr(raw.opening) ? raw.opening : null,
    moves,
    evals: fit(raw.evals, (x) => num(x), null),
    times: fit(raw.times, (x) => Math.max(0, num(x) ?? 0), 0),
    clock: { w: players.w.timeControl ? parseClock(clock.w) ?? players.w.timeControl.baseMs : null, b: players.b.timeControl ? parseClock(clock.b) ?? players.b.timeControl.baseMs : null },
    scores: { w: parseScore((scores as Record<Side, unknown>).w), b: parseScore((scores as Record<Side, unknown>).b) },
    end: parseEnd(raw.end),
    savedGameId: isStr(raw.savedGameId) ? raw.savedGameId : null,
    saveSkipped: raw.saveSkipped === true,
    updatedAt: num(raw.updatedAt) ?? Date.now(),
  };
  if (Array.isArray(raw.whiteScores) && raw.whiteScores.length === moves.length) p.whiteScores = raw.whiteScores.map(parseScore);
  return p;
}
