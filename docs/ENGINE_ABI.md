# BoardForm Engine ABI — version 1

Every engine in BoardForm is a WebAssembly module that implements this ABI.
Engines built in the app are written in AssemblyScript and compiled in the browser,
but any language that targets `wasm32` (C, C++, Rust, Zig, ...) can implement it and
be uploaded as a `.wasm` file.

The ABI is deliberately **numbers-only**: strings travel through two byte buffers in the
engine's own linear memory. No JS glue / loader is required.

## Conventions

* Squares use UCI names (`a1`..`h8`). Moves use UCI long algebraic notation:
  `e2e4`, `e7e8q` (promotion piece lower-case), castling as king move `e1g1`, `e1c1`, `e8g8`, `e8c8`.
* All text is UTF-8 (in practice ASCII).
* "Centipawns" (cp): 100 = one pawn.
* `i32`/`f64` refer to WebAssembly value types. Pointers are `i32` byte offsets into the exported memory.

## Required exports

| Export | Signature | Meaning |
|---|---|---|
| `memory` | `WebAssembly.Memory` | The engine's linear memory (exported by default by AssemblyScript). |
| `cb_abi_version` | `() -> i32` | Must return `1`. |
| `cb_init` | `() -> void` | Called exactly once after instantiation, before any other `cb_*` call. Allocate tables here. |
| `cb_in` | `() -> i32` | Pointer to the **input buffer** (host → engine). Capacity ≥ 65536 bytes. |
| `cb_out` | `() -> i32` | Pointer to the **output buffer** (engine → host). Capacity ≥ 65536 bytes. |
| `cb_new_game` | `() -> void` | Forget everything game-specific (clear hash table, history tables...). |
| `cb_position` | `(len: i32) -> i32` | The host has written `len` bytes into the input buffer: either `startpos [moves m1 m2 ...]` or `fen <6-field FEN> [moves m1 m2 ...]` (exactly the arguments of the UCI `position` command). Returns `1` on success, `0` on parse error / illegal move. |
| `cb_go` | `(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32) -> i32` | Search the current position. Writes the best move (UCI, e.g. `g1f3`) to the start of the output buffer and returns its byte length. Returns `0` when the side to move has no legal move. See *Search limits*. |

### Search limits (`cb_go`)

* `depth > 0` — do not start iterations deeper than `depth` plies.
* `nodes > 0` — stop once roughly `nodes` nodes have been searched.
* `movetime > 0` — spend at most `movetime` ms on this move.
* `wtime >= 0 && btime >= 0` — a game clock is running: remaining ms for White/Black,
  increments `winc`/`binc` ms per move, `movestogo > 0` moves until the next time control
  (0 = sudden death / increment only). The engine does its own time management.
  `wtime < 0` (and `btime < 0`) means "no clock".
* Limits combine: the search stops at the first one reached.
* If no limit is given at all (`depth<=0, nodes<=0, movetime<=0, wtime<0`) the search is
  **infinite**: it runs until the host requests a stop via `cb_should_stop`, or until the
  engine's maximum depth is reached. The host only issues infinite searches when it can
  signal stop (see below).
* The engine must always return a legal move if one exists — even when stopped after a
  few nodes (fall back to the first legal move).

## Required imports (module `"env"`)

| Import | Signature | Meaning |
|---|---|---|
| `cb_now` | `() -> f64` | Monotonic time in milliseconds (`performance.now()`). |
| `cb_should_stop` | `() -> i32` | Non-zero when the host wants the current search to end as soon as possible. Poll it together with the clock (e.g. every 1024–4096 nodes). |
| `cb_info` | `(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32) -> void` | Progress report, normally after each completed iteration. `score` is in centipawns **from the side to move's point of view** (UCI convention). If `mate != 0`, the score is a mate score and `mate` holds "mate in N moves" (positive = side to move mates, negative = side to move gets mated); `score` is then ignored. The principal variation is written as space-separated UCI moves at the start of the output buffer, `pvLen` bytes long. |
| `cb_log` | `(len: i32) -> void` | Free-form debug text, `len` bytes at the start of the output buffer. Shown in the engine console. |
| `abort` | `(msg: i32, file: i32, line: i32, col: i32) -> void` | AssemblyScript runtime abort (assertion / out-of-bounds). `msg` and `file` are AssemblyScript string pointers (UTF-16, byte length stored as `u32` at `ptr - 4`) or 0. The host turns this into a JS exception, which ends the current call. |

The host additionally provides, for AssemblyScript's standard library: `seed() -> f64`
(used by `Math.random`) and `trace(msg, n, a0..a4)`. For robustness the host inspects the
module's imports and supplies a harmless stub (returns 0, logs once) for any other function
import under `env`, so user engines never fail to instantiate because of a stray import.

## Optional exports

| Export | Signature | Meaning |
|---|---|---|
| `cb_eval` | `() -> i32` | Static evaluation of the current position in centipawns **from White's point of view**. Used by the editor's test panel. |
| `cb_eval_trace` | `() -> i32` | Evaluate the current position and write a breakdown to the output buffer; returns its byte length. Format: one line per term, `label\twhite\tblack\n`, where `white` is the term's contribution for White and `black` its contribution for Black, both in cp where positive is good for that side (so net White-POV contribution = white − black). Optional trailing line `total\t<white-pov total>\t0\n`. |
| `cb_perft` | `(depth: i32) -> f64` | Number of leaf nodes of the legal move tree of the given depth from the current position. |
| `cb_set_option` | `(len: i32) -> i32` | Input buffer holds `name=value` (e.g. `Hash=64`). Returns 1 if the option was recognised. Call before `cb_new_game`. Standard option: `Hash` (MiB). |
| `cb_nnue_alloc` | `(size: i32) -> i32` | Returns a pointer to a `size`-byte buffer into which the host copies an NNUE network file (see `NNUE_FORMAT.md`). |
| `cb_nnue_load` | `(size: i32) -> i32` | Parse/activate the network previously copied into the buffer. Returns 1 on success, 0 on failure. Engines that export these are "NNUE capable"; the host loads the engine's attached network right after `cb_init`. |
| `cb_name` | `() -> i32` | Writes a display name (e.g. `MyEngine 1.0 by Alice`) to the output buffer, returns length. |

## Call sequence used by the host

```
instantiate → cb_init() → [cb_set_option("Hash=N")] → [cb_nnue_alloc/cb_nnue_load]
→ cb_new_game()
→ loop: cb_position(...) → cb_go(...)  (cb_info/cb_log callbacks arrive during the call)
```

The host never calls into the engine concurrently: each engine instance lives in its own
Web Worker and calls are serialized.

## Stopping a search

When the page is cross-origin isolated, the host shares an `Int32Array` over a
`SharedArrayBuffer` with the engine worker; `cb_should_stop` returns `Atomics.load(flag, 0)`.
The host sets the flag to stop an infinite analysis or to enforce a hard time limit.

If `SharedArrayBuffer` is unavailable, `cb_should_stop` always returns 0 and the host stops a
search by terminating the worker, taking the first move of the last reported PV as the
result, and transparently re-instantiating the engine.

## Robustness rules the host enforces

* Every move returned by an engine is validated against the real rules; an illegal move
  forfeits the game (Arena) or is reported as an error (Play).
* A hard deadline (allotted time + grace) is applied to every timed search; an engine that
  overruns it is stopped (and loses on time when a clock is running).
* A trap (`unreachable`, out-of-bounds, `abort`) is reported with the message and the
  engine instance is re-created.
