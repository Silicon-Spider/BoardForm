import { describe, expect, it } from "vitest";
import { INFO_RATE_NOTE_PREFIX, InfoRateWatch, InfoThrottle, infoRateNote } from "./info-throttle";

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

describe("InfoRateWatch", () => {
  function watch() {
    let clock = 0;
    const warnings: number[] = [];
    const w = new InfoRateWatch((perSecond) => warnings.push(perSecond), { minDurationMs: 1000, maxPerSecond: 1000, now: () => clock });
    return { w, warnings, advance: (ms: number) => (clock += ms) };
  }

  it("stays quiet for a burst of fast iterations (many reports within a few milliseconds)", () => {
    const { w, warnings, advance } = watch();
    for (let call = 0; call < 200; call++) {
      w.startCall();
      for (let depth = 1; depth <= 64; depth++) {
        w.record();
        advance(0.01);
      }
      advance(5);
    }
    expect(warnings).toEqual([]);
  });

  it("stays quiet for once-per-iteration reports over a long search", () => {
    const { w, warnings, advance } = watch();
    w.startCall();
    // 40 iterations within the first 20 ms, then one report every ~half second for a minute.
    for (let i = 0; i < 40; i++) {
      w.record();
      advance(0.5);
    }
    for (let i = 0; i < 120; i++) {
      advance(500);
      w.record();
    }
    expect(warnings).toEqual([]);
  });

  it("warns once when the engine keeps reporting far too often, and never again", () => {
    const { w, warnings, advance } = watch();
    w.startCall();
    for (let i = 0; i < 60_000; i++) {
      w.record();
      advance(0.02); // 50,000 a second for 1.2 s
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeGreaterThan(40_000);
    expect(w.warned).toBe(true);
    w.startCall();
    for (let i = 0; i < 60_000; i++) {
      w.record();
      advance(0.02);
    }
    expect(warnings).toHaveLength(1);
  });

  it("measures each call on its own (quiet calls between fast bursts do not add up)", () => {
    const { w, warnings, advance } = watch();
    for (let call = 0; call < 20; call++) {
      w.startCall();
      for (let i = 0; i < 500; i++) {
        w.record();
        advance(0.1); // 50 ms of very fast reports
      }
      advance(2000); // then a long pause before the next search
    }
    expect(warnings).toEqual([]);
  });
});

describe("infoRateNote", () => {
  it("rounds the rate and gives accurate advice", () => {
    const note = infoRateNote(52_345.6);
    expect(note.startsWith(INFO_RATE_NOTE_PREFIX)).toBe(true);
    expect(note).toContain("about 52,000 times a second");
    expect(note).toContain("about 100 a second are shown");
    expect(infoRateNote(1234)).toContain("about 1,200 times a second");
  });
});
