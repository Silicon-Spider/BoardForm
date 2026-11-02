// Loading spinner (global .spinner) with an optional visible label.
import type { ReactNode } from "react";

export interface SpinnerProps {
  /** Diameter in px. Default 16. */
  size?: number;
  /** Visible text next to the spinner (also used as the accessible name). */
  label?: ReactNode;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const dims = size === 16 ? undefined : { width: size, height: size, borderWidth: Math.max(2, Math.round(size / 9)) };
  if (label === undefined) {
    return <span className={"spinner" + (className ? " " + className : "")} style={dims} role="status" aria-label="Loading" />;
  }
  return (
    <span className={"row muted" + (className ? " " + className : "")} role="status" style={{ display: "inline-flex" }}>
      <span className="spinner" style={dims} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
