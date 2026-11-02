// User preferences shared by every page. The Settings page edits them; boards, engines and
// background services read them. Stored in the IndexedDB `settings` store (via useSetting), except
// the colour theme, which lives in localStorage so it can be applied before the first paint.
import { useEffect } from "react";
import { settingsRepo, useSetting } from "@/storage";

// --- colour theme (dark / light / follow the system) ------------------------------------------

export type ThemePreference = "dark" | "light" | "system";
const THEME_STORAGE_KEY = "cb.theme";
const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function getThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

/** Applies a theme preference to <html data-theme> (resolving "system" now). */
export function applyTheme(pref: ThemePreference = getThemePreference()): void {
  const resolved = pref === "system" ? (systemDark() ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Private mode etc.: the theme still applies for this session.
  }
  applyTheme(pref);
}

/** Keeps a "system" theme in sync with the OS setting. Call once at start-up. */
export function watchSystemTheme(): void {
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}

// --- board appearance -------------------------------------------------------------------------

export type BoardTheme = "wood" | "green" | "blue" | "gray" | "purple";

export const BOARD_THEMES: Record<BoardTheme, { label: string; light: string; dark: string }> = {
  wood: { label: "Wood", light: "#e9d9b9", dark: "#b08862" },
  green: { label: "Green", light: "#eeeed2", dark: "#769656" },
  blue: { label: "Blue", light: "#dee3e6", dark: "#8ca2ad" },
  gray: { label: "Slate", light: "#d9d9d9", dark: "#8a8f98" },
  purple: { label: "Purple", light: "#e5dcf0", dark: "#9a7fbf" },
};

export interface BoardPreferences {
  theme: BoardTheme;
  showCoordinates: boolean;
  /** Piece animation duration; 0 = no animation. */
  animationMs: number;
  /** Dots on the squares the selected piece can move to. */
  showLegalMoves: boolean;
  /** Arrows for the engine's best line on the Play page. */
  showEngineArrows: boolean;
}

export const DEFAULT_BOARD_PREFERENCES: BoardPreferences = {
  theme: "wood",
  showCoordinates: true,
  animationMs: 160,
  showLegalMoves: true,
  showEngineArrows: true,
};

export const BOARD_PREFERENCES_KEY = "prefs.board";

/** Board preferences (merged over the defaults, so new fields get their default) and a setter. */
export function useBoardPreferences(): [BoardPreferences, (next: BoardPreferences) => void] {
  const [stored, setStored] = useSetting<Partial<BoardPreferences>>(BOARD_PREFERENCES_KEY, DEFAULT_BOARD_PREFERENCES);
  return [{ ...DEFAULT_BOARD_PREFERENCES, ...stored }, setStored];
}

/** Props to spread into every <Chessboard> / <MiniBoard>-like board so they follow the settings. */
export function useBoardProps(): { showCoordinates: boolean; animationMs: number; showLegalMoves: boolean } {
  const [p] = useBoardPreferences();
  return { showCoordinates: p.showCoordinates, animationMs: p.animationMs, showLegalMoves: p.showLegalMoves };
}

/** Applies the board colour theme as CSS variables on <html>. Rendered once by the app shell. */
export function useApplyBoardTheme(): void {
  const [p] = useBoardPreferences();
  useEffect(() => {
    const t = BOARD_THEMES[p.theme] ?? BOARD_THEMES.wood;
    const root = document.documentElement.style;
    root.setProperty("--board-light", t.light);
    root.setProperty("--board-dark", t.dark);
    root.setProperty("--board-coord-light", t.dark);
    root.setProperty("--board-coord-dark", t.light);
  }, [p.theme]);
}

// --- engines & background work ---------------------------------------------------------------

/** Default transposition table size (MiB) for engines that do not set their own. */
export const DEFAULT_HASH_KEY = "prefs.defaultHashMb";
export const DEFAULT_HASH_MB = 16;

/**
 * Upper bound on worker threads used by background work (self-play workers, arena games running
 * at once, trainer threads). Pages offer it as the default and maximum of their concurrency fields.
 */
export const MAX_WORKERS_KEY = "prefs.maxWorkers";

/** A sensible default: leave two cores for the page and the OS. */
export function defaultMaxWorkers(): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(16, cores - 2));
}

export function useDefaultHashMb(): [number, (mb: number) => void] {
  return useSetting<number>(DEFAULT_HASH_KEY, DEFAULT_HASH_MB);
}

export function useMaxWorkers(): [number, (n: number) => void] {
  return useSetting<number>(MAX_WORKERS_KEY, defaultMaxWorkers());
}

// Non-React readers for services (arena, training) that run outside components.

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

export async function getMaxWorkers(): Promise<number> {
  const fallback = defaultMaxWorkers();
  return clampInt(await settingsRepo.get<unknown>(MAX_WORKERS_KEY, fallback), 1, 64, fallback);
}

export async function getDefaultHashMb(): Promise<number> {
  return clampInt(await settingsRepo.get<unknown>(DEFAULT_HASH_KEY, DEFAULT_HASH_MB), 1, 512, DEFAULT_HASH_MB);
}
