// Tiny helpers for writing Blockly workspace JSON by hand (starter workspace, toolbox
// recipes, tests). Pure: no Blockly import.

import type { BlockState, ConnectionState, WorkspaceState } from "./workspace-json";

export interface BlockOptions {
  fields?: Record<string, unknown>;
  inputs?: Record<string, BlockState | ConnectionState>;
  next?: BlockState;
  extraState?: unknown;
  comment?: string | { text: string; pinned?: boolean; width?: number; height?: number; x?: number; y?: number };
  collapsed?: boolean;
  x?: number;
  y?: number;
  id?: string;
}

function isConnection(x: BlockState | ConnectionState): x is ConnectionState {
  return !("type" in x);
}

/** A block state. Inputs given as a plain block are connected as real (non-shadow) blocks. */
export function block(type: string, opts: BlockOptions = {}): BlockState {
  const b: BlockState = { type };
  if (opts.id) b.id = opts.id;
  if (opts.x !== undefined) b.x = opts.x;
  if (opts.y !== undefined) b.y = opts.y;
  if (opts.collapsed) b.collapsed = true;
  if (opts.extraState !== undefined) b.extraState = opts.extraState;
  if (opts.comment) {
    const c = typeof opts.comment === "string" ? { text: opts.comment } : opts.comment;
    b.icons = { comment: { pinned: false, width: 320, height: 140, ...c } };
  }
  if (opts.fields) b.fields = { ...opts.fields };
  if (opts.inputs) {
    b.inputs = {};
    for (const [k, v] of Object.entries(opts.inputs)) b.inputs[k] = isConnection(v) ? v : { block: v };
  }
  if (opts.next) b.next = { block: opts.next };
  return b;
}

/** Chains statement blocks through their `next` connections; returns the first one. */
export function stack(...blocks: BlockState[]): BlockState | undefined {
  for (let i = blocks.length - 2; i >= 0; i--) blocks[i]!.next = { block: blocks[i + 1]! };
  return blocks[0];
}

/** An input holding an editable shadow block (what the toolbox uses for default values). */
export function shadow(b: BlockState): ConnectionState {
  return { shadow: b };
}

/** A shadow number, e.g. the 10 in "add (10) points". */
export function num(n: number): ConnectionState {
  return shadow({ type: "math_number", fields: { NUM: n } });
}

/** A real (non-shadow) number block. */
export function numBlock(n: number): BlockState {
  return { type: "math_number", fields: { NUM: n } };
}

/** "our 7th rank" as a shadow zone. */
export function rankZone(rank: number, whose: "US" | "THEM" = "US"): ConnectionState {
  return shadow({ type: "cb_zone_rank", fields: { WHOSE: whose, RANK: String(rank) } });
}

export function term(name: string, body: BlockState[], opts: Omit<BlockOptions, "fields" | "inputs"> = {}): BlockState {
  const first = stack(...body);
  return block("cb_term", { ...opts, fields: { NAME: name }, inputs: first ? { DO: first } : undefined });
}

export function workspace(top: BlockState[], variables: { name: string; id: string }[] = []): WorkspaceState {
  const ws: WorkspaceState = { blocks: { languageVersion: 0, blocks: top } };
  if (variables.length) ws.variables = variables;
  return ws;
}

/** Deep copy (workspace JSON is plain data). */
export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
