// Headless Blockly (Node + jsdom via blockly's own node entry): the block definitions register,
// every block can be created, and our hand-written JSON (starter workspace, fixtures, toolbox)
// loads into a real Blockly workspace and round-trips to the same generated code.

import * as Blockly from "blockly";
import { beforeAll, describe, expect, it } from "vitest";
import { BLOCK_DEFINITIONS } from "./definitions";
import { DEFAULT_WORKSPACE } from "./default-workspace";
import { registerBlocks } from "./editor/register";
import { generateEval } from "./generator";
import { kitchenSinkWorkspace, optionSweepWorkspace } from "./testing/fixtures";
import { buildToolbox, RECIPES, type ToolboxItem } from "./toolbox";
import type { BlockState } from "./workspace-json";

beforeAll(() => {
  registerBlocks();
});

function roundTrip(json: object): object {
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(json, ws);
    return Blockly.serialization.workspaces.save(ws) as object;
  } finally {
    ws.dispose();
  }
}

describe("Blockly registration (headless)", () => {
  it("creates every custom block with its fields and inputs", () => {
    const ws = new Blockly.Workspace();
    for (const def of BLOCK_DEFINITIONS) {
      const b = ws.newBlock(def.type);
      expect(b.type).toBe(def.type);
      for (const args of [def.args0, def.args1, def.args2, def.args3]) {
        for (const a of args ?? []) {
          const name = "name" in a && typeof a.name === "string" ? a.name : null;
          if (!name) continue;
          if (a.type.startsWith("field_")) expect(b.getField(name), `${def.type}.${name}`).not.toBeNull();
          if (a.type === "input_value" || a.type === "input_statement") expect(b.getInput(name), `${def.type}.${name}`).not.toBeNull();
        }
      }
      expect(b.getTooltip(), def.type).not.toBe("");
    }
    ws.dispose();
  });

  it("registers the piece-square-table field and serialises it as 64 ints", () => {
    const ws = new Blockly.Workspace();
    const b = ws.newBlock("cb_pst");
    const state = Blockly.serialization.blocks.save(b) as BlockState;
    const table = state.fields?.TABLE as unknown[];
    expect(Array.isArray(table)).toBe(true);
    expect(table).toHaveLength(64);
    expect(table.every((v) => Number.isInteger(v))).toBe(true);
    b.setFieldValue(Array.from({ length: 64 }, (_, i) => i - 30), "TABLE");
    expect((b.getFieldValue("TABLE") as number[])[63]).toBe(33);
    b.setFieldValue([1, 2, 3], "TABLE"); // invalid: ignored
    expect((b.getFieldValue("TABLE") as number[])).toHaveLength(64);
    ws.dispose();
  });
});

describe("JSON loads into Blockly and round-trips", () => {
  const cases: [string, () => object][] = [
    ["DEFAULT_WORKSPACE", () => DEFAULT_WORKSPACE],
    ["kitchen sink", kitchenSinkWorkspace],
    ["option sweep", optionSweepWorkspace],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      const original = make();
      const saved = roundTrip(original);
      const a = generateEval(original);
      const b = generateEval(saved);
      expect(b.errors).toEqual(a.errors);
      expect(b.code).toBe(a.code);
    });
  }

  it("every toolbox block item loads", () => {
    const items: ToolboxItem[] = [];
    for (const c of buildToolbox().contents) {
      if (c.kind === "category" && Array.isArray(c.contents)) items.push(...(c.contents as ToolboxItem[]).filter((i) => i.kind === "block"));
    }
    expect(items.length).toBeGreaterThan(40);
    const ws = new Blockly.Workspace();
    for (const item of items) {
      const { kind: _kind, ...state } = item;
      const b = Blockly.serialization.blocks.append(state as unknown as Blockly.serialization.blocks.State, ws);
      expect(b.type).toBe(item.type);
    }
    ws.dispose();
  });

  it("ready-made terms keep their values through Blockly", () => {
    for (const recipe of RECIPES) {
      const json = { blocks: { languageVersion: 0, blocks: [{ type: "cb_evaluation", inputs: { TERMS: { block: recipe } } }] } };
      expect(generateEval(roundTrip(json)).code).toBe(generateEval(json).code);
    }
  });
});
