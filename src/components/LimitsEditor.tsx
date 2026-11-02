// Editor for how long an engine may think: a time control (presets, custom, or no clock) plus
// optional caps on depth, nodes ("max positions searched") and time per move.
import { useEffect, useId, useRef, useState } from "react";
import type { EngineLimits, TimeControl } from "@/types";
import { formatCount } from "@/utils/format";
import "./LimitsEditor.css";

export interface LimitsValue {
  limits: EngineLimits;
  /** null = no clock (limits only). */
  timeControl: TimeControl | null;
}

export interface LimitsEditorProps {
  value: LimitsValue;
  onChange: (value: LimitsValue) => void;
  /** Offer clock settings. Default true (false = caps only; timeControl is left untouched). */
  allowClock?: boolean;
  /** Dense single-block layout for tables and sidebars. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}

export interface TimeControlPreset {
  id: string;
  label: string;
  category: string;
  baseMs: number;
  incMs: number;
}

export const TIME_CONTROL_PRESETS: readonly TimeControlPreset[] = [
  { id: "1+0", label: "1+0", category: "Bullet", baseMs: 60_000, incMs: 0 },
  { id: "3+2", label: "3+2", category: "Blitz", baseMs: 180_000, incMs: 2_000 },
  { id: "5+0", label: "5+0", category: "Blitz", baseMs: 300_000, incMs: 0 },
  { id: "10+5", label: "10+5", category: "Rapid", baseMs: 600_000, incMs: 5_000 },
  { id: "15+10", label: "15+10", category: "Rapid", baseMs: 900_000, incMs: 10_000 },
  { id: "30+0", label: "30+0", category: "Classical", baseMs: 1_800_000, incMs: 0 },
];

const DEFAULT_CAPS: Required<EngineLimits> = { depth: 8, nodes: 100_000, movetimeMs: 1_000 };

/** Preset id for a time control, "none" for no clock, "custom" otherwise. */
export function timeControlPresetId(tc: TimeControl | null): string {
  if (!tc) return "none";
  const p = TIME_CONTROL_PRESETS.find((x) => x.baseMs === tc.baseMs && x.incMs === tc.incMs && !tc.movesPerControl);
  return p ? p.id : "custom";
}

function trimNumber(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

/** "5+0", "0.5+1", "40/90+30", "20s+0.1", or "No clock". */
export function formatTimeControl(tc: TimeControl | null): string {
  if (!tc) return "No clock";
  const base = tc.baseMs < 60_000 && tc.baseMs % 1000 === 0 ? `${tc.baseMs / 1000}s` : trimNumber(tc.baseMs / 60_000);
  const inc = trimNumber(tc.incMs / 1000);
  return `${tc.movesPerControl ? `${tc.movesPerControl}/` : ""}${base}+${inc}`;
}

/** One-line summary, e.g. "5+0 · depth 12 · 1M nodes · 0.5 s/move". */
export function describeLimits(v: LimitsValue): string {
  const parts: string[] = [];
  if (v.timeControl) parts.push(formatTimeControl(v.timeControl));
  if (v.limits.depth) parts.push(`depth ${v.limits.depth}`);
  if (v.limits.nodes) parts.push(`${formatCount(v.limits.nodes)} nodes`);
  if (v.limits.movetimeMs) parts.push(`${trimNumber(v.limits.movetimeMs / 1000, 3)} s/move`);
  return parts.length ? parts.join(" · ") : "No limits";
}

// ------------------------------------------------------------------------------------------
// Number field with its own text state (so partial input like "" or "1." is allowed while typing)

interface NumberRule {
  min: number;
  max: number;
  integer?: boolean;
  /** Empty input is valid and means null. */
  allowEmpty?: boolean;
  unit?: string;
}

function parseNumber(text: string, rule: NumberRule): { value: number | null; error?: string } {
  const t = text.trim().replace(",", ".");
  if (t === "") return rule.allowEmpty ? { value: null } : { value: null, error: "Required" };
  const v = Number(t);
  if (!Number.isFinite(v)) return { value: null, error: "Enter a number" };
  if (rule.integer && !Number.isInteger(v)) return { value: null, error: "Whole numbers only" };
  if (v < rule.min) return { value: null, error: `At least ${rule.min}${rule.unit ? " " + rule.unit : ""}` };
  if (v > rule.max) return { value: null, error: `At most ${formatCount(rule.max)}${rule.unit ? " " + rule.unit : ""}` };
  return { value: v };
}

const close = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));

function NumberField(props: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  rule: NumberRule;
  suffix?: string;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  /** Keep the label for screen readers only (a visible checkbox already names the field). */
  labelHidden?: boolean;
  onError?: (field: string, error: string | null) => void;
}) {
  const { label, value, onCommit, rule, suffix, step, placeholder, disabled, compact, labelHidden, onError } = props;
  const id = useId();
  const show = (v: number | null) => (v === null ? "" : trimNumber(v, 4));
  const [text, setText] = useState(show(value));
  const [error, setError] = useState<string | null>(null);

  // Follow external value changes unless the text already means that value.
  useEffect(() => {
    setText((t) => {
      const p = parseNumber(t, rule);
      return !p.error && close(p.value, value) ? t : show(value);
    });
    setError(null);
  }, [value]); // `rule` is a constant per field

  useEffect(() => {
    onError?.(label, error);
  }, [error, label, onError]);

  return (
    <div className={"field cb-limits-field" + (compact ? " cb-limits-field--compact" : "")}>
      <label htmlFor={id} className={labelHidden ? "cb-sr-only" : undefined}>
        {label}
      </label>
      <div className="cb-limits-input">
        <input
          id={id}
          className={"input" + (compact ? " input-sm" : "") + (error ? " cb-input-error" : "")}
          type="text"
          inputMode={rule.integer ? "numeric" : "decimal"}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const p = parseNumber(e.target.value, rule);
            setError(p.error ?? null);
            if (!p.error) onCommit(p.value);
          }}
          onKeyDown={(e) => {
            if (!step || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            const p = parseNumber(text, rule);
            const base = p.value ?? (e.key === "ArrowUp" ? rule.min - step : rule.min);
            const next = Math.min(rule.max, Math.max(rule.min, Number((base + (e.key === "ArrowUp" ? step : -step)).toFixed(4))));
            setText(show(next));
            setError(null);
            onCommit(next);
          }}
          onBlur={() => {
            if (!error) setText(show(value));
          }}
        />
        {suffix && <span className="cb-limits-suffix">{suffix}</span>}
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------

const RULES = {
  base: { min: 0.05, max: 600, unit: "minutes" },
  inc: { min: 0, max: 600, unit: "seconds" },
  moves: { min: 1, max: 200, integer: true, allowEmpty: true },
  depth: { min: 1, max: 99, integer: true, allowEmpty: true },
  nodes: { min: 1, max: 1e12, integer: true, allowEmpty: true },
  movetime: { min: 0.001, max: 3600, unit: "seconds", allowEmpty: true },
} satisfies Record<string, NumberRule>;

export function LimitsEditor({ value, onChange, allowClock = true, compact, disabled, className }: LimitsEditorProps) {
  const { limits, timeControl } = value;
  const presetId = timeControlPresetId(timeControl);
  const [customOpen, setCustomOpen] = useState(presetId === "custom");
  const mode = presetId === "custom" || (customOpen && timeControl) ? "custom" : presetId;
  const errors = useRef(new Map<string, string>());
  const [, forceRender] = useState(0);
  const onError = useRef((field: string, error: string | null) => {
    const had = errors.current.has(field);
    if (error) errors.current.set(field, error);
    else errors.current.delete(field);
    if (had !== !!error) forceRender((n) => n + 1);
  }).current;

  useEffect(() => {
    if (presetId === "custom") setCustomOpen(true);
  }, [presetId]);

  const setTc = (tc: TimeControl | null) => onChange({ limits, timeControl: tc });
  const setCap = (key: keyof EngineLimits, v: number | null | undefined) => {
    const next: EngineLimits = { ...limits };
    if (v === null || v === undefined || v <= 0) delete next[key];
    else next[key] = v;
    onChange({ limits: next, timeControl });
  };

  const choose = (id: string) => {
    if (id === "none") {
      setCustomOpen(false);
      setTc(null);
    } else if (id === "custom") {
      setCustomOpen(true);
      if (!timeControl) setTc({ baseMs: 300_000, incMs: 3_000 });
    } else {
      const p = TIME_CONTROL_PRESETS.find((x) => x.id === id);
      if (p) {
        setCustomOpen(false);
        setTc({ baseMs: p.baseMs, incMs: p.incMs });
      }
    }
  };

  const noLimits = !timeControl && !limits.depth && !limits.nodes && !limits.movetimeMs;

  const customFields = timeControl && mode === "custom" && (
    <div className="cb-limits-custom">
      <NumberField
        label="Base time"
        suffix="min"
        step={1}
        compact={compact}
        disabled={disabled}
        value={timeControl.baseMs / 60_000}
        rule={RULES.base}
        onError={onError}
        onCommit={(v) => v !== null && setTc({ ...timeControl, baseMs: Math.round(v * 60_000) })}
      />
      <NumberField
        label="Increment"
        suffix="s / move"
        step={1}
        compact={compact}
        disabled={disabled}
        value={timeControl.incMs / 1000}
        rule={RULES.inc}
        onError={onError}
        onCommit={(v) => v !== null && setTc({ ...timeControl, incMs: Math.round(v * 1000) })}
      />
      <NumberField
        label="Moves per control"
        placeholder="whole game"
        step={1}
        compact={compact}
        disabled={disabled}
        value={timeControl.movesPerControl ?? null}
        rule={RULES.moves}
        onError={onError}
        onCommit={(v) => {
          const next: TimeControl = { baseMs: timeControl.baseMs, incMs: timeControl.incMs };
          if (v) next.movesPerControl = v;
          setTc(next);
        }}
      />
    </div>
  );

  const caps: Array<{ key: keyof EngineLimits; label: string; hint: string; suffix?: string; rule: NumberRule; toView: (v: number) => number; fromView: (v: number) => number; step: number }> = [
    { key: "depth", label: "Depth", hint: "plies", suffix: "plies", rule: RULES.depth, toView: (v) => v, fromView: (v) => v, step: 1 },
    { key: "nodes", label: "Max positions searched (nodes)", hint: "nodes", rule: RULES.nodes, toView: (v) => v, fromView: (v) => v, step: 1000 },
    { key: "movetimeMs", label: "Time per move", hint: "seconds", suffix: "s", rule: RULES.movetime, toView: (v) => v / 1000, fromView: (v) => Math.max(1, Math.round(v * 1000)), step: 0.5 },
  ];

  if (compact) {
    return (
      <div className={["cb-limits", "cb-limits--compact", className].filter(Boolean).join(" ")}>
        {allowClock && (
          <div className="field">
            <label>Clock</label>
            <select className="select select-sm" value={mode} disabled={disabled} onChange={(e) => choose(e.target.value)}>
              {TIME_CONTROL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.category}
                </option>
              ))}
              <option value="custom">Custom…</option>
              <option value="none">No clock</option>
            </select>
          </div>
        )}
        {allowClock && customFields}
        <div className="cb-limits-caps cb-limits-caps--compact">
          {caps.map((c) => (
            <NumberField
              key={c.key}
              compact
              label={c.label}
              placeholder="no cap"
              suffix={c.suffix}
              step={c.step}
              disabled={disabled}
              value={limits[c.key] ? c.toView(limits[c.key]!) : null}
              rule={c.rule}
              onError={onError}
              onCommit={(v) => setCap(c.key, v === null ? null : c.fromView(v))}
            />
          ))}
        </div>
        {noLimits && <div className="cb-limits-warn">Set a clock or at least one limit.</div>}
      </div>
    );
  }

  return (
    <div className={["cb-limits", className].filter(Boolean).join(" ")}>
      {allowClock && (
        <section className="cb-limits-section">
          <div className="section-title">Time control</div>
          <div className="cb-limits-presets" role="radiogroup" aria-label="Time control">
            {TIME_CONTROL_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={mode === p.id}
                disabled={disabled}
                className={"cb-limits-chip" + (mode === p.id ? " active" : "")}
                onClick={() => choose(p.id)}
              >
                <span className="cb-limits-chip-main">{p.label}</span>
                <span className="cb-limits-chip-sub">{p.category}</span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={mode === "custom"} disabled={disabled} className={"cb-limits-chip" + (mode === "custom" ? " active" : "")} onClick={() => choose("custom")}>
              <span className="cb-limits-chip-main">Custom</span>
              <span className="cb-limits-chip-sub">{mode === "custom" && timeControl ? formatTimeControl(timeControl) : "Your own"}</span>
            </button>
            <button type="button" role="radio" aria-checked={mode === "none"} disabled={disabled} className={"cb-limits-chip" + (mode === "none" ? " active" : "")} onClick={() => choose("none")}>
              <span className="cb-limits-chip-main">No clock</span>
              <span className="cb-limits-chip-sub">Limits only</span>
            </button>
          </div>
          {customFields}
        </section>
      )}
      <section className="cb-limits-section">
        <div className="section-title">Search limits {allowClock && <span className="cb-limits-optional">optional, per move</span>}</div>
        <div className="cb-limits-caps">
          {caps.map((c) => {
            const on = !!limits[c.key];
            return (
              <div key={c.key} className={"cb-limits-cap" + (on ? " on" : "")}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => setCap(c.key, e.target.checked ? DEFAULT_CAPS[c.key] : null)}
                  />
                  <span>{c.label}</span>
                </label>
                <NumberField
                  label={c.label}
                  labelHidden
                  suffix={c.suffix}
                  step={c.step}
                  disabled={disabled || !on}
                  placeholder="no cap"
                  value={on ? c.toView(limits[c.key]!) : null}
                  rule={{ ...c.rule, allowEmpty: false }}
                  onError={onError}
                  onCommit={(v) => v !== null && setCap(c.key, c.fromView(v))}
                />
              </div>
            );
          })}
        </div>
      </section>
      <div className={"cb-limits-summary" + (noLimits ? " warn" : "")}>
        {noLimits
          ? "Set a clock or at least one limit — otherwise the engine would think forever."
          : `Per side: ${describeLimits(value)}${errors.current.size ? " (fix the highlighted field)" : ""}`}
      </div>
    </div>
  );
}
