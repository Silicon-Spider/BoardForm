// First-run starter engines and the starter network. Call ensureSeeded() once at start-up
// (src/main.tsx does).
//
// Two independent parts, each with its own flag, so databases created before the second part
// existed still receive it:
// * "seeded.v1": the starter engines Blocky, Classic and Sprout;
// * "seeded.network.v1": the starter NNUE network (public/networks/starter-hl128.nnue, trained on
//   5M self-play positions) and the engine "Neuron" that plays it. Both have fixed ids, so seeding
//   again (restore, another tab) never makes a second copy. If the file cannot be fetched, the flag
//   stays unset and the next start tries again.
//
// Idempotent, also with several tabs opening at once:
// * a Web Lock ("boardform:seed", when navigator.locks exists) lets only one tab seed at a time;
// * the starter engines and the "seeded.v1" flag are written in ONE transaction that re-checks the
//   flag first, so even without Web Locks two tabs can never both seed (IndexedDB serialises
//   overlapping read-write transactions).
// Once seeded, deleting the starter engines does not bring them back (until clearAllData()).

import type { EngineRecord, NetworkDataRecord, NetworkRecord } from "@/types";
import { withTransaction } from "./db";
import { emitChanges, type ChangeEvent } from "./events";
import { newId } from "./id";
import { requestPersistentStorage } from "./persist";
import { settingsRepo } from "./repos";

/** Settings key set (to true) once the starter engines were created. */
export const SEED_FLAG_KEY = "seeded.v1";
/** Settings key set (to true) once the starter network and its engine were created. */
export const NETWORK_SEED_FLAG_KEY = "seeded.network.v1";
/** Fixed ids of the starter network and of the NNUE engine that uses it. */
export const STARTER_NETWORK_ID = "starter-network-hl128";
export const STARTER_NNUE_ENGINE_ID = "starter-engine-neuron";
/** Where the starter network file is served from, relative to the app's base URL. */
export const STARTER_NETWORK_PATH = "networks/starter-hl128.nnue";
const SEED_LOCK_NAME = "boardform:seed";

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

async function flagSet(key: string): Promise<boolean> {
  return Boolean(await settingsRepo.get<unknown>(key, false));
}

async function seed(): Promise<void> {
  // Normal start-up: two cheap reads, no lock, no blocks / template modules loaded.
  if ((await flagSet(SEED_FLAG_KEY)) && (await flagSet(NETWORK_SEED_FLAG_KEY))) return;
  const created = await withSeedLock(async () => {
    // Re-check: another tab may have finished while we waited for the lock.
    // One timestamp for both parts, so the library lists the four starters in a fixed order.
    const now = Date.now();
    const engines = (await flagSet(SEED_FLAG_KEY)) ? null : await buildStarterEngines(now);
    const network = (await flagSet(NETWORK_SEED_FLAG_KEY)) ? null : await loadStarterNetwork(now);
    return writeStarter(engines, network);
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

async function buildStarterEngines(now: number): Promise<EngineRecord[]> {
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

interface StarterNetwork {
  network: NetworkRecord;
  data: NetworkDataRecord;
  engine: EngineRecord;
}

/**
 * Fetches and checks the starter network file and builds its records; null when it cannot be
 * loaded (offline, file missing, outside a browser), in which case seeding retries next start.
 */
async function loadStarterNetwork(now: number): Promise<StarterNetwork | null> {
  if (typeof fetch !== "function" || typeof location === "undefined") return null;
  let bytes: ArrayBuffer;
  try {
    const url = new URL(`${import.meta.env.BASE_URL ?? "/"}${STARTER_NETWORK_PATH}`, location.href);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    console.warn("[storage] Could not download the starter network; it will be added on a later start.", err);
    return null;
  }
  const [format, templates] = await Promise.all([import("@/nnue/format"), import("@/engine-host/templates")]);
  let parsed: ReturnType<typeof format.parseNetworkFile>;
  try {
    parsed = format.parseNetworkFile(bytes);
  } catch (err) {
    console.warn("[storage] The starter network file is damaged; it was not added.", err);
    return null;
  }
  const network: NetworkRecord = {
    id: STARTER_NETWORK_ID,
    name: `Starter network (${parsed.hidden} ${format.ACTIVATION_NAMES[parsed.activation]})`,
    description:
      "Trained on 5 million positions from self-play of the stock hand-crafted evaluation (5,000 nodes per move). " +
      "It plays about as strong as Classic. Continue training it in the NNUE Lab, or widen it.",
    createdAt: now,
    updatedAt: now,
    hidden: parsed.hidden,
    activation: parsed.activation,
    parentId: null,
    // Best validation loss, reached after 7 of 25 epochs over 4.85M training positions (3% held out).
    stats: { positionsSeen: 4_850_000 * 7, epochs: 7, trainLoss: null, valLoss: 0.00704 },
    sizeBytes: bytes.byteLength,
    builtin: true,
  };
  // Float weights equal to the file (dequantized), so the network can be trained further.
  const data: NetworkDataRecord = {
    id: STARTER_NETWORK_ID,
    quantized: bytes,
    float: format.dequantizeNetwork(parsed),
    optimizer: null,
  };
  const engine: EngineRecord = {
    id: STARTER_NNUE_ENGINE_ID,
    name: "Neuron",
    kind: "nnue",
    color: "#8b5cf6",
    description: `The stock search with a trained NNUE evaluation: the starter network, ${parsed.hidden} hidden neurons. Train your own network in the NNUE Lab and swap it in.`,
    files: templates.defaultFilesFor("nnue"),
    entry: "main.ts",
    templateVersion: templates.TEMPLATE_VERSION,
    networkId: STARTER_NETWORK_ID,
    options: { hashMb: 16 },
    builtin: true,
    parentId: null,
    build: null,
    tags: ["starter", "nnue"],
    // Listed after the three engines of the first part (the library sorts newest-updated first).
    createdAt: now - 3,
    updatedAt: now - 3,
  };
  return { network, data, engine };
}

/**
 * Writes the starter engines and/or the starter network atomically, each part with its flag. A part
 * is skipped when its flag is already set (another tab won the race); the network and its engine are
 * only added where no record with their fixed id exists. True when the starter engines were written.
 */
async function writeStarter(engines: EngineRecord[] | null, starter: StarterNetwork | null): Promise<boolean> {
  if (!engines && !starter) return false;
  const events: ChangeEvent[] = [];
  const wroteEngines = await withTransaction(
    "create the starter engines",
    ["engines", "networks", "networkData", "settings"],
    "readwrite",
    async (tx) => {
      const settings = tx.objectStore("settings");
      const store = tx.objectStore("engines");
      let wrote = false;
      const flag = await settings.get(SEED_FLAG_KEY);
      if (engines && !(flag !== undefined && Boolean(flag.value))) {
        await Promise.all(engines.map((e) => store.put(e)));
        await settings.put({ key: SEED_FLAG_KEY, value: true });
        events.push(...engines.map((e): ChangeEvent => ({ store: "engines", id: e.id, op: "put" })));
        events.push({ store: "settings", id: SEED_FLAG_KEY, op: "put" });
        wrote = true;
      }
      const netFlag = await settings.get(NETWORK_SEED_FLAG_KEY);
      if (starter && !(netFlag !== undefined && Boolean(netFlag.value))) {
        const networks = tx.objectStore("networks");
        if ((await networks.get(starter.network.id)) === undefined) {
          await tx.objectStore("networkData").put(starter.data);
          await networks.put(starter.network);
          events.push(
            { store: "networkData", id: starter.data.id, op: "put" },
            { store: "networks", id: starter.network.id, op: "put" },
          );
        }
        if ((await store.get(starter.engine.id)) === undefined) {
          await store.put(starter.engine);
          events.push({ store: "engines", id: starter.engine.id, op: "put" });
        }
        await settings.put({ key: NETWORK_SEED_FLAG_KEY, value: true });
        events.push({ store: "settings", id: NETWORK_SEED_FLAG_KEY, op: "put" });
      }
      return wrote;
    },
  );
  if (events.length > 0) emitChanges(events);
  return wroteEngines;
}
