// Editor for how long an engine may think: a time control (presets, custom, or no clock) plus
// optional caps per move on depth (half-moves ahead), nodes (positions searched) and time.
// Clock times are typed and shown in a friendly way ("5 min", "1:30 min", "20 s"), see
// ./timeFormat.ts; caps come with a plain-words explanation and quick picks.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EngineLimits, TimeControl } from "@/types";
import { formatCount } from "@/utils/format";
import { CLOCK_TIME_HELP, clockTextHasUnit, describeTimeControl, formatClockTime, formatTimeControl, parseClockTime, parseSecondsText } from "./timeFormat";
import "./LimitsEditor.css";

export { formatTimeControl, describeTimeControl, formatClockTime, parseClockTime } from "./timeFormat";

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
  /** Dense layout for side cards, tables and sidebars. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  /** Shortest base time a custom clock accepts. Default 1 s (handy for quick engine games). */
  minBaseMs?: number;
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
const MAX_BASE_MS = 600 * 60_000;

/** Preset id for a time control, "none" for no clock, "custom" otherwise. */
export function timeControlPresetId(tc: TimeControl | null): string {
  if (!tc) return "none";
  const p = TIME_CONTROL_PRESETS.find((x) => x.baseMs === tc.baseMs && x.incMs === tc.incMs && !tc.movesPerControl);
  return p ? p.id : "custom";
}

function trimNumber(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

/** Node counts without trailing zeros: 800, 5k, 2.5k, 12.3k, 100k, 1M, 1.5M. */
function countText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Number((n / 1e3).toPrecision(3))}k`;
  return `${Number((n / 1e6).toPrecision(3))}M`;
}

/** One-line summary, e.g. "5+0 · depth 12 · 1M nodes · 0.5 s/move". */
export function describeLimits(v: LimitsValue): string {
  const parts: string[] = [];
  if (v.timeControl) parts.push(formatTimeControl(v.timeControl));
  if (v.limits.depth) parts.push(`depth ${v.limits.depth}`);
  if (v.limits.nodes) parts.push(`${countText(v.limits.nodes)} nodes`);
  if (v.limits.movetimeMs) parts.push(`${trimNumber(v.limits.movetimeMs / 1000, 3)} s/move`);
  return parts.length ? parts.join(" · ") : "No limits";
}

/** Plain-words summary under the full editor: what the clock is and when a move's search stops. */
function explainLimits(v: LimitsValue, allowClock: boolean): string {
  const caps: string[] = [];
  if (v.limits.depth) caps.push(`depth ${v.limits.depth}`);
  if (v.limits.nodes) caps.push(`${countText(v.limits.nodes)} positions`);
  if (v.limits.movetimeMs) caps.push(`${trimNumber(v.limits.movetimeMs / 1000, 3)} s`);
  const capText =
    caps.length === 0
      ? ""
      : `each move stops at ${caps.length === 1 ? caps[0] : `${caps.slice(0, -1).join(", ")} or ${caps[caps.length - 1]}`}${caps.length > 1 ? ", whichever comes first" : ""}`;
  if (!allowClock) return capText.charAt(0).toUpperCase() + capText.slice(1) + ".";
  if (!v.timeControl) return `No clock: ${capText}.`;
  const clock = `${describeTimeControl(v.timeControl)} on each side's clock`;
  return capText ? `${clock}; ${capText}.` : `${clock}; the engine shares out its own time.`;
}

// ------------------------------------------------------------------------------------------
// Fields with their own text state (so partial input like "" or "1." is allowed while typing)

interface NumberRule {
  min: number;
  max: number;
  integer?: boolean;
  /** Empty input is valid and means null. */
  allowEmpty?: boolean;
  unit?: string;
  /** The value is in seconds: also accept "2 s", "1.5 sec" and "500 ms". */
  seconds?: boolean;
  /** A count: also accept "10k", "1.5M" and digit separators ("100,000"). */
  count?: boolean;
}

/** "10k" → 10000, "1.5m" → 1500000, "100,000" / "100 000" / "100_000" → 100000; null if not a count. */
function parseCount(text: string): number | null {
  const m = /^(\d+(?:\.\d*)?|\.\d+)\s*([km])?$/i.exec(text.replace(/[\s,_](?=\d{3}(\D|$))/g, ""));
  if (!m) return null;
  const mult = !m[2] ? 1 : m[2].toLowerCase() === "k" ? 1e3 : 1e6;
  return Math.round(Number(m[1]) * mult * 1e6) / 1e6;
}

function parseNumber(text: string, rule: NumberRule): { value: number | null; error?: string } {
  const raw = text.trim();
  const t = raw.replace(",", ".");
  if (t === "") return rule.allowEmpty ? { value: null } : { value: null, error: "Required" };
  const v = rule.count ? parseCount(raw) : rule.seconds ? parseSecondsText(t) : Number(t);
  if (v === null || !Number.isFinite(v)) return { value: null, error: rule.seconds ? "Enter seconds, e.g. 0.5" : rule.count ? "Enter a number, e.g. 5000 or 5k" : "Enter a number" };
  if (rule.integer && !Number.isInteger(v)) return { value: null, error: "Whole numbers only" };
  if (v < rule.min) return { value: null, error: `At least ${rule.min}${rule.unit ? " " + rule.unit : ""}` };
  if (v > rule.max) return { value: null, error: `At most ${formatCount(rule.max)}${rule.unit ? " " + rule.unit : ""}` };
  return { value: v };
}

const close = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));

type ErrorReporter = (field: string, error: string | null) => void;

interface FieldFrameProps {
  id: string;
  label: string;
  /** Keep the label for screen readers only (a visible checkbox already names the field). */
  labelHidden?: boolean;
  hint?: string;
  hintId: string;
  compact?: boolean;
  /** "row": label + hint on the left, input + quick picks on the right (search limits). */
  layout?: "stack" | "row";
  /** Stacked layout: show the hint under the input instead of under the label. */
  hintBelow?: boolean;
  /** Shown in the label's place (e.g. the checkbox that switches a limit on). */
  lead?: ReactNode;
  error: string | null;
  input: ReactNode;
  children?: ReactNode;
}

/** Label, hint, input, extras (quick picks) and error, laid out consistently for every field. */
function FieldFrame({ id, label, labelHidden, hint, hintId, compact, layout = "stack", hintBelow, lead, error, input, children }: FieldFrameProps) {
  const hintEl = hint && (
    <span id={hintId} className="cb-limits-hint">
      {hint}
    </span>
  );
  return (
    <div className={"field cb-limits-field" + (compact ? " cb-limits-field--compact" : "") + (layout === "row" ? " cb-limits-field--row" : "")}>
      {lead && <div className="cb-limits-lead">{lead}</div>}
      <label htmlFor={id} className={labelHidden ? "cb-sr-only" : "cb-limits-label"}>
        {label}
      </label>
      {!hintBelow && hintEl}
      {input}
      {hintBelow && hintEl}
      {children}
      {error && <span className="field-error cb-limits-error">{error}</span>}
    </div>
  );
}

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
  labelHidden?: boolean;
  hint?: string;
  hintBelow?: boolean;
  layout?: "stack" | "row";
  lead?: ReactNode;
  onError?: ErrorReporter;
  /** Rendered under the input (quick picks). Receives the hint id for aria-describedby. */
  extra?: (hintId: string) => ReactNode;
}) {
  const { label, value, onCommit, rule, suffix, step, placeholder, disabled, compact, labelHidden, hint, hintBelow, layout, lead, onError, extra } = props;
  const id = useId();
  const hintId = id + "-hint";
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
  // A field that goes away must not leave its error behind.
  useEffect(() => () => onError?.(label, null), [label, onError]);

  const input = (
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
        aria-describedby={hint ? hintId : undefined}
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
      {/* In rows the suffix column is kept even when empty, so the inputs line up. */}
      {(suffix || layout === "row") && (
        <span className="cb-limits-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
    </div>
  );
  return (
    <FieldFrame id={id} label={label} labelHidden={labelHidden} hint={hint} hintId={hintId} compact={compact} layout={layout} hintBelow={hintBelow} lead={lead} error={error} input={input}>
      {extra?.(hintId)}
    </FieldFrame>
  );
}

/** Step for ArrowUp / ArrowDown in a clock field: finer for short times. */
function clockStep(ms: number, up: boolean): number {
  const v = up ? ms : ms - 1;
  if (v < 10_000) return 1_000;
  if (v < 60_000) return 5_000;
  if (v < 300_000) return 30_000;
  return 60_000;
}

export interface ClockTimeFieldProps {
  label: string;
  /** Current time in ms. */
  valueMs: number;
  onCommit: (ms: number) => void;
  /** Default 1 s. */
  minMs?: number;
  /** Default 10 hours. */
  maxMs?: number;
  compact?: boolean;
  disabled?: boolean;
  /** Visible hint under the field (default: none; the error explains the accepted forms). */
  hint?: string;
  onError?: ErrorReporter;
}

/**
 * Clock time input: shows "5 min", "1:30 min" or "20 s" and accepts minutes ("5"), m:ss ("1:30")
 * or any value with a unit ("20 s", "1.5 min", "1m 30s"). A bare number means minutes; while one
 * is typed a "min" unit appears next to it, so the unit is always visible.
 */
export function ClockTimeField({ label, valueMs, onCommit, minMs = 1000, maxMs = MAX_BASE_MS, compact, disabled, hint, onError }: ClockTimeFieldProps) {
  const id = useId();
  const hintId = id + "-hint";
  const rule = { minMs, maxMs };
  const [text, setText] = useState(formatClockTime(valueMs));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText((t) => {
      const p = parseClockTime(t, rule);
      return p.ok && p.ms === valueMs ? t : formatClockTime(valueMs);
    });
    setError(null);
  }, [valueMs]); // rule bounds are constant per field

  useEffect(() => {
    onError?.(label, error);
  }, [error, label, onError]);
  useEffect(() => () => onError?.(label, null), [label, onError]);

  const commit = (ms: number) => {
    setText(formatClockTime(ms));
    setError(null);
    onCommit(ms);
  };
  const impliedUnit = text.trim() !== "" && !clockTextHasUnit(text);

  const input = (
    <div className="cb-limits-input">
      <input
        id={id}
        className={"input" + (compact ? " input-sm" : "") + (error ? " cb-input-error" : "")}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={text}
        disabled={disabled}
        title={CLOCK_TIME_HELP}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const p = parseClockTime(e.target.value, rule);
          setError(p.ok ? null : p.error);
          if (p.ok) onCommit(p.ms);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const p = parseClockTime(text, { minMs: 0, maxMs: Infinity });
          const cur = p.ok ? p.ms : valueMs;
          const up = e.key === "ArrowUp";
          const step = clockStep(cur, up);
          // Snap to the step grid first (1:20 → 1:30 → 2:00 rather than 1:50).
          const snapped = up ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
          commit(Math.min(maxMs, Math.max(minMs, snapped)));
        }}
        onBlur={() => {
          if (!error) setText(formatClockTime(valueMs));
        }}
      />
      {impliedUnit && (
        <span className="cb-limits-suffix" aria-hidden="true">
          min
        </span>
      )}
    </div>
  );
  return <FieldFrame id={id} label={label} hint={hint} hintId={hintId} compact={compact} hintBelow error={error} input={input} />;
}

// ------------------------------------------------------------------------------------------

interface QuickPick {
  /** Value in stored units (plies, nodes, ms). */
  value: number;
  label: string;
  title: string;
}

/** Small buttons that set a cap to a common value. */
function QuickPicks({ picks, current, onPick, disabled, describedBy }: { picks: readonly QuickPick[]; current: number | undefined; onPick: (v: number) => void; disabled?: boolean; describedBy?: string }) {
  return (
    // Named "Suggested values" (not after the field) so label lookups keep finding just the input.
    <div className="cb-limits-quick" role="group" aria-label="Suggested values">
      {picks.map((p) => (
        <button
          key={p.value}
          type="button"
          className={"cb-limits-quick-btn" + (current === p.value ? " active" : "")}
          aria-pressed={current === p.value}
          aria-describedby={describedBy}
          title={p.title}
          disabled={disabled}
          onClick={() => onPick(p.value)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

const RULES = {
  inc: { min: 0, max: 600, unit: "s", seconds: true },
  moves: { min: 1, max: 200, integer: true, allowEmpty: true },
  depth: { min: 1, max: 99, integer: true, allowEmpty: true },
  nodes: { min: 1, max: 1e12, integer: true, allowEmpty: true, count: true },
  movetime: { min: 0.001, max: 3600, unit: "s", allowEmpty: true, seconds: true },
} satisfies Record<string, NumberRule>;

interface CapDef {
  key: keyof EngineLimits;
  label: string;
  /** Plain-words explanation (full layout). */
  hint: string;
  /** Short explanation (compact layout). */
  shortHint: string;
  suffix?: string;
  rule: NumberRule;
  toView: (v: number) => number;
  fromView: (v: number) => number;
  step: number;
  picks: readonly QuickPick[];
}

// The labels are also the inputs' accessible names (tests and screen readers rely on them).
const CAPS: readonly CapDef[] = [
  {
    key: "depth",
    label: "Depth",
    hint: "How many half-moves (plies) ahead the engine looks. 2 plies = one move by each side.",
    shortHint: "plies — half-moves ahead",
    suffix: "plies",
    rule: RULES.depth,
    toView: (v) => v,
    fromView: (v) => v,
    step: 1,
    picks: [4, 6, 8, 12].map((d) => ({ value: d, label: String(d), title: `${d} plies` })),
  },
  {
    key: "nodes",
    label: "Max positions searched (nodes)",
    hint: "How many positions the engine may search for each move. Plays the same on any computer.",
    shortHint: "positions it may search per move",
    rule: RULES.nodes,
    toView: (v) => v,
    fromView: (v) => v,
    step: 1000,
    picks: [1_000, 10_000, 100_000, 1_000_000].map((n) => ({ value: n, label: countText(n), title: `${n.toLocaleString("en-US")} positions` })),
  },
  {
    key: "movetimeMs",
    label: "Time per move",
    hint: "Thinking time for each move. Faster computers search more in the same time.",
    shortHint: "seconds of thinking per move",
    suffix: "s",
    rule: RULES.movetime,
    toView: (v) => v / 1000,
    fromView: (v) => Math.max(1, Math.round(v * 1000)),
    step: 0.5,
    picks: [100, 500, 1_000, 3_000].map((ms) => ({ value: ms, label: `${trimNumber(ms / 1000)} s`, title: `${trimNumber(ms / 1000)} s per move` })),
  },
];

export function LimitsEditor({ value, onChange, allowClock = true, compact, disabled, className, minBaseMs = 1000 }: LimitsEditorProps) {
  const { limits, timeControl } = value;
  const presetId = timeControlPresetId(timeControl);
  const [customOpen, setCustomOpen] = useState(presetId === "custom");
  const mode = presetId === "custom" || (customOpen && timeControl) ? "custom" : presetId;
  const clockId = useId();
  const errors = useRef(new Map<string, string>());
  const [, forceRender] = useState(0);
  const onError = useRef<ErrorReporter>((field, error) => {
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
      <ClockTimeField
        label="Base time"
        compact={compact}
        disabled={disabled}
        valueMs={timeControl.baseMs}
        minMs={minBaseMs}
        hint={compact ? undefined : "e.g. 5, 1:30 or 20 s"}
        onError={onError}
        onCommit={(ms) => setTc({ ...timeControl, baseMs: ms })}
      />
      <NumberField
        label="Increment"
        suffix="s / move"
        step={1}
        compact={compact}
        disabled={disabled}
        value={timeControl.incMs / 1000}
        rule={RULES.inc}
        hint={compact ? undefined : "added after each move"}
        hintBelow
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
        hint={compact ? undefined : "empty = one period for the whole game"}
        hintBelow
        onError={onError}
        onCommit={(v) => {
          const next: TimeControl = { baseMs: timeControl.baseMs, incMs: timeControl.incMs };
          if (v) next.movesPerControl = v;
          setTc(next);
        }}
      />
    </div>
  );

  if (compact) {
    return (
      <div className={["cb-limits", "cb-limits--compact", className].filter(Boolean).join(" ")}>
        {allowClock && (
          <div className="field">
            <label htmlFor={clockId}>Clock</label>
            <select id={clockId} className="select select-sm" value={mode} disabled={disabled} onChange={(e) => choose(e.target.value)}>
              {TIME_CONTROL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.category}
                </option>
              ))}
              <option value="custom">{mode === "custom" && timeControl ? `Custom (${formatTimeControl(timeControl)})` : "Custom…"}</option>
              <option value="none">No clock</option>
            </select>
          </div>
        )}
        {allowClock && customFields}
        <div className="cb-limits-caps cb-limits-caps--compact">
          {CAPS.map((c) => (
            <NumberField
              key={c.key}
              compact
              layout="row"
              label={c.label}
              hint={c.shortHint}
              placeholder="no cap"
              suffix={c.suffix}
              step={c.step}
              disabled={disabled}
              value={limits[c.key] ? c.toView(limits[c.key]!) : null}
              rule={c.rule}
              onError={onError}
              onCommit={(v) => setCap(c.key, v === null ? null : c.fromView(v))}
              extra={(hintId) => <QuickPicks picks={c.picks} current={limits[c.key]} disabled={disabled} describedBy={hintId} onPick={(v) => setCap(c.key, v)} />}
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
                title={describeTimeControl(p)}
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
          {CAPS.map((c) => {
            const on = !!limits[c.key];
            return (
              <div key={c.key} className={"cb-limits-cap" + (on ? " on" : "")}>
                <NumberField
                  layout="row"
                  lead={
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={disabled}
                        onChange={(e) => setCap(c.key, e.target.checked ? DEFAULT_CAPS[c.key] : null)}
                      />
                      <span>{c.label}</span>
                    </label>
                  }
                  label={c.label}
                  labelHidden
                  hint={c.hint}
                  suffix={c.suffix}
                  step={c.step}
                  disabled={disabled || !on}
                  placeholder="no cap"
                  value={on ? c.toView(limits[c.key]!) : null}
                  rule={{ ...c.rule, allowEmpty: false }}
                  onError={onError}
                  onCommit={(v) => v !== null && setCap(c.key, c.fromView(v))}
                  // A quick pick also switches the cap on.
                  extra={(hintId) => <QuickPicks picks={c.picks} current={limits[c.key]} disabled={disabled} describedBy={hintId} onPick={(v) => setCap(c.key, v)} />}
                />
              </div>
            );
          })}
        </div>
      </section>
      <div className={"cb-limits-summary" + (noLimits ? " warn" : "")} aria-live="polite">
        {noLimits
          ? "Set a clock or at least one limit — otherwise the engine would think forever."
          : `${explainLimits(value, allowClock)}${errors.current.size ? " Fix the highlighted field first." : ""}`}
      </div>
    </div>
  );
}
