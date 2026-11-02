// Registers the custom field and block definitions with Blockly. Idempotent (safe with HMR and
// multiple editors) and works headless (no DOM needed), so tests can load workspaces too.

import * as Blockly from "blockly";
import { BLOCK_DEFINITIONS } from "../definitions";
import { FieldPst } from "./field-pst";

let registered = false;

export function registerBlocks(): void {
  if (registered) return;
  registered = true;

  if (Blockly.registry.hasItem(Blockly.registry.Type.FIELD, "field_pst")) Blockly.fieldRegistry.unregister("field_pst");
  Blockly.fieldRegistry.register("field_pst", FieldPst);

  for (const def of BLOCK_DEFINITIONS) delete Blockly.Blocks[def.type];
  Blockly.common.defineBlocks(Blockly.common.createBlockDefinitionsFromJsonArray(BLOCK_DEFINITIONS as unknown as object[]));
}

export { Blockly };
