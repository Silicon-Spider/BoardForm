// Formatting helpers shared by all pages.

/** 1234 → "1.2k", 1234567 → "1.23M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0) + "k";
  if (a < 1e9) return (n / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0) + "M";
  return (n / 1e9).toFixed(2) + "G";
}

/** Nodes per second → "1.2M nps". */
export function formatNps(nps: number): string {
  return formatCount(nps) + " nps";
}

/** Duration: 850 → "850 ms", 12500 → "12.5 s", 125000 → "2:05", 3725000 → "1:02:05". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const totalS = Math.round(ms / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Chess clock: 300000 → "5:00", 9800 → "0:09.8" (tenths under 20 s). */
export function formatClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 20000) {
    const tenths = Math.floor(t / 100);
    const s = Math.floor(tenths / 10);
    return `0:${String(s).padStart(2, "0")}.${tenths % 10}`;
  }
  const totalS = Math.floor(t / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Score for display: cp 35 → "+0.35", mate 3 → "M3", mate -2 → "-M2", null → "—". */
export function formatScore(cp: number | null | undefined, mate?: number | null): string {
  if (mate !== null && mate !== undefined && mate !== 0) return mate > 0 ? `M${mate}` : `-M${-mate}`;
  if (cp === null || cp === undefined || !Number.isFinite(cp)) return "—";
  const v = cp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}

/** Convert a side-to-move score to White's point of view. */
export function toWhitePov(value: number | null, sideToMove: "w" | "b"): number | null {
  if (value === null) return null;
  return sideToMove === "w" ? value : -value;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatPercent(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Pluralize: plural(3, "game") → "3 games". */
export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${formatCount(n)} ${n === 1 ? word : pluralWord}`;
}
