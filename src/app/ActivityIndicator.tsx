// "N running" button in the nav bar: background work (training, matches, dataset generation)
// that keeps going while the user is on other pages. Opens a panel with progress and links.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useActivities } from "./activity";
import { Link, useRoute } from "./router";

export function ActivityIndicator() {
  const activities = useActivities();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const path = useRoute().path;

  // The panel belongs to the page it was opened on.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (activities.length === 0) return null;
  const count = activities.length;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div
      className="activity"
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Tabbing out of the panel closes it.
        if (open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-ghost activity-button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={open ? undefined : "Background work"}
      >
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-count num">{count}</span>
        <span className="activity-label"> running</span>
      </button>
      {open && (
        <div className="activity-panel" id={panelId} role="region" aria-label="Background work">
          <div className="activity-panel-header">
            <span className="activity-panel-title">Background work</span>
            <span className="activity-panel-hint">Keeps running while this tab is open</span>
          </div>
          <ul className="activity-list">
            {activities.map((a) => {
              const pct = typeof a.progress === "number" ? Math.round(Math.min(1, Math.max(0, a.progress)) * 100) : null;
              return (
                <li key={a.id}>
                  <Link to={a.href ?? "/"} className="activity-item" onClick={() => setOpen(false)}>
                    <span className="activity-item-top">
                      <span className="activity-item-label truncate">{a.label}</span>
                      {pct !== null && <span className="activity-item-pct num">{pct}%</span>}
                    </span>
                    {a.detail && <span className="activity-item-detail truncate">{a.detail}</span>}
                    {/* The percentage is in the link text; the bar is decoration. */}
                    <span className={`progress ${pct === null ? "indeterminate" : ""}`} aria-hidden="true">
                      <span style={{ width: `${pct === null ? 35 : Math.max(2, pct)}%` }} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
