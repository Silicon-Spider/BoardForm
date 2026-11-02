// First-run starter engines and the starter network. Call ensureSeeded() once at start-up
// (src/main.tsx does).
//
// Two independent parts, each with its own flag, so databases created before the second part
// existed still receive it:
// * "seeded.v1": the starter engines Blocky, Classic and Sprout;
// * "seeded.network.v1": the starter NNUE network (public/networks/starter-hl128.nnue, trained on
//   5M self-play positions) and the engine "Neuron" that plays it. Both have fixed ids, so seeding
//   again (restore, another tab, a restored backup) never makes a second copy and never overwrites
//   them. If the file cannot be fetched (offline, or no answer within STARTER_NETWORK_TIMEOUT_MS),
//   the flag stays unset and the next start tries again.
//
// The engines part comes first and needs no network. whenSeeded() — which the engines list, the
// arena and the training service wait for — resolves as soon as it is done, so a slow download
// never keeps the library loading. The network part follows; ensureSeeded() resolves once both
// are done. On a first run the four engines are listed Blocky, Classic, Sprout, Neuron (Neuron's
// timestamps come from the same moment as the others', just older).
//
// Idempotent, also with several tabs and with data changing meanwhile:
// * each part runs under its own Web Lock ("boardform:seed", "boardform:seed:network", when
//   navigator.locks exists), so only one tab works on a part at a time;
// * each part and its flag are written in ONE transaction that re-checks the flag first, so even
//   without Web Locks two tabs can never both seed (IndexedDB serialises overlapping read-write
//   transactions);
// * a call while a part is running gets one more pass of that part once it is done: the data may
//   have changed in between (all data deleted, "Restore starter engines" clearing the flags).
// Once seeded, deleting the starter engines does not bring them back (until clearAllData() or
// "Restore starter engines").

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
/** The download of the starter network (about 200 KB) gives up after this long; retried next start. */
export const STARTER_NETWORK_TIMEOUT_MS = 30_000;
const ENGINES_LOCK_NAME = "boardform:seed";
const NETWORK_LOCK_NAME = "boardform:seed:network";

const noop = (): void => undefined;

/**
 * One part of the seeding in this tab: never two passes at once, and a call during a pass gets
 * exactly one more pass after it (calls meanwhile share that pass). A pass resolves with whether
 * it created anything.
 */
class SeedPart {
  private current: Promise<boolean> | null = null;
  private queued: Promise<boolean> | null = null;
  private queuedNow = 0;

  constructor(private readonly pass: (now: number) => Promise<boolean>) {}

  run(now: number): Promise<boolean> {
    if (!this.current) return this.start(now);
    this.queuedNow = now;
    if (!this.queued) {
      this.queued = this.current.then(noop, noop).then(() => {
        this.queued = null;
        return this.start(this.queuedNow);
      });
    }
    return this.queued;
  }

  /** Resolves once no pass is running or queued. Never rejects. */
  idle(): Promise<void> {
    const pending = this.queued ?? this.current;
    if (!pending) return Promise.resolve();
    const again = (): Promise<void> => this.idle();
    return pending.then(again, again);
  }

  private start(now: number): Promise<boolean> {
    const p: Promise<boolean> = this.pass(now).finally(() => {
      if (this.current === p) this.current = null;
    });
    this.current = p;
    return p;
  }
}

const enginesPart = new SeedPart(seedEngines);
const networkPart = new SeedPart(seedNetwork);

/**
 * Create the built-in starter engines and the starter network where they are missing (first run,
 * after all data was deleted, after "Restore starter engines" cleared the flags). Safe to call any
 * number of times. Rejects only when the starter engines could not be created; a starter network
 * that cannot be added is logged and tried again on the next start.
 */
export async function ensureSeeded(): Promise<void> {
  // One timestamp for both parts, so a first run lists the four starters in a fixed order.
  const now = Date.now();
  const created = await enginesPart.run(now);
  // First run only, and not awaited: Firefox may show a permission prompt and resolve only once
  // the user answers it. The result does not matter — the app works either way.
  if (created) void requestPersistentStorage();
  await networkPart.run(now);
}

/**
 * Resolves once the starter engines exist (immediately when no seeding is running), without waiting
 * for the starter network's download. Never rejects. The engines list waits for it, so a first start
 * shows "loading" rather than an empty library while the starter engines are being created.
 */
export function whenSeeded(): Promise<void> {
  return enginesPart.idle();
}

async function flagSet(key: string): Promise<boolean> {
  return Boolean(await settingsRepo.get<unknown>(key, false));
}

/** The starter engines part. True when it created them. */
async function seedEngines(now: number): Promise<boolean> {
  // Normal start-up: one cheap read, no lock, no blocks / template modules loaded.
  if (await flagSet(SEED_FLAG_KEY)) return false;
  return withSeedLock(ENGINES_LOCK_NAME, async () => {
    if (await flagSet(SEED_FLAG_KEY)) return false; // another tab finished while we waited
    return writeStarterEngines(await buildStarterEngines(now));
  });
}

/** The starter network part. True when it added something. Never rejects: it retries next start. */
async function seedNetwork(now: number): Promise<boolean> {
  try {
    if (await flagSet(NETWORK_SEED_FLAG_KEY)) return false;
    return await withSeedLock(NETWORK_LOCK_NAME, async () => {
      if (await flagSet(NETWORK_SEED_FLAG_KEY)) return false;
      const starter = await loadStarterNetwork(now);
      return starter ? writeStarterNetwork(starter) : false;
    });
  } catch (err) {
    console.warn("[storage] Could not add the starter network; it will be added on a later start.", err);
    return false;
  }
}

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

async function withSeedLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (!locks) return fn(); // the transactions in writeStarter* keep seeding atomic anyway
  let started = false;
  try {
    return (await locks.request(name, () => {
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

/** Fetches the starter network file, giving up after STARTER_NETWORK_TIMEOUT_MS. */
async function downloadStarterNetwork(): Promise<ArrayBuffer> {
  const url = new URL(`${import.meta.env.BASE_URL ?? "/"}${STARTER_NETWORK_PATH}`, location.href);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race also ends a fetch that ignores the abort signal.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DOMException(`No answer within ${Math.round(STARTER_NETWORK_TIMEOUT_MS / 1000)} seconds.`, "TimeoutError");
      controller?.abort(err);
      reject(err);
    }, STARTER_NETWORK_TIMEOUT_MS);
  });
  const download = (async () => {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  })();
  download.catch(noop); // after a timeout its rejection (AbortError) is expected and unobserved
  try {
    return await Promise.race([download, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches and checks the starter network file and builds its records; null when it cannot be
 * loaded (offline, file missing, no answer in time, outside a browser), in which case seeding
 * retries next start.
 */
async function loadStarterNetwork(now: number): Promise<StarterNetwork | null> {
  if (typeof fetch !== "function" || typeof location === "undefined") return null;
  let bytes: ArrayBuffer;
  try {
    bytes = await downloadStarterNetwork();
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
 * Writes the starter engines and their flag atomically — unless the flag is set by now (another
 * tab won the race). True when they were written.
 */
async function writeStarterEngines(engines: EngineRecord[]): Promise<boolean> {
  const wrote = await withTransaction("create the starter engines", ["engines", "settings"], "readwrite", async (tx) => {
    const settings = tx.objectStore("settings");
    const flag = await settings.get(SEED_FLAG_KEY);
    if (flag !== undefined && Boolean(flag.value)) return false;
    const store = tx.objectStore("engines");
    await Promise.all(engines.map((e) => store.put(e)));
    await settings.put({ key: SEED_FLAG_KEY, value: true });
    return true;
  });
  if (wrote) {
    emitChanges([
      ...engines.map((e): ChangeEvent => ({ store: "engines", id: e.id, op: "put" })),
      { store: "settings", id: SEED_FLAG_KEY, op: "put" },
    ]);
  }
  return wrote;
}

/**
 * Adds the starter network and Neuron atomically with their flag — unless the flag is set by now.
 * Each record is only added where no record with its fixed id exists, so a renamed or retrained
 * starter (or one from a restored backup) is never overwritten. True when something was added.
 */
async function writeStarterNetwork(starter: StarterNetwork): Promise<boolean> {
  const events: ChangeEvent[] = [];
  await withTransaction("add the starter network", ["engines", "networks", "networkData", "settings"], "readwrite", async (tx) => {
    const settings = tx.objectStore("settings");
    const flag = await settings.get(NETWORK_SEED_FLAG_KEY);
    if (flag !== undefined && Boolean(flag.value)) return;
    const networks = tx.objectStore("networks");
    if ((await networks.get(starter.network.id)) === undefined) {
      await tx.objectStore("networkData").put(starter.data);
      await networks.put(starter.network);
      events.push({ store: "networkData", id: starter.data.id, op: "put" }, { store: "networks", id: starter.network.id, op: "put" });
    }
    const engines = tx.objectStore("engines");
    if ((await engines.get(starter.engine.id)) === undefined) {
      await engines.put(starter.engine);
      events.push({ store: "engines", id: starter.engine.id, op: "put" });
    }
    await settings.put({ key: NETWORK_SEED_FLAG_KEY, value: true });
    events.push({ store: "settings", id: NETWORK_SEED_FLAG_KEY, op: "put" });
  });
  if (events.length > 0) emitChanges(events);
  return events.some((e) => e.store !== "settings");
}
