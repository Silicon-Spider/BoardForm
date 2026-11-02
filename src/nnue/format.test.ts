import { describe, expect, it } from "vitest";
import {
  HEADER_SIZE,
  dequantizeNetwork,
  INPUTS,
  NetworkFormatError,
  QA,
  QB,
  SCALE,
  inspectNetworkFile,
  networkFileOffsets,
  networkFileSize,
  parseNetworkFile,
  quantizeNetwork,
  quantizeWeights,
  readNetworkHeader,
  serializeNetwork,
} from "./format";
import { createNetwork, emptyNetwork } from "./init";

describe("CBNN constants", () => {
  it("matches the sizes in docs/NNUE_FORMAT.md", () => {
    expect(networkFileSize(128)).toBe(197444);
    expect(networkFileSize(8)).toBe(68 + 1542 * 8);
    expect(HEADER_SIZE).toBe(64);
    expect([QA, QB, SCALE]).toEqual([255, 64, 400]);
    expect(networkFileOffsets(128)).toEqual({ w1: 64, b1: 64 + 1536 * 128, w2: 64 + 1538 * 128, b2: 64 + 1542 * 128 });
  });
});

describe("quantizeNetwork / parseNetworkFile", () => {
  it("round-trips a network and writes the documented header", () => {
    const net = createNetwork(64, 1, 123);
    const buf = quantizeNetwork(net);
    expect(buf.byteLength).toBe(networkFileSize(64));
    const dv = new DataView(buf);
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe("CBNN");
    // version, inputs, hidden, activation, QA, QB, scale, flags
    expect([4, 8, 12, 16, 20, 24, 28, 32].map((o) => dv.getUint32(o, true))).toEqual([1, 768, 64, 1, 255, 64, 400, 0]);
    expect([...new Uint8Array(buf, 36, 28)].every((b) => b === 0)).toBe(true);

    const q = parseNetworkFile(buf);
    const direct = quantizeWeights(net);
    expect(q.hidden).toBe(64);
    expect(q.activation).toBe(1);
    expect(q.w1).toEqual(direct.w1);
    expect(q.b1).toEqual(direct.b1);
    expect(q.w2).toEqual(direct.w2);
    expect(q.b2).toBe(direct.b2);
    // Re-serialising the parsed network reproduces the file byte for byte.
    expect(new Uint8Array(serializeNetwork(q))).toEqual(new Uint8Array(buf));
    // Parsing accepts views with an offset, and copies (no aliasing of the input).
    const padded = new Uint8Array(buf.byteLength + 3);
    padded.set(new Uint8Array(buf), 3);
    const q2 = parseNetworkFile(padded.subarray(3));
    expect(q2.w1).toEqual(q.w1);
    padded[3 + 64] = (padded[3 + 64] as number) ^ 0xff;
    expect(q2.w1).toEqual(q.w1);
  });

  it("clips to ±1.98 and rounds with Math.round semantics", () => {
    const net = emptyNetwork(8, 0);
    const vals = [2.5, -2.5, 1.98, -1.98, 0.5 / QA, -0.5 / QA, 1.5 / QA, 0.1, -0.1];
    vals.forEach((v, i) => (net.w1[i] = v));
    net.b1[0] = 3;
    net.b1[1] = -0.7;
    net.w2[0] = 5;
    net.w2[1] = -5;
    net.w2[2] = 0.5 / QB;
    net.w2[3] = -1.5 / QB;
    net.b2[0] = 10; // b2 is not clipped
    const q = quantizeWeights(net);
    const f32 = (x: number) => Math.fround(x);
    const expected = vals.map((v) => Math.round(Math.min(1.98, Math.max(-1.98, f32(v))) * QA));
    expect([...q.w1.subarray(0, vals.length)]).toEqual(expected);
    expect(q.w1[0]).toBe(505);
    expect(q.w1[1]).toBe(-505);
    expect(q.b1[0]).toBe(505);
    expect(q.b1[1]).toBe(Math.round(f32(-0.7) * QA));
    expect(q.w2[0]).toBe(127);
    expect(q.w2[1]).toBe(-127);
    expect(q.w2[2]).toBe(Math.round(f32(0.5 / QB) * QB));
    expect(q.w2[3]).toBe(Math.round(f32(-1.5 / QB) * QB));
    expect(q.b2).toBe(Math.round(10 * QA * QB));
  });

  it("dequantizeNetwork → quantizeNetwork reproduces a file byte for byte", () => {
    for (const activation of [0, 1] as const) {
      const file = new Uint8Array(quantizeNetwork(createNetwork(32, activation, 77)));
      const q = parseNetworkFile(file);
      // Push values to the edges of the valid range too.
      q.w1[0] = 505;
      q.w1[1] = -505;
      q.b1[0] = -505;
      q.w2[0] = 127;
      q.w2[1] = -127;
      q.b2 = -8_000_000;
      const edited = new Uint8Array(serializeNetwork(q));
      const back = new Uint8Array(quantizeNetwork(dequantizeNetwork(parseNetworkFile(edited))));
      expect(back).toEqual(edited);
      expect(new Uint8Array(quantizeNetwork(dequantizeNetwork(parseNetworkFile(file))))).toEqual(file);
    }
  });

  it("refuses to quantize NaN weights", () => {
    const net = createNetwork(8, 1, 1);
    net.w2[3] = NaN;
    expect(() => quantizeNetwork(net)).toThrow(/NaN/);
    const net2 = createNetwork(8, 1, 1);
    net2.b2[0] = Infinity;
    expect(() => quantizeNetwork(net2)).toThrow(/not finite/);
  });

  it("rejects malformed float networks", () => {
    const net = createNetwork(16, 1, 1);
    expect(() => quantizeNetwork({ ...net, w1: new Float32Array(10) })).toThrow(NetworkFormatError);
    expect(() => quantizeNetwork({ ...net, hidden: 12 })).toThrow(/multiple of 8/);
  });
});

describe("parseNetworkFile validation", () => {
  const good = () => new Uint8Array(quantizeNetwork(createNetwork(16, 0, 9)));
  const withU32 = (offset: number, value: number) => {
    const b = good();
    new DataView(b.buffer).setUint32(offset, value, true);
    return b;
  };
  const cases: Array<[string, () => Uint8Array, RegExp]> = [
    ["too small for a header", () => good().slice(0, 40), /too small/],
    ["wrong magic", () => {
      const b = good();
      b[0] = 0x4e;
      return b;
    }, /Not a CBNN network file/],
    ["wrong version", () => withU32(4, 2), /version 2/],
    ["wrong input count", () => withU32(8, 769), /input size 769/],
    ["hidden not a multiple of 8", () => withU32(12, 20), /hidden size 20/],
    ["hidden zero", () => withU32(12, 0), /hidden size 0/],
    ["hidden too large", () => withU32(12, 4096), /hidden size 4096/],
    ["unknown activation", () => withU32(16, 2), /activation id 2/],
    ["wrong QA", () => withU32(20, 127), /QA = 127/],
    ["wrong QB", () => withU32(24, 32), /QB = 32/],
    ["wrong scale", () => withU32(28, 600), /scale 600/],
    ["truncated payload", () => good().slice(0, -1), /Size mismatch/],
    ["extra bytes", () => {
      const g = good();
      const b = new Uint8Array(g.length + 2);
      b.set(g);
      return b;
    }, /Size mismatch/],
    ["size of another hidden size", () => withU32(12, 24), /Size mismatch/],
  ];
  for (const [name, make, re] of cases) {
    it(`rejects: ${name}`, () => {
      const bytes = make();
      expect(() => parseNetworkFile(bytes.buffer)).toThrow(NetworkFormatError);
      expect(() => parseNetworkFile(bytes.buffer)).toThrow(re);
      const info = inspectNetworkFile(bytes);
      expect(info.ok).toBe(false);
    });
  }

  it("accepts a valid file and reports its header", () => {
    const h = readNetworkHeader(good());
    expect(h).toMatchObject({ version: 1, inputs: INPUTS, hidden: 16, activation: 0, qa: 255, qb: 64, scale: 400, sizeBytes: networkFileSize(16) });
    const info = inspectNetworkFile(good().buffer);
    expect(info.ok).toBe(true);
  });

  it("does not reject the reserved flags field (not in the spec's reject list)", () => {
    expect(() => parseNetworkFile(withU32(32, 1).buffer)).not.toThrow();
  });

  it("rejects non-buffer input", () => {
    expect(() => parseNetworkFile("CBNN" as unknown as ArrayBuffer)).toThrow(NetworkFormatError);
  });
});
