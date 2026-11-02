// EngineDraft: the Workshop's autosave store for one engine.
//
// The editors render `view` = the newest stored record with every unsaved edit applied on top, so
// what the user typed is always what they see — a store round trip (our own save coming back
// through the storage hooks, a build saving its result, ...) never resets an editor.
//
// * edit(patch) applies a patch at once and schedules a save (debounced, default 500 ms).
// * Saves go through `save(id, patch)` (enginesRepo.update: a shallow merge in one transaction),
//   one at a time; edits made while a save is running are saved right after it.
// * A failed save keeps the edits (they are retried with the next edit or flush()) and reports
//   the error; an engine that no longer exists ("gone") stops saving.
// * close() (page unmount) flushes and switches to "save immediately", so late changes — e.g. the
//   blocks editor delivering its last debounced edit while it unmounts — are not lost.
//
// No React and no storage imports: the page wires it up (useDraft.ts), tests drive it directly.
import type { EngineRecord } from "@/types";

export type SaveState = "saved" | "pending" | "saving" | "error";

export interface DraftSnapshot {
  /** What the editors show: the newest stored record plus all unsaved edits. */
  view: EngineRecord;
  /** The newest stored record (without unsaved edits). */
  saved: EngineRecord;
  state: SaveState;
  /** Message of the last failed save (cleared by the next successful one). */
  error: string | null;
  /** The engine was deleted: nothing is saved any more. */
  gone: boolean;
}

export type SaveFn = (id: string, patch: Partial<EngineRecord>) => Promise<EngineRecord>;

export interface DraftOptions {
  /** Debounce before an edit is written. Default 500 ms. */
  delayMs?: number;
  /** True when a save error means the record no longer exists (stop retrying). */
  isGoneError?: (err: unknown) => boolean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const timeOf = (r: EngineRecord) => (typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0);

export class EngineDraft {
  private base: EngineRecord;
  private pending: Partial<EngineRecord> = {};
  private hasPending = false;
  private inFlight: Partial<EngineRecord> | null = null;
  private writing: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private error: string | null = null;
  private gone = false;
  private immediate = false;
  private snapshot: DraftSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly delayMs: number;
  private readonly isGoneError: (err: unknown) => boolean;

  constructor(
    initial: EngineRecord,
    private readonly save: SaveFn,
    opts: DraftOptions = {},
  ) {
    this.base = initial;
    this.delayMs = opts.delayMs ?? 500;
    this.isGoneError = opts.isGoneError ?? (() => false);
    this.snapshot = this.compute();
  }

  get id(): string {
    return this.base.id;
  }

  readonly getSnapshot = (): DraftSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current view (shortcut for getSnapshot().view). */
  get view(): EngineRecord {
    return this.snapshot.view;
  }

  /** True while edits are waiting or being written. */
  get dirty(): boolean {
    return this.hasPending || this.writing !== null;
  }

  /** A stored version of the record (from the storage hooks or a save result); older ones are ignored. */
  receive(record: EngineRecord): void {
    if (record.id !== this.base.id || record === this.base) return;
    if (timeOf(record) < timeOf(this.base)) return;
    this.base = record;
    this.publish();
  }

  /** Applies an edit now and schedules saving it. */
  edit(patch: Partial<EngineRecord>): void {
    if (this.gone) return;
    this.pending = { ...this.pending, ...patch };
    this.hasPending = true;
    if (this.immediate) void this.flush();
    else this.schedule();
    this.publish();
  }

  /**
   * Writes every unsaved edit now. Resolves true when everything is saved, false when a save
   * failed (the edits are kept and the error is in the snapshot) or the engine is gone.
   */
  async flush(): Promise<boolean> {
    this.clearTimer();
    for (;;) {
      if (this.gone) return false;
      if (this.writing) {
        if (!(await this.writing)) return false;
        continue;
      }
      if (!this.hasPending) return this.error === null;
      if (!(await this.startWrite())) return false;
    }
  }

  /** Forgets unsaved edits and stops saving (used right before the engine is deleted). */
  discard(): void {
    this.clearTimer();
    this.pending = {};
    this.hasPending = false;
    this.gone = true;
    this.publish();
  }

  /** Page unmount: save what is left and save later edits immediately. */
  close(): void {
    this.immediate = true;
    void this.flush();
  }

  /** (Re)mount: back to debounced saving. */
  open(): void {
    this.immediate = false;
  }

  // --- internals ---------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private startWrite(): Promise<boolean> {
    const patch = this.pending;
    this.pending = {};
    this.hasPending = false;
    this.inFlight = patch;
    const run: Promise<boolean> = this.write(patch).then((ok) => {
      if (this.writing === run) this.writing = null;
      this.publish();
      return ok;
    });
    this.writing = run;
    this.publish();
    return run;
  }

  /** One save; never rejects (failures are recorded in the state). */
  private async write(patch: Partial<EngineRecord>): Promise<boolean> {
    try {
      const stored = await this.save(this.base.id, patch);
      this.inFlight = null;
      this.error = null;
      if (stored && stored.id === this.base.id && timeOf(stored) >= timeOf(this.base)) this.base = stored;
      return true;
    } catch (err) {
      this.inFlight = null;
      this.error = messageOf(err);
      if (this.isGoneError(err)) {
        this.gone = true;
      } else {
        // Keep the edits: newer ones (made during the write) win over the failed patch.
        this.pending = { ...patch, ...this.pending };
        this.hasPending = true;
      }
      return false;
    }
  }

  private compute(): DraftSnapshot {
    const view: EngineRecord =
      this.inFlight === null && !this.hasPending ? this.base : { ...this.base, ...(this.inFlight ?? {}), ...this.pending, id: this.base.id };
    const state: SaveState = this.writing ? "saving" : this.error !== null || this.gone ? "error" : this.hasPending ? "pending" : "saved";
    return { view, saved: this.base, state, error: this.gone && this.error === null ? "This engine no longer exists." : this.error, gone: this.gone };
  }

  private publish(): void {
    this.snapshot = this.compute();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("EngineDraft listener failed", err);
      }
    }
  }
}
