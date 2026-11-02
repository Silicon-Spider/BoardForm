// Test helpers for the storage tests (not used by the app). Import "fake-indexeddb/auto" first.
import { IDBFactory } from "fake-indexeddb";
import type {
  DatasetChunkRecord,
  DatasetRecord,
  EngineRecord,
  FloatNetworkData,
  GameRecord,
  MatchRecord,
  NetworkDataRecord,
  NetworkRecord,
  TrainingRunRecord,
} from "@/types";
import { resetLiveQueries } from "./cache";
import { closeDatabase } from "./db";
import { chunkId } from "./repos";

/** Fresh, empty in-memory IndexedDB + no open connection + no caches. */
export async function resetStorage(): Promise<void> {
  resetLiveQueries();
  await closeDatabase();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

export function makeEngine(id: string, overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    id,
    name: `Engine ${id}`,
    description: "test engine",
    kind: "eval",
    createdAt: 1_000,
    updatedAt: 1_000,
    color: "#123456",
    options: { hashMb: 16 },
    files: { "eval.ts": `// eval of ${id}` },
    templateVersion: 1,
    networkId: null,
    ...overrides,
  };
}

export function makeFloatNet(hidden: number, seed = 1): FloatNetworkData {
  const fill = (n: number, k: number) => Float32Array.from({ length: n }, (_, i) => ((i * 31 + k * 17 + seed) % 97) / 97 - 0.5);
  return { hidden, activation: 1, w1: fill(768 * hidden, 1), b1: fill(hidden, 2), w2: fill(2 * hidden, 3), b2: fill(1, 4) };
}

export function makeNetwork(id: string, overrides: Partial<NetworkRecord> = {}): NetworkRecord {
  return {
    id,
    name: `Net ${id}`,
    description: "",
    createdAt: 2_000,
    updatedAt: 2_000,
    hidden: 4,
    activation: 1,
    parentId: null,
    stats: { positionsSeen: 1000, epochs: 2, trainLoss: 0.1, valLoss: null },
    sizeBytes: 64,
    ...overrides,
  };
}

export function makeNetworkData(id: string, hidden = 4): NetworkDataRecord {
  const quantized = new Uint8Array(64).map((_, i) => (i * 7) & 0xff).buffer;
  return { id, quantized, float: makeFloatNet(hidden), optimizer: { step: 3, m: makeFloatNet(hidden, 2), v: makeFloatNet(hidden, 3) } };
}

export function makeDataset(id: string, overrides: Partial<DatasetRecord> = {}): DatasetRecord {
  return {
    id,
    name: `Data ${id}`,
    description: "",
    createdAt: 3_000,
    updatedAt: 3_000,
    positions: 0,
    games: 0,
    chunks: 0,
    source: { kind: "selfplay" },
    ...overrides,
  };
}

export function makeChunk(datasetId: string, index: number, count = 2): DatasetChunkRecord {
  return { id: chunkId(datasetId, index), datasetId, index, count, data: new Uint8Array(count * 32).fill(index % 251).buffer };
}

export function makeGame(id: string, createdAt: number, matchId: string | null = null): GameRecord {
  return {
    id,
    createdAt,
    white: { type: "human", name: "Me" },
    black: { type: "engine", engineId: "e1", name: "Engine e1" },
    startFen: "startpos",
    moves: ["e2e4"],
    san: ["e4"],
    result: "*",
    termination: "unterminated",
    pgn: "1. e4 *",
    matchId,
  };
}

export function makeMatch(id: string, updatedAt = 4_000): MatchRecord {
  return {
    id,
    createdAt: 4_000,
    updatedAt,
    status: "pending",
    totalGames: 2,
    results: [],
    config: {
      name: `Match ${id}`,
      participants: [],
      format: "round-robin",
      gamesPerPairing: 2,
      openings: { mode: "none" },
      concurrency: 1,
      adjudication: { resignScoreCp: null, resignMoves: 3, drawScoreCp: null, drawMoves: 8, drawMinPly: 40, maxPlies: null },
      saveGames: true,
    },
  };
}

export function makeRun(id: string, updatedAt = 5_000): TrainingRunRecord {
  return {
    id,
    createdAt: 5_000,
    updatedAt,
    status: "queued",
    autoResume: false,
    cycle: 0,
    progress: { phase: "queued", done: 0, total: 0 },
    networkId: null,
    engineId: null,
    networkHistory: [],
    datasetIds: [],
    points: [],
    log: [],
    config: {
      name: `Run ${id}`,
      network: { mode: "new", hidden: 32, activation: 1 },
      data: { datasetIds: [], selfPlay: null },
      hyper: {
        epochs: 1,
        batchSize: 1024,
        learningRate: 0.001,
        lrSchedule: "constant",
        evalWeight: 0.75,
        weightDecay: 0,
        validationSplit: 0.1,
        threads: 1,
        seed: 1,
      },
      loop: { enabled: false, cycles: 1, selfPlayWithLatest: true, keepCycles: null, gating: null },
      publishEngine: false,
    },
  };
}
