// React glue for the Play page: controller / session subscriptions, a debounced persistent state,
// clipboard and page-level keyboard shortcuts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/app/toast";
import { settingsRepo } from "@/storage";
import { AnalysisSession, type AnalysisDeps, type AnalysisState } from "./analysis-session";
import type { GameController, GameState } from "./controller";

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

/** The controller's state (null without a controller). */
export function useGameState(controller: GameController | null): GameState | null {
  return useSyncExternalStore(controller ? controller.subscribe : noopSubscribe, controller ? controller.getState : nullSnapshot, controller ? controller.getState : nullSnapshot);
}

/**
 * An AnalysisSession for the lifetime of the component (created in an effect so StrictMode's
 * mount → unmount → mount does not leave a disposed session behind).
 */
export function useAnalysisSession(deps: AnalysisDeps): [AnalysisState | null, AnalysisSession | null] {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [session, setSession] = useState<AnalysisSession | null>(null);
  useEffect(() => {
    const s = new AnalysisSession({ createEngine: (id, opts) => depsRef.current.createEngine(id, opts) });
    setSession(s);
    return () => s.dispose();
  }, []);
  const state = useSyncExternalStore(session ? session.subscribe : noopSubscribe, session ? session.getState : nullSnapshot, session ? session.getState : nullSnapshot);
  return [state, session];
}

/**
 * State persisted in the settings store with debounced writes (for values that change often, such
 * as the analysis board). Returns [value, set, loaded]; `fallback` is used until the stored value
 * is read. Pending writes are flushed when the page is hidden or the component unmounts.
 */
export function usePersistentState<T>(key: string, fallback: T, parse: (raw: unknown) => T, debounceMs = 400): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const [state, setState] = useState<{ value: T; loaded: boolean }>({ value: fallback, loaded: false });
  const latest = useRef<T>(fallback);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    let cancelled = false;
    settingsRepo
      .get<unknown>(key, undefined)
      .then((raw) => {
        if (cancelled) return;
        setState((s) => {
          if (s.loaded) return s; // the user already changed it
          const value = raw === undefined ? s.value : parseRef.current(raw);
          latest.current = value;
          return { value, loaded: true };
        });
      })
      .catch((err: unknown) => {
        console.error(`[play] could not read "${key}"`, err);
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    settingsRepo.set(key, latest.current).catch((err: unknown) => {
      console.error(`[play] could not save "${key}"`, err);
      toast("Could not save the analysis board", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    });
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const value = typeof next === "function" ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = value;
      dirty.current = true;
      setState({ value, loaded: true });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, debounceMs);
    },
    [flush, debounceMs],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  return [state.value, set, state.loaded];
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, { kind: "success", timeoutMs: 2000 });
  } catch {
    toast(`Could not copy the ${what.toLowerCase()}`, { kind: "error", detail: "The browser blocked clipboard access." });
  }
}

/** True when a key event belongs to a text field, a menu or a dialog rather than the page. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!t.closest('[role="listbox"], [role="dialog"], [role="tablist"], [role="menu"], .cb-chart-box');
}

/**
 * Page-level shortcuts while no field has focus: ←/→ (and Home/End) step through the moves,
 * F flips the board. Ignored while a dialog is open.
 */
export function useBoardKeys(handlers: { step(delta: number): void; first(): void; last(): void; flip(): void }): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e)) return;
      if (document.querySelector(".modal-backdrop")) return;
      const h = ref.current;
      switch (e.key) {
        case "ArrowLeft":
          h.step(-1);
          break;
        case "ArrowRight":
          h.step(1);
          break;
        case "Home":
          h.first();
          break;
        case "End":
          h.last();
          break;
        case "f":
        case "F":
          h.flip();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
