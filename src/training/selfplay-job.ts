// One self-play job: games from the pool go into a DatasetWriter, with live progress. Used by
// datasets.generate() and by the self-play phase of training runs.
import type { SelfPlayConfig } from "@/types";
import { formatDuration } from "@/utils/format";
import { ADJUDICATE_CP, ADJUDICATE_PLIES, RECORD_SCORE_LIMIT, SELFPLAY_MAX_HASH_MB } from "./constants";
import type { DatasetWriter } from "./dataset-writer";
import type { ServiceDeps } from "./deps";
import { RateMeter, emptySelfPlayProgress } from "./live";
import { selfPlaySearchLimits } from "./scores";
import type { SelfPlaySource } from "./selfplay-pool";
import type { GameSettings, SkipCounts } from "./selfplay-protocol";
import type { LiveBoard, SelfPlayProgress } from "./types";

/** Engine for self-play, resolved to module bytes. */
export interface SelfPlayEngineSpec {
  wasm: ArrayBuffer;
  network: ArrayBuffer | null;
  hashMb: number;
  /** Shown on the live boards. */
  name: string;
  /** Engine record used (null for the stock NNUE engine). */
  engineId: string | null;
  networkId: string | null;
}

/** The engine id that means "the stock NNUE engine running a network". */
export const NETWORK_ENGINE_ID = "$network";

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

/** Game settings of a self-play configuration (values clamped to sane ranges). */
export function gameSettingsFor(config: Pick<SelfPlayConfig, "limits" | "randomPlies" | "maxPlies" | "skipPlies">): GameSettings {
  const randomPlies = clampInt(config.randomPlies, 0, 60, 8);
  return {
    limits: selfPlaySearchLimits(config.limits),
    randomPlies,
    maxPlies: clampInt(config.maxPlies, randomPlies + 2, 2000, 400),
    skipPlies: clampInt(config.skipPlies, 0, 2000, 0),
    adjudicateCp: ADJUDICATE_CP,
    adjudicatePlies: ADJUDICATE_PLIES,
    recordScoreLimit: RECORD_SCORE_LIMIT,
  };
}

/** Resolves the self-play engine: a library engine, or "$network" = stock NNUE engine + network. */
export async function resolveSelfPlayEngine(deps: ServiceDeps, engineId: string, networkId: string | null | undefined): Promise<SelfPlayEngineSpec> {
  const defaultHash = await deps.defaultHashMb();
  if (engineId === NETWORK_ENGINE_ID) {
    if (!networkId) throw new Error("Self-play with the stock NNUE engine needs a network.");
    const [record, data] = await Promise.all([deps.networks.get(networkId), deps.networks.getData(networkId)]);
    if (!record || !data || !data.quantized || data.quantized.byteLength === 0) {
      throw new Error("The network chosen for self-play no longer exists.");
    }
    const wasm = await deps.stockNnueWasm();
    return { wasm, network: data.quantized, hashMb: Math.min(defaultHash, SELFPLAY_MAX_HASH_MB), name: record.name, engineId: null, networkId };
  }
  const art = await deps.engineArtifacts(engineId);
  return {
    wasm: art.wasm,
    network: art.network,
    hashMb: Math.min(art.engine.options?.hashMb || defaultHash, SELFPLAY_MAX_HASH_MB),
    name: art.engine.name,
    engineId: art.engine.id,
    networkId: art.engine.networkId ?? null,
  };
}

export interface SelfPlayJobOptions {
  source: SelfPlaySource;
  writer: DatasetWriter;
  engine: SelfPlayEngineSpec;
  config: SelfPlayConfig;
  /** Games to play now (null = until stopped). */
  games: number | null;
  concurrency: number;
  seed: number;
  firstGameIndex: number;
  /** Shown progress = offset + this job (e.g. games of a cycle played before a pause). */
  offset: { games: number; positions: number; total: number | null };
  signal: AbortSignal;
  onProgress(p: SelfPlayProgress): void;
  onLog?(level: "info" | "warn", message: string): void;
}

export interface SelfPlayJobSummary {
  games: number;
  positions: number;
  stopped: boolean;
  elapsedMs: number;
  skipped: SkipCounts;
}

/** Plays the games and writes their positions. Does not close the writer. */
export async function runSelfPlayJob(o: SelfPlayJobOptions): Promise<SelfPlayJobSummary> {
  const t0 = Date.now();
  const settings = gameSettingsFor(o.config);
  const progress = emptySelfPlayProgress(o.offset.total);
  progress.gamesDone = o.offset.games;
  progress.positions = o.offset.positions;
  const meter = new RateMeter();
  meter.reset(t0, 0);
  const skipped: SkipCounts = { check: 0, capture: 0, promotion: 0, score: 0, noScore: 0, early: 0 };
  let games = 0;
  let positions = 0;
  let plies = 0;
  let boards: LiveBoard[] = [];

  const publish = () => {
    const t = Date.now();
    o.onProgress({
      ...progress,
      gamesDone: o.offset.games + games,
      positions: o.offset.positions + positions,
      posPerSec: meter.rate(t, positions),
      boards,
      results: { ...progress.results },
      avgPlies: games > 0 ? plies / games : 0,
    });
  };

  const summary = await o.source.selfPlay(
    {
      wasm: o.engine.wasm,
      network: o.engine.network,
      hashMb: o.engine.hashMb,
      engineName: o.engine.name,
      settings,
      games: o.games,
      concurrency: Math.max(1, o.concurrency),
      seed: o.seed,
      firstGameIndex: o.firstGameIndex,
    },
    {
      onReady: (workers) => {
        progress.workers = workers;
        publish();
      },
      onBoards: (b) => {
        boards = b;
        publish();
      },
      onLog: o.onLog,
      onGame: async (g) => {
        await o.writer.add(new Uint8Array(g.data), g.positions, 1);
        games++;
        positions += g.positions;
        plies += g.plies;
        if (g.result === 2) progress.results.white++;
        else if (g.result === 0) progress.results.black++;
        else progress.results.draw++;
        for (const k of Object.keys(skipped) as Array<keyof SkipCounts>) skipped[k] += g.skipped[k];
        meter.add(Date.now(), positions);
        publish();
      },
    },
    o.signal,
  );
  progress.workers = 0;
  boards = [];
  publish();

  const elapsedMs = Date.now() - t0;
  if (summary.games > 0) {
    const searched = positions + skipped.check + skipped.capture + skipped.promotion + skipped.score + skipped.noScore + skipped.early;
    o.onLog?.(
      "info",
      `Self-play: ${summary.games.toLocaleString("en-US")} games, ${positions.toLocaleString("en-US")} positions in ${formatDuration(elapsedMs)} ` +
        `(${((positions * 1000) / Math.max(1, elapsedMs)).toFixed(1)} positions/s; ${searched > 0 ? Math.round((positions / searched) * 100) : 0}% of searched positions kept).`,
    );
    if (skipped.noScore > 0 && positions === 0) {
      o.onLog?.("warn", "The engine reported no search scores (cb_info), so no positions could be labelled. Use an engine that reports its score.");
    }
  }
  return { games: summary.games, positions, stopped: summary.stopped, elapsedMs, skipped };
}
