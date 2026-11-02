// Chess Builder Engine ABI v1 constants and checks (docs/ENGINE_ABI.md).
import type { SearchLimits } from "@/types";
import { formatFuncType, type WasmFuncType, type WasmModuleInfo, type WasmValType } from "./module-info";

export const ABI_VERSION = 1;
/** Guaranteed capacity of the engine's input/output buffers. */
export const IO_BUFFER_BYTES = 65536;

export const REQUIRED_FUNCTIONS = ["cb_abi_version", "cb_init", "cb_in", "cb_out", "cb_new_game", "cb_position", "cb_go"] as const;

/** Optional exports and what the app loses without them. */
export const OPTIONAL_FUNCTIONS: Record<string, string> = {
  cb_eval: "static evaluation in the test panel",
  cb_eval_trace: "the evaluation breakdown",
  cb_perft: "perft (move generation testing)",
  cb_set_option: "setting options such as the hash size",
  cb_nnue_alloc: "loading NNUE networks",
  cb_nnue_load: "loading NNUE networks",
  cb_name: "a self-reported engine name",
};

const sig = (params: WasmValType[], results: WasmValType[]): WasmFuncType => ({ params, results });
const I = "i32" as const;
const F = "f64" as const;

/** Export signatures from ENGINE_ABI.md. */
export const EXPORT_SIGNATURES: Record<string, WasmFuncType> = {
  cb_abi_version: sig([], [I]),
  cb_init: sig([], []),
  cb_in: sig([], [I]),
  cb_out: sig([], [I]),
  cb_new_game: sig([], []),
  cb_position: sig([I], [I]),
  cb_go: sig([I, F, I, I, I, I, I, I], [I]),
  cb_eval: sig([], [I]),
  cb_eval_trace: sig([], [I]),
  cb_perft: sig([I], [F]),
  cb_set_option: sig([I], [I]),
  cb_nnue_alloc: sig([I], [I]),
  cb_nnue_load: sig([I], [I]),
  cb_name: sig([], [I]),
};

/** Functions the host provides under "env". */
export const HOST_IMPORTS: Record<string, WasmFuncType> = {
  cb_now: sig([], [F]),
  cb_should_stop: sig([], [I]),
  cb_info: sig([I, I, I, I, F, F, I], []),
  cb_log: sig([I], []),
  abort: sig([I, I, I, I], []),
  seed: sig([], [F]),
  trace: sig([I, I, F, F, F, F, F], []),
};

const NUMERIC: ReadonlySet<WasmValType> = new Set<WasmValType>(["i32", "f32", "f64"]);

/**
 * Compares the module's export signatures with the ABI. Errors are mismatches the host cannot call
 * (i64 / vector / reference parameters, missing or multiple results); warnings are mismatches that
 * work through JavaScript's number conversions (e.g. i32 instead of f64).
 */
export function checkExportSignatures(info: WasmModuleInfo): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const exp of info.exports) {
    const expected = EXPORT_SIGNATURES[exp.name];
    if (!expected || exp.kind !== "function" || !exp.type) continue;
    const actual = exp.type;
    const what = `${exp.name} has signature ${formatFuncType(actual)}, the ABI expects ${formatFuncType(expected)}`;
    const badParam = actual.params.find((t) => !NUMERIC.has(t));
    if (badParam) {
      errors.push(`${what}: ${badParam} parameters cannot be passed from JavaScript as plain numbers.`);
      continue;
    }
    if (expected.results.length === 1 && actual.results.length !== 1) {
      errors.push(`${what}: the host needs exactly one return value.`);
      continue;
    }
    if (actual.results.length > 1) {
      errors.push(`${what}: multiple return values are not supported.`);
      continue;
    }
    const result = actual.results[0];
    if (result && !NUMERIC.has(result) && !(result === "i64" && exp.name === "cb_perft")) {
      errors.push(`${what}: ${result} results are not supported.`);
      continue;
    }
    const same = actual.params.length === expected.params.length && actual.params.every((t, i) => t === expected.params[i]) && (actual.results[0] ?? null) === (expected.results[0] ?? null);
    if (!same) warnings.push(`${what}; values will be converted, which may lose information.`);
  }
  return { errors, warnings };
}

export type GoArguments = [depth: number, nodes: number, movetime: number, wtime: number, btime: number, winc: number, binc: number, movestogo: number];

const I32_MAX = 0x7fffffff;

/** A positive limit as a positive integer (never rounds a real limit down to "no limit"). */
function positiveInt(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(I32_MAX, Math.max(1, Math.round(v)));
}

function clockMs(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(I32_MAX, Math.round(v));
}

/** Maps SearchLimits onto the eight cb_go arguments (ENGINE_ABI.md "Search limits"). */
export function goArguments(limits: SearchLimits): GoArguments {
  if (limits.infinite) return [0, 0, 0, -1, -1, 0, 0, 0];
  const depth = positiveInt(limits.depth);
  const nodes = typeof limits.nodes === "number" && Number.isFinite(limits.nodes) && limits.nodes > 0 ? Math.max(1, Math.round(limits.nodes)) : 0;
  const movetime = positiveInt(limits.movetimeMs);
  const c = limits.clock;
  if (!c) return [depth, nodes, movetime, -1, -1, 0, 0, 0];
  return [depth, nodes, movetime, clockMs(c.wtime), clockMs(c.btime), clockMs(c.winc), clockMs(c.binc), clockMs(c.movestogo)];
}

/** The text of a cb_position call: "startpos [moves ...]" or "fen <FEN> [moves ...]". */
export function positionCommand(startFen: string, moves: readonly string[]): string {
  const fen = startFen.trim();
  let cmd = fen === "" || fen === "startpos" ? "startpos" : fen.startsWith("fen ") ? fen : `fen ${fen}`;
  const list = moves.map((m) => m.trim()).filter(Boolean);
  if (list.length) cmd += ` moves ${list.join(" ")}`;
  return cmd;
}
