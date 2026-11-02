import { describe, expect, it } from "vitest";
import { capsText } from "./format";

describe("capsText", () => {
  it("summarises engine caps without trailing zeros", () => {
    expect(capsText({ nodes: 3000 })).toBe("3k nodes");
    expect(capsText({ nodes: 2500 })).toBe("2.5k nodes");
    expect(capsText({ nodes: 15_000 })).toBe("15k nodes");
    expect(capsText({ nodes: 100_000 })).toBe("100k nodes");
    expect(capsText({ nodes: 1_250_000 })).toBe("1.25M nodes");
    expect(capsText({ nodes: 800 })).toBe("800 nodes");
    expect(capsText({ movetimeMs: 200, depth: 8 })).toBe("0.2 s per move · depth 8");
    expect(capsText({})).toBe("");
  });
});
