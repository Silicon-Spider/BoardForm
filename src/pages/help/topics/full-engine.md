# Full engine code

A **Full code** engine has its own copy of every file of the template engine — the search, move generation, the transposition table, time management, the evaluation and the code that talks to the app. Change any of it, add files, or rewrite the search from the ground up.

> **Note** Blocks, Eval code and NNUE engines borrow every file except their evaluation from the *current* template, so they pick up improvements when the app is updated. A Full code engine keeps the snapshot it was created with: template updates never change your files.

If you only want to change how positions are judged, an [Eval code](#/help/eval-api) engine is simpler. Choose Full code when you want to change *how the engine thinks*.

There are two ways to get one: choose **Full engine code** in the **New engine** wizard on the [Engines](#/engines) page, or open an Eval code or NNUE engine in the Workshop and pick **Unlock the full engine source** from the **⋯** menu — that creates a new engine with every file of the template plus your `eval.ts`, and leaves the original untouched.

The Workshop shows a Full code engine's files on the left. The **File** menu creates files (**New file…**, use `/` for folders, such as `lib/pawns.ts`), renames them, sets the **entry file** the compiler starts from (normally `main.ts`), resets a file to the template's version and deletes files. The **API reference** tab lists every function of the template, with **Insert** for snippets.

## The file map

The template is a dozen AssemblyScript files. `main.ts` is the entry point the compiler starts from.

| File | What it contains | Change it to … |
| --- | --- | --- |
| `main.ts` | The `cb_*` functions the app calls ([Engine ABI](#/help/abi)) and the global `Position`. `cb_position` parses into a spare position and only swaps it in when everything parsed. | Rename your engine (`ENGINE_NAME`), add options to `cb_set_option`. |
| `io.ts` | The 64 KiB input and output buffers, text helpers (`outString`, `outInt`, `outMove`) and the host functions: `now()`, `shouldStop()`, `sendInfo()`, `logMessage()`. | Log debugging output to the engine console. |
| `types.ts` | Colours, piece types, squares `A1` … `H8`, the 16-bit move encoding, score constants (`MATE = 32000`, `MATE_BOUND = 31000`, `INFINITE = 32001`, `MAX_PLY = 128`). | Rarely — almost everything depends on it. |
| `bitboard.ts` | Masks, attack tables, magic bitboards for sliding pieces, geometry such as `betweenBB` and `passedPawnSpan`. | Add new masks or tables. |
| `position.ts` | The `Position` class: bitboards plus a square-by-square board, FEN, `makeMove` / `unmakeMove` with an undo stack, null moves, Zobrist keys, repetition and draw detection, `parseUci`. | Add incremental state (for example a running material count). |
| `movegen.ts` | Legal move generation (checks, pins, en passant, castling), `generateNoisy` for the quiescence search, and `perft`. | Only with [perft](#checking-correctness) at hand. |
| `tt.ts` | The transposition table: buckets of two 16-byte entries, replacement by depth and age. 16 MiB by default (the `Hash` option, up to 512 MiB). | Try other replacement schemes. |
| `search.ts` | `think()`: iterative deepening, aspiration windows, principal variation search, quiescence, move ordering, pruning and reductions, time management. | Most engine improvements happen here. |
| `evalkit.ts` | Evaluation helpers. The Blocks editor calls them by name, so keep their names and parameters (adding new helpers is fine). | Add helpers for new evaluation ideas. |
| `trace.ts` | The evaluation breakdown (`tracing`, `traceTerm`). | — |
| `eval.ts` | `evaluate(pos)`: the tapered hand-crafted evaluation. | See [Evaluation code](#/help/eval-api). |
| `nnue.ts` | Loading and evaluating NNUE networks with SIMD. | Incremental accumulator updates — a big speed-up. |

The files depend on each other roughly as `main.ts → search.ts → eval.ts → evalkit.ts → position.ts → bitboard.ts → types.ts`. The [reference](#/help/eval-api?section=reference-the-engine-template) lists every exported function.

## How a move is chosen

When the app wants a move it calls `cb_position(...)` with the game so far and then `cb_go(...)` with the limits. `cb_go` calls `think()` in `search.ts`:

1. **Limits.** `setupLimits` turns the depth, node, move-time and clock arguments into a node limit, a *soft* time limit (don't start another iteration) and a *hard* time limit (stop now).
2. **A move in hand.** The root moves are generated. If there are none the engine returns "no move" (checkmate or stalemate). Otherwise the first legal move — or the best move from an earlier search of this position — is kept as a fallback, so a legal move is returned even if the search is stopped at once.
3. **Iterative deepening.** The engine searches to depth 1, 2, 3 … Each finished iteration is reported to the app with `cb_info` (depth, score, nodes, time and the principal variation). The loop ends at the depth limit, when the soft time limit has passed, when the search is stopped, or — in a timed search — when a forced mate has been found that deeper searches can't improve.
4. **The answer.** The best move is written to the output buffer.

If time runs out halfway through an iteration, the engine keeps the best move found so far: the previous iteration's best move is searched first and only a move that proves better replaces it.

## How the search works

### Alpha-beta and PVS

The search is **negamax alpha-beta**: one function serves both sides by negating scores, and the window `[alpha, beta]` lets it skip moves that can't change the result — once a move is so good that the opponent will avoid the whole line (`score >= beta`), the remaining moves don't need searching. That is a *beta cutoff*.

On top of that sits **principal variation search** (PVS): the first move gets the full window; every other move is first searched with a null window `[alpha, alpha + 1]`, which only answers "is this better than what I have?". Only if it is, the move is searched again properly.

### Aspiration windows

From depth 4 on, an iteration starts with a narrow window of ±18 centipawns (`ASPIRATION_DELTA`) around the previous iteration's score. If the score falls outside, the window widens (doubling each time) and the iteration is repeated; beyond ±1000 it opens fully.

### Quiescence search

At depth 0 the engine doesn't evaluate straight away — that could happen in the middle of an exchange. Instead the **quiescence search** keeps playing captures and queen promotions until the position is quiet. The side to move may *stand pat* (accept the static evaluation) instead of capturing. Captures that cannot reach alpha even when winning the captured piece plus 200 cp are skipped (*delta pruning*), and so are captures that lose material according to static exchange evaluation. In check every evasion is searched.

### The transposition table

The same position is reached through different move orders and is searched again at every iteration. The transposition table (`tt.ts`) remembers, per Zobrist key, the best move, the score and its depth, whether the score is exact or only a bound (lower or upper), and the static evaluation. A stored result that is deep enough answers a node outright (outside the principal variation); otherwise its best move is searched first. Mate scores are stored relative to the node, so they stay correct at any ply.

### Move ordering

Alpha-beta prunes the most when the best move comes first. Moves are tried in this order:

1. the transposition-table move,
2. captures that win or keep material, most valuable victim first (MVV-LVA),
3. queen promotions,
4. two *killer* moves per ply — quiet moves that caused a cutoff in a sibling position,
5. other quiet moves, ordered by their *history* score (how often they caused cutoffs),
6. captures that lose material (judged by static exchange evaluation, `see()`),
7. under-promotions.

### Pruning and reductions

These skip or shorten parts of the tree that are very unlikely to matter. Reverse futility, null-move, late move, futility and SEE pruning are never used in principal-variation nodes or when in check, and a move that gives check is never pruned or reduced.

| Technique | When | Idea |
| --- | --- | --- |
| Mate distance pruning | every node except the root | No need to look for a longer mate than one already found. |
| Reverse futility pruning | non-PV, depth ≤ 7 | Already so far above beta (85 cp of margin per ply) that a shallow search won't drop below it. |
| Null-move pruning | non-PV, depth ≥ 3 | Let the opponent move twice; if we are still above beta, a real move will be too. Reduction `3 + depth / 4 + min((eval − beta) / 200, 3)`. Skipped without non-pawn material (zugzwang) and right after another null move. |
| Internal iterative reduction | depth ≥ 4 | A node without a hash move is probably unimportant: search it one ply shallower. |
| Late move pruning | non-PV, depth ≤ 4 | After enough quiet moves, skip the rest: `3 + depth²` of them, halved when the position isn't improving. |
| Futility pruning | non-PV, depth ≤ 6 | Skip quiet moves when the evaluation is at least `100 × depth + 50` below alpha. |
| SEE pruning | non-PV, depth ≤ 5 | Skip captures that lose more than `100 × depth` centipawns. |
| Late move reductions | depth ≥ 3 | Quiet moves late in the list (after the first two, or three in PV nodes) are first searched less deeply: more for non-PV nodes and positions that aren't improving, less for killers and moves with a good history. A move that turns out better than alpha is searched again at full depth. |
| Check extension | in check | Positions in check are searched one ply deeper. |

### Draws and mates

Repetitions (including positions from the game before the search started), insufficient material and the fifty-move rule score 0. A checkmate found `n` plies from the root scores `−(MATE − n)`, so shorter mates score higher; the app shows them as "mate in N".

### Time management

The engine manages its own clock (all times in milliseconds):

- **Time per move:** use it all, minus 5 ms. Unused time can't be saved for later.
- **Clock:** `available = remaining − 30` (the reserve for talking to the app). The plan is `available / movesToGo + 0.75 × increment`, where `movesToGo` is the number of moves to the next time control (at most 40) or 25 in sudden death, and never more than a quarter of `available`. That is the *soft* limit; the *hard* limit is three times the plan or 40 % of `available`, whichever is smaller.
- No new iteration starts after the soft limit. The hard limit, the app's stop request and the node limit are checked inside the search (the clock and the stop flag every 1024 nodes, the node limit at every node).

See [Search limits](#/help/limits) for how the app sets these limits.

## Tuning knobs

The constants at the top of `search.ts` are the easiest things to experiment with:

| Constant | Value | Meaning |
| --- | --- | --- |
| `ASPIRATION_DELTA` | 18 | Initial half-width of the aspiration window (cp). |
| `RFP_MAX_DEPTH` / `RFP_MARGIN` | 7 / 85 | Reverse futility pruning: maximum depth, margin per ply. |
| `NULL_MIN_DEPTH` | 3 | Null-move pruning from this depth on. |
| `LMP_MAX_DEPTH` | 4 | Late move pruning up to this depth. |
| `FUTILITY_MAX_DEPTH` / `FUTILITY_MARGIN` | 6 / 100 | Futility pruning: maximum depth, margin per ply. |
| `SEE_PRUNE_MAX_DEPTH` | 5 | Prune losing captures up to this depth. |
| `DELTA_MARGIN` | 200 | Quiescence delta-pruning margin. |
| `HISTORY_MAX` | 16384 | History scores stay within ±this value. |
| `MOVE_OVERHEAD` | 30 | Milliseconds kept in reserve on the clock. |

## Ideas to try

- **Tune a margin** — say `RFP_MARGIN` 70 or 100 — and measure it in the Arena.
- **Switch a technique off** (for example null-move pruning) to see how much it is worth.
- **Better time management:** spend more time when the best move keeps changing between iterations, and less when it is stable.
- **More move-ordering heuristics:** a counter-move table, or history that also depends on the previous move.
- **Extensions:** extend passed-pawn pushes to the 7th rank, or try singular extensions.
- **A pawn hash table** that caches pawn-structure terms by a pawn-only Zobrist key.
- **Incremental NNUE:** `nnue.ts` recomputes its accumulators at every evaluation; updating them in `makeMove` / `unmakeMove` instead makes NNUE engines much faster.

## Measuring a change

Engines are full of ideas that sound good and lose games. Measure everything:

1. **Duplicate the engine first** (**⋯** → **Duplicate** in the Workshop), so you have an unchanged baseline to play against.
2. **Run an Arena match** between the new and the old version — the Workshop's **Match** button starts one with this engine. Use an even number of games (colours alternate) and openings from the book or random opening moves, so the games differ.
3. **Choose the limits for what you changed.** With *fixed nodes* every engine searches the same number of positions per move: results don't depend on the computer's speed or load, which is ideal for evaluation changes — but a change that makes each node slower looks free. Anything that changes speed (incremental updates, a heavier evaluation, pruning) needs a *time control*. [Search limits](#/help/limits?section=choosing-fair-limits-for-matches) has more advice.
4. **Play enough games.** After 100 games the Elo estimate is typically good to about ±50–60; after 1000 games to about ±15–20. Trust a result once its error margin is smaller than the difference and the LOS is above 95% ([what these mean](#/help/play-and-arena?section=elo-and-los)).

## Checking correctness

- **After touching `movegen.ts` or `position.ts`,** open the Test panel's **Perft** tool and press **Check move generation**: it runs perft on six reference positions with known results, and every number must match. A single wrong number means a bug in move generation or in make/unmake. [From scratch](#/help/scratch?section=testing-with-perft) explains how to track it down.
- **After changing the search,** check its speed with **Bench** and watch the engine's games: the app checks every move it plays, so an illegal move shows up at once (it loses the game), and so does a crash.
- **Debug output:** `logMessage("...")` from `io.ts` prints a line in the Test panel's **Console** (and in the engine console on the Play page). It allocates, so keep it out of the search's hot paths.
