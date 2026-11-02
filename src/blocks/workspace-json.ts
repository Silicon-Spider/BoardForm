// Types for Blockly's JSON serialization format (Blockly.serialization.workspaces.save),
// plus small helpers to read it defensively. Pure: no Blockly import.

export interface ConnectionState {
  block?: BlockState;
  shadow?: BlockState;
}

export interface BlockState {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  collapsed?: boolean;
  /** Legacy (pre-v11) way of saving a disabled block. */
  enabled?: boolean;
  disabledReasons?: string[];
  deletable?: boolean;
  movable?: boolean;
  editable?: boolean;
  inline?: boolean;
  data?: string;
  extraState?: unknown;
  icons?: { comment?: { text?: string; pinned?: boolean; width?: number; height?: number; x?: number; y?: number } } & Record<
    string,
    unknown
  >;
  fields?: Record<string, unknown>;
  inputs?: Record<string, ConnectionState>;
  next?: ConnectionState;
}

export interface VariableState {
  name: string;
  id: string;
  type?: string;
}

export interface WorkspaceState {
  blocks?: { languageVersion?: number; blocks?: BlockState[] };
  variables?: VariableState[];
  [key: string]: unknown;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isBlockState(x: unknown): x is BlockState {
  return isRecord(x) && typeof x.type === "string";
}

/** The block plugged into a connection: the real block if present, otherwise its shadow. */
export function connectedBlock(conn: unknown): BlockState | null {
  if (!isRecord(conn)) return null;
  if (isBlockState(conn.block)) return conn.block;
  if (isBlockState(conn.shadow)) return conn.shadow;
  return null;
}

export function inputBlock(block: BlockState, name: string): BlockState | null {
  return isRecord(block.inputs) ? connectedBlock(block.inputs[name]) : null;
}

export function nextBlock(block: BlockState): BlockState | null {
  return connectedBlock(block.next);
}

export function isDisabled(block: BlockState): boolean {
  return block.enabled === false || (Array.isArray(block.disabledReasons) && block.disabledReasons.length > 0);
}

/** Top-level blocks of a workspace (empty when the structure is missing or malformed). */
export function topBlocks(ws: unknown): BlockState[] {
  if (!isRecord(ws) || !isRecord(ws.blocks) || !Array.isArray(ws.blocks.blocks)) return [];
  return ws.blocks.blocks.filter(isBlockState);
}

/** Text of a block's comment icon, if any. */
export function blockComment(block: BlockState): string | null {
  const c = isRecord(block.icons) ? block.icons.comment : undefined;
  return isRecord(c) && typeof c.text === "string" && c.text.trim() ? c.text : null;
}

/** Calls `fn` for every block (including shadows) reachable from the given roots. */
export function walkBlocks(roots: BlockState[], fn: (b: BlockState, isShadow: boolean) => void): void {
  const stack: [BlockState, boolean][] = roots.map((b) => [b, false]);
  while (stack.length) {
    const [b, shadow] = stack.pop()!;
    fn(b, shadow);
    const conns: ConnectionState[] = [];
    if (isRecord(b.inputs)) conns.push(...(Object.values(b.inputs).filter(isRecord) as ConnectionState[]));
    if (isRecord(b.next)) conns.push(b.next);
    for (const c of conns) {
      if (isBlockState(c.block)) stack.push([c.block, false]);
      if (isBlockState(c.shadow)) stack.push([c.shadow, true]);
    }
  }
}
