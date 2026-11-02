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
