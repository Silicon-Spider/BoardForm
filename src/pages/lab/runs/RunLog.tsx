// A run's log with level colours, a level filter, text search and follow-tail scrolling.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components";
import type { TrainingLogEntry } from "@/types";
import { formatDateTime } from "@/utils/format";

type Filter = "all" | "warn" | "error";

const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function RunLog({ log }: { log: readonly TrainingLogEntry[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const ignoreScroll = useRef(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return log.filter(
      (e) => (filter === "all" || (filter === "warn" ? e.level !== "info" : e.level === "error")) && (!q || e.message.toLowerCase().includes(q)),
    );
  }, [log, filter, query]);
  const counts = useMemo(() => ({ warn: log.filter((e) => e.level === "warn").length, error: log.filter((e) => e.level === "error").length }), [log]);

  // Follow the tail: keep the newest line in view while following.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    ignoreScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      // Our own jump to the bottom is not the user scrolling away.
      if (ignoreScroll.current) {
        ignoreScroll.current = false;
        if (atBottom) return;
      }
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="lab-log">
      <div className="lab-log-tools">
        <div className="btn-group" role="group" aria-label="Show">
          <button type="button" className={"btn btn-sm" + (filter === "all" ? " active" : "")} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" className={"btn btn-sm" + (filter === "warn" ? " active" : "")} aria-pressed={filter === "warn"} onClick={() => setFilter("warn")}>
            Warnings{counts.warn + counts.error > 0 ? ` (${counts.warn + counts.error})` : ""}
          </button>
          <button type="button" className={"btn btn-sm" + (filter === "error" ? " active" : "")} aria-pressed={filter === "error"} onClick={() => setFilter("error")}>
            Errors{counts.error > 0 ? ` (${counts.error})` : ""}
          </button>
        </div>
        <div className="lab-log-search">
          <Icon name="search" size={14} />
          <input className="input input-sm" type="search" placeholder="Filter the log…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter the log" />
        </div>
        <label className="checkbox small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>
      <div ref={boxRef} className="lab-log-box" role="log" aria-live="off" tabIndex={0} aria-label="Run log">
        {shown.length === 0 ? (
          <div className="lab-log-empty">{log.length === 0 ? "Nothing logged yet." : "No lines match."}</div>
        ) : (
          shown.map((e, i) => (
            <div key={`${e.t}-${i}`} className={`lab-log-line ${e.level}`}>
              <time dateTime={new Date(e.t).toISOString()} title={formatDateTime(e.t)}>
                {timeOf(e.t)}
              </time>
              <span className="lab-log-level">{e.level === "info" ? "" : e.level === "warn" ? "warn" : "error"}</span>
              <span className="lab-log-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
