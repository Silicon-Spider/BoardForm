// Number field that keeps its own text while typing ("", "1." are fine) and only reports valid
// values; out-of-range input shows an inline error instead of being silently clamped.
import { useEffect, useId, useState } from "react";

export interface NumberInputProps {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min: number;
  max: number;
  integer?: boolean;
  /** Empty input is valid and means null. */
  allowEmpty?: boolean;
  suffix?: string;
  placeholder?: string;
  step?: number;
  disabled?: boolean;
  hint?: string;
  className?: string;
}

function parse(text: string, p: Pick<NumberInputProps, "min" | "max" | "integer" | "allowEmpty">): { value: number | null; error?: string } {
  const t = text.trim().replace(",", ".");
  if (t === "") return p.allowEmpty ? { value: null } : { value: null, error: "Required" };
  const v = Number(t);
  if (!Number.isFinite(v)) return { value: null, error: "Enter a number" };
  if (p.integer && !Number.isInteger(v)) return { value: null, error: "Whole numbers only" };
  if (v < p.min) return { value: null, error: `At least ${p.min}` };
  if (v > p.max) return { value: null, error: `At most ${p.max}` };
  return { value: v };
}

const show = (v: number | null) => (v === null ? "" : String(Number(v.toFixed(4))));

export function NumberInput({ label, value, onCommit, min, max, integer, allowEmpty, suffix, placeholder, step = 1, disabled, hint, className }: NumberInputProps) {
  const id = useId();
  const [text, setText] = useState(show(value));
  const [error, setError] = useState<string | null>(null);

  // Follow outside changes unless the text already means that value.
  useEffect(() => {
    setText((t) => {
      const p = parse(t, { min, max, integer, allowEmpty });
      return !p.error && p.value === value ? t : show(value);
    });
    setError(null);
  }, [value, min, max, integer, allowEmpty]);

  const commit = (t: string) => {
    setText(t);
    const p = parse(t, { min, max, integer, allowEmpty });
    setError(p.error ?? null);
    if (!p.error) onCommit(p.value);
  };

  return (
    <div className={"field play-number" + (className ? " " + className : "")}>
      <label htmlFor={id}>{label}</label>
      <div className="play-number-input">
        <input
          id={id}
          className={"input input-sm" + (error ? " play-input-error" : "")}
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-msg` : undefined}
          onChange={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const p = parse(text, { min, max, integer, allowEmpty: true });
            const base = p.value ?? value ?? min;
            const next = Math.min(max, Math.max(min, Number((base + (e.key === "ArrowUp" ? step : -step)).toFixed(4))));
            commit(show(next));
          }}
          onBlur={() => {
            if (!error) setText(show(value));
          }}
        />
        {suffix && <span className="play-number-suffix">{suffix}</span>}
      </div>
      {(error || hint) && (
        <span id={`${id}-msg`} className={error ? "field-error" : "field-hint"}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}
