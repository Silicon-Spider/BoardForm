// DatasetWriter: appends packed positions to a dataset in IndexedDB.
//
// Positions are collected into chunks of POSITIONS_PER_CHUNK. A full chunk is written with
// datasetsRepo.putChunk at once; the chunk being filled is also (re)written every
// DATASET_PARTIAL_FLUSH_MS, so closing the tab loses at most that much work. flush() writes the
// partial chunk and moves on: positions added afterwards start the next chunk index (chunks are
// never rewritten once flushed). The DatasetRecord's positions / games / chunks always describe
// what is stored — never data still in memory — and are updated at most every DATASET_UPDATE_MS
// (plus at every flush).
import type { DatasetChunkRecord, DatasetRecord } from "@/types";
import { PACKED_SIZE, POSITIONS_PER_CHUNK } from "@/nnue/pack";
import { DATASET_PARTIAL_FLUSH_MS, DATASET_UPDATE_MS } from "./constants";

/** The dataset repository functions the writer uses (datasetsRepo in the app). */
export interface DatasetWriterRepo {
  get(id: string): Promise<DatasetRecord | undefined>;
  update(id: string, patch: Partial<DatasetRecord>): Promise<DatasetRecord>;
  putChunk(record: DatasetChunkRecord): Promise<void>;
  chunkCount(datasetId: string): Promise<number>;
  iterateChunks(datasetId: string): AsyncGenerator<DatasetChunkRecord>;
}

export interface DatasetWriterOptions {
  /** Positions per chunk (default POSITIONS_PER_CHUNK; smaller values are for tests). */
  chunkPositions?: number;
  partialFlushMs?: number;
  recordUpdateMs?: number;
}

export class DatasetWriter {
  readonly datasetId: string;
  private readonly repo: DatasetWriterRepo;
  private readonly capacity: number;
  private readonly partialFlushMs: number;
  private readonly recordUpdateMs: number;

  /** Buffer of the chunk being filled. */
  private buf: Uint8Array;
  /** Positions in `buf`. */
  private fill = 0;
  /** Index of the chunk being filled. */
  private chunkIndex: number;
  /** Positions in the chunks before `chunkIndex` (all stored). */
  private chunkBase: number;
  /** Positions of chunk `chunkIndex` already stored (by a partial write). */
  private currentStored = 0;
  /** Games before this writer was opened, games added, games whose positions are all stored. */
  private readonly gamesBefore: number;
  private gamesAdded = 0;
  private gamesStored = 0;
  /** Cumulative position counts at which pending games end (stored once persisted ≥ that). */
  private readonly pendingGameEnds: number[] = [];

  /** Operations run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private lastRecordUpdate = 0;
  private recordTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private constructor(repo: DatasetWriterRepo, record: DatasetRecord, chunks: number, positions: number, opts: DatasetWriterOptions) {
    this.repo = repo;
    this.datasetId = record.id;
    this.capacity = Math.max(1, Math.floor(opts.chunkPositions ?? POSITIONS_PER_CHUNK));
    this.partialFlushMs = opts.partialFlushMs ?? DATASET_PARTIAL_FLUSH_MS;
    this.recordUpdateMs = opts.recordUpdateMs ?? DATASET_UPDATE_MS;
    this.buf = new Uint8Array(this.capacity * PACKED_SIZE);
    this.chunkIndex = chunks;
    this.chunkBase = positions;
    this.gamesBefore = record.games;
    if (this.partialFlushMs > 0 && Number.isFinite(this.partialFlushMs)) {
      this.partialTimer = setInterval(() => {
        this.enqueue(() => this.writePartial());
      }, this.partialFlushMs);
      (this.partialTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Opens a dataset for appending. New positions go to the next chunk index. When the record's
   * counts disagree with the stored chunks (e.g. the tab closed between a chunk write and the
   * record update) they are recounted and corrected first.
   */
  static async open(repo: DatasetWriterRepo, datasetId: string, opts: DatasetWriterOptions = {}): Promise<DatasetWriter> {
    const record = await repo.get(datasetId);
    if (!record) throw new Error("The dataset no longer exists.");
    const chunks = await repo.chunkCount(datasetId);
    let positions = record.positions;
    if (chunks !== record.chunks) {
      positions = 0;
      for await (const c of repo.iterateChunks(datasetId)) positions += Math.min(c.count, Math.floor(c.data.byteLength / PACKED_SIZE));
      await repo.update(datasetId, { positions, chunks });
    }
    return new DatasetWriter(repo, record, chunks, positions, opts);
  }

  /** Positions stored in IndexedDB. */
  get storedPositions(): number {
    return this.chunkBase + this.currentStored;
  }

  /** Positions added (stored or still buffered), including those present before opening. */
  get positions(): number {
    return this.chunkBase + this.fill;
  }

  /** Games added through this writer. */
  get games(): number {
    return this.gamesAdded;
  }

  /** Chunk records stored. */
  get chunks(): number {
    return this.chunkIndex + (this.currentStored > 0 ? 1 : 0);
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      try {
        await op();
      } catch (e) {
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      }
    });
    // The queue itself never rejects (callers get the rejection of their own operation).
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Adds `count` packed positions (32 bytes each) belonging to `games` games (default 1; use 0 for
   * imported or merged positions). Resolves once the positions are buffered (full chunks written).
   */
  add(data: Uint8Array, count = Math.floor(data.byteLength / PACKED_SIZE), games = 1): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The dataset writer is closed."));
    const n = Math.min(count, Math.floor(data.byteLength / PACKED_SIZE));
    // Copy now: the caller may reuse or transfer its buffer.
    const bytes = data.slice(0, n * PACKED_SIZE);
    return this.enqueue(async () => {
      let off = 0;
      while (off < n) {
        const take = Math.min(n - off, this.capacity - this.fill);
        this.buf.set(bytes.subarray(off * PACKED_SIZE, (off + take) * PACKED_SIZE), this.fill * PACKED_SIZE);
        this.fill += take;
        off += take;
        if (this.fill === this.capacity) await this.writeFullChunk();
      }
      for (let g = 0; g < games; g++) this.pendingGameEnds.push(this.chunkBase + this.fill);
      this.gamesAdded += games;
      this.settleGames();
      this.scheduleRecordUpdate();
    });
  }

  /** Writes the partial chunk (if any) and updates the record now; later positions start a new chunk. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      await this.writePartial();
      if (this.fill > 0) {
        this.chunkBase += this.fill;
        this.chunkIndex++;
        this.fill = 0;
        this.currentStored = 0;
      }
      await this.updateRecord();
    });
  }

  /** flush() and stop the timers. Further add() calls reject. */
  async close(): Promise<void> {
    if (this.closed) return this.queue;
    try {
      await this.flush();
    } finally {
      this.closed = true;
      this.stopTimers();
    }
  }

  /** Stops the timers without writing (after a storage failure). */
  dispose(): void {
    this.closed = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.partialTimer) clearInterval(this.partialTimer);
    this.partialTimer = null;
    if (this.recordTimer) clearTimeout(this.recordTimer);
    this.recordTimer = null;
  }

  private chunkRecord(count: number): DatasetChunkRecord {
    return {
      id: `${this.datasetId}:${String(this.chunkIndex).padStart(6, "0")}`,
      datasetId: this.datasetId,
      index: this.chunkIndex,
      count,
      data: this.buf.slice(0, count * PACKED_SIZE).buffer,
    };
  }

  private async writeFullChunk(): Promise<void> {
    await this.repo.putChunk(this.chunkRecord(this.capacity));
    this.chunkBase += this.capacity;
    this.chunkIndex++;
    this.fill = 0;
    this.currentStored = 0;
    this.settleGames();
  }

  /** (Re)writes the chunk being filled when it holds positions that are not stored yet. */
  private async writePartial(): Promise<void> {
    if (this.fill === 0 || this.fill === this.currentStored) return;
    await this.repo.putChunk(this.chunkRecord(this.fill));
    this.currentStored = this.fill;
    this.settleGames();
    this.scheduleRecordUpdate();
  }

  private settleGames(): void {
    const stored = this.storedPositions;
    while (this.pendingGameEnds.length > 0 && (this.pendingGameEnds[0] as number) <= stored) {
      this.pendingGameEnds.shift();
      this.gamesStored++;
    }
  }

  private scheduleRecordUpdate(): void {
    if (this.recordTimer || this.closed) return;
    const wait = Math.max(0, this.lastRecordUpdate + this.recordUpdateMs - Date.now());
    this.recordTimer = setTimeout(() => {
      this.recordTimer = null;
      void this.enqueue(() => this.updateRecord()).catch(() => undefined);
    }, wait);
    (this.recordTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async updateRecord(): Promise<void> {
    this.lastRecordUpdate = Date.now();
    await this.repo.update(this.datasetId, {
      positions: this.storedPositions,
      chunks: this.chunks,
      games: this.gamesBefore + this.gamesStored,
    });
  }
}
