// Toast notifications: toast("Saved", { kind: "success" }).
import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "error";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  detail?: string;
}

interface ToastState {
  items: ToastItem[];
}

const useToastStore = create<ToastState>(() => ({ items: [] }));
let nextId = 1;

export function dismissToast(id: number): void {
  useToastStore.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function toast(
  message: string,
  opts: { kind?: ToastKind; detail?: string; timeoutMs?: number } = {},
): number {
  const id = nextId++;
  const kind = opts.kind ?? "info";
  useToastStore.setState((s) => ({ items: [...s.items.slice(-4), { id, message, kind, detail: opts.detail }] }));
  const timeout = opts.timeoutMs ?? (kind === "error" ? 9000 : 4000);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function Toaster() {
  const items = useToastStore((s) => s.items);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{t.message}</div>
            {t.detail && <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{t.detail}</div>}
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
