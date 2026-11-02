// Horizontal toolbar for button rows: <Toolbar><Toolbar.Group label="View">…</Toolbar.Group>
// <Toolbar.Separator /><Toolbar.Spacer />…</Toolbar>. Wraps on narrow screens.
import type { ReactNode } from "react";
import "./Toolbar.css";

export interface ToolbarProps {
  children: ReactNode;
  className?: string;
  /** Tighter padding, no background. */
  compact?: boolean;
  /** Draw as a panel strip (surface background + border). Default true unless compact. */
  framed?: boolean;
  "aria-label"?: string;
}

function ToolbarRoot({ children, className, compact, framed, "aria-label": ariaLabel }: ToolbarProps) {
  const isFramed = framed ?? !compact;
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={["cb-toolbar", compact && "cb-toolbar--compact", isFramed && "cb-toolbar--framed", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}

export function ToolbarGroup({ children, label, className }: { children: ReactNode; label?: ReactNode; className?: string }) {
  return (
    <div className={"cb-toolbar-group" + (className ? " " + className : "")} role="group">
      {label && <span className="cb-toolbar-label">{label}</span>}
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <span className="cb-toolbar-sep" role="separator" aria-orientation="vertical" />;
}

export function ToolbarSpacer() {
  return <span className="cb-toolbar-spacer" aria-hidden="true" />;
}

export const Toolbar = Object.assign(ToolbarRoot, {
  Group: ToolbarGroup,
  Separator: ToolbarSeparator,
  Spacer: ToolbarSpacer,
});
