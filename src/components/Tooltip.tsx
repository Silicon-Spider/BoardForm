// Hover/focus tooltip rendered in a portal, positioned next to its anchor and flipped to stay
// inside the viewport.
import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
  /** Delay before showing, ms. Default 350. */
  delay?: number;
  disabled?: boolean;
  /** Max width in px. Default 280. */
  maxWidth?: number;
  className?: string;
}

type Placement = NonNullable<TooltipProps["placement"]>;

export function Tooltip({ content, children, placement = "top", delay = 350, disabled, maxWidth = 280, className }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; placement: Placement } | null>(null);

  const show = () => {
    if (disabled || content === null || content === undefined || content === "") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
    setPos(null);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fits: Record<Placement, boolean> = {
      top: a.top - t.height - gap >= 4,
      bottom: a.bottom + t.height + gap <= vh - 4,
      left: a.left - t.width - gap >= 4,
      right: a.right + t.width + gap <= vw - 4,
    };
    const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    const p = fits[placement] || !fits[opposite[placement]] ? placement : opposite[placement];
    let left: number;
    let top: number;
    if (p === "top" || p === "bottom") {
      left = a.left + a.width / 2 - t.width / 2;
      top = p === "top" ? a.top - t.height - gap : a.bottom + gap;
    } else {
      top = a.top + a.height / 2 - t.height / 2;
      left = p === "left" ? a.left - t.width - gap : a.right + gap;
    }
    left = Math.min(Math.max(4, left), vw - t.width - 4);
    top = Math.min(Math.max(4, top), vh - t.height - 4);
    setPos({ left, top, placement: p });
  }, [open, placement, content]);

  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": open ? id : undefined })
    : children;

  return (
    <>
      <span
        ref={anchorRef}
        className={"cb-tooltip-anchor" + (className ? " " + className : "")}
        onPointerEnter={(e) => e.pointerType === "mouse" && show()}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        onPointerDown={hide}
      >
        {child}
      </span>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={"cb-tooltip" + (pos ? ` cb-tooltip--${pos.placement} cb-tooltip--shown` : "")}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxWidth }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
