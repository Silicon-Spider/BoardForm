// Change notifications for the storage layer. Worker-safe (no React / DOM).
//
// Every repo write calls `emitChanges()` after its transaction has committed. Listeners registered
// with `subscribe()` in this JS context are called synchronously, and the same batch is posted on the
// BroadcastChannel "chess-builder-db" so other tabs and workers of this origin (each with their own
// copy of this module) deliver it to their listeners too. BroadcastChannel never echoes a message
// back to the channel object that sent it, so local listeners are not called twice.

import { isStoreName, type StoreName } from "./stores";

export type ChangeOp = "put" | "delete";

/**
 * One changed record. `id` is the record's key (the setting key for store "settings").
 * `id === "*"` (ALL_RECORDS) means "many / unknown records of this store changed" — it is used for
 * bulk writes (imports, clears, deleting a dataset's chunks); listeners should refresh everything
 * they show from that store.
 */
export interface ChangeEvent {
  store: StoreName;
  id: string;
  op: ChangeOp;
}

export type ChangeListener = (event: ChangeEvent) => void;

export const ALL_RECORDS = "*";
export const CHANNEL_NAME = "chess-builder-db";

/** More events than this for one store in one batch are collapsed into a single ALL_RECORDS event. */
export const COLLAPSE_THRESHOLD = 64;

const MESSAGE_TYPE = "chess-builder-db:changes";

interface ChangesMessage {
  type: typeof MESSAGE_TYPE;
  events: ChangeEvent[];
}

const listeners = new Map<StoreName | "*", Set<ChangeListener>>();

/** undefined = not created yet; null = BroadcastChannel unsupported or failed to open. */
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === "undefined") {
    channel = null;
    return null;
  }
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = (ev: MessageEvent) => receive(ev.data);
    // Node (tests) keeps the process alive while a channel is referenced; browsers have no unref.
    (ch as unknown as { unref?: () => void }).unref?.();
    channel = ch;
  } catch {
    channel = null;
  }
  return channel;
}

function isChangeEvent(v: unknown): v is ChangeEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return isStoreName(e.store) && typeof e.id === "string" && (e.op === "put" || e.op === "delete");
}

function receive(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const msg = data as Partial<ChangesMessage>;
  if (msg.type !== MESSAGE_TYPE || !Array.isArray(msg.events)) return;
  dispatch(msg.events.filter(isChangeEvent));
}

function dispatch(events: readonly ChangeEvent[]): void {
  for (const event of events) {
    for (const key of [event.store, "*"] as const) {
      const set = listeners.get(key);
      if (!set || set.size === 0) continue;
      // Copy: a listener may unsubscribe (itself or others) while we iterate.
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch (err) {
          console.error("[storage] change listener threw", err);
        }
      }
    }
  }
}

/** Replace large per-store bursts by one ALL_RECORDS event (keeps broadcast messages small). */
function collapse(events: readonly ChangeEvent[]): ChangeEvent[] {
  const counts = new Map<StoreName, number>();
  for (const e of events) counts.set(e.store, (counts.get(e.store) ?? 0) + 1);
  if (![...counts.values()].some((n) => n > COLLAPSE_THRESHOLD)) return [...events];

  const out: ChangeEvent[] = [];
  const emitted = new Set<StoreName>();
  for (const e of events) {
    if ((counts.get(e.store) ?? 0) <= COLLAPSE_THRESHOLD) {
      out.push(e);
      continue;
    }
    if (emitted.has(e.store)) continue;
    emitted.add(e.store);
    const anyPut = events.some((x) => x.store === e.store && x.op === "put");
    out.push({ store: e.store, id: ALL_RECORDS, op: anyPut ? "put" : "delete" });
  }
  return out;
}

/**
 * Listen for changes to one store (or every store with "*"): local writes after they commit, and
 * writes made in other tabs or workers. Returns an unsubscribe function.
 */
export function subscribe(store: StoreName | "*", cb: ChangeListener): () => void {
  getChannel(); // start receiving other tabs' changes
  let set = listeners.get(store);
  if (!set) {
    set = new Set();
    listeners.set(store, set);
  }
  // Wrap so subscribing the same callback twice yields two independent subscriptions.
  const entry: ChangeListener = (e) => cb(e);
  set.add(entry);
  return () => {
    set.delete(entry);
  };
}

/**
 * Announce committed changes (called by the repos). Local listeners run synchronously; the batch is
 * also broadcast to other tabs / workers unless `broadcast` is false.
 */
export function emitChanges(events: readonly ChangeEvent[], opts: { broadcast?: boolean } = {}): void {
  if (events.length === 0) return;
  const batch = collapse(events);
  dispatch(batch);
  if (opts.broadcast === false) return;
  const ch = getChannel();
  if (!ch) return;
  try {
    const message: ChangesMessage = { type: MESSAGE_TYPE, events: batch };
    ch.postMessage(message);
  } catch (err) {
    console.warn("[storage] could not broadcast changes to other tabs", err);
  }
}
