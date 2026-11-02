// Training sets: packed positions from IndexedDB dataset chunks (or in-memory buffers) in one
// contiguous Uint8Array, a deterministic train / validation split and per-epoch shuffles.
//
// Determinism matters: a run resumed from a checkpoint must see exactly the same positions in
// the same order as an uninterrupted run with the same seed. Everything random here is derived
// from the hyper-parameter seed with mulberry32.
import type { DatasetChunkRecord } from "@/types";
import { mulberry32 } from "@/utils/misc";
import { PACKED_SIZE, POSITIONS_PER_CHUNK, validatePacked } from "./pack";
import type { BufferAllocator } from "./trainer";

/** Default memory cap for a training set (256 MB = 8 388 608 positions). */
export const DEFAULT_MAX_DATASET_BYTES = 256 * 1024 * 1024;

/** Positions held in memory for training. */
export interface TrainingSet {
  /** `positions · 32` bytes of PackedPosition records. */
  data: Uint8Array;
  positions: number;
  /** Indices (into `data`) of the training positions, ascending. */
  train: Uint32Array;
  /** Indices of the held-out validation positions, ascending. */
  validation: Uint32Array;
  /** Valid positions offered by the sources (before sampling). */
  sourcePositions: number;
  /** Corrupt records that were skipped. */
  invalidPositions: number;
  /** True when the sources exceeded the cap and a uniform random sample was kept. */
  sampled: boolean;
  /** Human-readable notes for the training log (sampling, skipped records, ...). */
  warnings: string[];
}

/** 32-bit seed mixing (murmur3 finaliser), for deriving independent PRNG streams. */
export function mixSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    let k = Math.imul(p | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SALT_RESERVOIR = 0x5a3f;
const SALT_SPLIT = 0x11c3;
const SALT_EPOCH = 0x7e01;

/**
 * Accumulates packed records with validation, growing its buffer up to `maxPositions`; beyond
 * that it keeps a uniform random sample (reservoir sampling, deterministic for the seed).
 */
export class TrainingSetBuilder {
  private buf: Uint8Array;
  private count = 0;
  private seen = 0;
  private invalid = 0;
  private firstInvalid: string | null = null;
  private readonly rnd: () => number;
  private readonly alloc: BufferAllocator;
  readonly maxPositions: number;

  /** `alloc` chooses the backing store (SharedArrayBuffer for multi-threaded training). */
  constructor(opts: { maxPositions: number; seed: number; expectedPositions?: number; alloc?: BufferAllocator }) {
    this.maxPositions = Math.max(1, Math.floor(opts.maxPositions));
    this.alloc = opts.alloc ?? ((n) => new ArrayBuffer(n));
    const initial = Math.min(this.maxPositions, Math.max(1024, Math.floor(opts.expectedPositions ?? POSITIONS_PER_CHUNK)));
    this.buf = new Uint8Array(this.alloc(initial * PACKED_SIZE));
    this.rnd = mulberry32(mixSeed(opts.seed, SALT_RESERVOIR));
  }

  get positions(): number {
    return this.count;
  }

  /** Adds `count` records (default: all whole records in `bytes`). */
  add(bytes: Uint8Array, count = Math.floor(bytes.length / PACKED_SIZE)): void {
    const n = Math.min(count, Math.floor(bytes.length / PACKED_SIZE));
    const cap = this.maxPositions;
    for (let i = 0; i < n; i++) {
      const src = i * PACKED_SIZE;
      const err = validatePacked(bytes, src);
      if (err !== null) {
        this.invalid++;
        if (this.firstInvalid === null) this.firstInvalid = err;
        continue;
      }
      let slot: number;
      if (this.count < cap) {
        if (this.count * PACKED_SIZE >= this.buf.length) this.grow();
        slot = this.count++;
      } else {
        // Reservoir sampling (Algorithm R): the k-th record replaces a random slot w.p. cap/k.
        const j = Math.floor(this.rnd() * (this.seen + 1));
        slot = j < cap ? j : -1;
      }
      this.seen++;
      if (slot >= 0) this.buf.set(bytes.subarray(src, src + PACKED_SIZE), slot * PACKED_SIZE);
    }
  }

  private grow(): void {
    const next = Math.min(this.maxPositions, Math.max(1024, Math.ceil((this.buf.length / PACKED_SIZE) * 1.5)));
    const bigger = new Uint8Array(this.alloc(next * PACKED_SIZE));
    bigger.set(this.buf);
    this.buf = bigger;
  }

  /** Finalises the set: trims the buffer and splits train / validation. */
  build(validationSplit: number, seed: number): TrainingSet {
    const warnings: string[] = [];
    const used = this.count * PACKED_SIZE;
    // Release unused capacity unless it is small (copying into the same kind of buffer).
    let data = this.buf.subarray(0, used);
    if (this.buf.length - used > Math.max(1 << 20, used >> 3)) {
      data = new Uint8Array(this.alloc(used));
      data.set(this.buf.subarray(0, used));
    }
    const sampled = this.seen > this.count;
    if (sampled) {
      warnings.push(
        `The selected data has ${this.seen.toLocaleString("en-US")} positions, more than fit in memory; ` +
          `training on a uniform random sample of ${this.count.toLocaleString("en-US")} (${((this.count / this.seen) * 100).toFixed(1)}%).`,
      );
    }
    if (this.invalid > 0) {
      warnings.push(`Skipped ${this.invalid.toLocaleString("en-US")} corrupt position record(s) (first problem: ${this.firstInvalid ?? "?"}).`);
    }
    const { train, validation } = splitTrainValidation(this.count, validationSplit, seed);
    return {
      data,
      positions: this.count,
      train,
      validation,
      sourcePositions: this.seen,
      invalidPositions: this.invalid,
      sampled,
      warnings,
    };
  }
}

/**
 * Deterministic train / validation split. Positions are assigned in contiguous blocks (up to
 * 512 consecutive records) because neighbouring records usually come from the same game; a
 * per-position split would put near-duplicates on both sides and make the validation loss look
 * better than it is. With `validationSplit > 0` and at least 2 positions, both sides are non-empty.
 */
export function splitTrainValidation(positions: number, validationSplit: number, seed: number): { train: Uint32Array; validation: Uint32Array } {
  const n = Math.max(0, Math.floor(positions));
  const split = Math.min(0.5, Math.max(0, validationSplit || 0));
  let target = Math.round(n * split);
  if (split > 0 && n >= 2) target = Math.max(1, target);
  target = Math.min(target, Math.max(0, n - 1));
  if (target === 0) {
    const train = new Uint32Array(n);
    for (let i = 0; i < n; i++) train[i] = i;
    return { train, validation: new Uint32Array(0) };
  }
  const block = Math.max(1, Math.min(512, Math.floor(n / 100)));
  const blocks = Math.ceil(n / block);
  const order = new Uint32Array(blocks);
  for (let i = 0; i < blocks; i++) order[i] = i;
  shuffleInPlace(order, mulberry32(mixSeed(seed, SALT_SPLIT)));
  const isVal = new Uint8Array(blocks);
  let valCount = 0;
  for (let k = 0; k < blocks && valCount < target; k++) {
    const b = order[k] as number;
    const len = Math.min(block, n - b * block);
    if (valCount + len > n - 1) continue; // keep at least one training position
    isVal[b] = 1;
    valCount += len;
  }
  const validation = new Uint32Array(valCount);
  const train = new Uint32Array(n - valCount);
  let v = 0;
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (isVal[Math.floor(i / block)] === 1) validation[v++] = i;
    else train[t++] = i;
  }
  return { train, validation };
}

/** Fisher–Yates shuffle with the given PRNG. */
export function shuffleInPlace(arr: Uint32Array, rnd: () => number): Uint32Array {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i] as number;
    arr[i] = arr[j] as number;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * The training order of one epoch: a shuffle of `train` that depends only on (seed, epoch), so
 * any epoch can be reproduced on its own when resuming. Writes into `out` when given.
 */
export function epochPermutation(train: Uint32Array, seed: number, epoch: number, out?: Uint32Array): Uint32Array {
  const p = out && out.length === train.length ? out : new Uint32Array(train.length);
  p.set(train);
  return shuffleInPlace(p, mulberry32(mixSeed(seed, SALT_EPOCH, epoch)));
}

export interface BuildOptions {
  validationSplit: number;
  seed: number;
  /** Cap on positions kept (uniform sample beyond it). */
  maxPositions?: number;
  /** Memory cap in bytes (default 256 MB). */
  maxBytes?: number;
  /** Backing store for the data (default: ArrayBuffer; sharedAllocator for several threads). */
  alloc?: BufferAllocator;
}

function capFor(opts: BuildOptions): number {
  const byBytes = Math.floor((opts.maxBytes ?? DEFAULT_MAX_DATASET_BYTES) / PACKED_SIZE);
  const byCount = opts.maxPositions !== undefined && opts.maxPositions > 0 ? Math.floor(opts.maxPositions) : Infinity;
  return Math.max(1, Math.min(byBytes, byCount));
}

function chunkBytes(chunk: ArrayBufferLike | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
}

/** Builds a training set from in-memory buffers of packed positions. */
export function buildTrainingSet(chunks: readonly (ArrayBufferLike | ArrayBufferView)[], opts: BuildOptions): TrainingSet {
  let expected = 0;
  for (const c of chunks) expected += Math.floor(c.byteLength / PACKED_SIZE);
  const builder = new TrainingSetBuilder({ maxPositions: capFor(opts), seed: opts.seed, expectedPositions: expected, alloc: opts.alloc });
  for (const c of chunks) builder.add(chunkBytes(c));
  const set = builder.build(opts.validationSplit, opts.seed);
  for (const c of chunks) {
    if (c.byteLength % PACKED_SIZE !== 0) {
      set.warnings.push(`A data buffer of ${c.byteLength} bytes is not a multiple of ${PACKED_SIZE}; the trailing bytes were ignored.`);
      break;
    }
  }
  return set;
}

/** Where dataset chunks come from (IndexedDB by default; injectable for tests). */
export interface ChunkSource {
  chunkCount(datasetId: string): Promise<number>;
  iterateChunks(datasetId: string): AsyncIterable<DatasetChunkRecord>;
  /** Total positions of a dataset if cheaply known (used to size the buffer up front). */
  positions?(datasetId: string): Promise<number | null>;
}

/** The IndexedDB-backed source (lazy import keeps storage out of Node tests that don't need it). */
export async function indexedDbChunkSource(): Promise<ChunkSource> {
  const { datasetsRepo } = await import("@/storage/repos");
  return {
    chunkCount: (id) => datasetsRepo.chunkCount(id),
    iterateChunks: (id) => datasetsRepo.iterateChunks(id),
    positions: async (id) => {
      const rec = await datasetsRepo.get(id);
      return rec ? rec.positions : null;
    },
  };
}

export interface LoadProgress {
  /** Index of the dataset being read (0-based) and the number of datasets. */
  dataset: number;
  datasets: number;
  chunksRead: number;
  chunksTotal: number;
  positions: number;
}

/** Thrown by loadTrainingSet when `shouldAbort()` returns true. */
export class LoadAbortedError extends Error {
  constructor() {
    super("Loading the training data was cancelled");
    this.name = "LoadAbortedError";
  }
}

export interface LoadOptions extends BuildOptions {
  datasetIds: readonly string[];
  /** In-memory packed buffers used in addition to the datasets. */
  data?: readonly (ArrayBufferLike | ArrayBufferView)[];
  source?: ChunkSource;
  onProgress?(p: LoadProgress): void;
  /** Polled between chunks; return true to cancel (rejects with LoadAbortedError). */
  shouldAbort?(): boolean;
}

/**
 * Loads datasets (chunk by chunk, in storage order) plus optional in-memory buffers into one
 * training set. Datasets larger than the cap are uniformly sampled with a warning.
 */
export async function loadTrainingSet(opts: LoadOptions): Promise<TrainingSet> {
  const ids = [...new Set(opts.datasetIds)];
  const source = ids.length > 0 ? (opts.source ?? (await indexedDbChunkSource())) : null;
  const counts: number[] = [];
  let expected = 0;
  let chunksTotal = 0;
  const warnings: string[] = [];
  for (const id of ids) {
    const chunks = await (source as ChunkSource).chunkCount(id);
    counts.push(chunks);
    chunksTotal += chunks;
    const known = source?.positions ? await source.positions(id) : null;
    expected += known ?? chunks * POSITIONS_PER_CHUNK;
    if (chunks === 0) warnings.push(`Dataset ${id} has no positions (or does not exist).`);
  }
  for (const c of opts.data ?? []) expected += Math.floor(c.byteLength / PACKED_SIZE);

  const builder = new TrainingSetBuilder({ maxPositions: capFor(opts), seed: opts.seed, expectedPositions: expected, alloc: opts.alloc });
  let chunksRead = 0;
  for (let d = 0; d < ids.length; d++) {
    const id = ids[d] as string;
    for await (const chunk of (source as ChunkSource).iterateChunks(id)) {
      if (opts.shouldAbort?.()) throw new LoadAbortedError();
      const bytes = chunkBytes(chunk.data);
      const whole = Math.floor(bytes.length / PACKED_SIZE);
      if (chunk.count !== whole) {
        warnings.push(`Chunk ${chunk.id} declares ${chunk.count} positions but holds ${whole}; using ${Math.min(chunk.count, whole)}.`);
      }
      builder.add(bytes, Math.min(chunk.count, whole));
      chunksRead++;
      opts.onProgress?.({ dataset: d, datasets: ids.length, chunksRead, chunksTotal, positions: builder.positions });
    }
  }
  for (const c of opts.data ?? []) builder.add(chunkBytes(c));
  if (opts.shouldAbort?.()) throw new LoadAbortedError();
  const set = builder.build(opts.validationSplit, opts.seed);
  set.warnings.unshift(...warnings);
  return set;
}
