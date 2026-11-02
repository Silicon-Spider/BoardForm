// Engine info panel: status, depth / score / nodes / speed / time, the principal variation in SAN
// (optionally clickable) and a collapsible console with the engine's log output.
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { KindBadge, Spinner } from "@/components";
import type { EngineKind, SearchInfo } from "@/types";
import { formatCount, formatDuration, formatNps } from "@/utils/format";
import { infoWhiteScore, pvTokens, scoreForSide, scoreText } from "./format";
import { PlayIcon } from "./icons";
import type { Side } from "./types";

export type EngineCardStatus = "off" | "loading" | "waiting" | "thinking" | "analysing" | "paused" | "stopped" | "finished" | "error";

export interface EngineCardProps {
  name: string;
  color?: string | null;
  kind?: EngineKind | null;
  /** The side this engine plays (games); shown as a small disc. */
  side?: Side | null;
  status: EngineCardStatus;
  statusText?: string | null;
  info: SearchInfo | null;
  /** Position the info belongs to. */
  infoFen: string | null;
  logs: readonly string[];
  /** Score point of view: White's (default) or the side to move's. */
  pov?: "white" | "stm";
  /** Makes PV moves clickable (analysis: play the PV up to that move). */
  onPvMove?: (index: number) => void;
  /** Buttons in the header. */
  actions?: ReactNode;
  /** Shown under the stats (errors, hints). */
  children?: ReactNode;
}

const STATUS_LABEL: Record<EngineCardStatus, string> = {
  off: "Not running",
  loading: "Starting",
  waiting: "Waiting",
  thinking: "Thinking",
  analysing: "Analysing",
  paused: "Paused",
  stopped: "Stopped",
  finished: "Finished",
  error: "Error",
};

function StatusPill({ status, text }: { status: EngineCardStatus; text?: string | null }) {
  const busy = status === "thinking" || status === "analysing";
  return (
    <span className={`play-engine-status play-engine-status--${status}`} role="status">
      {status === "loading" ? <Spinner size={12} /> : <span className={"play-engine-dot" + (busy ? " play-engine-dot--busy" : "")} aria-hidden="true" />}
      <span className="truncate">{status === "loading" && text ? text : STATUS_LABEL[status]}</span>
    </span>
  );
}

function Console({ logs }: { logs: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs, open]);
  return (
    <div className="play-console">
      <button type="button" className="play-console-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <PlayIcon name="terminal" size={14} />
        <span>Console</span>
        <span className="badge">{logs.length}</span>
        <span className={"play-console-chevron" + (open ? " open" : "")} aria-hidden="true">
          ▸
        </span>
      </button>
      {open && (
        <pre
          ref={preRef}
          className="play-console-log"
          tabIndex={0}
          aria-label="Engine console"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {logs.length ? logs.join("\n") : <span className="faint">No output yet. Messages the engine logs appear here.</span>}
        </pre>
      )}
    </div>
  );
}

function EngineCardImpl({ name, color, kind, side, status, statusText, info, infoFen, logs, pov = "white", onPvMove, actions, children }: EngineCardProps) {
  const white = infoWhiteScore(info, infoFen);
  const stm = infoFen ? (infoFen.split(" ")[1] === "b" ? "b" : "w") : "w";
  const shown = pov === "white" ? white : scoreForSide(white, stm);
  const tokens = info && infoFen ? pvTokens(infoFen, info.pv) : [];

  return (
    <section className="play-engine card" aria-label={`${name} engine`} style={color ? ({ "--play-engine-color": color } as CSSProperties) : undefined}>
      <header className="play-engine-head">
        {side && <span className={`play-player-side play-player-side--${side} play-engine-side`} aria-hidden="true" />}
        <span className="play-engine-name truncate" title={name}>
          {name}
        </span>
        {kind && <KindBadge kind={kind} small />}
        <span className="spacer" />
        <StatusPill status={status} text={statusText} />
        {actions}
      </header>
      <dl className="play-engine-stats">
        <div>
          <dt>Score</dt>
          <dd className={"num play-engine-score" + (shown?.mate ? " play-engine-score--mate" : "")} title={pov === "white" ? "From White's point of view" : "From the side to move's point of view"}>
            {scoreText(shown)}
          </dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd className="num">{info ? `${info.depth}${info.seldepth > info.depth ? `/${info.seldepth}` : ""}` : "—"}</dd>
        </div>
        <div>
          <dt>Nodes</dt>
          <dd className="num">{info ? formatCount(info.nodes) : "—"}</dd>
        </div>
        <div>
          <dt>Nodes/s</dt>
          <dd className="num" title={info && info.nps > 0 ? formatNps(info.nps) : undefined}>
            {info && info.nps > 0 ? formatCount(info.nps) : "—"}
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd className="num">{info ? formatDuration(info.timeMs) : "—"}</dd>
        </div>
      </dl>
      <div className="play-pv" aria-label="Principal variation">
        {tokens.length === 0 ? (
          <span className="faint">{status === "thinking" || status === "analysing" ? "Searching…" : "No line yet"}</span>
        ) : (
          tokens.map((t) => (
            <span key={t.index} className="play-pv-item">
              {t.prefix && <span className="play-pv-num">{t.prefix}</span>}
              {onPvMove ? (
                <button type="button" className="play-pv-move" onClick={() => onPvMove(t.index)} title="Play the line up to this move">
                  {t.san}
                </button>
              ) : (
                <span className="play-pv-move">{t.san}</span>
              )}
            </span>
          ))
        )}
      </div>
      {children}
      <Console logs={logs} />
    </section>
  );
}

export const EngineCard = memo(EngineCardImpl);
