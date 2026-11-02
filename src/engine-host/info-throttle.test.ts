import { describe, expect, it } from "vitest";
import { InfoThrottle } from "./info-throttle";

function harness(burst: number, intervalMs: number) {
  let clock = 0;
  const sent: number[] = [];
  const throttle = new InfoThrottle<number>((n) => sent.push(n), { burst, intervalMs, now: () => clock });
  return {
    throttle,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("InfoThrottle", () => {
  it("forwards everything while reports are rare (one per iteration)", () => {
    const { throttle, sent, advance } = harness(2, 10);
    for (let i = 1; i <= 20; i++) {
      throttle.push(i);
      advance(15);
    }
    throttle.flush();
    expect(sent).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(throttle.dropped).toBe(0);
  });

  it("forwards a burst, then at most one report per interval, and flushes the newest held one", () => {
    const { throttle, sent, advance } = harness(3, 10);
    // 1000 reports, 0.1 ms apart (100 ms in total).
    for (let i = 1; i <= 1000; i++) {
      throttle.push(i);
      advance(0.1);
    }
    expect(sent.slice(0, 3)).toEqual([1, 2, 3]);
    expect(sent.length).toBeLessThanOrEqual(3 + 11);
    for (let k = 4; k < sent.length; k++) expect(sent[k] - sent[k - 1]).toBeGreaterThanOrEqual(99); // >= 10 ms apart
    throttle.flush();
    expect(sent.at(-1)).toBe(1000); // the last report always arrives
    expect(sent.length + throttle.dropped).toBe(1000);
    throttle.flush();
    expect(sent.at(-1)).toBe(1000); // nothing pending any more: no duplicate
    expect(sent.filter((n) => n === 1000)).toHaveLength(1);
  });

  it("starts every call with a fresh burst", () => {
    const { throttle, sent } = harness(2, 1000);
    for (let i = 1; i <= 5; i++) throttle.push(i);
    expect(sent).toEqual([1, 2]);
    throttle.reset(); // a held report from the previous call is discarded
    throttle.flush();
    expect(sent).toEqual([1, 2]);
    throttle.push(10);
    throttle.push(11);
    throttle.push(12);
    throttle.flush();
    expect(sent).toEqual([1, 2, 10, 11, 12]);
    expect(throttle.dropped).toBe(0);
  });
});
