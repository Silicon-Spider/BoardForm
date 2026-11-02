// Live state of the matches running in this tab (boards, clocks, engine infos, log), as a zustand
// store. The runner writes it at most ~10 times per second per match; React reads it through
// useLiveMatch().
import { create } from "zustand";
import type { MatchRecord } from "@/types";
import type { ArenaGameSummary, ArenaLogEntry, ArenaMatchExtras, ArenaMatchRecord, LiveMatchState } from "./types";

interface ArenaLiveStore {
  matches: Record<string, LiveMatchState>;
}

export const useArenaLiveStore = create<ArenaLiveStore>(() => ({ matches: {} }));

/** Most log lines kept per match. */
export const LOG_LIMIT = 300;

export function getLiveMatch(matchId: string): LiveMatchState | null {
  return useArenaLiveStore.getState().matches[matchId] ?? null;
}

export function patchLiveMatch(matchId: string, patch: Partial<LiveMatchState>): void {
  useArenaLiveStore.setState((s) => {
    const prev: LiveMatchState = s.matches[matchId] ?? { matchId, running: false, games: [], lastError: null, log: [] };
    return { matches: { ...s.matches, [matchId]: { ...prev, ...patch, matchId } } };
  });
}

export function appendLiveLog(matchId: string, entries: ArenaLogEntry[]): void {
  if (entries.length === 0) return;
  useArenaLiveStore.setState((s) => {
    const prev: LiveMatchState = s.matches[matchId] ?? { matchId, running: false, games: [], lastError: null, log: [] };
    const log = [...(prev.log ?? []), ...entries];
    return { matches: { ...s.matches, [matchId]: { ...prev, log: log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log } } };
  });
}

export function removeLiveMatch(matchId: string): void {
  useArenaLiveStore.setState((s) => {
    if (!(matchId in s.matches)) return s;
    const next = { ...s.matches };
    delete next[matchId];
    return { matches: next };
  });
}

/** Live state of a match running (or recently stopped) in this tab; null otherwise. */
export function useLiveMatch(matchId: string | null | undefined): LiveMatchState | null {
  return useArenaLiveStore((s) => (matchId ? (s.matches[matchId] ?? null) : null));
}

// --- record extras ------------------------------------------------------------------------------

/** The arena's extra fields of a match record. */
export function matchExtras(record: MatchRecord): ArenaMatchExtras {
  return record as ArenaMatchRecord;
}

/** The arena's view of a result summary (with the optional detail). */
export function summaryDetail(summary: MatchRecord["results"][number]): string | null {
  return (summary as ArenaGameSummary).detail ?? null;
}

/** Total running time of a match (finished sessions + the current one). */
export function matchElapsedMs(record: MatchRecord, now = Date.now()): number {
  const x = matchExtras(record);
  const base = typeof x.elapsedMs === "number" && Number.isFinite(x.elapsedMs) ? x.elapsedMs : 0;
  const since = record.status === "running" && typeof x.runningSince === "number" ? Math.max(0, now - x.runningSince) : 0;
  return base + since;
}
