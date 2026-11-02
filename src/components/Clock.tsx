// Chess clock display. While `running`, it counts down locally from the last `ms` it received,
// so it stays smooth whether the parent updates `ms` every frame or only after each move.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatClock } from "@/utils/format";
import "./Clock.css";

export interface ClockProps {
  /** Remaining time in ms (as of this render). */
  ms: number;
  running: boolean;
  /** Whose clock it is. */
  side: "w" | "b" | "white" | "black";
  /** Player name (or any node) shown next to the time. */
  label?: ReactNode;
  /** Below this the clock turns red. Default 10 s. */
  lowTimeMs?: number;
  /** Smaller variant for dense layouts. */
  compact?: boolean;
  className?: string;
}

export function Clock({ ms, running, side, label, lowTimeMs = 10_000, compact, className }: ClockProps) {
  const base = useRef({ ms, running, at: 0 });
  if (base.current.ms !== ms || base.current.running !== running || base.current.at === 0) {
    base.current = { ms, running, at: performance.now() };
  }
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    // Faster ticks under 20 s, where tenths of a second are shown.
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [running]);

  const shown = running ? Math.max(0, base.current.ms - (performance.now() - base.current.at)) : Math.max(0, ms);
  const white = side === "w" || side === "white";
  const flagged = shown <= 0;
  const low = !flagged && shown < lowTimeMs;
  const cls = [
    "cb-clock",
    compact && "cb-clock--compact",
    running && "cb-clock--running",
    low && "cb-clock--low",
    flagged && "cb-clock--flagged",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} role="timer" aria-label={`${white ? "White" : "Black"} clock ${formatClock(shown)}`}>
      <span className={`cb-clock-side cb-clock-side--${white ? "w" : "b"}`} aria-hidden="true" />
      {label !== undefined && <span className="cb-clock-label truncate">{label}</span>}
      <span className="cb-clock-time">{formatClock(shown)}</span>
      {running && <span className="cb-clock-tick" aria-hidden="true" />}
    </div>
  );
}
