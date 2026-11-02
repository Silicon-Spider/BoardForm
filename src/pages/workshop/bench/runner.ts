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

/**
 * What a runtime error of an engine usually means, in words, for the errors AssemblyScript code
 * runs into most (null when there is nothing to add). The raw message of an AssemblyScript
 * runtime check points into its standard library (e.g. "~lib/staticarray.ts:78:41"), never to
 * the user's own line, so the hint says where to look instead.
 */
export function runtimeErrorHint(message: string): string | null {
  if (/Index out of range/i.test(message))
    return "An array index was past the end (or negative): check the indexes your code uses — a count, rank or square used to look up a table, for example. The file named in the message is AssemblyScript's own library (~lib), not your code.";
  if (/divide by zero|division by zero/i.test(message)) return "An integer was divided by zero (or used with % 0): check the divisor first.";
  if (/integer overflow/i.test(message)) return "An integer division overflowed (i32.MIN_VALUE / -1).";
  if (/float unrepresentable|invalid conversion to integer/i.test(message)) return "A float too large (or NaN) was converted to an integer.";
  if (/memory access out of bounds/i.test(message)) return "The engine read or wrote outside its memory, usually through an unchecked() index or a load / store with a wrong address.";
  if (/call stack|too much recursion/i.test(message)) return "The call stack overflowed: probably a function that keeps calling itself (check the depth limit of a recursive search).";
  if (/out of memory|allocation too large/i.test(message)) return "The engine ran out of memory: something keeps allocating (new arrays or strings inside the search?).";
  if (/unreachable/i.test(message)) return "The engine reached `unreachable`: a failed assert(), a throw, or a function that ended without returning a value.";
  if (/~lib\//.test(message)) return "The file named in the message is AssemblyScript's own library (~lib): the mistake is in the code that called it.";
  return null;
}

/** User-facing text of a failed engine call. */
export function engineErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/was terminated/i.test(msg)) return "The engine was restarted (for example after a new build) before it finished.";
  const hint = runtimeErrorHint(msg);
  return hint ? `${msg.replace(/\.?\s*$/, ".")} ${hint}` : msg;
}
