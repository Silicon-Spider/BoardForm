// Toast notifications: toast("Saved", { kind: "success" }).
//
// - At most 3 toasts show at once (2 on narrow screens); older ones fold into a "+N more" control
//   that expands the stack. Folded toasts keep counting down and leave on their own.
// - A toast identical to one already showing (same kind, message and detail) is not stacked: the
//   existing one counts it ("×3") and starts its countdown again.
// - Countdowns pause while the pointer is over the toasts or focus is inside them.
// - Errors are announced assertively (role="alert"), the rest politely (role="status").
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  detail?: string;
  /** How long the toast stays, in ms. 0 = until dismissed (progress toasts). */
  timeoutMs?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  detail?: string;
  /** How many times this toast was raised while showing (identical toasts are merged). */
  count: number;
  timeoutMs: number;
}

/** Default display time per kind. */
export const TOAST_TIMEOUTS: Record<ToastKind, number> = { info: 4000, success: 4000, warn: 6000, error: 9000 };
/** Toasts visible at once before the rest fold into "+N more". */
export const MAX_VISIBLE_TOASTS = 3;
export const MAX_VISIBLE_TOASTS_NARROW = 2;
/** Media query for the compact layout (matches the CSS in global.css). */
export const NARROW_TOASTS_QUERY = "(max-width: 600px)";
/** Hard cap on remembered toasts; the oldest beyond this are dropped. */
const MAX_STORED = 30;
/** After a pause, a toast stays at least this long so it can still be read. */
const MIN_AFTER_RESUME_MS = 1500;

interface ToastState {
  items: ToastItem[];
}

const useToastStore = create<ToastState>(() => ({ items: [] }));
let nextId = 1;

// --- countdowns -----------------------------------------------------------------------------------

interface Countdown {
  handle: ReturnType<typeof setTimeout> | null;
  /** Time left when (re)started. */
  remaining: number;
  startedAt: number;
}

const countdowns = new Map<number, Countdown>();
let paused = false;

function startCountdown(id: number, ms: number): void {
  stopCountdown(id);
  const c: Countdown = { handle: null, remaining: ms, startedAt: Date.now() };
  if (!paused) c.handle = setTimeout(() => dismissToast(id), ms);
  countdowns.set(id, c);
}

function stopCountdown(id: number): void {
  const c = countdowns.get(id);
  if (c?.handle) clearTimeout(c.handle);
  countdowns.delete(id);
}

/** Freezes every countdown (the pointer or focus is on the toasts). */
export function pauseToasts(): void {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const c of countdowns.values()) {
    if (!c.handle) continue;
    clearTimeout(c.handle);
    c.handle = null;
    c.remaining = Math.max(0, c.remaining - (now - c.startedAt));
  }
}

/** Lets the countdowns run again. */
export function resumeToasts(): void {
  if (!paused) return;
  paused = false;
  const now = Date.now();
  for (const [id, c] of countdowns) {
    c.remaining = Math.max(c.remaining, MIN_AFTER_RESUME_MS);
    c.startedAt = now;
    c.handle = setTimeout(() => dismissToast(id), c.remaining);
  }
}

// --- public API -----------------------------------------------------------------------------------

export function dismissToast(id: number): void {
  stopCountdown(id);
  useToastStore.setState((s) => (s.items.some((t) => t.id === id) ? { items: s.items.filter((t) => t.id !== id) } : s));
}

export function dismissAllToasts(): void {
  for (const id of [...countdowns.keys()]) stopCountdown(id);
  useToastStore.setState({ items: [] });
}

/** Shows a toast and returns its id (for dismissToast). */
export function toast(message: string, opts: ToastOptions = {}): number {
  const kind = opts.kind ?? "info";
  const timeoutMs = Math.max(0, opts.timeoutMs ?? TOAST_TIMEOUTS[kind]);
  const items = useToastStore.getState().items;

  // The same news again while it is still showing: count it instead of stacking a copy. Toasts
  // that stay until dismissed (progress) are never merged, since their owners dismiss them by id.
  const twin =
    timeoutMs > 0 ? items.find((t) => t.timeoutMs > 0 && t.kind === kind && t.message === message && (t.detail ?? "") === (opts.detail ?? "")) : undefined;
  if (twin) {
    const bumped: ToastItem = { ...twin, count: twin.count + 1, timeoutMs };
    // Move it to the newest position so it is visible again if it had folded away.
    useToastStore.setState({ items: [...items.filter((t) => t.id !== twin.id), bumped] });
    startCountdown(twin.id, timeoutMs);
    return twin.id;
  }

  const id = nextId++;
  const next = [...items, { id, message, kind, detail: opts.detail, count: 1, timeoutMs }];
  // Over the cap: drop the oldest toasts that will time out anyway, then the oldest of all.
  while (next.length > MAX_STORED) {
    const victim = next.findIndex((t) => t.timeoutMs > 0);
    const [removed] = next.splice(victim >= 0 ? victim : 0, 1);
    stopCountdown(removed.id);
  }
  useToastStore.setState({ items: next });
  if (timeoutMs > 0) startCountdown(id, timeoutMs);
  return id;
}

/** Current toasts, oldest first (for tests and diagnostics). */
export function getToasts(): readonly ToastItem[] {
  return useToastStore.getState().items;
}

/** Splits toasts into the folded (older) ones and the visible (newest) ones. */
export function splitToasts<T>(items: readonly T[], limit: number, expanded: boolean): { folded: T[]; visible: T[] } {
  if (expanded || items.length <= limit) return { folded: [], visible: [...items] };
  const cut = items.length - Math.max(1, limit);
  return { folded: items.slice(0, cut), visible: items.slice(cut) };
}

// --- UI -------------------------------------------------------------------------------------------

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    if (typeof matchMedia !== "function") return () => {};
    const mql = matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  };
}
const subscribeNarrow = subscribeMedia(NARROW_TOASTS_QUERY);
const isNarrow = () => typeof matchMedia === "function" && matchMedia(NARROW_TOASTS_QUERY).matches;

const KIND_LABEL: Record<ToastKind, string> = { info: "Notice", success: "Done", warn: "Warning", error: "Error" };

function ToastIcon({ kind }: { kind: ToastKind }) {
  const d =
    kind === "success"
      ? "M5 12.5l4.5 4.5L19 7.5"
      : kind === "error"
        ? "M12 7.5v6M12 16.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"
        : kind === "warn"
          ? "M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"
          : "M12 11v6M12 7.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z";
  return (
    <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

function ToastView({ item, folded, onDismiss }: { item: ToastItem; folded: boolean; onDismiss: (id: number, viaKeyboard: boolean) => void }) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);

  // Long details are clamped to a few lines; offer "More" only when something is actually cut off.
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (!el || open || folded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [item.detail, open, folded]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDismiss(item.id, true);
    }
  };

  return (
    <div
      className={`toast ${item.kind}`}
      role={item.kind === "error" ? "alert" : "status"}
      aria-atomic="true"
      hidden={folded}
      onKeyDown={onKeyDown}
      data-toast-id={item.id}
    >
      <ToastIcon kind={item.kind} />
      <div className="toast-body">
        <div className="toast-message">
          <span className="sr-only">{KIND_LABEL[item.kind]}: </span>
          {item.message}
          {item.count > 1 && (
            <span className="toast-count" aria-label={`${item.count} times`}>
              ×{item.count}
            </span>
          )}
        </div>
        {item.detail && (
          // "small muted" kept from the earlier markup (tests and pages may select `.toast .small`).
          <div ref={detailRef} className={`toast-detail small muted ${open ? "open" : ""}`}>
            {item.detail}
          </div>
        )}
        {item.detail && (clamped || open) && (
          <button type="button" className="toast-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Less" : "More"}
          </button>
        )}
      </div>
      <button type="button" className="btn btn-ghost btn-sm btn-icon toast-close" aria-label="Dismiss notification" title="Dismiss (Esc)" onClick={(e) => onDismiss(item.id, e.detail === 0)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useToastStore((s) => s.items);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const hover = useRef(false);
  const focus = useRef(false);

  const sync = useCallback(() => (hover.current || focus.current ? pauseToasts() : resumeToasts()), []);

  const limit = narrow ? MAX_VISIBLE_TOASTS_NARROW : MAX_VISIBLE_TOASTS;
  const { folded } = splitToasts(items, limit, expanded);
  const foldedIds = new Set(folded.map((t) => t.id));
  const overflow = items.length - limit;

  // Nothing left to fold: collapse again. Nothing left at all: the pointer or focus may have been
  // on a toast that just went away without a leave/blur event, so let countdowns run.
  useEffect(() => {
    if (overflow <= 0) setExpanded(false);
    if (items.length === 0) {
      hover.current = false;
      focus.current = false;
      resumeToasts();
    }
  }, [overflow, items.length]);

  useEffect(() => () => resumeToasts(), []);

  const onDismiss = (id: number, viaKeyboard: boolean) => {
    // Keyboard users keep their place: focus moves to the next toast's close button.
    if (viaKeyboard) {
      const buttons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>(".toast:not([hidden]) .toast-close") ?? [])];
      const index = buttons.findIndex((b) => b.closest<HTMLElement>(".toast")?.dataset.toastId === String(id));
      (buttons[index + 1] ?? buttons[index - 1])?.focus();
    }
    dismissToast(id);
    // A clicked close button had focus and is now gone, without a blur event: look again at where
    // focus is once the toast has left the DOM, or the countdowns would stay paused.
    setTimeout(() => {
      focus.current = !!rootRef.current?.contains(document.activeElement);
      sync();
    }, 0);
  };

  return (
    <section
      ref={rootRef}
      className={`toaster ${expanded ? "expanded" : ""}`}
      aria-label="Notifications"
      onMouseEnter={() => {
        hover.current = true;
        sync();
      }}
      onMouseLeave={() => {
        hover.current = false;
        sync();
      }}
      onFocus={() => {
        focus.current = true;
        sync();
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        focus.current = false;
        sync();
      }}
    >
      {overflow > 0 && (
        <div className="toast-overflow">
          <button type="button" className="toast-overflow-toggle" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
            {expanded ? "Show fewer" : `+${overflow} more`}
          </button>
          <button
            type="button"
            className="toast-overflow-clear"
            onClick={() => {
              focus.current = false;
              dismissAllToasts();
            }}
          >
            Clear all
          </button>
        </div>
      )}
      <div className="toast-list">
        {items.map((t) => (
          <ToastView key={t.id} item={t} folded={foldedIds.has(t.id)} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  );
}
