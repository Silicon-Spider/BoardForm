// Engine worker: hosts one EngineInstance and executes calls from EngineClient one at a time.
// A search blocks this worker; the client stops it through the shared stop flag or by
// terminating the worker (see client.ts).
import type { SearchInfo } from "@/types";
import { workerScope } from "@/utils/misc";
import { InfoRateWatch, InfoThrottle, infoRateNote } from "./info-throttle";
import { EngineInstance } from "./instance";
import { rememberModuleInfo } from "./module-info";
import type { EngineMethods, EngineWorkerCall, EngineWorkerRequest, EngineWorkerResponse } from "./protocol";

const scope = workerScope();
const post = (msg: EngineWorkerResponse) => scope.postMessage(msg);

/** Log lines forwarded per call; beyond this the engine is flooding the console. */
const MAX_LOG_LINES_PER_CALL = 500;

let engine: EngineInstance | null = null;
let currentCall = 0;
let logBudget = MAX_LOG_LINES_PER_CALL;
let suppressedLogs = 0;
/** Engines that report at every node would otherwise flood the main thread (see info-throttle.ts). */
const infos = new InfoThrottle<SearchInfo>((info) => post({ type: "info", id: currentCall, info }));
/**
 * Merging reports is routine (fast iterations at small node counts); an engine that keeps
 * reporting far more often than once per iteration is told so, once per engine session.
 */
const infoRate = new InfoRateWatch((perSecond) => post({ type: "log", text: infoRateNote(perSecond) }));

function forwardLog(text: string): void {
  if (logBudget > 0) {
    logBudget--;
    post({ type: "log", text });
  } else {
    suppressedLogs++;
  }
}

function dispatch(e: EngineInstance, call: EngineWorkerCall): unknown {
  switch (call.method) {
    case "newGame":
      return e.newGame();
    case "position": {
      const [startFen, moves] = call.args as EngineMethods["position"]["args"];
      return e.position(startFen, moves);
    }
    case "go":
      return e.go((call.args as EngineMethods["go"]["args"])[0]);
    case "eval":
      return e.eval();
    case "evalTrace":
      return e.evalTrace();
    case "perft":
      return e.perft((call.args as EngineMethods["perft"]["args"])[0]);
    case "setOption": {
      const [name, value] = call.args as EngineMethods["setOption"]["args"];
      return e.setOption(name, value);
    }
    case "loadNetwork":
      return e.loadNetwork((call.args as EngineMethods["loadNetwork"]["args"])[0]);
  }
}

function handleCall(call: EngineWorkerCall): void {
  currentCall = call.id;
  logBudget = MAX_LOG_LINES_PER_CALL;
  suppressedLogs = 0;
  infos.reset();
  infoRate.startCall();
  try {
    if (!engine) throw new Error("The engine is not initialised.");
    const value = dispatch(engine, call);
    infos.flush(); // the newest info must reach the client before the answer
    post({ type: "result", id: call.id, value });
  } catch (err) {
    infos.flush();
    post({ type: "error", id: call.id, message: err instanceof Error ? err.message : String(err), crashed: engine?.broken ?? false });
  } finally {
    if (suppressedLogs > 0) post({ type: "log", text: `[host] ${suppressedLogs} more log lines from this call were suppressed` });
  }
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as EngineWorkerRequest;
  queue = queue.then(async () => {
    if (msg.type === "init") {
      try {
        rememberModuleInfo(msg.module, msg.moduleInfo);
        engine = await EngineInstance.create(msg.module, {
          stopFlag: msg.stopBuffer ? new Int32Array(msg.stopBuffer) : null,
          hashMb: msg.hashMb ?? undefined,
          network: msg.network,
          onInfo: (info) => {
            infoRate.record();
            infos.push(info);
          },
          onLog: forwardLog,
        });
        infos.flush();
        post({ type: "ready", capabilities: engine.capabilities });
      } catch (err) {
        post({ type: "init-error", message: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === "call") {
      handleCall(msg);
    }
  });
};
