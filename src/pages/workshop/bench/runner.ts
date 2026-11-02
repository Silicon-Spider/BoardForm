// The test bench runs one engine job at a time (evaluate, search, perft, check, bench). The runner
// starts the engine if needed, tracks the running job for the UI and cancels it on Stop.
import { useCallback, useRef, useState } from "react";
import type { EngineClient } from "@/engine-host";
import type { EngineSession } from "../session";

export type ToolId = "eval" | "search" | "perft" | "bench" | "console";

export interface JobControl {
  /** Set by stop(); long jobs check it between engine calls. */
  cancelled: boolean;
}

export interface RunningJob {
  tool: ToolId;
  label: string;
}

export interface JobRunner {
  job: RunningJob | null;
  /** Runs `fn` with the engine unless another job is running (then resolves undefined). Rejects with fn's / the start's error. */
  run<T>(tool: ToolId, label: string, fn: (client: EngineClient, ctl: JobControl) => Promise<T>): Promise<T | undefined>;
  /** Cancels the running job (stops a search or perft in the engine). */
  stop(): void;
  busy: boolean;
}

export function useJobRunner(session: EngineSession): JobRunner {
  const [job, setJob] = useState<RunningJob | null>(null);
  const control = useRef<JobControl | null>(null);

  const run = useCallback(
    async <T,>(tool: ToolId, label: string, fn: (client: EngineClient, ctl: JobControl) => Promise<T>): Promise<T | undefined> => {
      if (control.current) return undefined;
      const ctl: JobControl = { cancelled: false };
      control.current = ctl;
      setJob({ tool, label });
      try {
        const client = await session.getClient();
        if (ctl.cancelled) return undefined;
        return await fn(client, ctl);
      } finally {
        if (control.current === ctl) control.current = null;
        setJob(null);
      }
    },
    [session],
  );

  const stop = useCallback(() => {
    const ctl = control.current;
    if (!ctl) return;
    ctl.cancelled = true;
    session.stop();
  }, [session]);

  return { job, run, stop, busy: job !== null };
}

/** User-facing text of a failed engine call. */
export function engineErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/was terminated/i.test(msg)) return "The engine was restarted (for example after a new build) before it finished.";
  return msg;
}
