// Building blocks of the new-run wizard steps.
import type { ReactNode } from "react";
import type { RunEstimate } from "@/training";
import { networkFileSize } from "@/nnue/format";
import { parameterCount } from "@/nnue/init";
import { formatBytes, formatCount } from "@/utils/format";
import { MIN_RECOMMENDED_STEPS, type WizardContext, type WizardState } from "../model/wizard";

export type WizardUpdate = (patch: Partial<WizardState> | ((s: WizardState) => WizardState)) => void;

export interface StepProps {
  state: WizardState;
  update: WizardUpdate;
  ctx: WizardContext;
}

/** Card-style radio button (a real radio input inside, so arrow keys work across the group). */
export function ChoiceCard<V extends string | number>({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  icon,
  disabled,
  badge,
  children,
  className,
}: {
  name: string;
  value: V;
  checked: boolean;
  onChange: (v: V) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <label className={["lab-choice", checked ? "checked" : "", disabled ? "disabled" : "", className ?? ""].filter(Boolean).join(" ")}>
      <input type="radio" className="lab-sr-input" name={name} value={String(value)} checked={checked} disabled={disabled} onChange={() => onChange(value)} />
      {icon && <span className="lab-choice-icon">{icon}</span>}
      <span className="lab-choice-body">
        <span className="lab-choice-title">
          {title}
          {badge}
        </span>
        {description && <span className="lab-choice-desc">{description}</span>}
        {children}
      </span>
    </label>
  );
}

export function StepSection({ title, description, children, aside }: { title: ReactNode; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="lab-step-section">
      <div className="lab-step-section-head">
        <div className="grow">
          <h3>{title}</h3>
          {description && <p className="muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Radio chips for hidden sizes, each with its parameter count and file size. */
export function HiddenSizeChips({
  name,
  sizes,
  value,
  onChange,
  label,
}: {
  name: string;
  sizes: readonly number[];
  value: number | null;
  onChange: (hidden: number) => void;
  label: string;
}) {
  return (
    <div className="lab-size-chips" role="radiogroup" aria-label={label}>
      {sizes.map((h) => (
        <label key={h} className={"lab-size-chip" + (value === h ? " checked" : "")}>
          <input type="radio" className="lab-sr-input" name={name} value={h} checked={value === h} onChange={() => onChange(h)} />
          <span className="lab-size-main">{h}</span>
          <span className="lab-size-sub">{formatCount(parameterCount(h))} params</span>
          <span className="lab-size-sub">{formatBytes(networkFileSize(h))}</span>
        </label>
      ))}
    </div>
  );
}

export type EstimateState = { status: "loading" | "ready" | "error"; value: RunEstimate | null; error: string | null };

/** The trainer's estimate for the current settings, with its warnings. */
export function EstimateCard({
  estimate,
  onUseSuggestion,
  suggestionText,
  compact,
}: {
  estimate: EstimateState;
  /** Shown as a button when there are too few optimizer steps. */
  onUseSuggestion?: (() => void) | null;
  suggestionText?: string | null;
  compact?: boolean;
}) {
  const e = estimate.value;
  const fewSteps = !!e && e.totalSteps > 0 && e.totalSteps < MIN_RECOMMENDED_STEPS;
  return (
    <div className={"lab-estimate" + (compact ? " compact" : "") + (estimate.status === "loading" && e ? " stale" : "")} aria-live="polite">
      <div className="lab-estimate-head">
        <span className="section-title">Estimate per cycle</span>
        {estimate.status === "loading" && <span className="spinner" style={{ width: 12, height: 12 }} aria-label="Updating" />}
      </div>
      {estimate.status === "error" && !e ? (
        <div className="small text-danger">{estimate.error ?? "Could not estimate this run."}</div>
      ) : !e ? (
        <div className="small muted">Working it out…</div>
      ) : (
        <>
          <dl className="lab-estimate-grid">
            <div>
              <dt>Positions</dt>
              <dd>{formatCount(e.positions)}</dd>
            </div>
            <div>
              <dt>Steps per epoch</dt>
              <dd>{formatCount(e.stepsPerEpoch)}</dd>
            </div>
            <div>
              <dt>Optimizer steps</dt>
              <dd className={fewSteps ? "text-warn" : undefined}>{formatCount(e.totalSteps)}</dd>
            </div>
            <div>
              <dt>Parameters</dt>
              <dd>{formatCount(e.parameters)}</dd>
            </div>
          </dl>
          {e.warnings.length > 0 && (
            <div className="callout warn lab-estimate-warn" role="status">
              <ul>
                {e.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {fewSteps && onUseSuggestion && (
            <div className="lab-estimate-suggest">
              {suggestionText && <div className="small muted">{suggestionText}</div>}
              <button type="button" className="btn btn-sm" onClick={onUseSuggestion}>
                Use suggested settings
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
