// Messages between EngineClient (main thread) and engine.worker.ts.
import type { EngineCapabilities, SearchInfo, SearchLimits, TraceEntry } from "@/types";
import type { GoOutcome } from "./instance";
import type { WasmModuleInfo } from "./module-info";

/** The EngineInstance methods the worker exposes, with their argument and result types. */
export interface EngineMethods {
  newGame: { args: []; result: void };
  position: { args: [startFen: string, moves: string[]]; result: boolean };
  go: { args: [limits: SearchLimits]; result: GoOutcome };
  eval: { args: []; result: number | null };
  evalTrace: { args: []; result: TraceEntry[] | null };
  perft: { args: [depth: number]; result: number | null };
  setOption: { args: [name: string, value: string]; result: boolean };
  loadNetwork: { args: [bytes: ArrayBuffer]; result: boolean };
}

export type EngineMethod = keyof EngineMethods;

export interface EngineWorkerInit {
  type: "init";
  module: WebAssembly.Module;
  /** Import/export signatures read from the bytes (a Module cannot be re-parsed in the worker). */
  moduleInfo: WasmModuleInfo | null;
  /** 4-byte SharedArrayBuffer behind the stop flag, when cross-origin isolated. */
  stopBuffer: SharedArrayBuffer | null;
  hashMb: number | null;
  network: ArrayBuffer | null;
}

export interface EngineWorkerCall<M extends EngineMethod = EngineMethod> {
  type: "call";
  id: number;
  method: M;
  args: EngineMethods[M]["args"];
}

export type EngineWorkerRequest = EngineWorkerInit | EngineWorkerCall;

export type EngineWorkerResponse =
  | { type: "ready"; capabilities: EngineCapabilities }
  | { type: "init-error"; message: string }
  | { type: "result"; id: number; value: unknown }
  /** `crashed`: the engine trapped and the instance is unusable (the client re-creates it). */
  | { type: "error"; id: number; message: string; crashed: boolean }
  | { type: "info"; id: number; info: SearchInfo }
  | { type: "log"; text: string };
