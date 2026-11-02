import { describe, expect, it } from "vitest";
import { documentTitleFor, resolveRoute } from "./routes";
import { PRIMARY_NAV, UTILITY_NAV } from "./AppHeader";

describe("routes", () => {
  it("gives every page a “… · BoardForm” title", () => {
    expect(documentTitleFor("/")).toBe("Engines · BoardForm");
    expect(documentTitleFor("/engines")).toBe("Engines · BoardForm");
    expect(documentTitleFor("/engines/abc")).toBe("Workshop · BoardForm");
    expect(documentTitleFor("/play")).toBe("Play · BoardForm");
    expect(documentTitleFor("/arena")).toBe("Arena · BoardForm");
    expect(documentTitleFor("/arena/m1")).toBe("Match · Arena · BoardForm");
    expect(documentTitleFor("/lab")).toBe("NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/runs")).toBe("Training runs · NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/runs/r1")).toBe("Training run · NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/networks")).toBe("Networks · NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/datasets/d1")).toBe("Dataset · NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/new")).toBe("New training run · NNUE Lab · BoardForm");
    expect(documentTitleFor("/lab/bogus")).toBe("NNUE Lab · BoardForm");
    expect(documentTitleFor("/settings")).toBe("Settings · BoardForm");
    expect(documentTitleFor("/help/blocks")).toBe("Help · BoardForm");
    expect(documentTitleFor("/nowhere/at/all")).toBe("Page not found · BoardForm");
  });

  it("maps every nav destination to a route in its own section", () => {
    for (const item of [...PRIMARY_NAV, ...UTILITY_NAV]) {
      expect(resolveRoute(item.to)?.def.section, item.label).toBe(item.section);
    }
    expect([...PRIMARY_NAV, ...UTILITY_NAV].map((n) => n.label)).toEqual(["Engines", "Play", "Arena", "NNUE Lab", "Help", "Settings"]);
  });

  it("does not throw on malformed escapes in a path", () => {
    expect(resolveRoute("/engines/%E0%A4%A")?.params.id).toBe("%E0%A4%A");
  });
});
