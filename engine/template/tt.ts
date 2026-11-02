// =====================================================================================
// tt.ts — transposition table (hash table of search results)
// =====================================================================================
//
// The same position is often reached through different move orders ("transpositions"), and
// iterative deepening searches the same positions again at every depth. The transposition
// table remembers, per position (identified by its 64-bit Zobrist key):
//
//   * the best move found        -> searched first next time (great for move ordering)
//   * the score and the depth it was searched to
//   * the bound type of the score:
//       EXACT  the true score (it was inside the alpha-beta window)
//       LOWER  the score is at least this (the search failed high, score >= beta)
//       UPPER  the score is at most this  (the search failed low, no move beat alpha)
//   * the static evaluation (saves calling evaluate() again)
//
// Layout: the table is one block of raw memory made of buckets of 2 entries (32 bytes).
// Each entry is two u64 words: the full key, and a packed data word:
//
//     bits  0..15  move           bits 32..47  static eval (i16)
//     bits 16..31  score (i16)    bits 48..55  depth
//                                 bits 56..57  bound      bits 58..63  generation
//
// Replacement: an entry with the same key is updated in place; otherwise the entry of the
// bucket that is least valuable (from an older search, or searched less deeply) is replaced.
//
// Mate scores are stored relative to the node ("mate in 3 from here") rather than to the
// root, so they stay correct when the position is reached at a different ply.

import { MATE_BOUND, MOVE_NONE } from "./types";

export const BOUND_NONE: i32 = 0;
export const BOUND_UPPER: i32 = 1;
export const BOUND_LOWER: i32 = 2;
export const BOUND_EXACT: i32 = 3;

/** Marker for "no static evaluation stored" (e.g. the node was in check). */
export const EVAL_NONE: i32 = -32768;

/** Default and maximum size in MiB (one allocation must stay below 1 GiB in AssemblyScript). */
export const DEFAULT_HASH_MB: i32 = 16;
export const MAX_HASH_MB: i32 = 512;

const ENTRY_BYTES: usize = 16;
const BUCKET_BYTES: usize = 32;

let table: usize = 0; // address of the first bucket
let tableBytes: usize = 0;
let bucketCount: u64 = 0;
let generation: u64 = 0; // 6-bit search counter used to recognise stale entries
let sizeMb: i32 = 0;

/** (Re)allocates the table with `mb` MiB (clamped to 1..MAX_HASH_MB) and clears it. */
export function ttResize(mb: i32): void {
  if (mb < 1) mb = 1;
  if (mb > MAX_HASH_MB) mb = MAX_HASH_MB;
  if (table != 0 && mb == sizeMb) {
    ttClear();
    return;
  }
  if (table != 0) heap.free(table);
  tableBytes = (<usize>mb) << 20;
  table = heap.alloc(tableBytes);
  bucketCount = <u64>(tableBytes / BUCKET_BYTES);
  sizeMb = mb;
  ttClear();
}

/** Current size in MiB. */
export function ttSizeMb(): i32 {
  return sizeMb;
}

/** Empties the table (called for a new game). */
export function ttClear(): void {
  if (table != 0) memory.fill(table, 0, tableBytes);
  generation = 0;
}

/** Starts a new search: entries from earlier searches become preferred victims. */
export function ttNewSearch(): void {
  generation = (generation + 1) & 63;
}

/** Address of the bucket for `key` (multiply-shift maps the key evenly onto the buckets). */
@inline
function bucketFor(key: u64): usize {
  const index = ((key >> 32) * bucketCount) >> 32;
  return table + <usize>index * BUCKET_BYTES;
}

/**
 * Looks up `key`. Returns the address of the matching entry, or 0 if the position is not in
 * the table. Read the fields with the ttEntry* functions below.
 */
export function ttProbe(key: u64): usize {
  const bucket = bucketFor(key);
  if (load<u64>(bucket) == key && load<u64>(bucket, 8) != 0) return bucket;
  const second = bucket + ENTRY_BYTES;
  if (load<u64>(second) == key && load<u64>(second, 8) != 0) return second;
  return 0;
}

/** Best move stored in an entry (MOVE_NONE if none). */
@inline
export function ttEntryMove(entry: usize): i32 {
  return <i32>(load<u64>(entry, 8) & 0xFFFF);
}

/** Stored score converted back to a root-relative score for a node at `ply`. */
@inline
export function ttEntryScore(entry: usize, ply: i32): i32 {
  const score = <i32><i16>(load<u64>(entry, 8) >> 16);
  if (score > MATE_BOUND) return score - ply;
  if (score < -MATE_BOUND) return score + ply;
  return score;
}

/** Stored static evaluation (EVAL_NONE if none). */
@inline
export function ttEntryEval(entry: usize): i32 {
  return <i32><i16>(load<u64>(entry, 8) >> 32);
}

/** Depth the stored score was searched to. */
@inline
export function ttEntryDepth(entry: usize): i32 {
  return <i32>((load<u64>(entry, 8) >> 48) & 0xFF);
}

/** Bound type of the stored score (BOUND_EXACT / BOUND_LOWER / BOUND_UPPER). */
@inline
export function ttEntryBound(entry: usize): i32 {
  return <i32>((load<u64>(entry, 8) >> 56) & 3);
}

/**
 * Stores a search result. `score` is relative to the root and is converted to a node-relative
 * mate distance using `ply`. A MOVE_NONE move keeps the previously stored move of the entry.
 */
export function ttStore(key: u64, move: i32, score: i32, staticEval: i32, depth: i32, bound: i32, ply: i32): void {
  const bucket = bucketFor(key);
  const second = bucket + ENTRY_BYTES;
  let slot: usize;
  if (load<u64>(bucket) == key) slot = bucket;
  else if (load<u64>(second) == key) slot = second;
  else {
    // Replace the less valuable entry: stale entries first, then the shallower one.
    slot = entryWorth(bucket) <= entryWorth(second) ? bucket : second;
  }

  const old = load<u64>(slot, 8);
  if (load<u64>(slot) == key && old != 0) {
    // Same position: keep a deeper result from this search unless the new one is exact.
    const oldDepth = <i32>((old >> 48) & 0xFF);
    const oldGeneration = (old >> 58) & 63;
    if (bound != BOUND_EXACT && oldGeneration == generation && depth + 2 < oldDepth) return;
    if (move == MOVE_NONE) move = <i32>(old & 0xFFFF);
  }

  if (score > MATE_BOUND) score += ply;
  else if (score < -MATE_BOUND) score -= ply;
  if (depth < 0) depth = 0;
  if (depth > 255) depth = 255;

  const data = (<u64>(move & 0xFFFF)) |
    ((<u64>(score & 0xFFFF)) << 16) |
    ((<u64>(staticEval & 0xFFFF)) << 32) |
    ((<u64>depth) << 48) |
    ((<u64>(bound & 3)) << 56) |
    (generation << 58);
  store<u64>(slot, key);
  store<u64>(slot, data, 8);
}

/** Replacement priority of an entry: lower is replaced first. */
@inline
function entryWorth(entry: usize): i32 {
  const data = load<u64>(entry, 8);
  if (data == 0) return -1000; // empty
  const depth = <i32>((data >> 48) & 0xFF);
  const stale = ((data >> 58) & 63) != generation;
  return stale ? depth - 256 : depth;
}

/** Approximate fill rate in permille, sampled from the first 1000 entries (UCI "hashfull"). */
export function ttHashfull(): i32 {
  let used = 0;
  const entries = <i32>min<u64>(1000, bucketCount * 2);
  for (let i = 0; i < entries; i++) {
    const data = load<u64>(table + <usize>i * ENTRY_BYTES, 8);
    if (data != 0 && ((data >> 58) & 63) == generation) used++;
  }
  return entries > 0 ? used * 1000 / entries : 0;
}
