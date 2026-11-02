// Small "more actions" menu for table rows and page headers: a button that opens a popover list
// (portal, flips above the button near the bottom of the window). Arrow keys move, Enter / Space
// choose, Esc closes and returns focus to the button.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LabIcon } from "./icons";

export interface ActionMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip (e.g. why the item is disabled). */
  title?: string;
}

export interface ActionMenuProps {
  items: ReadonlyArray<ActionMenuItem | "separator">;
  /** Accessible name of the button. */
  label?: string;
  /** Button content; default a "⋯" icon. */
  children?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}

export function ActionMenu({ items, label = "More actions", children, className, size = "sm" }: ActionMenuProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const entries = items.filter((i): i is ActionMenuItem => i !== "separator");

  const place = () => {
    const b = buttonRef.current?.getBoundingClientRect();
    const m = menuRef.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.max(200, m?.width ?? 200);
    const height = m?.height ?? 200;
    const left = Math.max(8, Math.min(b.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - b.bottom;
    setPos(below < height + 12 && b.top > below ? { left, top: Math.max(8, b.top - height - 4) } : { left, top: b.bottom + 4 });
  };

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (k: number) => buttons[(k + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(buttons.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={["btn", "btn-ghost", size === "sm" ? "btn-sm" : "", children ? "" : "btn-icon", className ?? ""].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={children ? undefined : label}
        title={children ? undefined : label}
        disabled={entries.length === 0}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children ?? <LabIcon name="more" />}
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="lab-menu" style={pos} onKeyDown={onKey}>
            {items.map((item, k) =>
              item === "separator" ? (
                <div key={`sep${k}`} className="lab-menu-sep" role="separator" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={"lab-menu-item" + (item.danger ? " danger" : "")}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  <span className="lab-menu-icon">{item.icon}</span>
                  <span className="grow">{item.label}</span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
