// Tab strip using the global .tabs/.tab classes, with arrow-key navigation (roving focus).
import { useRef, type ReactNode } from "react";
import "./Tabs.css";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Small count/badge after the label. */
  badge?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface TabsProps {
  /** Tab items, or plain strings (id = label). */
  tabs: ReadonlyArray<TabItem | string>;
  active: string;
  onChange: (id: string) => void;
  className?: string;
  /** Smaller tabs for panels. */
  size?: "sm" | "md";
  "aria-label"?: string;
}

function normalize(t: TabItem | string): TabItem {
  return typeof t === "string" ? { id: t, label: t } : t;
}

export function Tabs({ tabs, active, onChange, className, size = "md", "aria-label": ariaLabel }: TabsProps) {
  const items = tabs.map(normalize);
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (index: number) => {
    onChange(items[index].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };

  const activeIndex = Math.max(0, items.findIndex((t) => t.id === active));

  return (
    <div
      ref={listRef}
      className={["tabs", "cb-tabs", size === "sm" && "cb-tabs--sm", className].filter(Boolean).join(" ")}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        let next: number | null = null;
        if (e.key === "ArrowRight") next = activeIndex + 1;
        else if (e.key === "ArrowLeft") next = activeIndex - 1;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = items.length - 1;
        if (next === null) return;
        e.preventDefault();
        // Skip disabled tabs in the direction of travel.
        const dir = e.key === "ArrowLeft" || e.key === "End" ? -1 : 1;
        for (let k = 0; k < items.length; k++) {
          const i = (((next + k * dir) % items.length) + items.length) % items.length;
          if (!items[i].disabled) {
            focusTab(i);
            return;
          }
        }
      }}
    >
      {items.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            className={"tab" + (selected ? " active" : "")}
            onClick={() => onChange(t.id)}
          >
            {t.icon}
            {t.label}
            {t.badge !== undefined && t.badge !== null && <span className="badge cb-tab-badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
