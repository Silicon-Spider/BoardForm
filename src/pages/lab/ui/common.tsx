// Small building blocks shared by the Lab pages.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "@/app/router";
import { EmptyState, Icon, Spinner } from "@/components";
import type { TrainingRunStatus } from "@/types";
import { formatDateTime, formatRelativeTime } from "@/utils/format";
import { RUN_STATUS } from "../model/format";

// ------------------------------------------------------------------------------- status

export function RunStatusBadge({ status, live }: { status: TrainingRunStatus; live?: boolean }) {
  const meta = RUN_STATUS[status] ?? RUN_STATUS.queued;
  return (
    <span className={meta.badge + " lab-status"} title={meta.description}>
      {live && <span className="lab-live-dot" aria-hidden="true" />}
      {meta.label}
    </span>
  );
}

// ------------------------------------------------------------------------------- switch

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  /** Second line under the label. */
  description?: ReactNode;
  disabled?: boolean;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, "aria-label": ariaLabel, className }: SwitchProps) {
  const id = useId();
  return (
    <label className={["lab-switch", disabled ? "disabled" : "", className ?? ""].filter(Boolean).join(" ")} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="lab-switch-track" aria-hidden="true">
        <span className="lab-switch-thumb" />
      </span>
      {(label || description) && (
        <span className="lab-switch-text">
          {label && <span className="lab-switch-label">{label}</span>}
          {description && (
            <span className="lab-switch-desc" id={`${id}-d`}>
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

// ------------------------------------------------------------------------------- stats

export interface StatItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  title?: string;
}

/** A row of labelled values (stat tiles without boxes). */
export function StatGrid({ items, className, dense }: { items: ReadonlyArray<StatItem | null | false>; className?: string; dense?: boolean }) {
  return (
    <dl className={["lab-stats", dense ? "lab-stats--dense" : "", className ?? ""].filter(Boolean).join(" ")}>
      {items.filter((x): x is StatItem => !!x).map((s) => (
        <div key={s.label} className="lab-stat" title={s.title}>
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
          {s.hint && <div className="lab-stat-hint">{s.hint}</div>}
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------------------- page states

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="lab-loading">
      <Spinner label={label} />
    </div>
  );
}

export function NotFoundState({ what, backTo, backLabel }: { what: string; backTo: string; backLabel: string }) {
  return (
    <EmptyState
      icon={<Icon name="search" size={22} />}
      title={`This ${what} doesn't exist`}
      description={`It may have been deleted, possibly in another tab.`}
      action={
        <Link to={backTo} className="btn">
          {backLabel}
        </Link>
      }
    />
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav className="lab-crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="lab-crumb">
          {i > 0 && <span className="lab-crumb-sep" aria-hidden="true">/</span>}
          {it.to ? <Link to={it.to}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** "3 min ago", refreshed every 30 s; the exact date/time on hover. */
export function TimeAgo({ ts }: { ts: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!Number.isFinite(ts) || ts <= 0) return <span className="faint">—</span>;
  return (
    <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts)}>
      {formatRelativeTime(ts)}
    </time>
  );
}

/** Panel with a header row (title + optional actions) and a body. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  icon,
  id,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
  id?: string;
}) {
  return (
    <section className={"panel lab-panel" + (className ? " " + className : "")} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="panel-header lab-panel-header">
        {icon && <span className="lab-panel-icon">{icon}</span>}
        <h2 className="lab-panel-title" id={id ? `${id}-title` : undefined}>
          {title}
        </h2>
        {actions && <div className="lab-panel-actions">{actions}</div>}
      </header>
      <div className={"panel-body" + (bodyClassName ? " " + bodyClassName : "")}>{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------------------- number input

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Arrow-key step. */
  step?: number;
  suffix?: string;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

function parseNum(text: string, p: Pick<NumberInputProps, "min" | "max" | "integer">): { value: number | null; error: string | null } {
  const t = text.trim().replace(",", ".");
  if (t === "") return { value: null, error: "Required" };
  const v = Number(t);
  if (!Number.isFinite(v)) return { value: null, error: "Enter a number" };
  if (p.integer && !Number.isInteger(v)) return { value: null, error: "Whole numbers only" };
  if (p.min !== undefined && v < p.min) return { value: null, error: `At least ${p.min}` };
  if (p.max !== undefined && v > p.max) return { value: null, error: `At most ${p.max.toLocaleString("en-US")}` };
  return { value: v, error: null };
}

const showNum = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(10))) : "");

/**
 * Numeric text field that lets people type freely ("", "0.", "1e-") and only reports valid values;
 * an invalid entry shows its problem under the field and is reverted on blur.
 */
export function NumberInput({ value, onChange, min, max, integer, step, suffix, id, disabled, placeholder, className, ...aria }: NumberInputProps) {
  const [text, setText] = useState(showNum(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText((t) => {
      const p = parseNum(t, { min, max, integer });
      return p.value !== null && Math.abs(p.value - value) <= 1e-12 * Math.max(1, Math.abs(value)) ? t : showNum(value);
    });
    setError(null);
  }, [value]); // min/max/integer are stable per field
  const commit = (raw: string) => {
    setText(raw);
    const p = parseNum(raw, { min, max, integer });
    setError(p.error);
    if (p.value !== null) onChange(p.value);
  };
  return (
    <div className={"lab-num" + (className ? " " + className : "")}>
      <div className="lab-num-row">
        <input
          id={id}
          className={"input lab-num-input" + (error ? " lab-input-error" : "")}
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-label={aria["aria-label"]}
          aria-describedby={aria["aria-describedby"]}
          onChange={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (!step || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            const cur = parseNum(text, { min, max, integer }).value ?? value;
            let next = cur + (e.key === "ArrowUp" ? step : -step);
            if (min !== undefined) next = Math.max(min, next);
            if (max !== undefined) next = Math.min(max, next);
            commit(showNum(Number(next.toPrecision(10))));
          }}
          onBlur={() => {
            if (error) {
              setText(showNum(value));
              setError(null);
            }
          }}
        />
        {suffix && <span className="lab-num-suffix">{suffix}</span>}
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/** Field wrapper: label, control, hint. */
export function Field({ label, hint, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={"field" + (className ? " " + className : "")}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** A list of blocking problems ("danger") or advice ("warn"). */
export function ProblemList({ items, tone = "danger", title }: { items: readonly string[]; tone?: "danger" | "warn"; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`callout ${tone} lab-problems`} role={tone === "danger" ? "alert" : "status"}>
      {title && <div className="lab-problems-title">{title}</div>}
      {items.length === 1 ? (
        <p>{items[0]}</p>
      ) : (
        <ul>
          {items.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
