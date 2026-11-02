// Node-only test harness for generated evaluations: compiles engine/template (read from disk)
// with a replacement eval.ts through the AssemblyScript compiler API and the app's flags, and
// runs the result through the engine ABI (docs/ENGINE_ABI.md) with a minimal host.
// Used by compile.test.ts and by throwaway match scripts. Never import it from app code.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
// asc is loaded through the compiler package's JS shim on purpose: importing "assemblyscript/asc"
// from a .ts file would pull asc's declaration files (which declare AssemblyScript globals such as
// `i32` and `abs`) into the app's type check.
import type { AscDiagnosticMessage } from "@/compiler/asc-types";
import { loadAsc } from "@/compiler/load-asc.js";
import { makeRng } from "./fuzz";

export { makeRng };

/** engine/template on disk. */
export const TEMPLATE_DIR = fileURLToPath(new URL("../../../engine/template/", import.meta.url));

/** The app's compiler flags (docs/ENGINE_TEMPLATE.md). */
export const ASC_FLAGS = ["-O3", "--runtime", "incremental", "--enable", "simd", "--noColors"] as const;

/** Every engine/template/*.ts file, keyed by file name. */
export function templateSources(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(TEMPLATE_DIR)) {
    if (name.endsWith(".ts")) files[name] = readFileSync(TEMPLATE_DIR + name, "utf8");
  }
  return files;
}

export interface CompileDiagnosticText {
  severity: "error" | "warning" | "info";
  /** File the diagnostic points into (e.g. "eval.ts"), when known. */
  file: string | null;
  text: string;
}

export interface CompileOutput {
  wasm: Uint8Array | null;
  diagnostics: CompileDiagnosticText[];
  /** Everything asc printed. */
  log: string;
  ms: number;
}

/**
 * Compiles the template with `evalSource` as eval.ts (null keeps the template's own eval.ts).
 * Never throws for compile errors: they are returned as diagnostics with `wasm: null`.
 */
export async function compileEngine(evalSource: string | null, files: Record<string, string> = templateSources()): Promise<CompileOutput> {
  const asc = await loadAsc();
  const sources: Record<string, string> = { ...files };
  if (evalSource !== null) sources["eval.ts"] = evalSource;
  const outputs = new Map<string, Uint8Array | string>();
  const diagnostics: CompileDiagnosticText[] = [];
  let log = "";
  const decoder = new TextDecoder();
  const stream = {
    write(chunk: Uint8Array | string) {
      log += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    },
    toString: () => log,
  };
  const t0 = performance.now();
  const lookup = (name: string): string | null => (Object.prototype.hasOwnProperty.call(sources, name) ? sources[name]! : null);
  const { error } = await asc.main(["main.ts", "--outFile", "engine.wasm", ...ASC_FLAGS], {
    stdout: stream,
    stderr: stream,
    // The template is flat, so names arrive as "position.ts" etc. (baseDir ".").
    readFile: (name) => lookup(name.replace(/^\.\//, "")),
    writeFile: (name, contents) => void outputs.set(name, contents),
    listFiles: () => [],
    reportDiagnostic: (d: AscDiagnosticMessage) => {
      const severity = d.category === 3 ? "error" : d.category === 2 ? "warning" : "info";
      const file = d.range?.source?.normalizedPath ?? null;
      diagnostics.push({ severity, file, text: `${severity.toUpperCase()} AS${d.code}: ${d.message}${file ? ` (${file})` : ""}` });
    },
  });
  const ms = performance.now() - t0;
  if (error && !diagnostics.some((d) => d.severity === "error")) diagnostics.push({ severity: "error", file: null, text: error.message });
  const out = outputs.get("engine.wasm");
  const wasm = !error && out instanceof Uint8Array ? new Uint8Array(out) : null;
  return { wasm, diagnostics, log, ms };
}

// ───────────────────────────── minimal ABI host ─────────────────────────────

interface EngineExports {
  memory: WebAssembly.Memory;
  cb_abi_version(): number;
  cb_init(): void;
  cb_in(): number;
  cb_out(): number;
  cb_new_game(): void;
  cb_position(len: number): number;
  cb_go(depth: number, nodes: number, movetime: number, wtime: number, btime: number, winc: number, binc: number, movestogo: number): number;
  cb_eval?(): number;
  cb_eval_trace?(): number;
  cb_set_option?(len: number): number;
}

export interface SearchInfo {
  depth: number;
  score: number;
  mate: number;
  nodes: number;
  pv: string[];
}

export interface TraceLine {
  label: string;
  white: number;
  black: number;
}

export interface Trace {
  /** One entry per term, in the order evaluate() reported them. */
  terms: TraceLine[];
  /** The optional trailing "total" line (White's point of view), or null. */
  total: number | null;
  raw: string;
}

const utf8 = new TextDecoder();
const utf16 = new TextDecoder("utf-16le");
const encoder = new TextEncoder();

/** One engine instance behind the documented `env` imports, with JS wrappers for the cb_* calls. */
export class TestEngine {
  readonly infos: SearchInfo[] = [];
  readonly logs: string[] = [];
  private constructor(
    readonly exports: EngineExports,
    readonly importNames: string[],
  ) {}

  /** Instantiates, then cb_init → [cb_set_option("Hash=N")] → cb_new_game, like the app's host. */
  static async create(wasm: Uint8Array, opts: { hashMb?: number } = {}): Promise<TestEngine> {
    const module = await WebAssembly.compile(new Uint8Array(wasm));
    let self: TestEngine | null = null;
    const memory = (): WebAssembly.Memory => self!.exports.memory;
    const readOut = (len: number): string => (len > 0 ? utf8.decode(new Uint8Array(memory().buffer, self!.exports.cb_out(), len)) : "");
    /** AssemblyScript string: UTF-16LE, byte length stored as u32 at ptr - 4. */
    const readAsString = (ptr: number): string => {
      if (!ptr) return "";
      const len = new Uint32Array(memory().buffer, ptr - 4, 1)[0]!;
      return utf16.decode(new Uint8Array(memory().buffer, ptr, len));
    };
    const env: Record<string, (...args: number[]) => number | void> = {
      abort: (msg, file, line, col) => {
        throw new Error(`engine abort: ${readAsString(msg!)} at ${readAsString(file!)}:${line}:${col}`);
      },
      cb_now: () => performance.now(),
      cb_should_stop: () => 0,
      cb_info: (depth, _seldepth, score, mate, nodes, _timeMs, pvLen) => {
        const pv = readOut(pvLen!).trim();
        self!.infos.push({ depth: depth!, score: score!, mate: mate!, nodes: nodes!, pv: pv ? pv.split(/\s+/) : [] });
      },
      cb_log: (len) => void self!.logs.push(readOut(len!)),
      seed: () => 0x2545f491,
      trace: (msg, n, ...args) => void self!.logs.push(`trace: ${readAsString(msg!)} ${args.slice(0, n).join(", ")}`),
    };
    const instance = await WebAssembly.instantiate(module, { env });
    const importNames = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
    self = new TestEngine(instance.exports as unknown as EngineExports, importNames);
    self.exports.cb_init();
    if (opts.hashMb !== undefined && !self.setOption(`Hash=${opts.hashMb}`)) throw new Error("Hash option rejected");
    self.exports.cb_new_game();
    return self;
  }

  /** `cb_set_option("name=value")`; false when the engine lacks the export or rejects the option. */
  setOption(text: string): boolean {
    if (!this.exports.cb_set_option) return false;
    const bytes = encoder.encode(text);
    new Uint8Array(this.exports.memory.buffer, this.exports.cb_in(), bytes.length).set(bytes);
    return this.exports.cb_set_option(bytes.length) === 1;
  }

  private readOut(len: number): string {
    return len > 0 ? utf8.decode(new Uint8Array(this.exports.memory.buffer, this.exports.cb_out(), len)) : "";
  }

  /** `cb_position` with "startpos [moves …]" or "fen <FEN> [moves …]". */
  position(command: string): boolean {
    const bytes = encoder.encode(command);
    new Uint8Array(this.exports.memory.buffer, this.exports.cb_in(), bytes.length).set(bytes);
    return this.exports.cb_position(bytes.length) === 1;
  }

  setFen(fen: string): boolean {
    return this.position(`fen ${fen}`);
  }

  newGame(): void {
    this.exports.cb_new_game();
  }

  eval(): number {
    if (!this.exports.cb_eval) throw new Error("engine has no cb_eval export");
    return this.exports.cb_eval();
  }

  trace(): Trace {
    if (!this.exports.cb_eval_trace) throw new Error("engine has no cb_eval_trace export");
    const raw = this.readOut(this.exports.cb_eval_trace());
    const terms: TraceLine[] = [];
    let total: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const cols = line.split("\t");
      if (cols.length !== 3) throw new Error(`malformed trace line ${JSON.stringify(line)}`);
      const [label, white, black] = cols as [string, string, string];
      if (label === "total") total = Number(white);
      else terms.push({ label, white: Number(white), black: Number(black) });
    }
    return { terms, total, raw };
  }

  /** `cb_go` with the given limits (no clock). */
  go(limits: { depth?: number; nodes?: number; movetime?: number }): { best: string | null; infos: SearchInfo[] } {
    this.infos.length = 0;
    const len = this.exports.cb_go(limits.depth ?? 0, limits.nodes ?? 0, limits.movetime ?? 0, -1, -1, 0, 0, 0);
    return { best: len > 0 ? this.readOut(len).trim() : null, infos: [...this.infos] };
  }
}

// ───────────────────────────── positions ─────────────────────────────

const swapCase = (c: string): string => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());

/** The colour-flipped position: ranks mirrored, piece colours, side to move, castling and e.p. swapped. */
export function mirrorFen(fen: string): string {
  const [board = "", side = "w", castling = "-", ep = "-", half = "0", full = "1"] = fen.trim().split(/\s+/);
  const ranks = board.split("/").reverse().map((r) => [...r].map(swapCase).join(""));
  const swapped = new Set([...castling].map(swapCase));
  const rights = castling === "-" ? "-" : ["K", "Q", "k", "q"].filter((c) => swapped.has(c)).join("") || "-";
  const epOut = ep === "-" ? "-" : `${ep[0]}${9 - Number(ep[1])}`;
  return [ranks.join("/"), side === "w" ? "b" : "w", rights, epOut, half, full].join(" ");
}

/** UCI strings of the legal moves in a position (chess.js). */
export function legalUciMoves(fen: string): string[] {
  return new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
}

/** chess.js's internal move generator (no SAN), about 10× faster than `moves({ verbose: true })`. */
interface FastChess {
  _moves(opts: { legal: boolean }): { captured?: unknown; promotion?: unknown }[];
  _makeMove(move: unknown): void;
}

/**
 * FENs from seeded random playouts (deterministic). Captures and promotions are preferred a
 * little so that material imbalances, promotions and endgames show up. Positions without a legal
 * move (mate, stalemate) are skipped.
 */
export function randomFens(count: number, seed: number): string[] {
  const rng = makeRng(seed);
  const out: string[] = [];
  const fast = typeof (Chess.prototype as unknown as Partial<FastChess>)._moves === "function";
  while (out.length < count) {
    const chess = new Chess();
    const plies = 2 + Math.floor(rng() * 140);
    let stuck = false;
    for (let p = 0; p < plies; p++) {
      const moves: { captured?: unknown; promotion?: unknown }[] = fast
        ? (chess as unknown as FastChess)._moves({ legal: true })
        : chess.moves({ verbose: true });
      if (moves.length === 0) {
        stuck = true;
        break;
      }
      const captures = moves.filter((m) => m.captured || m.promotion);
      const pool = captures.length && rng() < 0.4 ? captures : moves;
      const move = pool[Math.floor(rng() * pool.length)]!;
      if (fast) (chess as unknown as FastChess)._makeMove(move);
      else chess.move(move as Parameters<Chess["move"]>[0]);
    }
    if (!stuck && legalUciMoves(chess.fen()).length > 0) out.push(chess.fen());
  }
  return out;
}
