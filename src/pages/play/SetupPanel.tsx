// New-game form: quick presets, White / Black (human or any engine, with limits, clock and hash),
// start position, move delay for engine games, and the Start button. Every change is saved
// (setting "play.lastSetup") by the page.
import { useEffect, useState, type ReactNode } from "react";
import { EnginePicker, LimitsEditor, TIME_CONTROL_PRESETS, formatTimeControl, timeControlPresetId, type EnginePickerOption } from "@/components";
import type { EngineRecord, TimeControl } from "@/types";
import { NumberInput } from "./NumberInput";
import { PlayIcon } from "./icons";
import { DEFAULT_ENGINE_LIMITS, HASH_MAX_MB, HASH_MIN_MB, PRESETS, applyPreset, hasAnyLimit, setSideClock, swapSides, type PresetId } from "./setup";
import { StartPositionField } from "./StartPositionField";
import type { GameSetup, Side, SideSetup } from "./types";

const HUMAN_OPTION: EnginePickerOption[] = [{ value: "human", label: "Human", description: "You play this side on the board" }];

/** Clock choice for a human side: presets, custom base + increment, or no clock. */
export function ClockPicker({ value, onChange, disabled, label = "Clock" }: { value: TimeControl | null; onChange(tc: TimeControl | null): void; disabled?: boolean; label?: string }) {
  const presetId = timeControlPresetId(value);
  const [customOpen, setCustomOpen] = useState(presetId === "custom");
  useEffect(() => {
    if (presetId === "custom") setCustomOpen(true);
  }, [presetId]);
  const mode = presetId === "custom" || (customOpen && value) ? "custom" : presetId;
  return (
    <div className="play-clockpicker">
      <div className="field">
        <label>{label}</label>
        <select
          className="select select-sm"
          value={mode}
          disabled={disabled}
          onChange={(e) => {
            const id = e.target.value;
            if (id === "none") {
              setCustomOpen(false);
              onChange(null);
            } else if (id === "custom") {
              setCustomOpen(true);
              if (!value) onChange({ baseMs: 300_000, incMs: 3_000 });
            } else {
              const p = TIME_CONTROL_PRESETS.find((x) => x.id === id);
              if (p) {
                setCustomOpen(false);
                onChange({ baseMs: p.baseMs, incMs: p.incMs });
              }
            }
          }}
        >
          <option value="none">No clock</option>
          {TIME_CONTROL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.category}
            </option>
          ))}
          <option value="custom">{mode === "custom" && value ? `Custom (${formatTimeControl(value)})` : "Custom…"}</option>
        </select>
      </div>
      {mode === "custom" && value && (
        <div className="play-clock-custom">
          <NumberInput label="Minutes" value={value.baseMs / 60_000} min={0.05} max={600} step={1} disabled={disabled} onCommit={(v) => v !== null && onChange({ ...value, baseMs: Math.round(v * 60_000) })} />
          <NumberInput label="Increment" suffix="s" value={value.incMs / 1000} min={0} max={600} step={1} disabled={disabled} onCommit={(v) => v !== null && onChange({ ...value, incMs: Math.round(v * 1000) })} />
        </div>
      )}
    </div>
  );
}

function SideCard({
  side,
  value,
  engines,
  onChange,
  defaultHashMb,
  disabled,
}: {
  side: Side;
  value: SideSetup;
  engines: readonly EngineRecord[] | undefined;
  onChange(next: SideSetup): void;
  defaultHashMb: number;
  disabled?: boolean;
}) {
  const engine = value.player === "engine" ? engines?.find((e) => e.id === value.engineId) : undefined;
  const engineDefaultHash = engine?.options?.hashMb ?? defaultHashMb;
  return (
    <div className="play-sidecard" data-side={side}>
      <div className="play-sidecard-head">
        <span className={`play-player-side play-player-side--${side}`} aria-hidden="true" />
        <span className="play-sidecard-title">{side === "w" ? "White" : "Black"}</span>
      </div>
      <EnginePicker
        value={value.player === "human" ? "human" : value.engineId}
        extraOptions={HUMAN_OPTION}
        disabled={disabled}
        aria-label={`${side === "w" ? "White" : "Black"} player`}
        onChange={(id) => {
          if (id === "human") onChange({ ...value, player: "human" });
          else if (id) onChange({ ...value, player: "engine", engineId: id, limits: hasAnyLimit({ ...value, player: "engine" }) ? value.limits : DEFAULT_ENGINE_LIMITS });
        }}
      />
      {value.player === "human" ? (
        <ClockPicker value={value.timeControl} onChange={(tc) => onChange({ ...value, timeControl: tc })} disabled={disabled} />
      ) : (
        <>
          <LimitsEditor
            compact
            disabled={disabled}
            value={{ limits: value.limits, timeControl: value.timeControl }}
            onChange={(v) => onChange({ ...value, limits: v.limits, timeControl: v.timeControl })}
          />
          <NumberInput
            label="Hash table"
            suffix="MB"
            value={value.hashMb}
            min={HASH_MIN_MB}
            max={HASH_MAX_MB}
            integer
            allowEmpty
            disabled={disabled}
            placeholder={`${engineDefaultHash} (engine default)`}
            onCommit={(v) => onChange({ ...value, hashMb: v })}
          />
        </>
      )}
    </div>
  );
}

export interface SetupPanelProps {
  setup: GameSetup;
  engines: readonly EngineRecord[] | undefined;
  onChange(next: GameSetup): void;
  onStart(): void;
  problems: string[];
  defaultHashMb: number;
  moveDelayMs: number;
  onMoveDelay(ms: number): void;
  /** Callouts above the form (link problems, unfinished game...). */
  notices?: ReactNode;
  starting?: boolean;
}

export function SetupPanel({ setup, engines, onChange, onStart, problems, defaultHashMb, moveDelayMs, onMoveDelay, notices, starting }: SetupPanelProps) {
  const noEngines = engines !== undefined && engines.length === 0;
  const bothEngines = setup.white.player === "engine" && setup.black.player === "engine";
  /** One side changed; with linked clocks a new clock applies to both sides. */
  const update = (side: Side, next: SideSetup) => {
    const prev = side === "w" ? setup.white : setup.black;
    const s: GameSetup = side === "w" ? { ...setup, white: next } : { ...setup, black: next };
    onChange(JSON.stringify(prev.timeControl) !== JSON.stringify(next.timeControl) ? setSideClock(s, side, next.timeControl) : s);
  };
  const preset = (id: PresetId) => engines && onChange(applyPreset(setup, id, engines));

  return (
    <div className="play-setup">
      {notices}
      <section>
        <h3 className="section-title">Quick start</h3>
        <div className="play-presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="play-preset" disabled={!engines || noEngines} onClick={() => preset(p.id)}>
              <span className="play-preset-label">{p.label}</span>
              <span className="play-preset-detail">{p.detail}</span>
            </button>
          ))}
        </div>
      </section>

      {noEngines && (
        <div className="callout warn">
          You have no engines yet, so only human players are available. <a href="#/engines?new=1">Create an engine</a> to play against it.
        </div>
      )}

      <section className="play-setup-players">
        <h3 className="section-title">Players</h3>
        <SideCard side="w" value={setup.white} engines={engines} defaultHashMb={defaultHashMb} onChange={(s) => update("w", s)} />
        <div className="play-swap">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(swapSides(setup))} title="Swap White and Black">
            <PlayIcon name="swap" /> Swap colours
          </button>
          <label className="checkbox small">
            <input type="checkbox" checked={setup.sameClock} onChange={(e) => onChange({ ...setup, sameClock: e.target.checked })} />
            <span>Same clock for both sides</span>
          </label>
        </div>
        <SideCard side="b" value={setup.black} engines={engines} defaultHashMb={defaultHashMb} onChange={(s) => update("b", s)} />
      </section>

      <section>
        <h3 className="section-title">Start position</h3>
        <StartPositionField value={setup.start} onChange={(start) => onChange({ ...setup, start })} />
      </section>

      {bothEngines && (
        <section>
          <h3 className="section-title">Watching</h3>
          <MoveDelaySlider value={moveDelayMs} onChange={onMoveDelay} />
        </section>
      )}

      <div className="play-setup-start">
        {problems.length > 0 && (
          <ul className="play-problems" aria-live="polite">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <button type="button" className="btn btn-primary btn-lg play-start-button" disabled={problems.length > 0 || starting} onClick={onStart}>
          <PlayIcon name="flag" /> Start game
        </button>
      </div>
    </div>
  );
}

export function MoveDelaySlider({ value, onChange, disabled }: { value: number; onChange(ms: number): void; disabled?: boolean }) {
  return (
    <label className="play-delay">
      <span className="row-between">
        <span className="field-label">Move delay</span>
        <span className="small num muted">{value === 0 ? "None" : `${(value / 1000).toFixed(1)} s`}</span>
      </span>
      <input type="range" min={0} max={2000} step={100} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label="Move delay in milliseconds" />
      <span className="field-hint">Pause between engine moves so you can follow the game.</span>
    </label>
  );
}
