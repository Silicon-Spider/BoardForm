// Public compiler API (docs/ARCHITECTURE.md §5): compiles AssemblyScript to WebAssembly in a
// dedicated worker. The worker is a lazily created singleton; it is re-created if it crashes.
import type { CompileRequest, CompileResult } from "@/types";
import { failedResult } from "./core";
import type { CompilerStatus, CompilerWorkerRequest, CompilerWorkerResponse } from "./protocol";
import { COMPILER_VERSION } from "./version";

export { COMPILER_VERSION };
export { formatDiagnostic } from "./diagnostics";
export type { CompilerStatus } from "./protocol";

/** A single compilation running longer than this is considered hung and the worker is restarted. */
const COMPILE_TIMEOUT_MS = 180_000;

interface Job {
  id: number;
  request: CompileRequest;
  onStatus?: (s: CompilerStatus) => void;
  resolve: (r: CompileResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let worker: Worker | null = null;
let nextId = 1;
/** Pending jobs in submission order, which is also the worker's (serial) processing order. */
const jobs = new Map<number, Job>();

function spawnWorker(): Worker {
  const w = new Worker(new URL("./compiler.worker.ts", import.meta.url), { type: "module", name: "assemblyscript-compiler" });
  w.onmessage = (ev: MessageEvent) => onMessage(w, ev.data as CompilerWorkerResponse);
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault();
    crash(w, `The compiler worker crashed${ev.message ? `: ${ev.message}` : ""}.`);
  };
  w.onmessageerror = () => crash(w, "The compiler worker sent a message that could not be read.");
  return w;
}

function getWorker(): Worker {
  if (!worker) worker = spawnWorker();
  return worker;
}

function send(w: Worker, msg: CompilerWorkerRequest): void {
  w.postMessage(msg);
}

function finish(id: number, result: CompileResult): void {
  const job = jobs.get(id);
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  jobs.delete(id);
  job.resolve(result);
}

/** The worker died: every pending job fails (re-sending could crash it again in a loop). */
function crash(w: Worker, message: string): void {
  if (w !== worker) return;
  w.terminate();
  worker = null;
  for (const id of [...jobs.keys()]) finish(id, failedResult(`${message} Please try again.`));
}

/** The job currently being compiled hung: restart the worker and re-send the jobs behind it. */
function timeOut(job: Job): void {
  if (!jobs.has(job.id)) return;
  worker?.terminate();
  worker = null;
  finish(job.id, failedResult(`Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000} s and was aborted.`));
  if (jobs.size === 0) return;
  const w = getWorker();
  for (const rest of jobs.values()) send(w, { type: "compile", id: rest.id, request: rest.request });
}

function reportStatus(job: Job, status: CompilerStatus): void {
  try {
    job.onStatus?.(status);
  } catch (err) {
    console.error("compile onStatus callback failed", err);
  }
}

function onMessage(w: Worker, msg: CompilerWorkerResponse): void {
  if (w !== worker) return; // a message from a worker we already replaced
  switch (msg.type) {
    case "status": {
      const job = jobs.get(msg.id);
      if (!job) return;
      if (msg.status === "compiling" && !job.timer) job.timer = setTimeout(() => timeOut(job), COMPILE_TIMEOUT_MS);
      reportStatus(job, msg.status);
      return;
    }
    case "result":
      finish(msg.id, msg.result);
      return;
    case "load-error":
      console.warn(`AssemblyScript compiler preload failed: ${msg.message}`);
      return;
    case "loaded":
      return;
  }
}

/**
 * Compiles an AssemblyScript source tree. Always resolves (failures, including a crashed or hung
 * compiler, come back as `ok: false` with an explanatory diagnostic). Requests are compiled one at
 * a time in submission order.
 */
export function compile(req: CompileRequest, opts?: { onStatus?: (s: CompilerStatus) => void }): Promise<CompileResult> {
  return new Promise<CompileResult>((resolve) => {
    const id = nextId++;
    jobs.set(id, { id, request: req, onStatus: opts?.onStatus, resolve, timer: null });
    try {
      send(getWorker(), { type: "compile", id, request: req });
    } catch (err) {
      finish(id, failedResult(`Could not start the compiler: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/** Starts loading the compiler in the background (e.g. when the Workshop opens). */
export function preloadCompiler(): void {
  try {
    send(getWorker(), { type: "preload" });
  } catch (err) {
    console.warn("Could not preload the AssemblyScript compiler", err);
  }
}
