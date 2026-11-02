// Settings → Appearance: colour theme and board appearance, with a live board preview.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  BOARD_THEMES,
  getThemePreference,
  setThemePreference,
  useBoardPreferences,
  useBoardProps,
  type BoardPreferences,
  type BoardTheme,
  type ThemePreference,
} from "@/app/preferences";
import { ChessGame, START_FEN, type MoveInput } from "@/chess";
import { Chessboard, Icon } from "@/components";
import { PageIcon } from "@/pages/engines/icons";
import { cx } from "@/pages/engines/ui";
import { Segmented, SettingRow, SettingsSection, Switch } from "./controls";
import { ANIMATION_PRESETS, demoMove, nearestAnimationPreset } from "./settings-logic";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", icon: <PageIcon name="moon" size={14} /> },
  { value: "light", label: "Light", icon: <PageIcon name="sun" size={14} /> },
  { value: "system", label: "System", icon: <PageIcon name="monitor" size={14} /> },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; icon: ReactNode }>;

const systemPrefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Whether the device currently prefers a dark theme (updates when the OS setting changes). */
function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const [prefs, setPrefs] = useBoardPreferences();
  const systemDark = useSystemPrefersDark();
  const update = (patch: Partial<BoardPreferences>) => setPrefs({ ...prefs, ...patch });

  const chooseTheme = (value: ThemePreference) => {
    setThemePreference(value);
    setTheme(value);
  };

  return (
    <SettingsSection id="appearance" title="Appearance" icon={<PageIcon name="palette" size={18} />} description="How the app and its chess boards look. Changes apply immediately.">
      <SettingRow
        title="Colour theme"
        titleId="settings-theme-label"
        description={theme === "system" ? `Follows your device — currently ${systemDark ? "dark" : "light"}.` : "Dark is easier on the eyes for long sessions; light suits bright rooms."}
      >
        <Segmented options={THEME_OPTIONS} value={theme} onChange={chooseTheme} labelledBy="settings-theme-label" />
      </SettingRow>

      <div className="settings-board">
        <div className="settings-board-options">
          <SettingRow title="Board colours" titleId="settings-board-theme-label" stacked>
            <BoardThemePicker value={prefs.theme} onChange={(t) => update({ theme: t })} />
          </SettingRow>
          <SettingRow title="Coordinates" description="Files a–h and ranks 1–8 along the board edges.">
            <Switch label="Show coordinates" checked={prefs.showCoordinates} onChange={(v) => update({ showCoordinates: v })} />
          </SettingRow>
          <SettingRow title="Piece animation" titleId="settings-animation-label" description="How pieces slide when a move is played.">
            <Segmented
              options={ANIMATION_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.ms ? `${p.ms} ms` : "No animation" }))}
              value={nearestAnimationPreset(prefs.animationMs)}
              onChange={(v) => update({ animationMs: ANIMATION_PRESETS.find((p) => p.value === v)?.ms ?? 160 })}
              labelledBy="settings-animation-label"
            />
          </SettingRow>
          <SettingRow title="Legal-move dots" description="Mark the squares the selected piece can move to.">
            <Switch label="Show legal-move dots" checked={prefs.showLegalMoves} onChange={(v) => update({ showLegalMoves: v })} />
          </SettingRow>
          <SettingRow title="Engine arrows" description="Draw the engine's best move as an arrow while it analyses on the Play page.">
            <Switch label="Show engine arrows" checked={prefs.showEngineArrows} onChange={(v) => update({ showEngineArrows: v })} />
          </SettingRow>
        </div>
        <BoardPreview showArrow={prefs.showEngineArrows} />
      </div>
    </SettingsSection>
  );
}

function BoardThemePicker({ value, onChange }: { value: BoardTheme; onChange: (theme: BoardTheme) => void }) {
  const ids = Object.keys(BOARD_THEMES) as BoardTheme[];
  return (
    <div
      className="settings-board-themes"
      role="radiogroup"
      aria-labelledby="settings-board-theme-label"
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = ids[(Math.max(0, ids.indexOf(value)) + step + ids.length) % ids.length];
        onChange(next);
        e.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-id="${next}"]`)?.focus();
      }}
    >
      {ids.map((id) => {
        const t = BOARD_THEMES[id];
        const checked = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-theme-id={id}
            className={cx("settings-board-theme", checked && "is-selected")}
            onClick={() => onChange(id)}
          >
            <span className="settings-board-swatch" style={{ "--sq-light": t.light, "--sq-dark": t.dark } as CSSProperties} aria-hidden="true">
              {checked && <Icon name="check" size={14} />}
            </span>
            <span className="settings-board-theme-label">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A small playable board that shows the current settings (theme, coordinates, animation, dots, arrows). */
function BoardPreview({ showArrow }: { showArrow: boolean }) {
  const boardProps = useBoardProps();
  const [game, setGame] = useState(() => new ChessGame());
  const [fen, setFen] = useState(START_FEN);
  const suggestion = useMemo(() => demoMove(fen), [fen]);

  const play = (move: MoveInput | string) => {
    if (game.play(move)) setFen(game.fen());
  };
  const reset = () => {
    setGame(new ChessGame());
    setFen(START_FEN);
  };

  return (
    <figure className="settings-preview">
      <div className="settings-preview-board">
        <Chessboard
          {...boardProps}
          fen={fen}
          onMove={play}
          lastMove={game.lastMove()}
          arrows={showArrow && suggestion ? [{ from: suggestion.slice(0, 2), to: suggestion.slice(2, 4) }] : []}
          aria-label="Board preview"
        />
      </div>
      <figcaption className="settings-preview-caption">
        <span className="small muted">Preview — try a move on the board.</span>
        <span className="settings-preview-actions">
          <button type="button" className="btn btn-sm" onClick={() => suggestion && play(suggestion)} disabled={!suggestion} title="Play the move the arrow shows">
            <Icon name="play" size={13} /> Play a move
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={reset} disabled={fen === START_FEN} title="Back to the start position">
            <Icon name="reset" size={13} /> Reset
          </button>
        </span>
      </figcaption>
    </figure>
  );
}
