// Friendly text for clock times and time controls, and the matching parsers used by the limits
// editor. Pure functions (no React) so they can be unit-tested and reused anywhere.
//
// Clock times are shown with their unit always visible:
//   45 s · 1.5 s · 5 min · 1:30 min (m:ss) · 90 min
// and typed in any of these forms:
//   5 (minutes) · 1:30 (m:ss) · 1:02:00 (h:mm:ss) · 20 s · 1.5 min · 1m 30s · 2 h · 500 ms
import type { TimeControl } from "@/types";

/** Clock times are kept to a tenth of a second (finer input is rounded). */
const RESOLUTION_MS = 100;

/** Drops trailing zeros: 1.50 → "1.5", 2.00 → "2". */
function trimNumber(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

function roundClock(ms: number): number {
  return Math.round(ms / RESOLUTION_MS) * RESOLUTION_MS;
}

/** "45 s", "1.5 s", "5 min", "1:30 min", "90 min". */
export function formatClockTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const t = Math.max(0, roundClock(ms));
  if (t < 60_000) return `${trimNumber(t / 1000, 1)} s`;
  if (t % 60_000 === 0) return `${t / 60_000} min`;
  const minutes = Math.floor(t / 60_000);
  const seconds = (t - minutes * 60_000) / 1000;
  return `${minutes}:${seconds < 10 ? "0" : ""}${trimNumber(seconds, 1)} min`;
}

/** Milliseconds per unit word, or null for an unknown word. */
function unitMs(word: string): number | null {
  if (/^(h|hr|hrs|hour|hours)$/.test(word)) return 3_600_000;
  if (/^(m|min|mins|minute|minutes)$/.test(word)) return 60_000;
  if (/^(s|sec|secs|second|seconds)$/.test(word)) return 1000;
  if (word === "ms") return 1;
  return null;
}

/** True when typed clock text names its own unit ("20 s", "2 min"); a bare "5" or "1:30" means minutes. */
export function clockTextHasUnit(text: string): boolean {
  return /[a-z]/i.test(text);
}

export const CLOCK_TIME_HELP = "Type minutes (5), m:ss (1:30) or seconds (20 s)";

export interface ClockTimeRule {
  /** Smallest allowed time. Default 1 s. */
  minMs?: number;
  /** Largest allowed time. Default 10 hours. */
  maxMs?: number;
}

export type ParsedClockTime = { ok: true; ms: number } | { ok: false; error: string };

/**
 * Parses a typed clock time (see the file comment for the accepted forms). A bare number is
 * minutes, as in chess time controls ("5+3" = 5 minutes). Results are rounded to 0.1 s.
 */
export function parseClockTime(text: string, rule: ClockTimeRule = {}): ParsedClockTime {
  const { minMs = 1000, maxMs = 36_000_000 } = rule;
  const t = text.trim().toLowerCase().replace(/,/g, ".");
  if (t === "") return { ok: false, error: "Enter a time" };
  let ms: number | null = null;

  // m:ss (optionally followed by "min") or h:mm:ss.
  const colon = /^(\d+):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?(?:\s*(?:m|min|mins|minutes?))?$/.exec(t);
  if (colon) {
    const a = Number(colon[1]);
    const b = Number(colon[2]);
    if (colon[3] !== undefined) {
      const c = Number(colon[3]);
      if (!Number.isInteger(b) || b >= 60 || c >= 60) return { ok: false, error: "In h:mm:ss, minutes and seconds go up to 59" };
      ms = a * 3_600_000 + b * 60_000 + c * 1000;
    } else {
      if (b >= 60) return { ok: false, error: "In m:ss, the seconds go up to 59" };
      ms = a * 60_000 + b * 1000;
    }
  } else if (/^(\d+(\.\d*)?|\.\d+)$/.test(t)) {
    ms = Number(t) * 60_000; // bare number: minutes
  } else {
    // One or more "<number> <unit>" pairs: "20 s", "1.5 min", "1m 30s", "1 h 15 min".
    const pair = /\s*(\d+(?:\.\d*)?|\.\d+)\s*([a-z]+)\s*/y;
    let total = 0;
    let pos = 0;
    let pairs = 0;
    while (pos < t.length) {
      pair.lastIndex = pos;
      const m = pair.exec(t);
      if (!m) break;
      const unit = unitMs(m[2]);
      if (unit === null) return { ok: false, error: `Unknown unit "${m[2]}" — use h, min, s or ms` };
      total += Number(m[1]) * unit;
      pos = pair.lastIndex;
      pairs++;
    }
    if (pairs > 0 && pos === t.length) ms = total;
  }

  if (ms === null || !Number.isFinite(ms)) return { ok: false, error: CLOCK_TIME_HELP };
  ms = roundClock(ms);
  if (ms < minMs) return { ok: false, error: `At least ${formatClockTime(minMs)}` };
  if (ms > maxMs) return { ok: false, error: `At most ${formatClockTime(maxMs)}` };
  return { ok: true, ms };
}

/**
 * Seconds typed into a seconds field: "2", "0.5", "2 s", "1.5 sec", "500 ms". Returns null when
 * the text is not a number of seconds (range checks are up to the caller).
 */
export function parseSecondsText(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, ".");
  const m = /^(\d+(?:\.\d*)?|\.\d+)\s*(s|sec|secs|seconds?|ms)?$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === "ms" ? v / 1000 : v;
}

/** Base time inside a time control label: "5", "1.5", "1:20", "30s". */
function controlBase(ms: number): string {
  const t = roundClock(ms);
  if (t < 60_000) return `${trimNumber(t / 1000, 1)}s`;
  const minutes = t / 60_000;
  // Whole, half and quarter minutes read well as decimals (chess style "1.5+1").
  if (Number.isInteger(minutes * 4)) return trimNumber(minutes);
  const whole = Math.floor(minutes);
  const seconds = (t - whole * 60_000) / 1000;
  return `${whole}:${seconds < 10 ? "0" : ""}${trimNumber(seconds, 1)}`;
}

/** "5+0", "1.5+1", "1:20+0", "40/90+30", "10s+0.1", or "No clock". Minutes + seconds of increment. */
export function formatTimeControl(tc: TimeControl | null): string {
  if (!tc) return "No clock";
  const inc = trimNumber(tc.incMs / 1000);
  return `${tc.movesPerControl ? `${tc.movesPerControl}/` : ""}${controlBase(tc.baseMs)}+${inc}`;
}

/** Spelled-out time control for tooltips and screen readers: "5 min + 3 s per move". */
export function describeTimeControl(tc: TimeControl | null): string {
  if (!tc) return "No clock";
  const base = formatClockTime(tc.baseMs);
  const inc = tc.incMs > 0 ? ` + ${trimNumber(tc.incMs / 1000)} s per move` : "";
  const period = tc.movesPerControl ? ` for ${tc.movesPerControl} moves` : "";
  return `${base}${period}${inc}`;
}
