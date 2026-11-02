# Engine ABI and .wasm uploads

Every engine in Chess Builder is a WebAssembly module that implements one small interface, the **Chess Builder Engine ABI**. The engines you build in the app implement it in AssemblyScript (`main.ts` in the template, or your own [scratch](#/help/scratch) engine). But any language that compiles to `wasm32` — C, C++, Rust, Zig and others — can implement it too, and you can upload the result as a `.wasm` file: a **WASM** engine.

This page starts with a friendly overview and practical tips for uploading, followed by the complete specification.

## The ABI in one minute

- **Numbers only.** Every call between the app and your engine passes plain numbers. Text — positions, moves, the principal variation, log lines — travels through two byte buffers inside your engine's own memory: an input buffer (app → engine) and an output buffer (engine → app), at least 64 KiB each.
- **A fixed conversation.** The app calls `cb_init()` once, optionally sets options such as `Hash=64` with `cb_set_option` and loads an NNUE network, calls `cb_new_game()`, and then, for every move, `cb_position(...)` followed by `cb_go(...)`.
- **One call at a time.** Each engine instance runs in its own Web Worker and calls never overlap, so your engine needs no locking.
- **The app double-checks.** Every move your engine returns is validated against the rules, every timed search has a hard deadline, and a crash is reported and the engine restarted.

```text
app                                   your engine
 │  cb_init()                        ─►  build tables
 │  cb_set_option("Hash=64")         ─►  (optional)
 │  cb_new_game()                    ─►  forget the last game
 │  cb_position("startpos moves e2e4")─► set up the position
 │  cb_go(depth, nodes, movetime, …) ─►  search …
 │       ◄─ cb_info(...) after each depth, cb_log(...) for debug text
 │       ◄─ returns the length of "e7e5" written to the output buffer
```

## Uploading a .wasm engine

Click **New engine** on the [Engines](#/engines) page, choose **Upload .wasm** and drop your `.wasm` file. Before the engine is created, Chess Builder inspects the module and lists **errors** (the module can't be used as an engine) and **warnings** (it works, with something missing or worked around), along with the optional features it found.

A WASM engine opens in the Workshop on its **Module** view: its exports and imports, the inspection results, and **Replace module…** to upload a new build of your engine without losing its games and settings. If the module exports the NNUE functions you can attach a network there too.

### Exports checklist

| Export | Signature | Required |
| --- | --- | --- |
| `memory` | the module's linear memory | yes (a module that imports its memory instead works too, with a warning) |
| `cb_abi_version` | `() → i32`, returning `1` | yes |
| `cb_init` | `() → void` | yes |
| `cb_in`, `cb_out` | `() → i32` (buffer addresses) | yes |
| `cb_new_game` | `() → void` | yes |
| `cb_position` | `(i32) → i32` | yes |
| `cb_go` | `(i32, f64, i32, i32, i32, i32, i32, i32) → i32` | yes |
| `cb_eval` | `() → i32` | no — static evaluation in the Test panel |
| `cb_eval_trace` | `() → i32` | no — the evaluation breakdown |
| `cb_perft` | `(i32) → f64` | no — perft (an `i64` result is accepted too) |
| `cb_set_option` | `(i32) → i32` | no — options such as the hash size |
| `cb_nnue_alloc`, `cb_nnue_load` | `(i32) → i32` each | no — NNUE networks (export both or neither) |
| `cb_name` | `() → i32` | no — a self-reported engine name |

Signatures are checked:

- Parameters must be `i32`, `f32` or `f64`. **`i64` parameters are an error**: JavaScript can't pass them as plain numbers. Note that `nodes` in `cb_go` is an `f64`.
- A function that should return a value must return exactly one; multiple return values are not supported.
- A signature that differs only in compatible number types (say `i32` where the ABI says `f64`) is a warning: the values are converted, which may lose information.

### Stubbed imports

The app provides these functions under the import module `"env"`: `cb_now`, `cb_should_stop`, `cb_info`, `cb_log`, plus `abort`, `seed` and `trace` for AssemblyScript's standard library.

If your module imports **any other function** under `"env"` (or under a module that is neither `"env"` nor WASI), the app doesn't refuse it: it supplies a harmless **stub** that returns 0 and logs once, and the inspector warns *"Unknown import … the host provides a stub that returns 0."* That keeps a stray import from breaking your engine — but if your engine actually relies on that function, it won't work as intended, so treat these warnings as a to-do list. Imported globals and tables get an empty stand-in (with a warning); an imported exception tag is an error.

### WASI

Many toolchains target WASI by default (wasi-sdk for C/C++, Rust's `wasm32-wasip1`, Zig's `wasm32-wasi`, TinyGo). Chess Builder includes a small WASI preview 1 shim (`wasi_snapshot_preview1`, also `wasi_unstable`):

- **Works:** writing to stdout and stderr (each line appears in the engine console), clocks, random numbers, `sched_yield`, `proc_exit` (ends the current call), and empty arguments and environment variables.
- **Doesn't:** files and directories. Any other WASI function returns `ENOSYS`, with a warning.
- **Build a library ("reactor"), not a program ("command").** The app never runs `_start`, so a WASI command's `main` never executes and the inspector warns about it. If your toolchain needs initialisation code to run first, export `_initialize`: the app calls it before `cb_init`.

### Practical tips

- **Stop when asked.** Poll `cb_should_stop()` together with the clock every 1024–4096 nodes. When it returns non-zero, finish quickly with your best move so far. (If the browser can't share memory with the engine, the app stops a search by restarting the engine and takes the first move of your last reported principal variation — so report it with `cb_info` after every depth.)
- **Always return a legal move** when one exists, even if you were stopped after a few nodes.
- **Report progress** with `cb_info` after every finished depth: the score is from the side to move's point of view, and the principal variation goes at the start of the output buffer as space-separated UCI moves.
- **Keep the buffers fixed.** Allocate the input and output buffers once (static arrays are ideal); `cb_in()` and `cb_out()` must keep returning the same addresses.
- **Deadlines.** With a fixed time per move, the app intervenes after the time plus 100 ms plus 10 %; with a clock, after the remaining time plus 100 ms. It raises the stop flag first and terminates the engine one second later if it still hasn't answered. In a game with a clock, an engine that overruns loses on time.

### Language notes

These are typical starting points — check your toolchain's documentation for the details of your version.

**C / C++** (clang targeting `wasm32`): mark exports with `__attribute__((export_name("cb_go")))` and imports with `__attribute__((import_module("env"), import_name("cb_now")))`, and link a library without an entry point, for example `clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry -o engine.wasm engine.c`. The linker exports the memory as `memory` by default.

```c
#include <stdint.h>

__attribute__((import_module("env"), import_name("cb_now"))) double cb_now(void);
__attribute__((import_module("env"), import_name("cb_should_stop"))) int32_t cb_should_stop(void);

static uint8_t input[65536], output[65536];

__attribute__((export_name("cb_in"))) int32_t cb_in(void) { return (int32_t)(uintptr_t)input; }
__attribute__((export_name("cb_out"))) int32_t cb_out(void) { return (int32_t)(uintptr_t)output; }

__attribute__((export_name("cb_go")))
int32_t cb_go(int32_t depth, double nodes, int32_t movetime, int32_t wtime, int32_t btime,
              int32_t winc, int32_t binc, int32_t movestogo) {
  /* search, write the best move (e.g. "e2e4") to output[], return its length in bytes */
}
```

**Rust:** build a `cdylib` for `wasm32-unknown-unknown`, export functions with `#[no_mangle] pub extern "C" fn cb_go(depth: i32, nodes: f64, …) -> i32`, and declare the imports in an `extern "C"` block (they default to the `"env"` module). Use `i32` and `f64`, never `i64`, in exported signatures.

**Zig:** build for `wasm32-freestanding` without an entry point and with exported symbols kept (for recent Zig versions: `-fno-entry -rdynamic`), write the ABI functions as `export fn`, and declare the imports with `extern "env" fn cb_now() f64;`.

<!-- include: ENGINE_ABI.md title="The specification" -->
