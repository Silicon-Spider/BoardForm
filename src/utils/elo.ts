// Match statistics: Elo difference from a score, 95% error margin, likelihood of superiority.

export interface WdlCounts {
  wins: number;
  draws: number;
  losses: number;
}

/** Elo difference implied by an expected score in (0,1). */
export function eloFromScore(score: number): number {
  const s = Math.min(Math.max(score, 1e-6), 1 - 1e-6);
  return -400 * Math.log10(1 / s - 1);
}

/** Expected score for an Elo difference. */
export function scoreFromElo(elo: number): number {
  return 1 / (1 + Math.pow(10, -elo / 400));
}

export interface EloEstimate {
  /** Elo difference (positive = first player stronger). */
  elo: number;
  /** ± half-width of the 95% confidence interval, in Elo. */
  error: number;
  /** Likelihood of superiority (0..1). */
  los: number;
  score: number;
  games: number;
}

/** Elo estimate with a 95% confidence interval using the trinomial (W/D/L) variance. */
export function eloEstimate({ wins, draws, losses }: WdlCounts): EloEstimate {
  const n = wins + draws + losses;
  if (n === 0) return { elo: 0, error: Infinity, los: 0.5, score: 0.5, games: 0 };
  const score = (wins + draws / 2) / n;
  const w = wins / n;
  const d = draws / n;
  const l = losses / n;
  const variance = w * (1 - score) ** 2 + d * (0.5 - score) ** 2 + l * (0 - score) ** 2;
  const stdErr = Math.sqrt(variance / n);
  const z = 1.959964;
  const lo = eloFromScore(score - z * stdErr);
  const hi = eloFromScore(score + z * stdErr);
  const elo = eloFromScore(score);
  const decisive = wins + losses;
  const los = decisive === 0 ? 0.5 : 0.5 * (1 + erf((wins - losses) / Math.sqrt(2 * decisive)));
  return { elo, error: (hi - lo) / 2, los, score, games: n };
}

/** Abramowitz–Stegun approximation of the error function. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function formatElo(e: EloEstimate): string {
  if (e.games === 0) return "—";
  const elo = Number.isFinite(e.elo) ? Math.round(e.elo) : e.elo > 0 ? Infinity : -Infinity;
  const err = Number.isFinite(e.error) ? Math.round(e.error) : "∞";
  const sign = elo > 0 ? "+" : "";
  return `${sign}${Number.isFinite(elo) ? elo : elo > 0 ? "∞" : "-∞"} ± ${err}`;
}
