import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { datasetsRepo, enginesRepo, networksRepo } from "@/storage/repos";
import { makeDataset, resetStorage } from "@/storage/test-utils";
import { createNetwork } from "@/nnue/init";
import { networkFileSize, parseNetworkFile, quantizeNetwork } from "@/nnue/format";
import { evaluateQuantized } from "@/nnue/reference";
import { createLabService } from "./service";
import { runConfig, testDeps, testEngine } from "./test-helpers";

describe("network service", () => {
  beforeEach(async () => {
    await resetStorage();
  });
  afterEach(async () => {
    await resetStorage();
  });

  it("imports a CBNN file with dequantized float weights and exports the same bytes", async () => {
    const lab = createLabService(testDeps());
    const bytes = quantizeNetwork(createNetwork(32, 1, 5));
    const id = await lab.networks.importFile(new File([bytes], "my-net.nnue"));
    const rec = await networksRepo.get(id);
    expect(rec).toMatchObject({ name: "my-net", hidden: 32, activation: 1, parentId: null, sizeBytes: networkFileSize(32) });
    const data = await networksRepo.getData(id);
    expect(data?.optimizer).toBeNull();
    expect(data?.float?.w1.length).toBe(768 * 32);
    // The float weights quantize back to exactly the imported file.
    expect(new Uint8Array(quantizeNetwork(data!.float!))).toEqual(new Uint8Array(bytes));
    const out = await lab.networks.exportFile(id);
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array(bytes));

    await expect(lab.networks.importFile(new File([new Uint8Array(100)], "junk.nnue"))).rejects.toThrow(/not a network file.*magic/i);
    const truncated = bytes.slice(0, bytes.byteLength - 2);
    await expect(lab.networks.importFile(new File([truncated], "cut.nnue"))).rejects.toThrow(/Size mismatch/);
    expect((await networksRepo.list()).length).toBe(1);
  });

  it("creates random networks, engines, renames and evaluates (White POV)", async () => {
    const lab = createLabService(testDeps());
    await expect(lab.networks.createRandom({ name: "bad", hidden: 12, activation: 1 })).rejects.toThrow(/multiple of 8/);
    const id = await lab.networks.createRandom({ name: "Random 16", hidden: 16, activation: 0, seed: 3 });
    const rec = await networksRepo.get(id);
    expect(rec).toMatchObject({ hidden: 16, activation: 0, sizeBytes: networkFileSize(16) });
    const data = await networksRepo.getData(id);
    expect(new Uint8Array(data!.quantized)).toEqual(new Uint8Array(quantizeNetwork(createNetwork(16, 0, 3))));

    const engineId = await lab.networks.createEngine(id);
    const engine = await enginesRepo.get(engineId);
    expect(engine).toMatchObject({ kind: "nnue", name: "Random 16", networkId: id, entry: "main.ts", templateVersion: 1, options: { hashMb: 16 } });
    expect(engine?.files).toEqual({ "eval.ts": "// nnue eval" });
    expect(engine?.color).toMatch(/^#[0-9a-f]{6}$/);

    await lab.networks.rename(id, "  Renamed  ", "notes");
    expect(await networksRepo.get(id)).toMatchObject({ name: "Renamed", description: "notes" });
    await expect(lab.networks.rename(id, " ")).rejects.toThrow(/name/);

    const q = parseNetworkFile(data!.quantized);
    const white = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";
    const black = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const evals = await lab.networks.evaluate(id, [white, black, "nonsense", "startpos"]);
    expect(evals[0]).toBe(evaluateQuantized(q, white));
    expect(evals[1]).toBe(-evaluateQuantized(q, black) || 0);
    expect(evals[2]).toBeNull();
    expect(typeof evals[3]).toBe("number");
    await expect(lab.networks.evaluate("missing", [white])).rejects.toThrow(/no longer exists/);

    await lab.networks.remove(id);
    expect(await networksRepo.get(id)).toBeUndefined();
    expect(await networksRepo.getData(id)).toBeUndefined();
  });

  it("refuses to delete networks and datasets used by an active run", async () => {
    const deps = testDeps();
    const lab = createLabService(deps);
    const net = await lab.networks.createRandom({ name: "Base", hidden: 16, activation: 1, seed: 1 });
    await datasetsRepo.put(makeDataset("ds", { positions: 100, chunks: 1 }));
    const runId = await lab.training.createRun(runConfig({ network: { mode: "continue", networkId: net }, data: { datasetIds: ["ds"], selfPlay: null } }), { start: false });
    // Mark it running in "another tab": status + a held lock.
    await deps.runs.update(runId, { status: "training" });
    const lock = await deps.locks.acquire(runId);
    await expect(lab.networks.remove(net)).rejects.toThrow(/"Test run" is using this network/);
    await expect(lab.datasets.remove("ds")).rejects.toThrow(/"Test run" is using this dataset/);
    lock?.release(); // the other tab is gone: the stale status no longer blocks
    await lab.datasets.remove("ds");
    await lab.networks.remove(net);
  });
});

describe("validateConfig / estimate", () => {
  beforeEach(async () => {
    await resetStorage();
  });

  it("accepts a sound configuration and explains every problem", async () => {
    const lab = createLabService(testDeps());
    await datasetsRepo.put(makeDataset("ds", { positions: 300_000, chunks: 19 }));
    await enginesRepo.put(testEngine("e1"));
    const ok = runConfig({ data: { datasetIds: ["ds"], selfPlay: null } });
    expect(await lab.training.validateConfig(ok)).toEqual([]);

    const problems = await lab.training.validateConfig(
      runConfig({
        name: " ",
        network: { mode: "new", hidden: 20, activation: 1 },
        data: { datasetIds: ["missing"], selfPlay: null },
        hyper: { ...ok.hyper, learningRate: -1, threads: 0 },
        loop: { enabled: false, cycles: 1, selfPlayWithLatest: true, keepCycles: null, gating: { games: 1, limits: { nodes: 100 }, minScore: 2 } },
      }),
    );
    expect(problems.join("\n")).toMatch(/name/);
    expect(problems.join("\n")).toMatch(/hidden size must be a multiple of 8/);
    expect(problems.join("\n")).toMatch(/datasets no longer exists/);
    expect(problems.join("\n")).toMatch(/nothing to train on/);
    expect(problems.join("\n")).toMatch(/learning rate/);
    expect(problems.join("\n")).toMatch(/training thread/);
    expect(problems.join("\n")).toMatch(/needs the reinforcement loop/);
    expect(problems.join("\n")).toMatch(/at least 2 games/);
    expect(problems.join("\n")).toMatch(/between 0 and 1/);

    const net = await lab.networks.createRandom({ name: "N", hidden: 32, activation: 1, seed: 1 });
    const widenSmaller = await lab.training.validateConfig(runConfig({ network: { mode: "widen", networkId: net, newHidden: 32 }, data: { datasetIds: ["ds"], selfPlay: null } }));
    expect(widenSmaller.join(" ")).toMatch(/larger hidden size than the network's current 32/);
    const goneNet = await lab.training.validateConfig(runConfig({ network: { mode: "continue", networkId: "gone" }, data: { datasetIds: ["ds"], selfPlay: null } }));
    expect(goneNet.join(" ")).toMatch(/no longer exists/);

    const sp = { engineId: "$network", limits: { nodes: 1000 }, randomPlies: 8, games: 10, concurrency: 2, maxPlies: 300, skipPlies: 8 };
    const noNet = await lab.training.validateConfig(runConfig({ data: { datasetIds: [], selfPlay: sp } }));
    expect(noNet.join(" ")).toMatch(/needs an existing network/);
    expect(await lab.training.validateConfig(runConfig({ network: { mode: "continue", networkId: net }, data: { datasetIds: [], selfPlay: sp } }))).toEqual([]);
    const badEngine = await lab.training.validateConfig(runConfig({ data: { datasetIds: [], selfPlay: { ...sp, engineId: "nope" } } }));
    expect(badEngine.join(" ")).toMatch(/self-play engine no longer exists/);
    const loopNoSp = await lab.training.validateConfig(
      runConfig({ data: { datasetIds: ["ds"], selfPlay: null }, loop: { enabled: true, cycles: 3, selfPlayWithLatest: true, keepCycles: null, gating: null } }),
    );
    expect(loopNoSp.join(" ")).toMatch(/loop needs self-play/);

    // Malformed ids (a stale form) are reported as missing, not thrown by IndexedDB.
    const malformed = await lab.training.validateConfig(runConfig({ data: { datasetIds: [undefined as unknown as string, ""], selfPlay: null } }));
    expect(malformed.join(" ")).toMatch(/2 of the selected datasets no longer exist/);
    const est = await lab.training.estimate(runConfig({ data: { datasetIds: [undefined as unknown as string], selfPlay: null } }));
    expect(est.positions).toBe(0);
  });

  it("estimates positions, steps and parameters with the guidance warnings", async () => {
    const lab = createLabService(testDeps());
    await datasetsRepo.put(makeDataset("big", { positions: 1_000_000 }));
    await datasetsRepo.put(makeDataset("small", { positions: 10_000 }));
    const big = await lab.training.estimate(
      runConfig({ network: { mode: "new", hidden: 128, activation: 1 }, data: { datasetIds: ["big"], selfPlay: null }, hyper: { ...runConfig().hyper, batchSize: 4096, epochs: 10, validationSplit: 0.05 } }),
    );
    expect(big.positions).toBe(1_000_000);
    expect(big.stepsPerEpoch).toBe(Math.ceil(950_000 / 4096));
    expect(big.totalSteps).toBe(big.stepsPerEpoch * 10);
    expect(big.parameters).toBe(768 * 128 + 128 + 256 + 1);
    expect(big.warnings).toEqual([]);

    const small = await lab.training.estimate(
      runConfig({
        data: { datasetIds: ["small"], selfPlay: { engineId: "e", limits: {}, randomPlies: 8, games: 100, concurrency: 1, maxPlies: 300, skipPlies: 0 } },
        hyper: { ...runConfig().hyper, batchSize: 4096, epochs: 3, validationSplit: 0.1 },
      }),
    );
    expect(small.positions).toBe(10_000 + 100 * 95);
    expect(small.stepsPerEpoch).toBe(Math.ceil((19_500 - 1950) / 4096));
    expect(small.warnings.length).toBe(2);
    expect(small.warnings[0]).toMatch(/optimizer steps per cycle/);
    expect(small.warnings[1]).toMatch(/few hundred thousand positions/);

    // The advice quotes only sensible numbers: none for a tiny dataset, concrete ones otherwise.
    await datasetsRepo.put(makeDataset("tiny", { positions: 1900 }));
    const tiny = await lab.training.estimate(
      runConfig({ data: { datasetIds: ["tiny"], selfPlay: null }, hyper: { ...runConfig().hyper, batchSize: 1024, epochs: 12, validationSplit: 0.05 } }),
    );
    expect(tiny.warnings[0]).toMatch(/Add more positions/);
    expect(tiny.warnings[0]).not.toMatch(/batch size \(about|about [\d,]+ epochs/);
    await datasetsRepo.put(makeDataset("medium", { positions: 100_000 }));
    const medium = await lab.training.estimate(
      runConfig({ data: { datasetIds: ["medium"], selfPlay: null }, hyper: { ...runConfig().hyper, batchSize: 4096, epochs: 10, validationSplit: 0.05 } }),
    );
    expect(medium.warnings[0]).toMatch(/Use a smaller batch size \(about 950\) or about 42 epochs\./);

    const empty = await lab.training.estimate(runConfig());
    expect(empty).toMatchObject({ positions: 0, stepsPerEpoch: 0, totalSteps: 0 });
    expect(empty.warnings[0]).toMatch(/no positions/);
  });
});
