// Small UI helpers used across the Workshop: a dropdown menu, a media-query hook and a
// "pick an option" dropdown button.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components";

export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    if (typeof matchMedia !== "function") return () => {};
    const mq = matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
  const get = () => (typeof matchMedia === "function" ? matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, get, get);
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

/**
 * A button that opens a list of actions (role="menu"): arrow keys move, Enter / Space choose,
 * Escape or a click outside closes.
 */
export function MenuButton({
  label,
  items,
  className,
  align = "right",
  title,
  "aria-label": ariaLabel,
}: {
  label: ReactNode;
  items: ReadonlyArray<MenuItem | "separator">;
  className?: string;
  align?: "left" | "right";
  title?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Horizontal correction that keeps the open list inside the window (a left-aligned menu near the
  // right edge would otherwise be cut off, e.g. "Presets" in the side panel).
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const el = listRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const right = document.documentElement.clientWidth - margin;
    let dx = r.right > right ? right - r.right : 0;
    if (r.left + dx < margin) dx = margin - r.left;
    setShift(Math.round(dx));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the menu wherever the focus is (also before it reached the first item).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    // Focus the first enabled item.
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (item: MenuItem) => {
    setOpen(false);
    buttonRef.current?.focus();
    item.onSelect();
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={"workshop-menu" + (className ? " " + className : "")} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          id={menuId}
          ref={listRef}
          role="menu"
          className={`workshop-menu-list workshop-menu-list--${align}`}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          onKeyDown={onMenuKey}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={`sep-${i}`} className="workshop-menu-sep" role="separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={"workshop-menu-item" + (item.danger ? " danger" : "")}
                onClick={() => choose(item)}
              >
                <span className="workshop-menu-label">{item.label}</span>
                {item.hint && <span className="workshop-menu-hint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Chevron used by dropdown buttons. */
export function Chevron() {
  return <Icon name="chevronDown" size={14} />;
}

/** A coloured status pill (header save / build indicators, tool results). */
export function Pill({
  tone,
  children,
  title,
  onClick,
  spinner,
  className,
}: {
  tone: "ok" | "warn" | "danger" | "accent" | "neutral";
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  spinner?: boolean;
  className?: string;
}) {
  const cls = `workshop-pill workshop-pill--${tone}` + (className ? " " + className : "");
  const content = (
    <>
      {spinner ? <span className="spinner workshop-pill-spinner" aria-hidden="true" /> : <span className="workshop-pill-dot" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls + " workshop-pill--button"} title={title} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} title={title} role="status">
      {content}
    </span>
  );
}

/** True on Apple platforms (Cmd instead of Ctrl for shortcuts). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
