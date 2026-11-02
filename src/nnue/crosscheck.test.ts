// Cross-check of the two NNUE implementations of docs/NNUE_FORMAT.md: the app's JS toolkit
// (createNetwork / Trainer / quantizeNetwork / parseNetworkFile / evaluateQuantized) against the
// engine-side inference (engine/template/nnue.ts, used through engine/variants/eval-nnue.ts),
// compiled from the files on disk with the app's compiler flags:
//
//   asc main.ts --outFile engine.wasm -O3 --runtime incremental --enable simd --noColors
//
//  1. Exactness: networks of both activations and hidden sizes 16 / 64 / 128 — fresh from
//     createNetwork and briefly trained by the Trainer (so accumulators reach the negative, linear
//     and saturated regions) — plus two at the clip extremes and HL 8 / 2048, are written with
//     quantizeNetwork, loaded through cb_nnue_alloc / cb_nnue_load, and cb_eval (White POV) must
//     equal evaluateQuantized (side-to-move POV, converted) exactly on >= 1000 random-playout
//     positions.
//  2. File validation: parseNetworkFile and the engine must agree on accepting / rejecting
//     corrupted CBNN variants — and agree with the spec's reject list, written out per variant
//     and as an independent checker for a header fuzz. A rejected file must leave the engine's
//     previous network active; an accepted (payload-corrupted) file must evaluate identically.
import { readFileSync, readdirSync } from "node:fs";
import { Chess } from "chess.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { AscModule } from "@/compiler/asc-types";
import { loadAsc } from "@/compiler/load-asc.js";
import type { Activation, FloatNetworkData } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { extractFeatures } from "./features";
import { HEADER_SIZE, NetworkFormatError, QA, inspectNetworkFile, networkFileSize, parseNetworkFile, quantizeNetwork, type QuantizedNetwork } from "./format";
import { createNetwork } from "./init";
import { evaluateQuantized } from "./reference";
import { makeMaterialDataset } from "./synthetic";
import { Trainer } from "./trainer";

// ------------------------------------------------------------------------------ setup

const TEMPLATE_DIR = new URL("../../engine/template/", import.meta.url);
const NNUE_EVAL = new URL("../../engine/variants/eval-nnue.ts", import.meta.url);
/** The app's compiler flags (docs/ENGINE_TEMPLATE.md). */
const APP_FLAGS = ["-O3", "--runtime", "incremental", "--enable", "simd", "--noColors"];
/** The engine clamps evaluations to ±(MATE_BOUND − 1) (allowed by the spec; MATE_BOUND = 31000). */
const EVAL_LIMIT = 30999;
/** Largest buffer the engine's cb_nnue_alloc hands out (engine choice, not part of the spec). */
const ENGINE_MAX_FILE_BYTES = 8 << 20;
const RANDOM_POSITIONS = 1200;

/** The stock NNUE engine's sources: engine/template/*.ts with eval.ts = variants/eval-nnue.ts. */
function nnueEngineSources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(TEMPLATE_DIR)) {
    if (name.endsWith(".ts")) files.set(name, readFileSync(new URL(name, TEMPLATE_DIR), "utf8"));
  }
  files.set("eval.ts", readFileSync(NNUE_EVAL, "utf8"));
  return files;
}

/** Resolves an asc file name against its base directory ("." for the entry's folder). */
function virtualPath(name: string, baseDir: string): string {
  const parts: string[] = [];
  for (const seg of `${baseDir}/${name}`.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Compiles the sources with the programmatic asc API (in memory, nothing written to disk). */
async function compileEngine(files: Map<string, string>): Promise<WebAssembly.Module> {
  const asc: AscModule = await loadAsc();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const stream = {
    write(chunk: Uint8Array | string) {
      chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    },
    toString: () => chunks.join(""),
  };
  const output: { wasm: Uint8Array<ArrayBuffer> | null } = { wasm: null };
  const { error } = await asc.main(["main.ts", "--outFile", "engine.wasm", ...APP_FLAGS], {
    stdout: stream,
    stderr: stream,
    readFile: (name, baseDir) => files.get(virtualPath(name, baseDir)) ?? null,
    writeFile: (name, contents) => {
      // Copy: asc may hand out a view into Binaryen's heap.
      if (name.endsWith("engine.wasm") && typeof contents !== "string") output.wasm = new Uint8Array(contents);
    },
    listFiles: (dirname, baseDir) => {
      const dir = virtualPath(dirname, baseDir);
      const prefix = dir ? `${dir}/` : "";
      return [...files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map((f) => f.slice(prefix.length));
    },
  });
  if (error || !output.wasm) throw new Error(`the NNUE engine failed to compile: ${error?.message ?? "no output"}\n${stream.toString()}`);
  return new WebAssembly.Module(output.wasm);
}

// ------------------------------------------------------------------- a minimal ABI host

interface EngineExports {
  memory: WebAssembly.Memory;
  cb_init(): void;
  cb_in(): number;
  cb_out(): number;
  cb_new_game(): void;
  cb_position(len: number): number;
  cb_eval(): number;
  cb_nnue_alloc(size: number): number;
  cb_nnue_load(size: number): number;
}

const utf8 = new TextDecoder();
const utf16 = new TextDecoder("utf-16le");
const encoder = new TextEncoder();

/** Just enough of docs/ENGINE_ABI.md to set positions, load networks and call cb_eval. */
class NnueEngine {
  readonly logs: string[] = [];
  private ex: EngineExports | null = null;

  static async create(module: WebAssembly.Module): Promise<NnueEngine> {
    const engine = new NnueEngine();
    const instance = await WebAssembly.instantiate(module, { env: engine.imports(module) });
    engine.ex = instance.exports as unknown as EngineExports;
    engine.exports.cb_init();
    return engine;
  }

  private get exports(): EngineExports {
    if (!this.ex) throw new Error("engine not instantiated");
    return this.ex;
  }

  private imports(module: WebAssembly.Module): Record<string, (...args: number[]) => number | void> {
    const asString = (ptr: number) => {
      if (!ptr) return "";
      const buf = this.exports.memory.buffer;
      return utf16.decode(new Uint8Array(buf, ptr, new Uint32Array(buf, ptr - 4, 1)[0]));
    };
    const env: Record<string, (...args: number[]) => number | void> = {
      abort: (msg = 0, file = 0, line = 0, col = 0) => {
        throw new Error(`engine abort: ${asString(msg)} at ${asString(file)}:${line}:${col}`);
      },
      cb_now: () => performance.now(),
      cb_should_stop: () => 0,
      cb_info: () => {},
      cb_log: (len = 0) => {
        this.logs.push(utf8.decode(new Uint8Array(this.exports.memory.buffer, this.exports.cb_out(), len)));
      },
      seed: () => 0x2545f491,
      trace: () => {},
    };
    // A harmless stub for any other function import (as the app's host does).
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "env" && imp.kind === "function" && !(imp.name in env)) env[imp.name] = () => 0;
    }
    return env;
  }

  newGame(): void {
    this.exports.cb_new_game();
  }

  /** cb_position("fen <fen>"); true on success. */
  position(fen: string): boolean {
    const bytes = encoder.encode(`fen ${fen}`);
    new Uint8Array(this.exports.memory.buffer, this.exports.cb_in(), bytes.length).set(bytes);
    return this.exports.cb_position(bytes.length) === 1;
  }

  /** cb_eval: static evaluation, White's point of view. */
  eval(): number {
    return this.exports.cb_eval();
  }

  /**
   * Loads a network file like the app's host: cb_nnue_alloc(size), copy, cb_nnue_load(size).
   * A null buffer from cb_nnue_alloc counts as a rejection.
   */
  loadNetwork(bytes: Uint8Array): boolean {
    const ptr = this.exports.cb_nnue_alloc(bytes.length);
    if (ptr === 0) return false;
    // Read memory.buffer after the allocation: the memory may have grown.
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return this.exports.cb_nnue_load(bytes.length) === 1;
  }
}

// ---------------------------------------------------------------------- reference side

/** What cb_eval must return: the reference evaluation in White's POV, clamped like the engine. */
function expectedWhite(q: QuantizedNetwork, fen: string): { value: number; clamped: boolean } {
  const stm = evaluateQuantized(q, fen);
  const white = fen.split(" ")[1] === "b" ? -stm : stm;
  const value = Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, white)) + 0; // + 0: no -0
  return { value, clamped: value !== white };
}

/** Compares cb_eval with the reference on `fens`; returns mismatch descriptions and clamp count. */
function compareEvals(engine: NnueEngine, q: QuantizedNetwork, fens: readonly string[]): { mismatches: string[]; clamped: number; values: number[] } {
  const mismatches: string[] = [];
  const values: number[] = [];
  let clamped = 0;
  for (const fen of fens) {
    if (!engine.position(fen)) {
      mismatches.push(`cb_position rejected ${fen}`);
      continue;
    }
    const want = expectedWhite(q, fen);
    if (want.clamped) clamped++;
    const got = engine.eval();
    values.push(want.value);
    if (got !== want.value) mismatches.push(`${fen}: engine ${got}, reference ${want.value}`);
  }
  return { mismatches, clamped, values };
}

/** Accumulator values (both perspectives, all positions) below 0, in [0, QA] and above QA. */
function accumulatorRegions(q: QuantizedNetwork, fens: readonly string[]): { negative: number; linear: number; saturated: number } {
  const hl = q.hidden;
  const acc = new Int16Array(hl);
  let negative = 0;
  let linear = 0;
  let saturated = 0;
  for (const fen of fens) {
    const f = extractFeatures(fen);
    for (const list of [f.white, f.black]) {
      acc.set(q.b1);
      for (let i = 0; i < f.count; i++) {
        const row = (list[i] as number) * hl;
        for (let j = 0; j < hl; j++) acc[j] = (acc[j] as number) + (q.w1[row + j] as number);
      }
      for (let j = 0; j < hl; j++) {
        const v = acc[j] as number;
        if (v < 0) negative++;
        else if (v > QA) saturated++;
        else linear++;
      }
    }
  }
  return { negative, linear, saturated };
}

// ------------------------------------------------------------------------- positions

/** Positions from seeded random playouts (chess.js), sampled along the games. */
function playoutFens(count: number, seed: number): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  while (out.length < count) {
    const chess = new Chess();
    const plies = 4 + Math.floor(rnd() * 160);
    for (let p = 0; p < plies; p++) {
      const moves = chess.moves();
      if (moves.length === 0) break;
      // Prefer captures now and then so that material imbalances and endgames appear.
      const captures = moves.filter((m) => m.includes("x"));
      const pool = captures.length > 0 && rnd() < 0.4 ? captures : moves;
      chess.move(pool[Math.floor(rnd() * pool.length)] as string);
      if (rnd() < 0.08 && out.length < count) out.push(chess.fen());
    }
    if (out.length < count) out.push(chess.fen());
  }
  return out;
}

/** Hand-picked extremes: full board, bare kings, many queens, en passant, Black to move. */
const SPECIAL_FENS = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
  "4k3/8/8/8/8/8/8/4K3 b - - 0 1",
  "QQQQQQQk/8/8/8/8/8/8/K7 b - - 0 1",
  "1k6/8/8/8/8/8/qqqqqqq1/K7 w - - 0 1",
  "rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6 0 3",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
];

// -------------------------------------------------------------------------- networks

const TRAIN_POSITIONS = 8192;
const TRAIN_BATCH = 256;
const TRAIN_STEPS = 160;
const TRAIN_LR = 0.02;

/**
 * 160 AdamW steps (high learning rate) on the synthetic material dataset: enough to move the
 * weights far from their initialisation, so accumulators leave the small linear region.
 */
function trainBriefly(net: FloatNetworkData, seed: number): { network: FloatNetworkData; lossBefore: number; lossAfter: number } {
  const data = makeMaterialDataset(TRAIN_POSITIONS, seed);
  const order = Uint32Array.from({ length: TRAIN_POSITIONS }, (_, i) => i);
  const trainer = new Trainer(net, null, { evalWeight: 0.75, weightDecay: 0.01 });
  const lossBefore = trainer.lossSum(data, order, 0, TRAIN_POSITIONS) / TRAIN_POSITIONS;
  for (let step = 0; step < TRAIN_STEPS; step++) {
    const start = (step * TRAIN_BATCH) % TRAIN_POSITIONS;
    trainer.trainBatch(data, order, start, Math.min(TRAIN_BATCH, TRAIN_POSITIONS - start), TRAIN_LR);
  }
  const lossAfter = trainer.lossSum(data, order, 0, TRAIN_POSITIONS) / TRAIN_POSITIONS;
  return { network: trainer.snapshot().network, lossBefore, lossAfter };
}

/** A handful of Trainer steps (cheap enough for HL 2048). */
function trainBrieflyLight(net: FloatNetworkData): FloatNetworkData {
  const n = 1024;
  const data = makeMaterialDataset(n, net.hidden);
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  const trainer = new Trainer(net, null, { evalWeight: 0.75, weightDecay: 0.01 });
  for (let step = 0; step < 8; step++) trainer.trainBatch(data, order, (step * 128) % n, 128, 0.01);
  return trainer.snapshot().network;
}

/** Float weights spread over ±2.5: quantizeNetwork clips them, so W1/b1 hit ±505 and W2 ±127. */
function clipExtremesNetwork(hidden: number, activation: Activation, seed: number): FloatNetworkData {
  const net = createNetwork(hidden, activation, seed);
  const rnd = mulberry32(seed ^ 0x5bd1e995);
  for (const arr of [net.w1, net.b1, net.w2]) for (let i = 0; i < arr.length; i++) arr[i] = (rnd() * 2 - 1) * 2.5;
  net.b2[0] = (rnd() * 2 - 1) * 2;
  return net;
}

interface TestNetwork {
  label: string;
  kind: "fresh" | "trained" | "extremes";
  file: Uint8Array;
  lossBefore?: number;
  lossAfter?: number;
}

const ACT_NAME = ["CReLU", "SCReLU"] as const;

function buildNetworks(): TestNetwork[] {
  const nets: TestNetwork[] = [];
  let seed = 7000;
  for (const hidden of [16, 64, 128]) {
    for (const activation of [0, 1] as const) {
      const fresh = createNetwork(hidden, activation, seed++);
      nets.push({ label: `HL ${hidden} ${ACT_NAME[activation]} fresh`, kind: "fresh", file: new Uint8Array(quantizeNetwork(fresh)) });
      const t = trainBriefly(fresh, seed++);
      nets.push({
        label: `HL ${hidden} ${ACT_NAME[activation]} trained`,
        kind: "trained",
        file: new Uint8Array(quantizeNetwork(t.network)),
        lossBefore: t.lossBefore,
        lossAfter: t.lossAfter,
      });
    }
  }
  for (const activation of [0, 1] as const) {
    nets.push({
      label: `HL 64 ${ACT_NAME[activation]} clip extremes`,
      kind: "extremes",
      file: new Uint8Array(quantizeNetwork(clipExtremesNetwork(64, activation, seed++))),
    });
  }
  return nets;
}

// ----------------------------------------------------------------------------- tests

let engineModule: WebAssembly.Module;
let fens: string[];
let networks: TestNetwork[];

beforeAll(async () => {
  engineModule = await compileEngine(nnueEngineSources());
  fens = [...playoutFens(RANDOM_POSITIONS, 20261102), ...SPECIAL_FENS];
  networks = buildNetworks();
});

describe("engine NNUE inference (engine/template/nnue.ts) == evaluateQuantized (src/nnue/reference.ts)", () => {
  it("has >= 1000 distinct random-playout positions and networks of every kind", () => {
    expect(new Set(fens.slice(0, RANDOM_POSITIONS)).size).toBeGreaterThanOrEqual(1000);
    expect(fens.some((f) => f.split(" ")[1] === "b") && fens.some((f) => f.split(" ")[1] === "w")).toBe(true);
    expect(networks).toHaveLength(14);
    expect(new Set(networks.map((n) => n.kind))).toEqual(new Set(["fresh", "trained", "extremes"]));
  });

  it("the briefly trained networks really trained: lower loss, accumulators in all three activation regions", () => {
    for (const n of networks.filter((x) => x.kind === "trained")) {
      expect(n.lossAfter!, n.label).toBeLessThan(n.lossBefore! * 0.8);
      const r = accumulatorRegions(parseNetworkFile(n.file), fens);
      const total = r.negative + r.linear + r.saturated;
      // Clamping at 0 and at QA must both be exercised, not just the linear part.
      expect(r.negative / total, `${n.label}: negative share`).toBeGreaterThan(0.05);
      expect(r.saturated / total, `${n.label}: saturated share`).toBeGreaterThan(0.005);
      expect(r.linear / total, `${n.label}: linear share`).toBeGreaterThan(0.05);
    }
  });

  it("every network loads through cb_nnue_alloc / cb_nnue_load and cb_eval matches exactly on every position", async () => {
    // One engine instance for all networks: loading a network replaces the active one.
    const engine = await NnueEngine.create(engineModule);
    let evaluations = 0;
    for (const n of networks) {
      expect(engine.loadNetwork(n.file), `${n.label}: cb_nnue_load (log: ${engine.logs.slice(-2).join(" | ")})`).toBe(true);
      engine.newGame();
      const q = parseNetworkFile(n.file);
      const r = compareEvals(engine, q, fens);
      evaluations += fens.length;
      expect(r.mismatches.slice(0, 5), `${n.label}: ${r.mismatches.length} mismatches`).toEqual([]);
      // Real networks never come near the clamp, so their comparison is unclamped.
      if (n.kind !== "extremes") expect(r.clamped, `${n.label}: clamped evaluations`).toBe(0);
      // Trained / extreme networks give non-trivial evaluations: many distinct values of both
      // signs (fresh ones stay within a few centipawns of 0 by design).
      if (n.kind !== "fresh") {
        expect(new Set(r.values).size, `${n.label}: distinct values`).toBeGreaterThan(fens.length / 10);
        expect(r.values.some((v) => v > 0) && r.values.some((v) => v < 0), `${n.label}: both signs`).toBe(true);
      }
    }
    expect(evaluations).toBeGreaterThanOrEqual(14 * 1000);
  });

  it("a fresh engine instance gives the same results (load right after cb_init, before cb_new_game)", async () => {
    for (const n of networks.filter((x) => x.kind === "trained")) {
      const engine = await NnueEngine.create(engineModule);
      expect(engine.loadNetwork(n.file)).toBe(true);
      engine.newGame();
      const r = compareEvals(engine, parseNetworkFile(n.file), fens.slice(0, 200));
      expect(r.mismatches.slice(0, 5), n.label).toEqual([]);
    }
  });
});

// --------------------------------------------------------- accept / reject agreement

/** docs/NNUE_FORMAT.md's reject list, implemented independently of format.ts and nnue.ts. */
function specAccepts(b: Uint8Array): boolean {
  if (b.length < 64) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  const magic = String.fromCharCode(b[0] as number, b[1] as number, b[2] as number, b[3] as number);
  const hidden = u32(12);
  return (
    magic === "CBNN" &&
    u32(4) === 1 &&
    u32(8) === 768 &&
    hidden % 8 === 0 &&
    hidden >= 8 &&
    hidden <= 2048 &&
    (u32(16) === 0 || u32(16) === 1) &&
    u32(20) === 255 &&
    u32(24) === 64 &&
    u32(28) === 400 &&
    b.length === 68 + 1542 * hidden
  );
}

/** JS verdict; anything thrown must be a NetworkFormatError, and inspectNetworkFile must agree. */
function jsAccepts(bytes: Uint8Array): boolean {
  let ok: boolean;
  try {
    parseNetworkFile(bytes);
    ok = true;
  } catch (e) {
    expect(e).toBeInstanceOf(NetworkFormatError);
    ok = false;
  }
  expect(inspectNetworkFile(bytes).ok).toBe(ok);
  return ok;
}

function withU32(base: Uint8Array, offset: number, value: number): Uint8Array {
  const b = base.slice();
  new DataView(b.buffer).setUint32(offset, value >>> 0, true);
  return b;
}

function withBytes(base: Uint8Array, offset: number, values: readonly number[]): Uint8Array {
  const b = base.slice();
  b.set(values, offset);
  return b;
}

/** A file whose size matches `hidden` exactly (header copied from `base`, payload random). */
function sizedFile(base: Uint8Array, hidden: number, seed: number): Uint8Array {
  const size = 68 + 1542 * hidden;
  const b = new Uint8Array(size);
  b.set(base.subarray(0, HEADER_SIZE));
  new DataView(b.buffer).setUint32(12, hidden, true);
  const rnd = mulberry32(seed);
  for (let i = HEADER_SIZE; i < size; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

/** Payload corruption: the header stays valid, so both sides must accept and agree on evals. */
function withPayload(base: Uint8Array, fill: (dv: DataView, hidden: number) => void): Uint8Array {
  const b = base.slice();
  const dv = new DataView(b.buffer);
  fill(dv, dv.getUint32(12, true));
  return b;
}

interface Variant {
  name: string;
  bytes: Uint8Array;
  /** The spec's verdict, stated explicitly. */
  valid: boolean;
}

/** Header and size corruption of `base` (plus a few valid edits), each with the spec's verdict. */
function headerVariants(base: Uint8Array, other: Uint8Array): Variant[] {
  const hl = new DataView(base.buffer).getUint32(12, true);
  const size = base.length;
  const v: Variant[] = [];
  const add = (name: string, bytes: Uint8Array, valid: boolean) => v.push({ name, bytes, valid });

  add("unchanged", base, true);
  add("a second valid network (other hidden size and activation)", other, true);
  // Reserved fields are not on the reject list.
  add("flags = 1", withU32(base, 32, 1), true);
  add("flags = 0xffffffff", withU32(base, 32, 0xffffffff), true);
  add("reserved bytes 36..63 = 0xff", withBytes(base, 36, new Array<number>(28).fill(0xff)), true);
  // Magic.
  for (let i = 0; i < 4; i++) add(`magic byte ${i} bit-flipped`, withBytes(base, i, [(base[i] as number) ^ 0x01]), false);
  add('magic "cbnn"', withBytes(base, 0, [0x63, 0x62, 0x6e, 0x6e]), false);
  add('magic "NNBC"', withBytes(base, 0, [0x4e, 0x4e, 0x42, 0x43]), false);
  add("magic zeroed", withBytes(base, 0, [0, 0, 0, 0]), false);
  // Version.
  for (const ver of [0, 2, 0x100, 0x01000001, 0xffffffff]) add(`version ${ver}`, withU32(base, 4, ver), false);
  // Inputs.
  for (const inputs of [0, 767, 769, 768 * 2, 768 + 0x10000]) add(`inputs ${inputs}`, withU32(base, 8, inputs), false);
  // Hidden size: invalid values, and valid values that do not match the file size.
  for (const h of [0, 4, hl + 4, hl + 1, 2049, 2056, 4096, 0x80000010, 0xfffffff8]) add(`hidden ${h >>> 0}`, withU32(base, 12, h), false);
  for (const h of [8, hl + 8, 2048]) add(`hidden ${h} (valid size, wrong for the file)`, withU32(base, 12, h), false);
  // Invalid hidden sizes with a file of exactly the size they imply (the size check must not mask them).
  for (const h of [4, 12, 20, 2056, 8192]) add(`hidden ${h} with a file of matching size`, sizedFile(base, h, h), false);
  // Activation.
  for (const act of [2, 3, 0x100, 0x10001, 0xffffffff]) add(`activation ${act >>> 0}`, withU32(base, 16, act), false);
  add("activation switched (still a valid file)", withU32(base, 16, new DataView(base.buffer).getUint32(16, true) ^ 1), true);
  // Quantization constants.
  for (const qa of [0, 254, 256, 255 + 0x100, 255 + 0x10000]) add(`QA ${qa}`, withU32(base, 20, qa), false);
  for (const qb of [0, 63, 65, 64 + 0x1000000]) add(`QB ${qb}`, withU32(base, 24, qb), false);
  for (const sc of [0, 399, 401, 400 + 0x10000]) add(`scale ${sc}`, withU32(base, 28, sc), false);
  // Sizes.
  for (const cut of [1, 2, 4, 1542]) add(`truncated by ${cut} byte(s)`, base.slice(0, size - cut), false);
  add("header only (64 bytes)", base.slice(0, 64), false);
  add("63 bytes", base.slice(0, 63), false);
  add("4 bytes", base.slice(0, 4), false);
  add("empty", new Uint8Array(0), false);
  for (const extra of [1, 4, 1542]) {
    const b = new Uint8Array(size + extra);
    b.set(base);
    add(`${extra} extra byte(s)`, b, false);
  }
  {
    const b = new Uint8Array(2 * size);
    b.set(base);
    b.set(base, size);
    add("two copies concatenated", b, false);
  }
  return v;
}

/**
 * Payload corruption of a valid file (the header stays valid): random bytes, i16 extremes (the
 * accumulators wrap around), output weights outside the trainer's range (the SCReLU fast path
 * must be left), extreme output biases (the engine's clamp). Both sides must accept these and
 * evaluate them identically.
 */
function payloadVariants(base: Uint8Array, label: string): Variant[] {
  const size = base.length;
  const rnd = mulberry32(99);
  const v: Variant[] = [];
  const add = (name: string, bytes: Uint8Array, valid: boolean) => v.push({ name: `${label}: ${name}`, bytes, valid });
  add(
    "random W1/b1/W2 payload",
    withPayload(base, (dv) => {
      for (let o = HEADER_SIZE; o < size - 4; o++) dv.setUint8(o, Math.floor(rnd() * 256));
    }),
    true,
  );
  add(
    "W1 = 0x7fff everywhere (i16 wrap-around)",
    withPayload(base, (dv, h) => {
      for (let i = 0; i < 768 * h; i++) dv.setInt16(HEADER_SIZE + 2 * i, 0x7fff, true);
    }),
    true,
  );
  add(
    "W1 = -32768 everywhere, b1 random",
    withPayload(base, (dv, h) => {
      for (let i = 0; i < 768 * h; i++) dv.setInt16(HEADER_SIZE + 2 * i, -32768, true);
      for (let j = 0; j < h; j++) dv.setInt16(HEADER_SIZE + 1536 * h + 2 * j, Math.floor(rnd() * 65536) - 32768, true);
    }),
    true,
  );
  add(
    "W2 over the full i16 range",
    withPayload(base, (dv, h) => {
      for (let j = 0; j < 2 * h; j++) dv.setInt16(HEADER_SIZE + 1538 * h + 2 * j, Math.floor(rnd() * 65536) - 32768, true);
    }),
    true,
  );
  add(
    "W2 = ±129 (just outside the SCReLU fast path)",
    withPayload(base, (dv, h) => {
      for (let j = 0; j < 2 * h; j++) dv.setInt16(HEADER_SIZE + 1538 * h + 2 * j, rnd() < 0.5 ? 129 : -129, true);
    }),
    true,
  );
  for (const b2 of [2147483647, -2147483648, 1, -1]) {
    add(`b2 = ${b2}`, withPayload(base, (dv, h) => dv.setInt32(HEADER_SIZE + 1542 * h, b2, true)), true);
  }
  return v;
}

describe("parseNetworkFile and the engine agree on accepting / rejecting CBNN files", () => {
  it("explicit corrupted variants: both follow docs/NNUE_FORMAT.md; rejects keep the previous network", async () => {
    const base = networks.find((n) => n.label === "HL 16 SCReLU trained")!.file;
    const other = networks.find((n) => n.label === "HL 64 CReLU trained")!.file;
    const engine = await NnueEngine.create(engineModule);
    expect(engine.loadNetwork(base)).toBe(true);
    engine.newGame();
    let active = parseNetworkFile(base);
    const sample = fens.slice(0, 150);
    // Payload variants of every trained network: HL >= 64 runs the engine's 64-wide tile path,
    // HL 16 only its 8-wide remainder loop.
    const variants = [
      ...headerVariants(base, other),
      ...networks.filter((n) => n.kind === "trained").flatMap((n) => payloadVariants(n.file, n.label)),
    ];
    expect(variants.length).toBeGreaterThan(110);
    const disagreements: string[] = [];
    for (const variant of variants) {
      const js = jsAccepts(variant.bytes);
      const spec = specAccepts(variant.bytes);
      const logsBefore = engine.logs.length;
      const eng = engine.loadNetwork(variant.bytes);
      if (js !== variant.valid || eng !== variant.valid || spec !== variant.valid) {
        disagreements.push(`${variant.name}: expected ${variant.valid ? "accept" : "reject"}, parseNetworkFile ${js}, engine ${eng}, spec checker ${spec}`);
        continue;
      }
      if (eng) {
        active = parseNetworkFile(variant.bytes);
      } else if (variant.bytes.length > 0 && variant.bytes.length <= ENGINE_MAX_FILE_BYTES) {
        // The engine explains a rejection in its log ("NNUE: <reason>").
        const newLogs = engine.logs.slice(logsBefore);
        expect(newLogs.some((l) => l.startsWith("NNUE: ")), `${variant.name}: ${newLogs.join(" | ")}`).toBe(true);
      }
      // Accepted: the new network evaluates exactly like the reference. Rejected: the previous
      // network is still active and unchanged.
      const r = compareEvals(engine, active, sample);
      expect(r.mismatches.slice(0, 3), `after "${variant.name}"`).toEqual([]);
    }
    expect(disagreements).toEqual([]);
  });

  it("header / size fuzz: parseNetworkFile, the engine and an independent spec checker always agree", async () => {
    const base = networks.find((n) => n.label === "HL 16 CReLU trained")!.file;
    const engine = await NnueEngine.create(engineModule);
    expect(engine.loadNetwork(base)).toBe(true);
    let active = parseNetworkFile(base);
    const rnd = mulberry32(4242);
    // Values near the accepted ones make the fuzz hit both verdicts often.
    const interesting = [0, 1, 2, 7, 8, 16, 24, 63, 64, 65, 254, 255, 256, 399, 400, 401, 767, 768, 769, 2048, 2056, 0xffffffff];
    let accepted = 0;
    let rejected = 0;
    const disagreements: string[] = [];
    const baseHidden = new DataView(base.buffer, base.byteOffset).getUint32(12, true);
    for (let trial = 0; trial < 600; trial++) {
      let b: Uint8Array = base.slice();
      const edits = 1 + Math.floor(rnd() * 3);
      for (let e = 0; e < edits; e++) {
        const kind = rnd();
        if (kind < 0.45) {
          // Replace one of the nine header u32 fields with an interesting or random value.
          const field = Math.floor(rnd() * 9) * 4;
          const value = rnd() < 0.7 ? (interesting[Math.floor(rnd() * interesting.length)] as number) : Math.floor(rnd() * 2 ** 32);
          b = withU32(b, field, value);
        } else if (kind < 0.75) {
          // Flip one bit somewhere in the header (including the reserved bytes).
          const at = Math.floor(rnd() * HEADER_SIZE);
          b = withBytes(b, at, [(b[at] as number) ^ (1 << Math.floor(rnd() * 8))]);
        } else if (kind < 0.9) {
          // Truncate or extend.
          const delta = Math.floor(rnd() * 9) - 4 || 1;
          const nb = new Uint8Array(Math.max(0, b.length + delta));
          nb.set(b.subarray(0, Math.min(b.length, nb.length)));
          b = nb;
        } else {
          // Restore the base file's hidden size, so the other edits are judged on their own.
          b = withU32(b, 12, baseHidden);
        }
      }
      const spec = specAccepts(b);
      const js = jsAccepts(b);
      const eng = engine.loadNetwork(b);
      if (js !== spec || eng !== spec) disagreements.push(`trial ${trial}: spec ${spec}, parseNetworkFile ${js}, engine ${eng}`);
      if (spec) {
        accepted++;
        if (eng) active = parseNetworkFile(b);
      } else rejected++;
      if (trial % 50 === 0) {
        const r = compareEvals(engine, active, fens.slice(0, 40));
        expect(r.mismatches.slice(0, 3), `trial ${trial}`).toEqual([]);
      }
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
    expect(accepted).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(300);
  });

  it("accepts the smallest and largest hidden sizes (8 and 2048) and evaluates them exactly", async () => {
    const engine = await NnueEngine.create(engineModule);
    for (const [hidden, activation] of [
      [8, 1],
      [2048, 0],
      [2048, 1],
    ] as const) {
      const file = new Uint8Array(quantizeNetwork(trainBrieflyLight(createNetwork(hidden, activation, hidden + activation))));
      expect(file.length).toBe(networkFileSize(hidden));
      expect(jsAccepts(file)).toBe(true);
      expect(engine.loadNetwork(file), `HL ${hidden}`).toBe(true);
      const r = compareEvals(engine, parseNetworkFile(file), fens.slice(0, hidden === 2048 ? 120 : 400));
      expect(r.mismatches.slice(0, 3), `HL ${hidden} ${ACT_NAME[activation]}`).toEqual([]);
    }
  });
});
