// Registry of long-running background work (training runs, matches, compiles, data generation).
// Services call setActivity/clearActivity; the nav bar shows them on every page.
import { create } from "zustand";

export interface Activity {
  id: string;
  kind: "training" | "arena" | "selfplay" | "compile" | "other";
  label: string;
  detail?: string;
  /** 0..1, or null for indeterminate. */
  progress?: number | null;
  /** Route to open when clicked, e.g. "/lab/runs/abc". */
  href?: string;
  startedAt: number;
}

interface ActivityState {
  activities: Record<string, Activity>;
}

export const useActivityStore = create<ActivityState>(() => ({ activities: {} }));

export function setActivity(a: Omit<Activity, "startedAt"> & { startedAt?: number }): void {
  useActivityStore.setState((s) => {
    const prev = s.activities[a.id];
    return {
      activities: {
        ...s.activities,
        [a.id]: { ...a, startedAt: a.startedAt ?? prev?.startedAt ?? Date.now() },
      },
    };
  });
}

export function clearActivity(id: string): void {
  useActivityStore.setState((s) => {
    if (!(id in s.activities)) return s;
    const next = { ...s.activities };
    delete next[id];
    return { activities: next };
  });
}

export function useActivities(): Activity[] {
  const map = useActivityStore((s) => s.activities);
  return Object.values(map).sort((a, b) => a.startedAt - b.startedAt);
}
