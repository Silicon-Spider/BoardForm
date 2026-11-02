// Confirmation dialog + a promise-based hook:
//   const confirm = useConfirm();
//   if (await confirm({ title: "Delete engine?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true })) ...
// The hook renders the dialog itself (no provider or element to mount).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title?: ReactNode;
  message?: ReactNode;
  /** Default "OK" (or "Delete" when danger). */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Destructive action: red confirm button, Cancel focused by default. */
  danger?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disables the buttons and shows a spinner on the confirm button. */
  busy?: boolean;
}

export function ConfirmDialog({ open, title = "Are you sure?", message, confirmLabel, cancelLabel = "Cancel", danger, onConfirm, onCancel, busy }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!busy) onCancel();
      }}
      width={440}
      initialFocus={danger ? cancelRef : confirmRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? "btn cb-btn-danger-solid" : "btn btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            {confirmLabel ?? (danger ? "Delete" : "OK")}
          </button>
        </>
      }
    >
      {message !== undefined && <div className="cb-confirm-message">{typeof message === "string" ? <p>{message}</p> : message}</div>}
    </Modal>
  );
}

function ConfirmHost({ options, onDone }: { options: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const finish = (ok: boolean) => {
    setOpen(false);
    onDone(ok);
  };
  return <ConfirmDialog {...options} open={open} onConfirm={() => finish(true)} onCancel={() => finish(false)} />;
}

/**
 * Shows a confirmation dialog and resolves true (confirmed) or false (cancelled / closed).
 * Works anywhere in the app — it mounts its own small React root.
 */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> & { close(): void } {
  const options: ConfirmOptions = typeof opts === "string" ? { message: opts } : opts;
  let settle: (ok: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    if (typeof document === "undefined") {
      resolve(false);
      return;
    }
    const host = document.createElement("div");
    host.className = "cb-confirm-host";
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    settle = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
      // Unmount after the current event finishes.
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<ConfirmHost options={options} onDone={(ok) => settle(ok)} />);
  });
  return Object.assign(promise, { close: () => settle(false) });
}

export type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

/** Promise-based confirmation. Dialogs still open when the calling component unmounts resolve false. */
export function useConfirm(): ConfirmFn {
  const open = useRef(new Set<{ close(): void }>());
  useEffect(() => {
    const set = open.current;
    return () => {
      for (const d of set) d.close();
      set.clear();
    };
  }, []);
  return useCallback((opts: ConfirmOptions | string) => {
    const d = confirmDialog(opts);
    open.current.add(d);
    return d.finally(() => open.current.delete(d));
  }, []);
}
