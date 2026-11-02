// A "⋯" button that opens a small action menu (role="menu") in a portal: arrow keys / Home / End
// move between items, Esc closes and returns focus to the button, clicks outside, scrolling and
// resizing close it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageIcon } from "./icons";
import { cx } from "./ui";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuButtonProps {
  items: readonly MenuItem[];
  /** Accessible name of the button, e.g. "More actions for Blocky". */
  label: string;
  className?: string;
}

const MENU_WIDTH = 190;
const ITEM_HEIGHT = 34;

export function MenuButton({ items, label, className }: MenuButtonProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = items.length * ITEM_HEIGHT + 10;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const below = window.innerHeight - rect.bottom;
    setStyle(below < height + 8 && rect.top > below ? { left, width: MENU_WIDTH, bottom: window.innerHeight - rect.top + 4 } : { left, width: MENU_WIDTH, top: rect.bottom + 4 });
  };

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useLayoutEffect(() => {
    if (open) menuItems()[0]?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (index + 1) % list.length;
    else if (e.key === "ArrowUp") next = (index - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      // Keep an enclosing dialog open: the menu handles this Esc.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      // The menu lives at the end of <body>; send focus back to its button rather than off-page.
      e.preventDefault();
      close(true);
      return;
    }
    if (next !== null && list.length > 0) {
      e.preventDefault();
      list[next]?.focus();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx("btn btn-ghost btn-sm btn-icon", className)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close(false);
          else {
            place();
            setOpen(true);
          }
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            place();
            setOpen(true);
          }
        }}
      >
        <PageIcon name="more" size={18} />
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="engines-menu" style={style} onKeyDown={onMenuKeyDown}>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={cx("engines-menu-item", item.danger && "engines-menu-item--danger")}
                onClick={() => {
                  // Focus goes back to the button first, so a dialog the action opens restores it there.
                  close(true);
                  item.onSelect();
                }}
              >
                <span className="engines-menu-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
