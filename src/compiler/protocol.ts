// Messages between the compiler client (index.ts) and compiler.worker.ts.
import type { CompileRequest, CompileResult } from "@/types";

export type CompilerStatus = "loading-compiler" | "compiling";

export type CompilerWorkerRequest =
  /** Start loading asc now so the first compile is fast. */
  | { type: "preload" }
  | { type: "compile"; id: number; request: CompileRequest };

export type CompilerWorkerResponse =
  | { type: "status"; id: number; status: CompilerStatus }
  /** The `wasm` buffer of `result` is transferred. */
  | { type: "result"; id: number; result: CompileResult }
  | { type: "loaded"; version: string }
  | { type: "load-error"; message: string };
