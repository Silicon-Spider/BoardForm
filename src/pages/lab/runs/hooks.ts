// Hooks for the run pages: lock-based "running in another tab" detection and live chart points.
import { useEffect, useRef, useState } from "react";
import { toast } from "@/app/toast";
import type { LiveRunState } from "@/training";
import { errorMessage } from "../model/format";
import type { ChartInputPoint } from "../model/chart";

type LockInfo = { name?: string };

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.query === "function" ? locks : null;
}

/**
 * Whether some tab holds a Web Lock whose name mentions `id` (the training service locks every run
 * it executes, so only one tab runs it). null = unknown (no Web Locks, or not checked yet).
 * Polls every few seconds while mounted; `enabled` false skips the checks.
 */
export function useLockHeld(id: string, enabled: boolean, intervalMs = 3000): boolean | null {
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => {
    const locks = lockManager();
    if (!enabled || !locks) {
      setHeld(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const snap = await locks.query();
        const names = [...(snap.held ?? []), ...(snap.pending ?? [])].map((l: LockInfo) => l.name ?? "");
        if (!cancelled) setHeld(names.some((n) => n.includes(id)));
      } catch {
        if (!cancelled) setHeld(null);
      }
    };
    void check();
    const t = setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, enabled, intervalMs]);
  return held;
}

/** True once `ms` have passed since mount (or since `key` changed); avoids flashing notices on load. */
export function useSettled(ms: number, key: string): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(t);
  }, [ms, key]);
  return settled;
}

const MAX_LIVE_POINTS = 4000;

/**
 * Training progress reports seen while this page is open, as chart points (cycle, positions,
 * losses, learning rate). The persisted run.points are saved less often; these fill the gap.
 */
export function useLivePoints(live: LiveRunState | null): ChartInputPoint[] {
  const [points, setPoints] = useState<ChartInputPoint[]>([]);
  const runId = useRef<string | null>(null);
  const train = live?.phase === "training" ? live.train : null;
  const cycle = live?.cycle ?? 0;
  useEffect(() => {
    if (live && runId.current !== live.runId) {
      runId.current = live.runId;
      setPoints([]);
    }
  }, [live]);
  useEffect(() => {
    if (!train) return;
    setPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.cycle === cycle && last.positions >= train.positionsSeen) return prev;
      const next = [...prev, { cycle, epoch: train.epoch, positions: train.positionsSeen, trainLoss: train.trainLoss, valLoss: train.valLoss, lr: train.lr }];
      return next.length > MAX_LIVE_POINTS ? next.slice(next.length - MAX_LIVE_POINTS) : next;
    });
  }, [train, cycle]);
  return points;
}

/**
 * A switch bound to a stored boolean: it flips at once (the stored record follows a moment later
 * through its storage hook), and flips back with an error toast if saving fails.
 * Returns [checked, saving, set].
 */
export function useOptimisticToggle(stored: boolean, save: (on: boolean) => Promise<void>, failure: string): [boolean, boolean, (on: boolean) => void] {
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (pending !== null && stored === pending) setPending(null);
  }, [stored, pending]);
  const set = (on: boolean) => {
    setPending(on);
    save(on).catch((e: unknown) => {
      setPending(null);
      toast(failure, { kind: "error", detail: errorMessage(e) });
    });
  };
  return [pending ?? stored, pending !== null, set];
}
