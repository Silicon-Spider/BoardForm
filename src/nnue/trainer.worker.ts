// NNUE trainer worker. Reads datasets from IndexedDB, trains in time slices (so pause / stop
// messages are handled between slices), posts progress ~4×/s and checkpoints.
// Protocol: TrainerRequest in, TrainerEvent out (protocol.ts). Spawned by TrainerClient.
import { workerScope } from "@/utils/misc";
import type { TrainerRequest } from "./protocol";
import { createTrainerWorkerHandler } from "./workerCore";

const scope = workerScope();
const handle = createTrainerWorkerHandler({
  post: (event, transfer) => scope.postMessage(event, transfer ?? []),
});
scope.onmessage = (ev: MessageEvent) => handle(ev.data as TrainerRequest);
