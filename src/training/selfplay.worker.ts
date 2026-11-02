// Self-play worker: one engine (self-play) or two (gating) inside this worker play the games the
// pool hands out one at a time and post them back (packed positions as a transferable buffer).
// Protocol: selfplay-protocol.ts. Spawned by selfplay-pool.ts.
//
// Worker-safe imports only: never "@/storage" or "@/engine-host" (their indexes pull in React,
// the compiler client and the template sources).
import { workerScope } from "@/utils/misc";
import { createSelfPlayWorkerHandler } from "./selfplay-core";
import type { SelfPlayWorkerRequest } from "./selfplay-protocol";

const scope = workerScope();
const handle = createSelfPlayWorkerHandler({
  post: (event, transfer) => scope.postMessage(event, transfer ?? []),
});
scope.onmessage = (ev: MessageEvent) => handle(ev.data as SelfPlayWorkerRequest);
