// Compiler worker: loads AssemblyScript (+ Binaryen) once, on the first request or on "preload",
// and compiles requests one at a time. Spawned by ./index.ts.
import type { CompileRequest } from "@/types";
import { workerScope } from "@/utils/misc";
import type { AscModule } from "./asc-types";
import { compileWithAsc, compilerVersionOf, failedResult } from "./core";
import { loadAsc } from "./load-asc.js";
import type { CompilerWorkerRequest, CompilerWorkerResponse } from "./protocol";

const scope = workerScope();
const post = (msg: CompilerWorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

let asc: AscModule | null = null;
let ascLoading: Promise<AscModule> | null = null;

function getAsc(): Promise<AscModule> {
  if (asc) return Promise.resolve(asc);
  if (!ascLoading) {
    ascLoading = loadAsc().then(
      (mod) => {
        asc = mod;
        post({ type: "loaded", version: compilerVersionOf(mod) });
        return mod;
      },
      (err: unknown) => {
        ascLoading = null; // allow a retry on the next request
        throw err;
      },
    );
  }
  return ascLoading;
}

async function handleCompile(id: number, request: CompileRequest): Promise<void> {
  let compiler: AscModule;
  try {
    if (!asc) post({ type: "status", id, status: "loading-compiler" });
    compiler = await getAsc();
  } catch (err) {
    const message = `Could not load the AssemblyScript compiler: ${err instanceof Error ? err.message : String(err)}`;
    post({ type: "result", id, result: failedResult(message) });
    return;
  }
  post({ type: "status", id, status: "compiling" });
  const result = await compileWithAsc(compiler, request);
  post({ type: "result", id, result }, result.wasm ? [result.wasm.buffer] : []);
}

// Serial queue: asc is not re-entrant and compiles are CPU-bound anyway.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as CompilerWorkerRequest;
  if (msg.type === "preload") {
    getAsc().catch((err: unknown) => post({ type: "load-error", message: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (msg.type === "compile") {
    queue = queue.then(() =>
      handleCompile(msg.id, msg.request).catch((err: unknown) => {
        post({ type: "result", id: msg.id, result: failedResult(`Compiler worker error: ${err instanceof Error ? err.message : String(err)}`) });
      }),
    );
  }
};
