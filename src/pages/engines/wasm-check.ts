// Checks an uploaded .wasm before it becomes an engine: inspectWasm() validates it against the
// Engine ABI, then a trial start in a worker proves that cb_init works and reads the name the
// engine reports (cb_name). Running the engine in a worker keeps a module that hangs from
// freezing the page.
import { EngineClient, inspectWasm, type WasmInspection } from "@/engine-host";

/** What an uploaded module supports, from its exports and imports. */
export interface ModuleCapabilities {
  /** cb_eval: static evaluation in the test panel. */
  eval: boolean;
  /** cb_eval_trace: evaluation breakdown. */
  trace: boolean;
  /** cb_perft: move-generation testing. */
  perft: boolean;
  /** cb_nnue_alloc + cb_nnue_load: can load NNUE networks. */
  nnue: boolean;
  /** cb_set_option: options such as the hash size. */
  options: boolean;
  /** Imports env.cb_should_stop, so a search can be stopped without restarting the worker. */
  instantStop: boolean;
}

export const CAPABILITY_LABELS: ReadonlyArray<{ key: keyof ModuleCapabilities; label: string; hint: string }> = [
  { key: "eval", label: "Evaluation", hint: "cb_eval — static evaluation in the Workshop's test panel" },
  { key: "trace", label: "Eval breakdown", hint: "cb_eval_trace — the evaluation split into its terms" },
  { key: "perft", label: "Perft", hint: "cb_perft — counts move-tree leaves to test move generation" },
  { key: "nnue", label: "NNUE", hint: "cb_nnue_alloc / cb_nnue_load — can load NNUE networks" },
  { key: "options", label: "Options", hint: "cb_set_option — accepts options such as the hash size" },
  { key: "instantStop", label: "Instant stop", hint: "Polls cb_should_stop, so searches end at once instead of the host restarting its worker" },
];

export function capabilitiesFromInspection(inspection: Pick<WasmInspection, "exports" | "imports">): ModuleCapabilities {
  const exports = new Set(inspection.exports);
  return {
    eval: exports.has("cb_eval"),
    trace: exports.has("cb_eval_trace"),
    perft: exports.has("cb_perft"),
    nnue: exports.has("cb_nnue_alloc") && exports.has("cb_nnue_load"),
    options: exports.has("cb_set_option"),
    instantStop: inspection.imports.includes("env.cb_should_stop"),
  };
}

export interface WasmCheck {
  /** The module can be used as an engine. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  capabilities: ModuleCapabilities;
  /** The name the engine reports through cb_name (null if it has none or did not start). */
  reportedName: string | null;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Validates and trial-starts a module. Never rejects. `signal` abandons the check. */
export async function checkWasmModule(bytes: ArrayBuffer, signal?: AbortSignal): Promise<WasmCheck> {
  let inspection: WasmInspection;
  try {
    inspection = await inspectWasm(bytes);
  } catch (err) {
    return { ok: false, errors: [`The file could not be checked: ${messageOf(err)}`], warnings: [], capabilities: capabilitiesFromInspection({ exports: [], imports: [] }), reportedName: null };
  }
  const capabilities = capabilitiesFromInspection(inspection);
  const result: WasmCheck = { ok: inspection.ok, errors: [...inspection.errors], warnings: [...inspection.warnings], capabilities, reportedName: null };
  if (!inspection.ok || signal?.aborted) return result;

  let client: EngineClient | null = null;
  try {
    // A copy: the check must not detach or share the buffer the engine record will store.
    client = await EngineClient.create(bytes.slice(0), { hashMb: 1, label: "upload check", maxWaitMs: 15_000 });
    result.reportedName = client.capabilities.name;
  } catch (err) {
    result.ok = false;
    result.errors.push(`The module is valid WebAssembly, but the engine failed to start: ${messageOf(err)}`);
  } finally {
    client?.terminate();
  }
  return result;
}
