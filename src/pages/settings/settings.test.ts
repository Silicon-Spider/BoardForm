import { describe, expect, it } from "vitest";
import { START_FEN } from "@/chess";
import type { EngineRecord } from "@/types";
import {
  backupFileName,
  demoMove,
  duplicateStarterIds,
  joinList,
  nearestAnimationPreset,
  parseHashMb,
  restoredSummary,
  usageFraction,
} from "./settings-logic";

function starter(id: string, name: string, createdAt: number, overrides: Partial<EngineRecord> = {}): EngineRecord {
  return {
    id,
    name,
    description: "",
    kind: name === "Blocky" ? "blocks" : name === "Classic" ? "eval" : "scratch",
    createdAt,
    updatedAt: createdAt,
    color: "#f59e0b",
    options: { hashMb: 16 },
    builtin: true,
    tags: ["starter"],
    build: null,
    ...overrides,
  };
}

describe("settings helpers", () => {
  it("names backups by local date", () => {
    expect(backupFileName(new Date(2026, 10, 2, 23, 59))).toBe("boardform-backup-2026-11-02.json");
    expect(backupFileName(new Date(2027, 0, 9))).toBe("boardform-backup-2027-01-09.json");
  });

  it("maps animation durations to the nearest preset", () => {
    expect(nearestAnimationPreset(0)).toBe("off");
    expect(nearestAnimationPreset(-5)).toBe("off");
    expect(nearestAnimationPreset(100)).toBe("fast");
    expect(nearestAnimationPreset(150)).toBe("normal");
    expect(nearestAnimationPreset(160)).toBe("normal");
    expect(nearestAnimationPreset(400)).toBe("slow");
    expect(nearestAnimationPreset(Number.NaN)).toBe("off");
  });

  it("parses hash sizes strictly", () => {
    expect(parseHashMb("16")).toBe(16);
    expect(parseHashMb(" 512 ")).toBe(512);
    expect(parseHashMb("1")).toBe(1);
    expect(parseHashMb("0")).toBeNull();
    expect(parseHashMb("513")).toBeNull();
    expect(parseHashMb("12.5")).toBeNull();
    expect(parseHashMb("")).toBeNull();
    expect(parseHashMb("abc")).toBeNull();
  });

  it("computes usage fractions only when both numbers are known", () => {
    expect(usageFraction(50, 200)).toBe(0.25);
    expect(usageFraction(Number.NaN, 200)).toBeNull();
    expect(usageFraction(5, Number.NaN)).toBeNull();
    expect(usageFraction(5, 0)).toBeNull();
    expect(usageFraction(500, 200)).toBe(1);
  });

  it("summarizes restored records", () => {
    expect(
      restoredSummary({ engines: 3, networks: 1, networkData: 1, datasets: 0, datasetChunks: 0, games: 25, matches: 1, trainingRuns: 0, settings: 12 }),
    ).toEqual(["3 engines", "1 network", "25 games", "1 match", "12 settings"]);
    expect(restoredSummary({})).toEqual([]);
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b"])).toBe("a and b");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(joinList([])).toBe("");
  });

  it("finds untouched duplicate starter engines", () => {
    const restored = [starter("old-b", "Blocky", 100), starter("old-c", "Classic", 99, { updatedAt: 500 }), starter("old-s", "Sprout", 98)];
    const fresh = [starter("new-b", "Blocky", 1000), starter("new-c", "Classic", 999), starter("new-s", "Sprout", 998)];
    expect(duplicateStarterIds([...fresh, ...restored]).sort()).toEqual(["new-b", "new-c", "new-s"]);
    // A copy the user changed is always kept; the untouched one is the duplicate.
    const edited = starter("new-b", "Blocky", 1000, { updatedAt: 2000 });
    expect(duplicateStarterIds([edited, restored[0]])).toEqual(["old-b"]);
    // Two changed copies are both kept.
    expect(duplicateStarterIds([edited, starter("old-b", "Blocky", 100, { updatedAt: 300 })])).toEqual([]);
    // Non-builtin engines with starter names are never touched.
    expect(duplicateStarterIds([starter("mine", "Blocky", 5, { builtin: false }), restored[0]])).toEqual([]);
    expect(duplicateStarterIds(restored)).toEqual([]);
  });

  it("suggests a legal demo move", () => {
    const move = demoMove(START_FEN);
    expect(move).toMatch(/^[a-h][1-8][a-h][1-8]$/);
    // Takes the hanging queen.
    expect(demoMove("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1")).toBe("e4d5");
    // Checkmated: no move.
    expect(demoMove("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")).toBeNull();
  });
});
