// Gradient helper thread of multi-threaded NNUE training (see parallel.ts). Receives its shared
// buffers once, reports "ready", then sleeps in Atomics.wait between batches until told to exit.
import { workerScope } from "@/utils/misc";
import { createHelperState, helperLoop, type HelperInit, type HelperState } from "./parallel";

const scope = workerScope();
scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; init?: HelperInit } | null;
  if (msg?.type !== "init" || !msg.init) return;
  let state: HelperState;
  try {
    state = createHelperState(msg.init);
  } catch (e) {
    scope.postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) });
    return;
  }
  scope.postMessage({ type: "ready" });
  helperLoop(state); // blocks this thread until the coordinator sends OP_EXIT
  scope.close();
};
