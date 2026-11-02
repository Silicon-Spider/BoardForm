// The arena service (docs/ARCHITECTURE.md §5 "@/arena"): a module-level singleton that runs
// matches in this tab, so they keep going while the user navigates.
//
// Cross-tab rules:
// * A Web Lock "chess-builder:match:<id>" is held while a tab runs a match, so two tabs never run
//   the same match. start() in another tab reports "running in another tab".
// * A match whose tab was closed or reloaded stays "running" in the database. initArenaService()
//   marks such matches "paused" (interrupted) once storage is ready — but only when no other tab
//   holds the lock. For matches running in another tab it waits for the lock (a tab that crashes
//   releases it), so a crashed tab's match is marked interrupted while this tab stays open.
// * pause / abort for a match running in another tab are forwarded over a BroadcastChannel.
import { toast } from "@/app/toast";
import { ALL_RECORDS, subscribe, type ChangeEvent } from "@/storage/events";
import { newId } from "@/storage/id";
import { gamesRepo, matchesRepo } from "@/storage/repos";
import { whenSeeded } from "@/storage/seed";
import type { MatchConfig, MatchRecord } from "@/types";
import { clearActivity } from "@/app/activity";
import { normalizeMatchConfig, validateMatchConfig } from "./config";
import { runEngineGame } from "./game";
import { matchExtras, removeLiveMatch } from "./live";
import { MatchRunner, type RunnerDeps } from "./runner";
import { countGames } from "./schedule";
import { computeStandings, formatPoints, scoreLine } from "./standings";
import type { ArenaMatchExtras, ArenaMatchRecord, ArenaService, PlayEngineGameOptions, PlayedGame } from "./types";

const LOCK_PREFIX = "chess-builder:match:";
const CHANNEL_NAME = "chess-builder-arena";
/** A just-released lock can be briefly held by another tab's watcher; start() retries this often. */
const LOCK_RETRIES = 4;
const LOCK_RETRY_MS = 120;

const runners = new Map<string, MatchRunner>();
const starting = new Map<string, Promise<void>>();
/** Matches running in another tab whose lock we wait for (to detect a crashed tab). */
const watched = new Set<string>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

// --- engines for the runner ---------------------------------------------------------------------

// The engine host (compiler client, template sources, workers) is loaded on first use, so the
// start-up bundle that calls initArenaService() stays small.
const engineHost = () => import("@/engine-host");

const engineDeps: RunnerDeps = {
  async prepare(engineId, onStatus) {
    const { getEngineArtifacts } = await engineHost();
    await getEngineArtifacts(engineId, { onStatus });
  },
  async load(engineId, opts) {
    const { loadEngine } = await engineHost();
    return loadEngine(engineId, { hashMb: opts.hashMb, label: opts.label, onLog: opts.onLog });
  },
};

// --- cross-tab commands -------------------------------------------------------------------------

interface ArenaCommand {
  type: "arena:command";
  action: "pause" | "abort";
  matchId: string;
}

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as Partial<ArenaCommand> | null;
      if (!msg || msg.type !== "arena:command" || typeof msg.matchId !== "string") return;
      const runner = runners.get(msg.matchId);
      if (runner && (msg.action === "pause" || msg.action === "abort")) void runner.stop(msg.action === "pause" ? "paused" : "aborted");
    };
  } catch {
    channel = null;
  }
  return channel;
}

function sendCommand(action: ArenaCommand["action"], matchId: string): void {
  getChannel()?.postMessage({ type: "arena:command", action, matchId } satisfies ArenaCommand);
}

// --- recovery of interrupted matches ------------------------------------------------------------

/**
 * Runs `fn` while holding the match's lock, if nobody else holds it. Resolves with false (without
 * running fn) when the match is running in another tab.
 */
async function withFreeLock(matchId: string, fn: () => Promise<void>): Promise<boolean> {
  const locks = lockManager();
  if (!locks) {
    await fn();
    return true;
  }
  return locks.request(LOCK_PREFIX + matchId, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

/** A "running" record that no tab runs → "paused" (interrupted), with its running time kept. */
async function markInterrupted(matchId: string): Promise<void> {
  if (runners.has(matchId) || starting.has(matchId)) return;
  const record = await matchesRepo.get(matchId);
  if (!record || record.status !== "running") return;
  const x = matchExtras(record);
  const ran = typeof x.runningSince === "number" ? Math.max(0, record.updatedAt - x.runningSince) : 0;
  const patch: ArenaMatchExtras & Partial<MatchRecord> = {
    status: "paused",
    interrupted: true,
    runningSince: null,
    elapsedMs: (x.elapsedMs ?? 0) + ran,
  };
  await matchesRepo.update(matchId, patch as Partial<MatchRecord>);
}

/** Waits for another tab's lock on a running match; when it is released, checks for an orphan. */
function watchRemote(matchId: string): void {
  const locks = lockManager();
  if (!locks || watched.has(matchId) || runners.has(matchId) || starting.has(matchId)) return;
  watched.add(matchId);
  locks
    .request(LOCK_PREFIX + matchId, async () => {
      watched.delete(matchId);
      await markInterrupted(matchId);
    })
    .catch((err: unknown) => {
      watched.delete(matchId);
      console.warn("[arena] could not watch a match running in another tab", err);
    });
}

async function recover(matchId: string): Promise<void> {
  if (runners.has(matchId) || starting.has(matchId)) return;
  const free = await withFreeLock(matchId, () => markInterrupted(matchId));
  if (!free) watchRemote(matchId);
}

async function onMatchesChanged(e: ChangeEvent): Promise<void> {
  if (e.op !== "put") return;
  const records = e.id === ALL_RECORDS ? await matchesRepo.list() : [await matchesRepo.get(e.id)];
  for (const r of records) {
    if (r && r.status === "running" && !runners.has(r.id) && !starting.has(r.id)) watchRemote(r.id);
  }
}

let initialized = false;

/** Called once from src/main.tsx (idempotent). */
export function initArenaService(): void {
  if (initialized) return;
  initialized = true;
  getChannel();
  void (async () => {
    await whenSeeded();
    const all = await matchesRepo.list();
    for (const m of all) if (m.status === "running") await recover(m.id);
    subscribe("matches", (e) => {
      onMatchesChanged(e).catch((err: unknown) => console.warn("[arena] match change handling failed", err));
    });
  })().catch((err: unknown) => console.error("[arena] start-up check failed", err));
}

// --- notifications ------------------------------------------------------------------------------

function notifyFinished(record: MatchRecord, labels: string[]): void {
  const cfg = record.config;
  if (cfg.participants.length === 2) {
    const rows = computeStandings(cfg, record.results);
    const a = rows.find((r) => r.participant === 0)!;
    const b = rows.find((r) => r.participant === 1)!;
    toast(`${cfg.name} finished: ${formatPoints(a.points)} - ${formatPoints(b.points)}`, {
      kind: "success",
      detail: `${labels[0]} ${formatPoints(a.points)} – ${formatPoints(b.points)} ${labels[1]}`,
      timeoutMs: 8000,
    });
  } else {
    toast(`${cfg.name} finished`, { kind: "success", detail: scoreLine(cfg, record.results, labels, { final: true }) ?? undefined, timeoutMs: 8000 });
  }
}

function notifyError(record: MatchRecord | null, message: string): void {
  toast(`${record?.config.name ?? "The match"} was paused`, { kind: "error", detail: message });
}

// --- the service ---------------------------------------------------------------------------------

async function startMatch(matchId: string): Promise<void> {
  if (runners.has(matchId)) return;
  const record = await matchesRepo.get(matchId);
  if (!record) throw new Error("This match no longer exists.");
  if (record.status === "finished") throw new Error("This match is already finished. Use Rematch to play it again.");

  const runner = new MatchRunner(matchId, engineDeps, { onFinished: notifyFinished, onError: notifyError });
  const launch = async (): Promise<void> => {
    runners.set(matchId, runner);
    try {
      await runner.run();
    } finally {
      if (runners.get(matchId) === runner) runners.delete(matchId);
    }
  };

  const locks = lockManager();
  if (!locks) {
    void launch();
    return runner.started;
  }
  for (let attempt = 0; ; attempt++) {
    let held = false;
    const granted = new Promise<boolean>((resolve, reject) => {
      locks
        .request(LOCK_PREFIX + matchId, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          held = true;
          resolve(true);
          await launch(); // the lock is held until the runner is done
        })
        .catch((err: unknown) => {
          if (!held) reject(err instanceof Error ? err : new Error(String(err)));
          else console.error("[arena] match runner failed", err);
        });
    });
    if (await granted) return runner.started;
    if (attempt >= LOCK_RETRIES) throw new Error("This match is running in another tab.");
    await sleep(LOCK_RETRY_MS);
  }
}

export const arena: ArenaService = {
  async createMatch(config: MatchConfig, opts: { start?: boolean } = {}): Promise<string> {
    const normalized = normalizeMatchConfig(config);
    const problems = validateMatchConfig(normalized);
    if (problems.length > 0) throw new Error(problems.join(" "));
    const now = Date.now();
    const record: ArenaMatchRecord = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      config: normalized,
      totalGames: countGames(normalized),
      results: [],
      elapsedMs: 0,
      lastError: null,
      interrupted: false,
      runningSince: null,
    };
    await matchesRepo.put(record);
    if (opts.start) await arena.start(record.id);
    return record.id;
  },

  start(matchId: string): Promise<void> {
    const pending = starting.get(matchId);
    if (pending) return pending;
    const p = startMatch(matchId).finally(() => {
      if (starting.get(matchId) === p) starting.delete(matchId);
    });
    starting.set(matchId, p);
    return p;
  },

  async pause(matchId: string): Promise<void> {
    await starting.get(matchId)?.catch(() => undefined);
    const runner = runners.get(matchId);
    if (runner) return runner.stop("paused");
    const record = await matchesRepo.get(matchId);
    if (!record || record.status !== "running") return;
    const fixed = await withFreeLock(matchId, () => markInterrupted(matchId));
    if (!fixed) sendCommand("pause", matchId);
  },

  async abort(matchId: string): Promise<void> {
    await starting.get(matchId)?.catch(() => undefined);
    const runner = runners.get(matchId);
    if (runner) return runner.stop("aborted");
    const record = await matchesRepo.get(matchId);
    if (!record || record.status === "finished" || record.status === "aborted") return;
    const done = await withFreeLock(matchId, async () => {
      const x = matchExtras(record);
      const ran = record.status === "running" && typeof x.runningSince === "number" ? Math.max(0, record.updatedAt - x.runningSince) : 0;
      const patch: ArenaMatchExtras & Partial<MatchRecord> = { status: "aborted", runningSince: null, elapsedMs: (x.elapsedMs ?? 0) + ran };
      await matchesRepo.update(matchId, patch as Partial<MatchRecord>);
    });
    if (!done) sendCommand("abort", matchId);
  },

  async deleteMatch(matchId: string, opts: { deleteGames?: boolean } = {}): Promise<void> {
    await starting.get(matchId)?.catch(() => undefined);
    const runner = runners.get(matchId);
    // A runner in another tab stops by itself when it sees the record disappear.
    if (runner) await runner.stop("deleted");
    await matchesRepo.remove(matchId);
    if (opts.deleteGames) await gamesRepo.removeByMatch(matchId);
    removeLiveMatch(matchId);
    clearActivity(`arena:${matchId}`);
  },

  isRunning(matchId: string): boolean {
    return runners.has(matchId);
  },
};

/** Ids of the matches running in this tab. */
export function runningMatchIds(): string[] {
  return [...runners.keys()];
}

/**
 * One engine-vs-engine game (reusable outside matches). Uses `opts.engines` when given; otherwise
 * starts both engines with loadEngine() and terminates them afterwards.
 */
export async function playEngineGame(opts: PlayEngineGameOptions): Promise<PlayedGame> {
  if (opts.engines) return runEngineGame(opts, opts.engines);
  const { loadEngine } = await engineHost();
  const white = await loadEngine(opts.white.engineId, { hashMb: opts.white.config.hashMb, label: opts.white.name });
  let black;
  try {
    black = await loadEngine(opts.black.engineId, { hashMb: opts.black.config.hashMb, label: opts.black.name });
  } catch (err) {
    white.terminate();
    throw new Error(`Could not start ${opts.black.name}: ${messageOf(err)}`);
  }
  try {
    return await runEngineGame(opts, { white, black });
  } finally {
    white.terminate();
    black.terminate();
  }
}
