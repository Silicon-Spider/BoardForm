// Pure helpers for the Settings page (unit-tested in settings.test.ts).
import { ChessGame } from "@/chess";
import type { StoreName } from "@/storage/stores";
import type { EngineRecord } from "@/types";
import { plural } from "@/utils/format";

/** "boardform-backup-2026-11-02.json" (local date). */
export function backupFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `boardform-backup-${y}-${m}-${d}.json`;
}

export type AnimationPreset = "off" | "fast" | "normal" | "slow";

export const ANIMATION_PRESETS: ReadonlyArray<{ value: AnimationPreset; label: string; ms: number }> = [
  { value: "off", label: "Off", ms: 0 },
  { value: "fast", label: "Fast", ms: 100 },
  { value: "normal", label: "Normal", ms: 160 },
  { value: "slow", label: "Slow", ms: 260 },
];

/** The preset closest to a stored animation duration (any number of ms). */
export function nearestAnimationPreset(ms: number): AnimationPreset {
  if (!Number.isFinite(ms) || ms <= 0) return "off";
  let best = ANIMATION_PRESETS[1];
  for (const p of ANIMATION_PRESETS) if (p.ms > 0 && Math.abs(p.ms - ms) < Math.abs(best.ms - ms)) best = p;
  return best.value;
}

export const MIN_HASH_MB = 1;
export const MAX_HASH_MB = 512;

/** A typed hash size, or null unless it is a whole number of MiB from 1 to 512. */
export function parseHashMb(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_HASH_MB && n <= MAX_HASH_MB ? n : null;
}

/** usage / quota in 0..1, or null when either is unknown. */
export function usageFraction(usage: number, quota: number): number | null {
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
  return Math.min(1, Math.max(0, usage / quota));
}

const RESTORE_LABELS: ReadonlyArray<[StoreName, string, string]> = [
  ["engines", "engine", "engines"],
  ["networks", "network", "networks"],
  ["datasets", "dataset", "datasets"],
  ["games", "game", "games"],
  ["matches", "match", "matches"],
  ["trainingRuns", "training run", "training runs"],
  ["settings", "setting", "settings"],
];

/** What a restore brought back, e.g. ["3 engines", "1 network", "12 settings"] (empty stores left out). */
export function restoredSummary(counts: Partial<Record<StoreName, number>>): string[] {
  return RESTORE_LABELS.filter(([store]) => (counts[store] ?? 0) > 0).map(([store, one, many]) => plural(counts[store] ?? 0, one, many));
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Never edited and never built since it was created (a fresh starter engine). */
const isPristine = (e: EngineRecord) => e.createdAt === e.updatedAt && !e.build;

/**
 * Starter engines that exist more than once — typically the fresh copies a new browser creates on
 * first start, next to the ones a backup restored. Returns the ids of the redundant *untouched*
 * copies: within each group of built-in engines with the same kind and name, the oldest engine that
 * was changed (or else the oldest one) is kept, every other untouched copy is listed, and copies
 * the user changed are never listed.
 */
export function duplicateStarterIds(engines: readonly EngineRecord[]): string[] {
  const groups = new Map<string, EngineRecord[]>();
  for (const e of engines) {
    if (!e.builtin) continue;
    const key = `${e.kind}\u0000${(e.name ?? "").trim().toLocaleLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  const redundant: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const keep = sorted.find((e) => !isPristine(e)) ?? sorted[0];
    for (const e of sorted) if (e !== keep && isPristine(e)) redundant.push(e.id);
  }
  return redundant;
}

const PIECE_VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

/**
 * A plausible-looking move for the board preview's "engine arrow": the biggest capture, else a
 * move towards the centre. Deterministic; null when the game is over.
 */
export function demoMove(fen: string): string | null {
  let game: ChessGame;
  try {
    game = new ChessGame(fen);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const uci of game.legalMoves()) {
    const captured = game.pieceAt(uci.slice(2, 4));
    const file = uci.charCodeAt(2) - 97;
    const rank = uci.charCodeAt(3) - 49;
    const centre = 3.5 - Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5));
    const mover = game.pieceAt(uci.slice(0, 2));
    // Prefer captures, then central squares; nudge pawns and minor pieces ahead of the king.
    const score = (captured ? PIECE_VALUE[captured[1]] * 10 : 0) + centre + (mover?.[1] === "K" ? -3 : mover?.[1] === "Q" ? -0.5 : 0) + (uci[4] === "q" ? 8 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = uci;
    }
  }
  return best;
}
