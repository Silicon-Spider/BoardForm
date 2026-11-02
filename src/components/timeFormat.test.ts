import { describe, expect, it } from "vitest";
import { clockTextHasUnit, describeTimeControl, formatClockTime, formatTimeControl, parseClockTime, parseSecondsText } from "./timeFormat";

const ms = (text: string, rule?: Parameters<typeof parseClockTime>[1]) => {
  const r = parseClockTime(text, rule);
  if (!r.ok) throw new Error(`"${text}" did not parse: ${r.error}`);
  return r.ms;
};
const error = (text: string, rule?: Parameters<typeof parseClockTime>[1]) => {
  const r = parseClockTime(text, rule);
  if (r.ok) throw new Error(`"${text}" parsed as ${r.ms}`);
  return r.error;
};

describe("formatClockTime", () => {
  it("uses seconds below a minute, minutes or m:ss above, always with a unit", () => {
    expect(formatClockTime(1000)).toBe("1 s");
    expect(formatClockTime(3000)).toBe("3 s");
    expect(formatClockTime(1500)).toBe("1.5 s");
    expect(formatClockTime(45_000)).toBe("45 s");
    expect(formatClockTime(60_000)).toBe("1 min");
    expect(formatClockTime(300_000)).toBe("5 min");
    expect(formatClockTime(90_000)).toBe("1:30 min");
    expect(formatClockTime(65_000)).toBe("1:05 min");
    expect(formatClockTime(90_500)).toBe("1:30.5 min");
    expect(formatClockTime(5_400_000)).toBe("90 min");
  });

  it("rounds to a tenth of a second", () => {
    expect(formatClockTime(1234)).toBe("1.2 s");
    expect(formatClockTime(59_960)).toBe("1 min");
  });
});

describe("parseClockTime", () => {
  it("reads a bare number as minutes", () => {
    expect(ms("5")).toBe(300_000);
    expect(ms("0.5")).toBe(30_000);
    expect(ms("1,5")).toBe(90_000);
    expect(ms(" 10 ")).toBe(600_000);
  });

  it("reads m:ss and h:mm:ss", () => {
    expect(ms("1:30")).toBe(90_000);
    expect(ms("0:03")).toBe(3_000);
    expect(ms("1:05")).toBe(65_000);
    expect(ms("1:30 min")).toBe(90_000);
    expect(ms("1:02:00")).toBe(3_720_000);
    expect(error("1:75")).toMatch(/seconds go up to 59/);
    expect(error("1:61:00")).toMatch(/59/);
  });

  it("reads values with units", () => {
    expect(ms("20 s")).toBe(20_000);
    expect(ms("20s")).toBe(20_000);
    expect(ms("3 sec")).toBe(3_000);
    expect(ms("1.5 min")).toBe(90_000);
    expect(ms("2 minutes")).toBe(120_000);
    expect(ms("1m 30s")).toBe(90_000);
    expect(ms("1m30s")).toBe(90_000);
    expect(ms("1 h 15 min")).toBe(4_500_000);
    expect(ms("1500 ms")).toBe(1_500);
    expect(ms("2 S")).toBe(2_000);
  });

  it("round-trips its own output", () => {
    for (const v of [1000, 1500, 3000, 45_000, 60_000, 65_000, 90_000, 90_500, 300_000, 5_400_000]) {
      expect(ms(formatClockTime(v))).toBe(v);
    }
  });

  it("explains bad input and enforces the range", () => {
    expect(error("")).toBe("Enter a time");
    expect(error("abc")).toBe("Type minutes (5), m:ss (1:30) or seconds (20 s)");
    expect(error("five")).toMatch(/m:ss/);
    expect(error("5 parsecs")).toMatch(/Unknown unit "parsecs"/);
    expect(error("1:")).toMatch(/minutes \(5\), m:ss \(1:30\) or seconds \(20 s\)/);
    expect(error("-5")).toMatch(/m:ss/);
    expect(error("0.5 s")).toBe("At least 1 s");
    expect(error("0")).toBe("At least 1 s");
    expect(error("2 s", { minMs: 10_000 })).toBe("At least 10 s");
    expect(error("601")).toBe("At most 600 min");
    expect(ms("0.5 s", { minMs: 100 })).toBe(500);
  });

  it("tells whether typed text names its unit", () => {
    expect(clockTextHasUnit("5")).toBe(false);
    expect(clockTextHasUnit("1:30")).toBe(false);
    expect(clockTextHasUnit("20 s")).toBe(true);
    expect(clockTextHasUnit("1:30 min")).toBe(true);
  });
});

describe("parseSecondsText", () => {
  it("accepts plain seconds, units and milliseconds", () => {
    expect(parseSecondsText("2")).toBe(2);
    expect(parseSecondsText("0.5")).toBe(0.5);
    expect(parseSecondsText(".5")).toBe(0.5);
    expect(parseSecondsText("1,5")).toBe(1.5);
    expect(parseSecondsText("2 s")).toBe(2);
    expect(parseSecondsText("3sec")).toBe(3);
    expect(parseSecondsText("500 ms")).toBe(0.5);
    expect(parseSecondsText("abc")).toBeNull();
    expect(parseSecondsText("2 min")).toBeNull();
    expect(parseSecondsText("")).toBeNull();
  });
});

describe("formatTimeControl / describeTimeControl", () => {
  it("writes chess-style base+increment", () => {
    expect(formatTimeControl(null)).toBe("No clock");
    expect(formatTimeControl({ baseMs: 300_000, incMs: 0 })).toBe("5+0");
    expect(formatTimeControl({ baseMs: 180_000, incMs: 2_000 })).toBe("3+2");
    expect(formatTimeControl({ baseMs: 90_000, incMs: 1_000 })).toBe("1.5+1");
    expect(formatTimeControl({ baseMs: 80_000, incMs: 0 })).toBe("1:20+0");
    expect(formatTimeControl({ baseMs: 10_000, incMs: 100 })).toBe("10s+0.1");
    expect(formatTimeControl({ baseMs: 3_000, incMs: 0 })).toBe("3s+0");
    expect(formatTimeControl({ baseMs: 5_400_000, incMs: 30_000, movesPerControl: 40 })).toBe("40/90+30");
  });

  it("spells a time control out", () => {
    expect(describeTimeControl(null)).toBe("No clock");
    expect(describeTimeControl({ baseMs: 300_000, incMs: 3_000 })).toBe("5 min + 3 s per move");
    expect(describeTimeControl({ baseMs: 10_000, incMs: 0 })).toBe("10 s");
    expect(describeTimeControl({ baseMs: 5_400_000, incMs: 30_000, movesPerControl: 40 })).toBe("90 min for 40 moves + 30 s per move");
  });
});
