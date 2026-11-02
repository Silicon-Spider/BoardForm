// EngineClient logic against an in-process fake engine worker (Node has no Web Worker): stop
// reasons on a busy main thread, timer overflow, and the terminate + respawn fallback. The real
// worker + engine combination is exercised in the browser (see the WP-HOST verification notes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCapabilities } from "@/types";
import { EngineClient, judgeStop, startTimer } from "./client";
import type { GoOutcome } from "./instance";
import type { EngineMethod, EngineWorkerCall, EngineWorkerRequest, EngineWorkerResponse } from "./protocol";

const CAPS: EngineCapabilities = { abiVersion: 1, eval: true, trace: false, perft: false, nnue: false, setOption: true, name: "fake", stopFlag: false };
const EMPTY_MODULE = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type GoHandler = (worker: FakeWorker, call: EngineWorkerCall) => void;

/** Stands in for engine.worker.ts: answers init and calls in-process. */
class FakeWorker {
  static all: FakeWorker[] = [];
  /** How the current test's "engine" answers go (default: at once, e2e4). */
  static onGo: GoHandler = (w, call) => w.answer(call, { bestMove: "e2e4", info: null, elapsedMs: 1, stopFlagRaised: false });

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  flag: Int32Array | null = null;
  readonly calls: EngineMethod[] = [];

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(msg: EngineWorkerRequest): void {
    if (this.terminated) return;
    if (msg.type === "init") {
      this.flag = msg.stopBuffer ? new Int32Array(msg.stopBuffer) : null;
      setTimeout(() => this.send({ type: "ready", capabilities: { ...CAPS, stopFlag: this.flag !== null } }), 0);
      return;
    }
    this.calls.push(msg.method);
    if (msg.method === "go") FakeWorker.onGo(this, msg);
    else setTimeout(() => this.answer(msg, msg.method === "position" || msg.method === "setOption" ? true : msg.method === "eval" ? 42 : undefined), 0);
  }

  answer(call: EngineWorkerCall, value: unknown): void {
    this.send({ type: "result", id: call.id, value });
  }

  send(msg: EngineWorkerResponse): void {
    if (!this.terminated) this.onmessage?.({ data: msg } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const defaultGo = FakeWorker.onGo;

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.onGo = defaultGo;
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crossOriginIsolated", true); // so the client shares a stop flag
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("judgeStop", () => {
  const out = (elapsedMs: number, stopFlagRaised: boolean): Pick<GoOutcome, "elapsedMs" | "stopFlagRaised"> => ({ elapsedMs, stopFlagRaised });
  it("separates host interventions from answers that were only processed late", () => {
    expect(judgeStop(null, out(50, false), 210)).toBe("done");
    expect(judgeStop("stopped", out(50, true), 210)).toBe("stopped");
    expect(judgeStop("stopped", out(5000, true), 210)).toBe("stopped");
    expect(judgeStop("timeout", out(205, true), 210)).toBe("timeout"); // still searching when the flag went up
    expect(judgeStop("timeout", out(80, false), 210)).toBe("done"); // answered in time, processed late
    expect(judgeStop("timeout", out(400, false), 210)).toBe("timeout"); // finished on its own, but too late
    expect(judgeStop(null, out(400, false), 210)).toBe("timeout");
    expect(judgeStop(null, out(400, false), null)).toBe("done"); // infinite: no deadline
  });
});

describe("startTimer", () => {
  it("never fires early for non-finite or out-of-range delays", async () => {
    const fn = vi.fn();
    expect(startTimer(Infinity, fn)).toBeUndefined();
    expect(startTimer(Number.NaN, fn)).toBeUndefined();
    const huge = startTimer(3e9, fn); // a plain setTimeout would fire this at once
    const soon = startTimer(5, fn);
    await sleep(40);
    clearTimeout(huge);
    clearTimeout(soon);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("EngineClient (fake worker)", () => {
  it("an answer queued behind a busy main thread past the deadline still counts as on time", async () => {
    const client = await EngineClient.create(EMPTY_MODULE);
    expect(client.capabilities.stopFlag).toBe(true);
    let flagWhenProcessed = -1;
    // movetime 10 → deadline 10 + 100 + 1 ms. The engine finished after 8 ms (flag still down), but
    // its answer is only processed at ~160 ms, after the deadline timer raised the flag.
    FakeWorker.onGo = (w, call) =>
      setTimeout(() => {
        flagWhenProcessed = Atomics.load(w.flag!, 0);
        w.answer(call, { bestMove: "e2e4", info: null, elapsedMs: 8, stopFlagRaised: false });
      }, 160);
    const r = await client.go({ movetimeMs: 10 });
    expect(flagWhenProcessed).toBe(1);
    expect(r).toMatchObject({ bestMove: "e2e4", stopReason: "done", elapsedMs: 8 });

    // The same late processing, but the engine was still searching when the flag went up.
    FakeWorker.onGo = (w, call) => setTimeout(() => w.answer(call, { bestMove: "d2d4", info: null, elapsedMs: 109, stopFlagRaised: Atomics.load(w.flag!, 0) !== 0 }), 160);
    expect(await client.go({ movetimeMs: 10 })).toMatchObject({ bestMove: "d2d4", stopReason: "timeout" });
    expect(FakeWorker.all).toHaveLength(1); // answered within the grace period: no restart
    client.terminate();
  });

  it("maxWaitMs: Infinity disables the safety deadline instead of firing at once", async () => {
    const client = await EngineClient.create(EMPTY_MODULE, { maxWaitMs: Infinity });
    FakeWorker.onGo = (w, call) => setTimeout(() => w.answer(call, { bestMove: "e2e4", info: null, elapsedMs: 50, stopFlagRaised: Atomics.load(w.flag!, 0) !== 0 }), 50);
    await client.newGame(); // call timeouts use the same limit
    expect(await client.position("startpos", [])).toBe(true);
    expect(await client.go({ depth: 30 })).toMatchObject({ stopReason: "done" });
    // A movetime beyond setTimeout's range is not cut short either.
    expect(await client.go({ movetimeMs: 3e9 })).toMatchObject({ stopReason: "done" });
    client.terminate();
  });

  it("an engine that never answers is terminated after the grace period, respawned and replayed", async () => {
    const logs: string[] = [];
    const client = await EngineClient.create(EMPTY_MODULE, { onLog: (s) => logs.push(s), hashMb: 16 });
    expect(await client.setOption("Contempt", "10")).toBe(true);
    expect(await client.position("startpos", ["e2e4"])).toBe(true);
    FakeWorker.onGo = (w, call) => {
      if (w === FakeWorker.all[0]) {
        w.send({ type: "info", id: call.id, info: { depth: 3, seldepth: 5, scoreCp: 20, mate: null, nodes: 999, timeMs: 3, nps: 333000, pv: ["e7e5", "g1f3"] } });
        return; // hangs: never answers
      }
      w.answer(call, { bestMove: "c7c5", info: null, elapsedMs: 1, stopFlagRaised: false });
    };
    const t0 = performance.now();
    const r = await client.go({ movetimeMs: 10 });
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ bestMove: "e7e5", stopReason: "timeout" }); // first move of the last PV
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(logs.some((l) => l.includes("restarting the engine: the search overran its deadline"))).toBe(true);

    expect(await client.go({ depth: 1 })).toMatchObject({ bestMove: "c7c5", stopReason: "done" });
    expect(FakeWorker.all).toHaveLength(2);
    // The new worker got the session back: options, a new game and the last position.
    expect(FakeWorker.all[1].calls).toEqual(["setOption", "newGame", "position", "go"]);
    expect(client.alive && !client.busy).toBe(true);
    client.terminate();
  });
});
