// Network lineage: the chain of parents (continued / widened from) and the children of a network.
import type { NetworkRecord } from "@/types";

export interface LineageEntry {
  id: string;
  /** null when the parent record no longer exists. */
  network: NetworkRecord | null;
}

/**
 * Parents of `network`, nearest first (parent, grandparent, ...). Stops at a missing record (which
 * is included once with `network: null`, so the UI can say "deleted"), at a cycle, or after `max`.
 */
export function parentChain(network: Pick<NetworkRecord, "id" | "parentId">, all: readonly NetworkRecord[], max = 50): LineageEntry[] {
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const seen = new Set<string>([network.id]);
  const out: LineageEntry[] = [];
  let next = network.parentId;
  while (next && out.length < max && !seen.has(next)) {
    seen.add(next);
    const rec = byId.get(next) ?? null;
    out.push({ id: next, network: rec });
    if (!rec) break;
    next = rec.parentId;
  }
  return out;
}

/** Networks whose parent is `id`, newest first. */
export function childrenOf(id: string, all: readonly NetworkRecord[]): NetworkRecord[] {
  return all.filter((n) => n.parentId === id).sort((a, b) => b.createdAt - a.createdAt);
}
