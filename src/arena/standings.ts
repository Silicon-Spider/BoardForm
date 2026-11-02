// Standings, crosstable and score summaries from a match's results.
//
// Results are mapped back to participants through the schedule (summary.index → the scheduled
// colours), so an engine that appears twice in a match is still counted as two participants.
import type { MatchConfig, MatchGameSummary } from "@/types";
import { eloEstimate, type EloEstimate } from "@/utils/elo";
import { buildSlots, type ScheduledSlot } from "./schedule";

export interface StandingRow {
  /** Index in MatchConfig.participants. */
  participant: number;
  engineId: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  /** points / games, NaN without games. */
  score: number;
  /** Elo difference against the field (for two engines: head-to-head), with the 95% error and LOS. */
  elo: EloEstimate;
  /** Sonneborn-Berger tie-break. */
  sonnebornBerger: number;
  /** 1-based; equal points, tie-break and wins share a rank. */
  rank: number;
}

export interface CrossCell {
  points: number;
  games: number;
}

/** A finished game mapped to participant indices. */
export interface ResolvedResult {
  summary: MatchGameSummary;
  white: number;
  black: number;
}

/** Maps each result to its participants (null entries are dropped: results that fit no participant). */
export function resolveResults(config: MatchConfig, results: readonly MatchGameSummary[], slots: readonly ScheduledSlot[] = buildSlots(config)): ResolvedResult[] {
  const ids = config.participants.map((p) => p.engineId);
  const out: ResolvedResult[] = [];
  for (const summary of results) {
    const slot = slots[summary.index];
    if (slot && ids[slot.white] === summary.whiteId && ids[slot.black] === summary.blackId) {
      out.push({ summary, white: slot.white, black: slot.black });
      continue;
    }
    // Fallback (should not happen): first participants with these engines.
    const w = ids.indexOf(summary.whiteId);
    const b = ids.lastIndexOf(summary.blackId);
    if (w >= 0 && b >= 0 && w !== b) out.push({ summary, white: w, black: b });
  }
  return out;
}

/** Points for White: 1, 0.5, 0, or null for unfinished results. */
export function whitePoints(result: string): number | null {
  return result === "1-0" ? 1 : result === "0-1" ? 0 : result === "1/2-1/2" ? 0.5 : null;
}

export function crosstable(config: MatchConfig, resolved: readonly ResolvedResult[]): CrossCell[][] {
  const n = config.participants.length;
  const cells: CrossCell[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ points: 0, games: 0 })));
  for (const r of resolved) {
    const wp = whitePoints(r.summary.result);
    if (wp === null) continue;
    cells[r.white][r.black].points += wp;
    cells[r.white][r.black].games += 1;
    cells[r.black][r.white].points += 1 - wp;
    cells[r.black][r.white].games += 1;
  }
  return cells;
}

/** Standings sorted by rank (points, then Sonneborn-Berger, then wins). */
export function computeStandings(config: MatchConfig, results: readonly MatchGameSummary[]): StandingRow[] {
  const resolved = resolveResults(config, results);
  const n = config.participants.length;
  const rows = config.participants.map((p, i) => ({ participant: i, engineId: p.engineId, games: 0, wins: 0, draws: 0, losses: 0, points: 0 }));
  for (const r of resolved) {
    const wp = whitePoints(r.summary.result);
    if (wp === null) continue;
    const w = rows[r.white];
    const b = rows[r.black];
    w.games++;
    b.games++;
    if (wp === 1) {
      w.wins++;
      b.losses++;
    } else if (wp === 0) {
      w.losses++;
      b.wins++;
    } else {
      w.draws++;
      b.draws++;
    }
    w.points += wp;
    b.points += 1 - wp;
  }
  const cross = crosstable(config, resolved);
  const full: StandingRow[] = rows.map((r) => {
    let sb = 0;
    for (let j = 0; j < n; j++) if (j !== r.participant) sb += cross[r.participant][j].points * rows[j].points;
    return {
      ...r,
      score: r.games > 0 ? r.points / r.games : NaN,
      elo: eloEstimate({ wins: r.wins, draws: r.draws, losses: r.losses }),
      sonnebornBerger: sb,
      rank: 0,
    };
  });
  full.sort((a, b) => b.points - a.points || b.sonnebornBerger - a.sonnebornBerger || b.wins - a.wins || a.participant - b.participant);
  full.forEach((row, i) => {
    const prev = full[i - 1];
    row.rank = prev && prev.points === row.points && prev.sonnebornBerger === row.sonnebornBerger && prev.wins === row.wins ? prev.rank : i + 1;
  });
  return full;
}

/** Results by colour: White wins, draws, Black wins. */
export function colorStats(results: readonly MatchGameSummary[]): { white: number; draws: number; black: number } {
  const out = { white: 0, draws: 0, black: 0 };
  for (const r of results) {
    if (r.result === "1-0") out.white++;
    else if (r.result === "0-1") out.black++;
    else if (r.result === "1/2-1/2") out.draws++;
  }
  return out;
}

/** "12.5" / "3" — points without trailing zeros. */
export function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/**
 * Display labels for the participants: engine names, numbered when a name occurs more than once
 * ("Classic (1)", "Classic (2)"). `nameOf` returns null for engines that no longer exist.
 */
export function participantLabels(config: Pick<MatchConfig, "participants">, nameOf: (engineId: string) => string | null | undefined): string[] {
  const base = config.participants.map((p) => nameOf(p.engineId) || "Deleted engine");
  const total = new Map<string, number>();
  for (const b of base) total.set(b, (total.get(b) ?? 0) + 1);
  const seen = new Map<string, number>();
  return base.map((b) => {
    if ((total.get(b) ?? 0) < 2) return b;
    const k = (seen.get(b) ?? 0) + 1;
    seen.set(b, k);
    return `${b} (${k})`;
  });
}

/** Default match name: "A vs B", "Gauntlet: A vs 3 engines", "Round robin (4 engines)". */
export function autoMatchName(config: Pick<MatchConfig, "participants" | "format">, labels: readonly string[]): string {
  const n = config.participants.length;
  if (n === 2) return `${labels[0]} vs ${labels[1]}`;
  if (n < 2) return labels[0] ? `${labels[0]} match` : "New match";
  if (config.format === "gauntlet") return `Gauntlet: ${labels[0]} vs ${n - 1} engines`;
  return `Round robin (${n} engines)`;
}

/** One-line score: "Classic 12.5 – 7.5 Blocky" (two engines) or "Classic leads with 4.5 / 6". */
export function scoreLine(config: MatchConfig, results: readonly MatchGameSummary[], labels: readonly string[], opts: { final?: boolean } = {}): string | null {
  if (results.length === 0) return null;
  const rows = computeStandings(config, results);
  if (config.participants.length === 2) {
    const a = rows.find((r) => r.participant === 0)!;
    const b = rows.find((r) => r.participant === 1)!;
    return `${labels[0]} ${formatPoints(a.points)} – ${formatPoints(b.points)} ${labels[1]}`;
  }
  const top = rows[0];
  const shared = rows.filter((r) => r.rank === 1).length > 1;
  const leaders = rows.filter((r) => r.rank === 1).length;
  if (opts.final) {
    return shared
      ? `${leaders} engines share first place with ${formatPoints(top.points)}`
      : `${labels[top.participant]} wins with ${formatPoints(top.points)} / ${top.games}`;
  }
  return shared ? `${leaders} engines share the lead with ${formatPoints(top.points)}` : `${labels[top.participant]} leads with ${formatPoints(top.points)} / ${top.games}`;
}
