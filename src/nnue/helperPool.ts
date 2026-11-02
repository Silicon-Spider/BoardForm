// Starts the gradient helper threads of a ParallelTrainer as (nested) dedicated workers.
// Imported lazily by the trainer worker only when more than one thread is requested.
import type { HelperInit, HelperPool } from "./parallel";

/** Spawns one gradient.worker per init and resolves once all of them are ready. */
export async function startWorkerHelpers(inits: HelperInit[], timeoutMs = 20_000): Promise<HelperPool> {
  const workers: Worker[] = [];
  const dispose = () => {
    for (const w of workers) w.terminate();
    workers.length = 0;
  };
  try {
    await Promise.all(
      inits.map(
        (init) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL("./gradient.worker.ts", import.meta.url), {
              type: "module",
              name: `nnue-gradients-${init.index + 1}`,
            });
            workers.push(w);
            const timer = setTimeout(() => reject(new Error("a helper thread did not start in time")), timeoutMs);
            w.onmessage = (ev: MessageEvent) => {
              const d = ev.data as { type?: string; error?: string } | null;
              if (d?.type === "ready") {
                clearTimeout(timer);
                resolve();
              } else if (d?.type === "error") {
                clearTimeout(timer);
                reject(new Error(d.error ?? "a helper thread failed"));
              }
            };
            w.onerror = (ev: ErrorEvent) => {
              ev.preventDefault();
              clearTimeout(timer);
              reject(new Error(ev.message || "a helper thread failed to load"));
            };
            w.postMessage({ type: "init", init });
          }),
      ),
    );
  } catch (e) {
    dispose();
    throw e;
  }
  return { threaded: true, dispose };
}
