// Small building blocks shared by the Arena pages.
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { matchExtras, participantLabels, type LiveMatchState } from "@/arena";
import { formatTimeControl } from "@/components";
import { useEngines } from "@/storage";
import type { EngineLimits, EngineRecord, MatchConfig, MatchRecord, ParticipantConfig } from "@/types";
import type { EloEstimate } from "@/utils/elo";
import { formatCount } from "@/utils/format";

/** Engines by id (undefined while loading). */
export function useEngineMap(): Map<string, EngineRecord> | undefined {
  const engines = useEngines();
  return useMemo(() => (engines ? new Map(engines.map((e) => [e.id, e])) : undefined), [engines]);
}

export interface ParticipantInfo {
  labels: string[];
  colors: string[];
  /** False when the engine of that participant no longer exists. */
  exists: boolean[];
}

/** Display names (numbered duplicates) and accent colours of a match's participants. */
export function useParticipants(config: Pick<MatchConfig, "participants"> | null | undefined): ParticipantInfo {
  const engines = useEngineMap();
  return useMemo(() => {
    const parts = config?.participants ?? [];
    return {
      labels: engines ? participantLabels({ participants: parts }, (id) => engines.get(id)?.name ?? null) : parts.map(() => "…"),
      colors: parts.map((p) => engines?.get(p.engineId)?.color ?? "var(--text-faint)"),
      exists: parts.map((p) => !engines || engines.has(p.engineId)),
    };
  }, [config, engines]);
}

export type MatchDisplayStatus = "pending" | "preparing" | "running" | "remote" | "stopping" | "paused" | "interrupted" | "finished" | "aborted";

/** What to show for a match: its record status, refined by what this tab knows. */
export function displayStatus(record: MatchRecord, live: LiveMatchState | null): MatchDisplayStatus {
  if (live?.running) return live.phase === "preparing" ? "preparing" : live.phase === "stopping" ? "stopping" : "running";
  switch (record.status) {
    case "running":
      return "remote";
    case "paused":
      return matchExtras(record).interrupted ? "interrupted" : "paused";
    default:
      return record.status;
  }
}

const STATUS_BADGE: Record<MatchDisplayStatus, { label: string; cls: string }> = {
  pending: { label: "Not started", cls: "" },
  preparing: { label: "Starting", cls: "badge-accent" },
  running: { label: "Running", cls: "badge-ok" },
  remote: { label: "Running in another tab", cls: "badge-accent" },
  stopping: { label: "Stopping", cls: "badge-warn" },
  paused: { label: "Paused", cls: "badge-warn" },
  interrupted: { label: "Interrupted", cls: "badge-warn" },
  finished: { label: "Finished", cls: "badge-violet" },
  aborted: { label: "Aborted", cls: "badge-danger" },
};

export function StatusBadge({ status }: { status: MatchDisplayStatus }) {
  const s = STATUS_BADGE[status];
  return (
    <span className={`badge ${s.cls} arena-status`} data-status={status}>
      {(status === "running" || status === "preparing") && <span className="arena-status-dot" aria-hidden="true" />}
      {s.label}
    </span>
  );
}

/** A coloured dot for an engine. */
export function EngineDot({ color, title }: { color: string; title?: string }) {
  return <span className="arena-dot" style={{ "--arena-dot": color } as CSSProperties} title={title} aria-hidden="true" />;
}

/** "● Classic  ● Blocky  +2 more" */
export function ParticipantChips({ info, max = 4 }: { info: ParticipantInfo; max?: number }) {
  const shown = info.labels.slice(0, max);
  return (
    <div className="arena-chips">
      {shown.map((label, i) => (
        <span key={i} className={"arena-chip" + (info.exists[i] ? "" : " arena-chip--missing")} title={info.exists[i] ? label : "This engine was deleted"}>
          <EngineDot color={info.colors[i]} />
          <span className="truncate">{label}</span>
        </span>
      ))}
      {info.labels.length > max && <span className="arena-chip arena-chip--more">+{info.labels.length - max} more</span>}
    </div>
  );
}

/** Re-renders every `ms` while `enabled`; returns Date.now(). */
export function useNow(ms: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

/** One-line summary of an engine's limits: "10s+0.1 · 5k nodes". */
export function describeParticipant(p: Pick<ParticipantConfig, "limits" | "timeControl">): string {
  const parts: string[] = [];
  if (p.timeControl) parts.push(formatTimeControl(p.timeControl));
  const l: EngineLimits = p.limits ?? {};
  if (l.depth) parts.push(`depth ${l.depth}`);
  if (l.nodes) parts.push(`${formatCount(l.nodes)} nodes`);
  if (l.movetimeMs) parts.push(`${Number((l.movetimeMs / 1000).toFixed(3))} s/move`);
  return parts.length ? parts.join(" · ") : "1 s/move (default)";
}

/** The match's settings in a few words: "Round robin · 10s+0.1" or "… · settings differ per engine". */
export function describeConfig(config: MatchConfig): string {
  const n = config.participants.length;
  const format = n === 2 ? "Match" : config.format === "gauntlet" ? `Gauntlet · ${n} engines` : `Round robin · ${n} engines`;
  const each = config.participants.map(describeParticipant);
  const limits = each.every((d) => d === each[0]) ? each[0] : "settings differ per engine";
  return `${format} · ${limits}`;
}

/** Whole-number input that keeps its own text while typing and reports valid values only. */
export function IntField(props: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  width?: number;
}) {
  const { label, value, onChange, min, max, suffix, hint, disabled, className, width } = props;
  const id = useId();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== "" ? t : String(value)));
    setError(null);
  }, [value]);
  const parse = (t: string): { v: number | null; error: string | null } => {
    const s = t.trim();
    if (s === "") return { v: null, error: "Required" };
    const v = Number(s);
    if (!Number.isFinite(v) || !Number.isInteger(v)) return { v: null, error: "Whole numbers only" };
    if (v < min) return { v: null, error: `At least ${formatCount(min)}` };
    if (v > max) return { v: null, error: `At most ${formatCount(max)}` };
    return { v, error: null };
  };
  return (
    <div className={"field arena-int" + (className ? " " + className : "")}>
      <label htmlFor={id}>{label}</label>
      <div className="arena-int-input">
        <input
          id={id}
          className={"input" + (error ? " arena-input-error" : "")}
          type="text"
          inputMode="numeric"
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          style={width ? { width } : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const p = parse(e.target.value);
            setError(p.error);
            if (p.v !== null) onChange(p.v);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const cur = parse(text).v ?? value;
            const next = Math.min(max, Math.max(min, cur + (e.key === "ArrowUp" ? 1 : -1)));
            setText(String(next));
            setError(null);
            onChange(next);
          }}
          onBlur={() => {
            if (error) return;
            setText(String(value));
          }}
        />
        {suffix && <span className="arena-int-suffix">{suffix}</span>}
      </div>
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** "+35 ± 40"; a margin of 1000 Elo or more (a handful of games) is shown as ±∞. */
export function formatEloEstimate(e: EloEstimate): string {
  if (e.games === 0) return "—";
  // A perfect score has no finite Elo (eloFromScore clamps it to about ±2400).
  if (e.score >= 1) return "+∞";
  if (e.score <= 0) return "−∞";
  const elo = Math.round(e.elo);
  const value = elo > 0 ? `+${elo}` : elo < 0 ? `−${-elo}` : "0";
  // Zero variance (e.g. only draws) or a huge interval: too few games for a margin.
  const margin = Number.isFinite(e.error) && e.error > 0 && e.error < 1000 ? String(Math.round(e.error)) : "∞";
  return `${value} ± ${margin}`;
}

/** Result as shown in tables: "1–0", "½–½", "0–1", "*". */
export function resultText(result: string): string {
  return result === "1/2-1/2" ? "½–½" : result === "1-0" ? "1–0" : result === "0-1" ? "0–1" : result;
}
