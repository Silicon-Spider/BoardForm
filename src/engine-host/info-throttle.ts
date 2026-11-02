// Rate limit for search info forwarded from engine.worker.ts to the main thread.
//
// Engines normally report once per completed iteration (a few dozen times per search), but a
// hand-written engine may call cb_info at every node: hundreds of thousands of messages per second
// that would freeze the page while the main thread works through them. The first `burst` reports
// of a call are forwarded as they come; after that at most one per `intervalMs`. A report that was
// held back is kept (newer ones replace it) and sent by flush(), which the worker calls before it
// answers the call, so the last info always reaches the client before the result.
//
// The worker is blocked inside the engine during a search, so this cannot use timers: it decides
// on each report, using the clock.

export interface InfoThrottleOptions {
  /** Reports forwarded unthrottled at the start of each call. */
  burst: number;
  /** Minimum gap between forwarded reports once the burst is used up. */
  intervalMs: number;
  now: () => number;
}

export const DEFAULT_INFO_THROTTLE: InfoThrottleOptions = { burst: 64, intervalMs: 10, now: () => performance.now() };

export class InfoThrottle<T> {
  private readonly opts: InfoThrottleOptions;
  private burstLeft: number;
  private lastSentAt = -Infinity;
  private pending: T | null = null;
  private droppedCount = 0;

  constructor(
    private readonly send: (info: T) => void,
    opts: Partial<InfoThrottleOptions> = {},
  ) {
    this.opts = { ...DEFAULT_INFO_THROTTLE, ...opts };
    this.burstLeft = this.opts.burst;
  }

  /** Starts a new call: a fresh burst, nothing pending. */
  reset(): void {
    this.burstLeft = this.opts.burst;
    this.lastSentAt = -Infinity;
    this.pending = null;
    this.droppedCount = 0;
  }

  push(info: T): void {
    const t = this.opts.now();
    if (this.burstLeft > 0 || t - this.lastSentAt >= this.opts.intervalMs) {
      if (this.burstLeft > 0) this.burstLeft--;
      if (this.pending !== null) {
        this.droppedCount++; // superseded by this newer report
        this.pending = null;
      }
      this.lastSentAt = t;
      this.send(info);
    } else {
      if (this.pending !== null) this.droppedCount++;
      this.pending = info;
    }
  }

  /** Sends the report held back last, if any. */
  flush(): void {
    const info = this.pending;
    if (info === null) return;
    this.pending = null;
    this.lastSentAt = this.opts.now();
    this.send(info);
  }

  /** Reports that were never forwarded (a newer one replaced them) since the last reset. */
  get dropped(): number {
    return this.droppedCount;
  }
}

// ---------------------------------------------------------------------------------------------
// Report-rate watch
//
// Merging reports is routine: at small node counts the stock search finishes its iterations
// within microseconds, so dozens of reports arrive at once, and that is fine. A real problem is
// an engine that keeps reporting far more often than once per iteration (e.g. at every node): it
// spends its time building reports nobody sees. InfoRateWatch spots that — a high rate kept up for
// a meaningful time within one call — and says so once per engine session (one worker).

export interface InfoRateOptions {
  /** A rate only counts once it has been kept up this long within one call. */
  minDurationMs: number;
  /** Reports per second above which the engine reports far more often than it needs to. */
  maxPerSecond: number;
  now: () => number;
}

export const DEFAULT_INFO_RATE: InfoRateOptions = { minDurationMs: 1000, maxPerSecond: 1000, now: () => performance.now() };

/** Start of the note posted by infoRateNote() (src/arena shows it once per engine). */
export const INFO_RATE_NOTE_PREFIX = "[host] This engine reports search info";

/** The engine log line for an engine that reports `perSecond` times a second. */
export function infoRateNote(perSecond: number): string {
  // Two significant digits: "about 52,000 times a second".
  const digits = Math.max(0, Math.floor(Math.log10(Math.max(1, perSecond))) - 1);
  const rounded = Math.round(perSecond / 10 ** digits) * 10 ** digits;
  return (
    `${INFO_RATE_NOTE_PREFIX} about ${rounded.toLocaleString("en-US")} times a second; only about ` +
    `${Math.round(1000 / DEFAULT_INFO_THROTTLE.intervalMs)} a second are shown and the rest are merged. ` +
    "Reporting once per completed iteration (cb_info) is enough and keeps the search fast."
  );
}

export class InfoRateWatch {
  private readonly opts: InfoRateOptions;
  private count = 0;
  private firstAt = 0;
  private fired = false;

  constructor(
    private readonly onExcessive: (perSecond: number) => void,
    opts: Partial<InfoRateOptions> = {},
  ) {
    this.opts = { ...DEFAULT_INFO_RATE, ...opts };
  }

  /** A new call begins: the rate is measured afresh (a warning already given stays given). */
  startCall(): void {
    this.count = 0;
  }

  /** One report arrived. Calls onExcessive (at most once per watch) when the rate is too high. */
  record(): void {
    if (this.fired) return;
    const t = this.opts.now();
    if (this.count === 0) this.firstAt = t;
    this.count++;
    const span = t - this.firstAt;
    if (span < this.opts.minDurationMs) return;
    const perSecond = ((this.count - 1) * 1000) / span; // gaps between reports per second
    if (perSecond <= this.opts.maxPerSecond) return;
    this.fired = true;
    this.onExcessive(perSecond);
  }

  /** Whether the warning was given. */
  get warned(): boolean {
    return this.fired;
  }
}
