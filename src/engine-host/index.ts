// Public API of the engine host (docs/ARCHITECTURE.md §5). Worker files are intentionally not
// exported. Code running inside a worker should import "./instance" directly: this index also
// pulls in storage, the compiler client and the bundled template sources.
export { TEMPLATE_VERSION, templateFiles, variantFiles, defaultFilesFor, scratchFiles, usesTemplate } from "./templates";
export { EngineInstance, EngineCrashError, type EngineInstanceOptions, type GoOutcome } from "./instance";
export { EngineClient, EngineCallError, type EngineClientOptions } from "./client";
export {
  assembleSources,
  BuildError,
  buildEngine,
  getEngineArtifacts,
  loadEngine,
  getStockNnueWasm,
  isBuildCurrent,
  sourceHashOf,
  BUILD_OPTIONS,
  STOCK_NNUE_SETTING,
  type BuildOutcome,
} from "./build";
export { toSearchLimits, searchDeadlineMs, sideToMoveOf, DEFAULT_MOVETIME_MS, DEFAULT_MAX_WAIT_MS, STOP_GRACE_MS } from "./limits";
export { inspectWasm, type WasmInspection } from "./inspect";
export { ABI_VERSION, IO_BUFFER_BYTES, goArguments, positionCommand } from "./abi";
