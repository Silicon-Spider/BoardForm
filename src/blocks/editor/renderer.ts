// "chess-builder" renderer: zelos (rounded, touch-friendly) with one fix.
//
// Zelos draws dropdowns on shadow blocks without their own border rect and makes the whole
// block their click target. Our square blocks are shadows with two dropdowns ("our ▾ 7th ▾"),
// so both dropdowns would share one click target: a click could open the wrong menu and
// disposing the block unbinds the same handlers twice (Blockly throws). Giving every dropdown
// its own border rect, as on normal blocks, avoids both problems.

import * as Blockly from "blockly";

export const RENDERER_NAME = "chess-builder";

class ChessBuilderConstants extends Blockly.zelos.ConstantProvider {
  constructor() {
    super();
    this.FIELD_DROPDOWN_NO_BORDER_RECT_SHADOW = false;
  }
}

class ChessBuilderRenderer extends Blockly.zelos.Renderer {
  protected override makeConstants_(): Blockly.zelos.ConstantProvider {
    return new ChessBuilderConstants();
  }
}

let registered = false;

export function registerRenderer(): void {
  if (registered) return;
  registered = true;
  if (Blockly.registry.hasItem(Blockly.registry.Type.RENDERER, RENDERER_NAME)) {
    Blockly.registry.unregister(Blockly.registry.Type.RENDERER, RENDERER_NAME);
  }
  Blockly.blockRendering.register(RENDERER_NAME, ChessBuilderRenderer);
}
