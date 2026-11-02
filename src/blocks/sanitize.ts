// Prepares stored workspace JSON for Blockly: deep-copies it and removes blocks whose type is
// unknown (Blockly would throw half-way through loading). Pure: no Blockly import.

import { isBlockState, isRecord, type BlockState, type ConnectionState, type WorkspaceState } from "./workspace-json";

export interface SanitizeResult {
  workspace: WorkspaceState;
  /** Types of the blocks that were dropped. */
  removed: string[];
}

export function sanitizeWorkspace(input: unknown, isKnownType: (type: string) => boolean): SanitizeResult {
  const removed: string[] = [];
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(input ?? {}));
  } catch {
    copy = {};
  }
  const ws: WorkspaceState = isRecord(copy) ? (copy as WorkspaceState) : {};

  /** Cleans a statement chain; returns its new first block (unknown blocks are skipped). */
  const cleanChain = (first: BlockState | null): BlockState | null => {
    let head: BlockState | null = null;
    let tail: BlockState | null = null;
    for (let b: BlockState | null = first; b; ) {
      const next: BlockState | null = isRecord(b.next) && isBlockState(b.next.block) ? b.next.block : null;
      if (!isKnownType(b.type)) {
        removed.push(b.type);
      } else {
        cleanInputs(b);
        delete b.next;
        if (tail) tail.next = { block: b };
        else head = b;
        tail = b;
      }
      b = next;
    }
    return head;
  };

  const cleanConnection = (c: ConnectionState, statement: boolean): void => {
    if (isBlockState(c.shadow)) {
      if (isKnownType(c.shadow.type)) cleanInputs(c.shadow);
      else {
        removed.push(c.shadow.type);
        delete c.shadow;
      }
    }
    if (isBlockState(c.block)) {
      if (statement) {
        const head = cleanChain(c.block);
        if (head) c.block = head;
        else delete c.block;
      } else if (isKnownType(c.block.type)) {
        cleanInputs(c.block);
      } else {
        removed.push(c.block.type);
        delete c.block;
      }
    }
  };

  const cleanInputs = (b: BlockState): void => {
    if (!isRecord(b.inputs)) return;
    for (const [name, conn] of Object.entries(b.inputs)) {
      if (!isRecord(conn)) {
        delete b.inputs[name];
        continue;
      }
      // Statement inputs hold chains; value inputs hold single blocks. Chains only appear
      // where the child block has `next` or the input is a known statement input name.
      const child = (conn as ConnectionState).block;
      const statement = isBlockState(child) && (isRecord(child.next) || /^(DO\d*|ELSE|TERMS|STACK)$/.test(name));
      cleanConnection(conn as ConnectionState, statement);
      if (!(conn as ConnectionState).block && !(conn as ConnectionState).shadow) delete b.inputs[name];
    }
  };

  if (isRecord(ws.blocks) && Array.isArray(ws.blocks.blocks)) {
    const tops: BlockState[] = [];
    for (const b of ws.blocks.blocks) {
      if (!isBlockState(b)) continue;
      const x = b.x;
      const y = b.y;
      const head = cleanChain(b);
      if (head) {
        if (head !== b) {
          head.x = x;
          head.y = y;
        }
        tops.push(head);
      }
    }
    ws.blocks.blocks = tops;
  } else if (ws.blocks !== undefined) {
    delete ws.blocks;
  }
  if (ws.variables !== undefined && !Array.isArray(ws.variables)) delete ws.variables;
  return { workspace: ws, removed };
}
