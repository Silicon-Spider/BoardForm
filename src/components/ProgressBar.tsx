// Progress bar on the global .progress classes. value null/undefined (or max ≤ 0) = indeterminate.
import type { ReactNode } from "react";
import { formatCount } from "@/utils/format";
import "./ProgressBar.css";

export interface ProgressBarProps {
  value: number | null | undefined;
  /** Default 1. */
  max?: number;
  label?: ReactNode;
  /** What to show at the right of the label row. Default "percent" when a label is given. */
  showValue?: "percent" | "fraction" | "none";
  /** Extra line under the bar (e.g. "12 games/min · ETA 3 min"). */
  detail?: ReactNode;
  variant?: "accent" | "ok" | "warn" | "danger";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ProgressBar({ value, max = 1, label, showValue, detail, variant = "accent", size = "md", className }: ProgressBarProps) {
  const determinate = value !== null && value !== undefined && Number.isFinite(value) && max > 0;
  const fraction = determinate ? Math.min(1, Math.max(0, value / max)) : 0;
  const mode = showValue ?? (label !== undefined ? "percent" : "none");
  const valueText = !determinate
    ? null
    : mode === "percent"
      ? `${Math.floor(fraction * 100)}%`
      : mode === "fraction"
        ? `${formatCount(value)} / ${formatCount(max)}`
        : null;
  return (
    <div className={["cb-progress", `cb-progress--${size}`, `cb-progress--${variant}`, className].filter(Boolean).join(" ")}>
      {(label !== undefined || valueText) && (
        <div className="cb-progress-head">
          <span className="cb-progress-label truncate">{label}</span>
          {valueText && <span className="cb-progress-value">{valueText}</span>}
        </div>
      )}
      <div
        className={"progress" + (determinate ? "" : " indeterminate")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={determinate ? max : undefined}
        aria-valuenow={determinate ? value : undefined}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <div style={{ width: determinate ? `${fraction * 100}%` : undefined }} />
      </div>
      {detail && <div className="cb-progress-detail">{detail}</div>}
    </div>
  );
}
