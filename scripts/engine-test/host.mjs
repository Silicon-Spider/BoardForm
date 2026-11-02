// A minimal Node host for BoardForm engines (docs/ENGINE_ABI.md), used by the engine tests.
//
// It supplies the `env` imports (abort, cb_now, cb_should_stop, cb_info, cb_log, seed, trace,
// plus a harmless stub for any other function import), and wraps the cb_* exports in
// convenient JS methods that take care of the input/output buffers.

const REQUIRED_EXPORTS = {
  cb_abi_version: 0,
  cb_init: 0,
  cb_in: 0,
  cb_out: 0,
  cb_new_game: 0,
  cb_position: 1,
  cb_go: 8,
};
const OPTIONAL_EXPORTS = {
  cb_eval: 0,
  cb_eval_trace: 0,
  cb_perft: 1,
  cb_set_option: 1,
  cb_nnue_alloc: 1,
  cb_nnue_load: 1,
  cb_name: 0,
};
export { REQUIRED_EXPORTS, OPTIONAL_EXPORTS };

const utf8 = new TextDecoder();
const utf16 = new TextDecoder("utf-16le");
const encoder = new TextEncoder();

export class TestEngine {
  /**
   * @param {WebAssembly.Module} module compiled engine module
   * @param {{ init?: boolean }} [opts]
   */
  static async create(module, opts = {}) {
    const engine = new TestEngine(module);
    engine.instance = await WebAssembly.instantiate(module, { env: engine.#imports(module) });
    engine.exports = engine.instance.exports;
    if (opts.init !== false) engine.exports.cb_init();
    return engine;
  }

  constructor(module) {
    this.module = module;
    this.instance = null;
    this.exports = null;
    /** "never" | "always" | "afterFirstInfo" | a function returning truthy to stop */
    this.stopMode = "never";
    this.infos = [];
    this.logs = [];
    this.onInfo = null;
    this.firstInfoAt = 0;
    this.stubbedImports = [];
  }

  has(name) {
    return typeof this.exports[name] === "function";
  }

  get memory() {
    return this.exports.memory;
  }

  // ----------------------------------------------------------------- buffer helpers

  readOut(len) {
    if (len <= 0) return "";
    return utf8.decode(new Uint8Array(this.memory.buffer, this.exports.cb_out(), len));
  }

  writeIn(text) {
    const bytes = encoder.encode(text);
    if (bytes.length > 65536) throw new Error("input too long");
    new Uint8Array(this.memory.buffer, this.exports.cb_in(), bytes.length).set(bytes);
    return bytes.length;
  }

  /** AssemblyScript string at `ptr`: UTF-16LE, byte length stored as u32 at ptr - 4. */
  readAsString(ptr) {
    if (!ptr) return "";
    const buf = this.memory.buffer;
    const len = new Uint32Array(buf, ptr - 4, 1)[0];
    return utf16.decode(new Uint8Array(buf, ptr, len));
  }

  #imports(module) {
    const env = {
      abort: (msg, file, line, col) => {
        throw new Error(`engine abort: ${this.readAsString(msg)} at ${this.readAsString(file)}:${line}:${col}`);
      },
      cb_now: () => performance.now(),
      cb_should_stop: () => {
        if (this.stopMode === "always") return 1;
        if (this.stopMode === "afterFirstInfo") return this.infos.length > 0 ? 1 : 0;
        if (typeof this.stopMode === "function") return this.stopMode() ? 1 : 0;
        return 0;
      },
      cb_info: (depth, seldepth, score, mate, nodes, timeMs, pvLen) => {
        const pvText = this.readOut(pvLen).trim();
        const info = { depth, seldepth, score, mate, nodes, timeMs, pv: pvText ? pvText.split(/\s+/) : [] };
        if (this.infos.length === 0) this.firstInfoAt = performance.now();
        this.infos.push(info);
        if (this.onInfo) this.onInfo(info);
      },
      cb_log: (len) => {
        this.logs.push(this.readOut(len));
      },
      seed: () => 0x2545f491,
      trace: (msg, n, ...args) => {
        this.logs.push(`trace: ${this.readAsString(msg)} ${args.slice(0, n).join(", ")}`);
      },
    };
    // Harmless stubs for any other function import under "env".
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "env" && imp.kind === "function" && !(imp.name in env)) {
        this.stubbedImports.push(imp.name);
        env[imp.name] = () => 0;
      }
    }
    return env;
  }

  // ------------------------------------------------------------------ ABI wrappers

  newGame() {
    this.exports.cb_new_game();
  }

  /** "startpos [moves ...]" or "fen <FEN> [moves ...]" -> true on success */
  position(command) {
    return this.exports.cb_position(this.writeIn(command)) === 1;
  }

  /**
   * Runs cb_go. limits: { depth, nodes, movetime, wtime, btime, winc, binc, movestogo }.
   * Returns { best: string|null, infos, last, elapsedMs }.
   */
  go(limits = {}) {
    this.infos = [];
    this.firstInfoAt = 0;
    const t0 = performance.now();
    const len = this.exports.cb_go(
      limits.depth ?? 0,
      limits.nodes ?? 0,
      limits.movetime ?? 0,
      limits.wtime ?? -1,
      limits.btime ?? -1,
      limits.winc ?? 0,
      limits.binc ?? 0,
      limits.movestogo ?? 0,
    );
    const elapsedMs = performance.now() - t0;
    const best = len > 0 ? this.readOut(len).trim() : null;
    return { best, infos: this.infos, last: this.infos[this.infos.length - 1] ?? null, elapsedMs, t0 };
  }

  eval() {
    return this.exports.cb_eval();
  }

  /** Raw trace text. */
  evalTrace() {
    return this.readOut(this.exports.cb_eval_trace());
  }

  perft(depth) {
    return this.exports.cb_perft(depth);
  }

  setOption(text) {
    return this.exports.cb_set_option(this.writeIn(text)) === 1;
  }

  name() {
    return this.readOut(this.exports.cb_name());
  }
}
