// EngineInstance: synchronous wrapper around one instantiated engine module (docs/ENGINE_ABI.md).
// Works in any worker and in Node. Calls block until the engine returns, so in the browser an
// instance lives inside engine.worker.ts and is driven through EngineClient.
import type { EngineCapabilities, SearchInfo, SearchLimits, TraceEntry } from "@/types";
import { ABI_VERSION, IO_BUFFER_BYTES, REQUIRED_FUNCTIONS, checkExportSignatures, goArguments, positionCommand } from "./abi";
import { buildImports, type BuiltImports } from "./imports";
import { WasmMemoryAccess } from "./memory";
import { compileModule, moduleInfoOf } from "./module-info";

export interface EngineInstanceOptions {
  /** Shared stop flag: cb_should_stop returns Atomics.load(stopFlag, 0). */
  stopFlag?: Int32Array | null;
  onInfo?: (i: SearchInfo) => void;
  /** Engine output (cb_log, trace, WASI stdout/stderr) and host notes (prefixed "[host]"). */
  onLog?: (s: string) => void;
  /** Passed as `Hash=N` via cb_set_option when the engine supports options. */
  hashMb?: number;
  /** NNUE network loaded right after cb_init (throws if the engine cannot load it). */
  network?: ArrayBuffer | null;
}

export interface GoOutcome {
  bestMove: string | null;
  /** Last cb_info reported during this search. */
  info: SearchInfo | null;
  /** Duration of the cb_go call, measured where the engine runs. */
  elapsedMs: number;
  /**
   * The shared stop flag was raised when cb_go returned, i.e. the host asked the engine to stop
   * while it was still searching (always false without a flag). Lets EngineClient tell a search the
   * host had to cut short from an answer that was merely processed late.
   */
  stopFlagRaised: boolean;
}

/** A call into the engine failed (trap, abort, proc_exit...). The instance is unusable afterwards. */
export class EngineCrashError extends Error {
  constructor(
    message: string,
    /** The ABI function that was running, e.g. "cb_go". */
    readonly during: string,
  ) {
    super(message);
    this.name = "EngineCrashError";
  }
}

type ExportFn = (...args: number[]) => unknown;

/** Largest engine output we decode in one go (PV, logs, traces). */
const MAX_OUTPUT_BYTES = 1 << 20;

const toInt = (v: unknown): number => (typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : Number(v) | 0);
const toPtr = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v) >>> 0);
const toNum = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

/** Human-readable description of whatever a wasm call threw. */
export function describeEngineError(err: unknown): string {
  if (err instanceof WebAssembly.RuntimeError) return `WebAssembly trap: ${err.message}`;
  if (err instanceof RangeError && /call stack/i.test(err.message)) return `Stack overflow (${err.message})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parses cb_eval_trace output: `label\twhite\tblack` lines (the optional "total" line included). */
export function parseTrace(text: string): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const [label, white, black] = line.split("\t");
    if (!label?.trim()) continue;
    const w = Number(white);
    const b = Number(black);
    entries.push({ label: label.trim(), white: Number.isFinite(w) ? w : 0, black: Number.isFinite(b) ? b : 0 });
  }
  return entries;
}

export class EngineInstance {
  private readonly fns: Record<string, ExportFn | undefined>;
  private readonly mem: WasmMemoryAccess;
  private readonly opts: EngineInstanceOptions;
  private readonly built: BuiltImports;
  private inPtr = 0;
  private outPtr = 0;
  private outPtrKnown = false;
  private crashed: string | null = null;
  private searchInfo: SearchInfo | null = null;
  /** Filled in by initialize() from the engine's exports. */
  private caps: EngineCapabilities = { abiVersion: 0, eval: false, trace: false, perft: false, nnue: false, setOption: false, name: null, stopFlag: false };

  private constructor(exportsObj: WebAssembly.Exports, mem: WasmMemoryAccess, built: BuiltImports, opts: EngineInstanceOptions) {
    this.mem = mem;
    this.built = built;
    this.opts = opts;
    this.fns = {};
    for (const [name, value] of Object.entries(exportsObj)) if (typeof value === "function") this.fns[name] = value as ExportFn;
  }

  /** What the engine supports (from its exports, cb_abi_version and cb_name). */
  get capabilities(): EngineCapabilities {
    return this.caps;
  }

  /**
   * Instantiates an engine and runs the ABI start-up sequence:
   * [_initialize] → cb_init → version check → [Hash option] → [network] → cb_new_game.
   */
  static async create(module: WebAssembly.Module | ArrayBuffer | Uint8Array, opts: EngineInstanceOptions = {}): Promise<EngineInstance> {
    const wasmModule = module instanceof WebAssembly.Module ? module : await compileModule(module);
    const info = moduleInfoOf(wasmModule);

    const missing = REQUIRED_FUNCTIONS.filter((name) => !WebAssembly.Module.exports(wasmModule).some((e) => e.name === name && e.kind === "function"));
    if (missing.length) {
      throw new Error(`Not a Chess Builder engine: missing required export${missing.length > 1 ? "s" : ""} ${missing.join(", ")} (see the Engine ABI documentation).`);
    }
    if (info) {
      const { errors } = checkExportSignatures(info);
      if (errors.length) throw new Error(`Incompatible engine: ${errors.join(" ")}`);
    }

    const mem = new WasmMemoryAccess();
    // The instance object does not exist yet while imports are built; route callbacks through it later.
    let self: EngineInstance | null = null;
    const built = buildImports(wasmModule, info, mem, {
      now: () => performance.now(),
      shouldStop: () => (opts.stopFlag ? Atomics.load(opts.stopFlag, 0) : 0),
      info: (...args) => self?.handleInfo(...args),
      log: (len) => self?.emit(self.readOut(len)),
      output: (text) => self?.emit(text),
      note: (text) => self?.emit(`[host] ${text}`),
    });

    // A memory we created for the module is readable even while its start function runs.
    if (built.importedMemory) mem.attach(built.importedMemory);
    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(wasmModule, built.imports);
    } catch (err) {
      throw new Error(`The engine could not be instantiated: ${describeEngineError(err)}`);
    }

    const memory = instance.exports.memory instanceof WebAssembly.Memory ? instance.exports.memory : built.importedMemory;
    if (!memory) throw new Error("Not a Chess Builder engine: it does not export its memory as `memory`.");
    mem.attach(memory);

    const engine = new EngineInstance(instance.exports, mem, built, opts);
    self = engine;
    try {
      engine.initialize();
    } catch (err) {
      if (err instanceof EngineCrashError) throw new EngineCrashError(`The engine crashed while starting (${err.during}): ${err.message}`, err.during);
      throw err;
    }
    return engine;
  }

  /** True after a trap: every further call throws. Create a new instance instead. */
  get broken(): boolean {
    return this.crashed !== null;
  }

  /** Why the instance broke (null while healthy). */
  get crashReason(): string | null {
    return this.crashed;
  }

  /** Imports satisfied by stubs ("module.name"), for diagnostics. */
  get stubbedImports(): readonly string[] {
    return this.built.stubbed;
  }

  // --- ABI calls ---------------------------------------------------------------------------------

  newGame(): void {
    this.call("cb_new_game", () => this.fn("cb_new_game")());
  }

  /** `startFen` is "startpos" or a FEN; returns false if the engine rejects the position. */
  position(startFen: string, moves: string[]): boolean {
    const len = this.writeIn(positionCommand(startFen, moves));
    if (len < 0) {
      this.emit(`[host] position command longer than ${IO_BUFFER_BYTES} bytes was not sent`);
      return false;
    }
    return toInt(this.call("cb_position", () => this.fn("cb_position")(len))) !== 0;
  }

  /** Runs a search (blocking). Info callbacks arrive during the call. */
  go(limits: SearchLimits): GoOutcome {
    const args = goArguments(limits);
    this.searchInfo = null;
    const t0 = performance.now();
    const len = toInt(this.call("cb_go", () => this.fn("cb_go")(...args)));
    const elapsedMs = performance.now() - t0;
    const stopFlagRaised = this.opts.stopFlag ? Atomics.load(this.opts.stopFlag, 0) !== 0 : false;
    const text = len > 0 ? this.readOut(len).trim() : "";
    // Only the first token counts (tolerates "e2e4 ponder e7e5" style output).
    const bestMove = text ? text.split(/\s+/)[0] : null;
    return { bestMove, info: this.searchInfo, elapsedMs, stopFlagRaised };
  }

  /** Static eval, White POV centipawns (null if the engine has no cb_eval). */
  eval(): number | null {
    const f = this.fns.cb_eval;
    return f ? toInt(this.call("cb_eval", () => f())) : null;
  }

  evalTrace(): TraceEntry[] | null {
    const f = this.fns.cb_eval_trace;
    if (!f) return null;
    const len = toInt(this.call("cb_eval_trace", () => f()));
    return parseTrace(len > 0 ? this.readOut(len) : "");
  }

  perft(depth: number): number | null {
    const f = this.fns.cb_perft;
    if (!f) return null;
    const d = Math.max(0, Math.floor(depth));
    return toNum(this.call("cb_perft", () => f(d)));
  }

  setOption(name: string, value: string): boolean {
    const f = this.fns.cb_set_option;
    if (!f) return false;
    const len = this.writeIn(`${name}=${value}`);
    if (len < 0) return false;
    return toInt(this.call("cb_set_option", () => f(len))) !== 0;
  }

  /** Copies a CBNN network into the engine and activates it; false if unsupported or rejected. */
  loadNetwork(bytes: ArrayBuffer): boolean {
    return this.loadNetworkDetailed(bytes) === null;
  }

  /** Calls any export by name (guarded like the ABI calls). For engine-specific debug functions. */
  callRaw(name: string, ...args: number[]): unknown {
    const f = this.fns[name];
    if (!f) throw new Error(`The engine has no export named ${name}`);
    return this.call(name, () => f(...args));
  }

  /** Last info of the current / most recent search. */
  get lastInfo(): SearchInfo | null {
    return this.searchInfo;
  }

  // --- internals ---------------------------------------------------------------------------------

  private initialize(): void {
    const reactorInit = this.fns._initialize; // WASI "reactor" modules must run this before anything else
    if (reactorInit) this.call("_initialize", () => reactorInit());
    this.call("cb_init", () => this.fn("cb_init")());
    const abiVersion = toInt(this.call("cb_abi_version", () => this.fn("cb_abi_version")()));
    if (abiVersion !== ABI_VERSION) {
      throw new Error(`Unsupported engine ABI version ${abiVersion}: this app implements version ${ABI_VERSION}.`);
    }
    this.inPtr = toPtr(this.call("cb_in", () => this.fn("cb_in")()));
    this.outPtr = toPtr(this.call("cb_out", () => this.fn("cb_out")()));
    this.outPtrKnown = true;
    const size = this.mem.byteLength;
    if (this.inPtr <= 0 || this.inPtr >= size || this.outPtr <= 0 || this.outPtr >= size) {
      throw new Error(`The engine returned invalid buffer pointers (cb_in=${this.inPtr}, cb_out=${this.outPtr}, memory ${size} bytes).`);
    }

    let name: string | null = null;
    const nameFn = this.fns.cb_name;
    if (nameFn) {
      const len = toInt(this.call("cb_name", () => nameFn()));
      name = len > 0 ? this.readOut(len).trim() || null : null;
    }

    const caps: EngineCapabilities = {
      abiVersion,
      eval: !!this.fns.cb_eval,
      trace: !!this.fns.cb_eval_trace,
      perft: !!this.fns.cb_perft,
      nnue: !!this.fns.cb_nnue_alloc && !!this.fns.cb_nnue_load,
      setOption: !!this.fns.cb_set_option,
      name,
      stopFlag: !!this.opts.stopFlag,
    };
    this.caps = caps;

    const hashMb = this.opts.hashMb;
    if (caps.setOption && typeof hashMb === "number" && Number.isFinite(hashMb) && hashMb > 0) {
      if (!this.setOption("Hash", String(Math.round(hashMb)))) this.emit(`[host] the engine did not accept Hash=${Math.round(hashMb)}`);
    }

    const network = this.opts.network;
    if (network && network.byteLength > 0) {
      if (!caps.nnue) {
        throw new Error("This engine cannot load NNUE networks (it does not export cb_nnue_alloc and cb_nnue_load). Remove the network or use an NNUE-capable engine.");
      }
      const problem = this.loadNetworkDetailed(network);
      if (problem) throw new Error(problem);
    }

    this.newGame();
  }

  /** Returns null on success or a description of the failure. */
  private loadNetworkDetailed(bytes: ArrayBuffer): string | null {
    const alloc = this.fns.cb_nnue_alloc;
    const load = this.fns.cb_nnue_load;
    if (!alloc || !load) return "This engine cannot load NNUE networks.";
    const size = bytes.byteLength;
    if (size <= 0) return "The network file is empty.";
    const ptr = toPtr(this.call("cb_nnue_alloc", () => alloc(size)));
    if (ptr === 0) return `The engine could not allocate ${size.toLocaleString("en-US")} bytes for the network (cb_nnue_alloc returned 0).`;
    // Allocation may have grown memory: write through a fresh view.
    if (!this.mem.write(ptr, new Uint8Array(bytes))) return "cb_nnue_alloc returned a buffer outside the engine's memory.";
    const ok = toInt(this.call("cb_nnue_load", () => load(size))) !== 0;
    return ok ? null : "The engine rejected the network (cb_nnue_load returned 0). It may be corrupt or use a format/size this engine does not support.";
  }

  private fn(name: string): ExportFn {
    const f = this.fns[name];
    if (!f) throw new Error(`The engine has no export named ${name}`);
    return f;
  }

  /** Runs a wasm call; any exception marks the instance broken (its state may be corrupt). */
  private call<T>(during: string, run: () => T): T {
    if (this.crashed) throw new EngineCrashError(`The engine crashed earlier and must be restarted (${this.crashed})`, during);
    try {
      return run();
    } catch (err) {
      this.crashed = describeEngineError(err);
      throw new EngineCrashError(this.crashed, during);
    } finally {
      this.built.wasi?.flush();
    }
  }

  private readOut(len: number): string {
    const n = Math.max(0, Math.min(toInt(len), MAX_OUTPUT_BYTES));
    if (n === 0) return "";
    if (!this.outPtrKnown) {
      // cb_log during cb_init arrives before the host has asked for the output buffer.
      this.outPtr = toPtr(this.fn("cb_out")());
      this.outPtrKnown = true;
    }
    return this.mem.readUtf8(this.outPtr, n);
  }

  private writeIn(text: string): number {
    const capacity = Math.min(IO_BUFFER_BYTES, this.mem.byteLength - this.inPtr);
    return this.mem.writeUtf8(this.inPtr, text, capacity);
  }

  private handleInfo(depth: number, seldepth: number, score: number, mate: number, nodes: number, timeMs: number, pvLen: number): void {
    const pvText = this.readOut(pvLen).trim();
    const mateN = Math.trunc(mate) | 0;
    const info: SearchInfo = {
      depth: Math.trunc(depth),
      seldepth: Math.trunc(seldepth),
      scoreCp: mateN !== 0 ? null : Math.trunc(score),
      mate: mateN !== 0 ? mateN : null,
      nodes,
      timeMs,
      nps: timeMs > 0 ? Math.round((nodes * 1000) / timeMs) : 0,
      pv: pvText ? pvText.split(/\s+/) : [],
    };
    this.searchInfo = info;
    try {
      this.opts.onInfo?.(info);
    } catch (err) {
      console.error("EngineInstance onInfo callback failed", err); // never let a UI bug abort the search
    }
  }

  private emit(text: string): void {
    try {
      this.opts.onLog?.(text);
    } catch (err) {
      console.error("EngineInstance onLog callback failed", err);
    }
  }
}
