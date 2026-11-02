// Colour picker for an engine's accent colour: a radio group of palette swatches plus a
// "custom" swatch backed by the native colour input.
import { Icon } from "@/components";
import { ENGINE_COLORS } from "./records";
import { cx } from "./ui";

export interface ColorSwatchesProps {
  value: string;
  onChange: (color: string) => void;
  /** Radio group name (unique per form). */
  name: string;
  "aria-labelledby"?: string;
}

/** "#abc" → "#aabbcc" (the native colour input only accepts six digits). */
function sixDigitHex(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return "#5b9cf5";
}

export function ColorSwatches({ value, onChange, name, "aria-labelledby": labelledBy }: ColorSwatchesProps) {
  const current = sixDigitHex(value);
  const isCustom = !ENGINE_COLORS.some((c) => c.value === current);
  return (
    <div className="engines-swatches" role="radiogroup" aria-labelledby={labelledBy}>
      {ENGINE_COLORS.map((c) => (
        <label key={c.value} className="engines-swatch" title={c.name}>
          <input type="radio" name={name} value={c.value} checked={current === c.value} onChange={() => onChange(c.value)} aria-label={c.name} />
          <span className="engines-swatch-chip" style={{ background: c.value }} aria-hidden="true">
            {current === c.value && <Icon name="check" size={14} />}
          </span>
        </label>
      ))}
      <label className={cx("engines-swatch", "engines-swatch--custom", isCustom && "is-checked")} title="Custom colour">
        <input type="color" value={current} onChange={(e) => onChange(e.target.value)} aria-label="Custom colour" />
        <span className="engines-swatch-chip" style={isCustom ? { background: current } : undefined} aria-hidden="true">
          {isCustom ? <Icon name="check" size={14} /> : <Icon name="plus" size={14} />}
        </span>
      </label>
    </div>
  );
}
