// NetworkService: import / export CBNN files, random networks, engines for networks, evaluation.
import type { Activation, EngineRecord, NetworkDataRecord, NetworkRecord } from "@/types";
import { ACTIVATION_NAMES, MAX_HIDDEN, MIN_HIDDEN, dequantizeNetwork, isValidHidden, parseNetworkFile, quantizeNetwork, type QuantizedNetwork } from "@/nnue/format";
import { createNetwork } from "@/nnue/init";
import { extractFeatures } from "@/nnue/features";
import { evaluateQuantizedFeatures } from "@/nnue/reference";
import { fnv1a } from "@/utils/misc";
import type { ServiceDeps } from "./deps";
import type { NetworkService } from "./types";

/** Accent colours for engines created from networks (picked by id). */
const ENGINE_COLORS = ["#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#22c55e", "#3b82f6", "#eab308", "#ef4444", "#06b6d4", "#a855f7"];

export function engineColorFor(id: string): string {
  return ENGINE_COLORS[parseInt(fnv1a(id), 16) % ENGINE_COLORS.length] as string;
}

/** "my-net.nnue" → "my-net". */
export function baseName(file: Blob, fallback: string): string {
  const name = (file as Partial<File>).name;
  if (typeof name !== "string" || name.trim() === "") return fallback;
  return name.replace(/\.[^.]+$/, "").trim() || fallback;
}

export interface NetworkServiceHooks {
  /** Name of an active training run that uses the network, or null. */
  usedByActiveRun(networkId: string): Promise<string | null>;
}

const PARSED_CACHE_SIZE = 4;

export function createNetworkService(deps: ServiceDeps, hooks: NetworkServiceHooks): NetworkService {
  // Parsed networks for evaluate(), keyed by id + updatedAt so a replaced network is re-read.
  const parsed = new Map<string, QuantizedNetwork>();

  async function parsedNetwork(id: string): Promise<QuantizedNetwork> {
    const rec = await deps.networks.get(id);
    if (!rec) throw new Error("The network no longer exists.");
    const key = `${id}\u0000${rec.updatedAt}`;
    const hit = parsed.get(key);
    if (hit) {
      parsed.delete(key);
      parsed.set(key, hit);
      return hit;
    }
    const data = await deps.networks.getData(id);
    if (!data || !data.quantized || data.quantized.byteLength === 0) throw new Error(`The weights of the network “${rec.name}” are missing.`);
    const net = parseNetworkFile(data.quantized);
    parsed.set(key, net);
    while (parsed.size > PARSED_CACHE_SIZE) parsed.delete(parsed.keys().next().value as string);
    return net;
  }

  async function save(record: NetworkRecord, data: NetworkDataRecord): Promise<void> {
    // Weights first: the network never appears in the library without them.
    await deps.networks.putData(data);
    await deps.networks.put(record);
  }

  return {
    async importFile(file, opts = {}) {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch (e) {
        throw new Error(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
      }
      let q: QuantizedNetwork;
      try {
        q = parseNetworkFile(bytes);
      } catch (e) {
        throw new Error(`This is not a network file BoardForm can use: ${e instanceof Error ? e.message : String(e)}`);
      }
      const id = deps.newId();
      const now = Date.now();
      const name = (opts.name ?? "").trim() || baseName(file, "Imported network");
      await save(
        {
          id,
          name,
          description: "",
          createdAt: now,
          updatedAt: now,
          hidden: q.hidden,
          activation: q.activation,
          parentId: null,
          stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
          sizeBytes: bytes.byteLength,
        },
        // Float weights equal to the file (dequantized), so the network can be trained further.
        { id, quantized: bytes, float: dequantizeNetwork(q), optimizer: null },
      );
      return id;
    },

    async exportFile(networkId) {
      const data = await deps.networks.getData(networkId);
      if (!data || !data.quantized || data.quantized.byteLength === 0) throw new Error("The network no longer exists.");
      return new Blob([data.quantized], { type: "application/octet-stream" });
    },

    async createRandom(opts) {
      const name = (opts.name ?? "").trim();
      if (!name) throw new Error("Give the network a name.");
      if (!isValidHidden(opts.hidden)) throw new Error(`The hidden size must be a multiple of 8 between ${MIN_HIDDEN} and ${MAX_HIDDEN}.`);
      if (opts.activation !== 0 && opts.activation !== 1) throw new Error("Choose an activation function (CReLU or SCReLU).");
      const seed = Number.isFinite(opts.seed) ? Math.floor(opts.seed as number) : Math.floor(Math.random() * 2 ** 31);
      const float = createNetwork(opts.hidden, opts.activation as Activation, seed);
      const quantized = quantizeNetwork(float);
      const id = deps.newId();
      const now = Date.now();
      await save(
        {
          id,
          name,
          description: `Random initial weights (seed ${seed}). Train it in a run before using it in an engine.`,
          createdAt: now,
          updatedAt: now,
          hidden: opts.hidden,
          activation: opts.activation,
          parentId: null,
          stats: { positionsSeen: 0, epochs: 0, trainLoss: null, valLoss: null },
          sizeBytes: quantized.byteLength,
        },
        { id, quantized, float, optimizer: null },
      );
      return id;
    },

    async createEngine(networkId, opts = {}) {
      const network = await deps.networks.get(networkId);
      if (!network) throw new Error("The network no longer exists.");
      const data = await deps.networks.getData(networkId);
      if (!data || !data.quantized || data.quantized.byteLength === 0) throw new Error(`The weights of the network “${network.name}” are missing.`);
      const { files, templateVersion } = deps.nnueEngineFiles();
      const id = deps.newId();
      const now = Date.now();
      const engine: EngineRecord = {
        id,
        name: (opts.name ?? "").trim() || network.name,
        description: `The stock search with the NNUE evaluation, using the network “${network.name}” (hidden ${network.hidden}, ${ACTIVATION_NAMES[network.activation]}).`,
        kind: "nnue",
        createdAt: now,
        updatedAt: now,
        color: engineColorFor(id),
        files,
        entry: "main.ts",
        templateVersion,
        networkId,
        options: { hashMb: await deps.defaultHashMb() },
        build: null,
        parentId: null,
        tags: ["nnue"],
      };
      await deps.engines.put(engine);
      return id;
    },

    async rename(networkId, name, description) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("The network needs a name.");
      const patch: Partial<NetworkRecord> = { name: trimmed };
      if (description !== undefined) patch.description = description;
      await deps.networks.update(networkId, patch);
    },

    async remove(networkId) {
      const run = await hooks.usedByActiveRun(networkId);
      if (run) throw new Error(`The training run “${run}” is using this network. Pause or stop the run first.`);
      await deps.networks.remove(networkId); // also deletes the weights (networkData)
    },

    async evaluate(networkId, fens) {
      const net = await parsedNetwork(networkId);
      return fens.map((fen) => {
        try {
          const f = extractFeatures(fen);
          if (f.count > 32) return null; // not a chess position (and beyond the i16 accumulator guarantee)
          const cp = evaluateQuantizedFeatures(net, f);
          const white = f.stm === 0 ? cp : -cp;
          return white === 0 ? 0 : white;
        } catch {
          return null;
        }
      });
    },
  };
}
