// Modal dialog: portal to <body>, Esc / backdrop close (topmost modal only), basic focus trap
// and focus restore. Uses the .modal* classes from global.css.
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import "./Modal.css";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** Dialog width (px or CSS length). Default 560px. */
  width?: number | string;
  className?: string;
  /** Close on a click on the backdrop. Default true. */
  closeOnBackdrop?: boolean;
  /** Hide the × button in the header. */
  hideClose?: boolean;
  /** Element focused when the dialog opens (default: first field/button in the body). */
  initialFocus?: RefObject<HTMLElement | null>;
}

/** Open modals, bottom → top; only the topmost reacts to Esc. */
const stack: string[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("data-focus-skip"));
}

export function Modal(props: ModalProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<ModalInner {...props} />, document.body);
}

function ModalInner({ title, onClose, children, footer, width, className, closeOnBackdrop = true, hideClose, initialFocus }: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The element that had focus when the dialog opened (captured before React's autoFocus runs).
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  const initialFocusRef = useRef(initialFocus);

  // Register in the stack, move focus in, restore it on close. Runs once per opened dialog.
  useEffect(() => {
    stack.push(id);
    const previous = opener.current as HTMLElement | null;
    const dialog = dialogRef.current;
    const preferred = initialFocusRef.current?.current;
    if (dialog && (preferred || !dialog.contains(document.activeElement))) {
      const body = dialog.querySelector<HTMLElement>(".modal-body");
      const target =
        preferred ??
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        (body ? focusables(body)[0] : undefined) ??
        focusables(dialog).find((el) => !el.classList.contains("cb-modal-close")) ??
        dialog;
      target.focus({ preventScroll: true });
    }
    return () => {
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [id]);

  useEffect(() => {
    // Bubble phase: widgets inside the dialog (e.g. an open dropdown) handle Esc first and
    // call preventDefault, which keeps the dialog open.
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const items = focusables(dialogRef.current);
        if (items.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id]);

  return (
    <div
      className="modal-backdrop cb-modal-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (closeOnBackdrop && downOnBackdrop.current && e.target === e.currentTarget) onCloseRef.current();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className={"modal cb-modal" + (className ? " " + className : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width !== undefined ? { width } : undefined}
      >
        <div className="modal-header">
          <div id={titleId} className="cb-modal-title">
            {title}
          </div>
          {!hideClose && (
            <button type="button" className="btn btn-ghost btn-sm btn-icon cb-modal-close" aria-label="Close" onClick={() => onCloseRef.current()}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
