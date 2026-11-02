import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const ago = (ms: number) => formatRelativeTime(NOW - ms, NOW);

describe("formatRelativeTime", () => {
  it("says just now for the first 45 seconds and for future times", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44.9 * S)).toBe("just now");
    expect(ago(-5 * MIN)).toBe("just now");
  });

  it("counts minutes from 45 s and never says 0 min", () => {
    expect(ago(45 * S)).toBe("1 min ago");
    expect(ago(89 * S)).toBe("1 min ago");
    expect(ago(90 * S)).toBe("2 min ago");
    expect(ago(30 * MIN)).toBe("30 min ago");
    expect(ago(59 * MIN + 29 * S)).toBe("59 min ago");
  });

  it("moves to hours when the minutes would round to 60", () => {
    expect(ago(59 * MIN + 30 * S)).toBe("1 h ago");
    expect(ago(59 * MIN + 59 * S)).toBe("1 h ago");
    expect(ago(H)).toBe("1 h ago");
    expect(ago(H + 29 * MIN)).toBe("1 h ago");
    expect(ago(H + 30 * MIN)).toBe("2 h ago");
    expect(ago(23 * H + 29 * MIN)).toBe("23 h ago");
  });

  it("moves to days when the hours would round to 24", () => {
    expect(ago(23 * H + 30 * MIN)).toBe("1 d ago");
    expect(ago(D)).toBe("1 d ago");
    expect(ago(D + 11 * H)).toBe("1 d ago");
    expect(ago(D + 12 * H)).toBe("2 d ago");
    expect(ago(6 * D + 11 * H)).toBe("6 d ago");
  });

  it("shows the date once the days would round to 7", () => {
    const date = (ms: number) => new Date(NOW - ms).toLocaleDateString();
    expect(ago(6 * D + 12 * H)).toBe(date(6 * D + 12 * H));
    expect(ago(7 * D)).toBe(date(7 * D));
    expect(ago(400 * D)).toBe(date(400 * D));
  });

  it("never produces 60 min, 24 h or 7 d anywhere in the range", () => {
    for (let ms = 0; ms < 8 * D; ms += 7 * S) {
      expect(ago(ms)).not.toMatch(/^(60 min|24 h|7 d|0 \w+) ago$/);
    }
  });

  it("handles invalid timestamps", () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("—");
  });
});
