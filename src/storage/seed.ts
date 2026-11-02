// First-run starter engines. Call ensureSeeded() once at start-up (src/main.tsx does).
//
// Idempotent, also with several tabs opening at once:
// * a Web Lock ("chess-builder:seed", when navigator.locks exists) lets only one tab seed at a time;
// * the starter engines and the "seeded.v1" flag are written in ONE transaction that re-checks the
//   flag first, so even without Web Locks two tabs can never both seed (IndexedDB serialises
//   overlapping read-write transactions).
// Once seeded, deleting the starter engines does not bring them back (until clearAllData()).

import type { EngineRecord } from "@/types";
import { withTransaction } from "./db";
import { emitChanges, type ChangeEvent } from "./events";
import { newId } from "./id";
import { requestPersistentStorage } from "./persist";
import { settingsRepo } from "./repos";

/** Settings key set (to true) once the starter engines were created. */
export const SEED_FLAG_KEY = "seeded.v1";
const SEED_LOCK_NAME = "chess-builder:seed";

let running: Promise<void> | null = null;

/** Create the built-in starter engines on first run. Safe to call any number of times. */
export function ensureSeeded(): Promise<void> {
  if (!running) {
    running = seed().finally(() => {
      running = null;
    });
  }
  return running;
}

/**
 * Resolves once a seeding started by ensureSeeded() has finished (immediately if none is running).
 * Never rejects. The engines list waits for it, so a first start shows "loading" rather than an
 * empty library while the starter engines are being created.
 */
export function whenSeeded(): Promise<void> {
  if (!running) return Promise.resolve();
  return running.then(
    () => undefined,
    () => undefined,
  );
}

async function isSeeded(): Promise<boolean> {
  return Boolean(await settingsRepo.get<unknown>(SEED_FLAG_KEY, false));
}

async function seed(): Promise<void> {
  // Normal start-up: one cheap read, no lock, no blocks / template modules loaded.
  if (await isSeeded()) return;
  const created = await withSeedLock(async () => {
    if (await isSeeded()) return false; // another tab finished while we waited for the lock
    return writeStarterEngines(await buildStarterEngines());
  });
  // First run only, and not awaited: Firefox may show a permission prompt and resolve only once
  // the user answers it. The result does not matter — the app works either way.
  if (created) void requestPersistentStorage();
}

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

async function withSeedLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (!locks) return fn(); // the transaction in writeStarterEngines keeps seeding atomic anyway
  let started = false;
  try {
    return (await locks.request(SEED_LOCK_NAME, () => {
      started = true;
      return fn();
    })) as T;
  } catch (err) {
    if (started) throw err; // the seeding itself failed
    // Web Locks exist but are unusable here (e.g. SecurityError in a sandboxed frame).
    return fn();
  }
}

async function buildStarterEngines(): Promise<EngineRecord[]> {
  // Dynamic imports: only the very first start-up pays for loading these modules.
  const [blocks, templates] = await Promise.all([import("@/blocks"), import("@/engine-host/templates")]);
  const { DEFAULT_WORKSPACE, GENERATOR_VERSION, generateEvalSource } = blocks;
  const { TEMPLATE_VERSION, defaultFilesFor, scratchFiles } = templates;

  let blocksCode = "";
  try {
    const generated = generateEvalSource(DEFAULT_WORKSPACE);
    blocksCode = generated.code;
    if (generated.errors.length > 0) {
      console.warn(
        '[storage] The starter blocks workspace produced errors; "Blocky" was created anyway and can be fixed in the Workshop:\n' +
          generated.errors.join("\n"),
      );
    }
  } catch (err) {
    console.warn('[storage] Could not generate code for the starter blocks workspace; "Blocky" was created without it.', err);
  }

  const now = Date.now();
  const common = {
    templateVersion: TEMPLATE_VERSION,
    options: { hashMb: 16 },
    builtin: true,
    entry: "main.ts",
    networkId: null,
    parentId: null,
    build: null,
    tags: ["starter"],
  } satisfies Partial<EngineRecord>;

  // Decreasing timestamps so the library (newest-updated first) lists them in this order.
  return [
    {
      ...common,
      id: newId(),
      name: "Blocky",
      kind: "blocks",
      color: "#f59e0b",
      description:
        "A hand-crafted evaluation built from drag-and-drop blocks. Open it in the Workshop and change which pieces, squares and bonuses count.",
      blocks: DEFAULT_WORKSPACE,
      files: { "eval.ts": blocksCode },
      generatorVersion: GENERATOR_VERSION,
      createdAt: now,
      updatedAt: now,
    },
    {
      ...common,
      id: newId(),
      name: "Classic",
      kind: "eval",
      color: "#5b9cf5",
      description:
        "The stock search with a classic tapered evaluation written in code. Edit eval.ts to make it play your way.",
      files: defaultFilesFor("eval"),
      createdAt: now - 1,
      updatedAt: now - 1,
    },
    {
      ...common,
      id: newId(),
      name: "Sprout",
      kind: "scratch",
      color: "#4cc38a",
      description: "A small single-file engine to learn from — every line is yours to read, change or rewrite.",
      files: scratchFiles("minimal"),
      createdAt: now - 2,
      updatedAt: now - 2,
    },
  ];
}

/** Writes the engines and the flag atomically; false (nothing written) if already seeded. */
async function writeStarterEngines(engines: EngineRecord[]): Promise<boolean> {
  const written = await withTransaction("create the starter engines", ["engines", "settings"], "readwrite", async (tx) => {
    const settings = tx.objectStore("settings");
    const flag = await settings.get(SEED_FLAG_KEY);
    if (flag !== undefined && Boolean(flag.value)) return false;
    const store = tx.objectStore("engines");
    await Promise.all(engines.map((e) => store.put(e)));
    await settings.put({ key: SEED_FLAG_KEY, value: true });
    return true;
  });
  if (written) {
    const events: ChangeEvent[] = engines.map((e) => ({ store: "engines", id: e.id, op: "put" }));
    events.push({ store: "settings", id: SEED_FLAG_KEY, op: "put" });
    emitChanges(events);
  }
  return written;
}
