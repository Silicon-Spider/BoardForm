// Building blocks of the Settings page: section panels, labelled rows, a segmented control
// (radio group with arrow-key navigation) and an on/off switch.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/pages/engines/ui";

export function SettingsSection({ id, title, icon, description, danger, children }: { id: string; title: string; icon: ReactNode; description?: ReactNode; danger?: boolean; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} tabIndex={-1} className={cx("panel settings-section", danger && "settings-section--danger")} aria-labelledby={`settings-${id}-title`}>
      <header className="panel-header settings-section-header">
        <span className="settings-section-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="grow">
          <h2 id={`settings-${id}-title`} className="settings-section-title">
            {title}
          </h2>
          {description && <p className="settings-section-desc">{description}</p>}
        </div>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

export interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  /** id of the control, so the title becomes its <label>. */
  htmlFor?: string;
  /** id for the title (aria-labelledby of group controls). */
  titleId?: string;
  /** Control under the text instead of beside it (wide controls). */
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}

export function SettingRow({ title, description, htmlFor, titleId, stacked, children, className }: SettingRowProps) {
  return (
    <div className={cx("settings-row", stacked && "settings-row--stacked", className)}>
      <div className="settings-row-text">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="settings-row-title" id={titleId}>
            {title}
          </label>
        ) : (
          <div className="settings-row-title" id={titleId}>
            {title}
          </div>
        )}
        {description && <div className="settings-row-desc">{description}</div>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
}

/** A row of mutually exclusive buttons (role="radiogroup"); arrow keys move the selection. */
export function Segmented<T extends string>({ options, value, onChange, label, labelledBy }: { options: ReadonlyArray<SegmentedOption<T>>; value: T; onChange: (value: T) => void; label?: string; labelledBy?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number | null = null;
    if (e.key in keys) next = ((index < 0 ? 0 : index) + keys[e.key] + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="btn-group settings-segmented" role="radiogroup" aria-label={label} aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
            title={o.title}
            className={cx("btn btn-sm", checked && "active")}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** An on/off switch (a styled checkbox with role="switch"). */
export function Switch({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <label className={cx("settings-switch", disabled && "is-disabled")}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="settings-switch-track" aria-hidden="true">
        <span className="settings-switch-thumb" />
      </span>
    </label>
  );
}
