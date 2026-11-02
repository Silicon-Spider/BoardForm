# From scratch

A **Scratch** engine is entirely yours: none of the template is used, only the files you write. It is the way to learn how a chess engine works from the inside — board representation, move generation, search, evaluation, time management — by building one.

## The two starting points

Choose **From scratch** in the **New engine** wizard on the [Engines](#/engines) page, then pick a starting point:

| Starting point | What you get |
| --- | --- |
| **Minimal working engine** | The code the starter engine **Sprout** begins with: a complete engine in one file of about 1 200 commented lines. A 0x88 board, Zobrist keys, FEN parsing, move generation with castling, en passant and promotions, perft, material and piece-square tables, and an alpha-beta search with iterative deepening, quiescence, MVV-LVA ordering, killer moves and time control. |
| **Empty skeleton** | Every function the app calls already exists and the text plumbing is done — reading commands, writing moves, logging, progress reports — but `cb_go` answers "no move". A step-by-step roadmap in the comments tells you what to build next. |

The minimal engine is deliberately simple — no transposition table, no pruning tricks — so it is easy to read and plays clearly weaker than the template engine. Its header lists the improvements that help most, in order.

> **Note** An engine built from the empty skeleton can't play yet: it returns "no move" for every position and writes a TODO line to the engine console. The Test panel's **Search** then says *The engine produced no move*, and in a game the engine loses for producing no move — Chess Builder never mistakes it for checkmate or stalemate.

You can split your engine into several files (**File** → **New file…** in the Workshop) and import between them with `import { ... } from "./board";`. Compilation starts at the entry file, `main.ts`.

## What the app needs from your engine

Your engine is a WebAssembly module that follows the [Engine ABI](#/help/abi). In short:

| You export | The app uses it to … |
| --- | --- |
| `cb_abi_version()` | Check the ABI version — return `1`. |
| `cb_init()` | Initialise once after loading: build tables here. |
| `cb_in()`, `cb_out()` | Find your input and output buffers (at least 64 KiB each). |
| `cb_new_game()` | Start a new game: clear anything learned in the previous one. |
| `cb_position(len)` | Set up a position; return 1 if it was valid, 0 if not. |
| `cb_go(depth, nodes, movetime, wtime, btime, winc, binc, movestogo)` | Search and write the best move; return its length in bytes, or 0 only when there is no legal move. |

And you may call the app's functions `cb_now()` (the time in ms), `cb_should_stop()` (non-zero when you must stop), `cb_info(...)` (progress after each depth) and `cb_log(len)` (a line for the engine console). Optional exports such as `cb_perft`, `cb_eval` and `cb_eval_trace` switch on the matching tools of the Workshop's **Test** panel.

## How text gets in and out

Only numbers cross the boundary between the app and WebAssembly, so text travels through two byte buffers inside your engine's own memory:

- The app writes a command such as `startpos moves e2e4 e7e5` into the **input** buffer and calls `cb_position(len)` with its length.
- You write your answer — a move like `g1f3` — at the start of the **output** buffer and return its length.

The skeleton has helpers for both directions: `readInput(len)` returns the command as a string, `writeOutput(text)` writes UTF-8 text and returns its length, `log(text)` prints a line in the engine console, and `sendInfo(...)` reports a finished search depth. Moves use UCI notation: `e2e4`, `e7e8q` for a promotion, and the king's move for castling (`e1g1`, `e1c1`, `e8g8`, `e8c8`).

## From the empty skeleton to a working engine

The skeleton's roadmap, step by step. Test after every step.

### 1. Board and FEN

Choose a board representation — an array of 64 squares (a1 = 0 … h8 = 63) holding piece codes is a fine start — plus the side to move, castling rights, the en-passant square and the move counters. Then make `cb_position` understand its two forms:

```text
startpos [moves e2e4 e7e5 ...]
fen <six FEN fields> [moves ...]
```

```ts
export function cb_position(len: i32): i32 {
  const words = readInput(len).split(" ");
  // words[0] is "startpos" or "fen"; a FEN takes the next six words.
  // Then, after "moves", play each move with your makeMove() ...
  // Return 0 for a bad FEN or an illegal move, so the app knows something is wrong.
  return 1;
}
```

### 2. Move generation

Generate every legal move: pawn pushes and captures, double pushes, en passant, promotions to all four pieces, castling (not out of, through or into check), and no move that leaves your own king in check. This is where most bugs hide, so uncomment `cb_perft` and use [perft](#testing-with-perft) before going on.

### 3. Play a move

Make `cb_go` write the first legal move. From now on your engine plays complete games — badly:

```ts
export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  const count = generateLegalMoves(); // your move generator
  if (count == 0) return 0; // no legal move: checkmate or stalemate
  return writeOutput(moveToUci(firstMove())); // your helpers: write e.g. "g1f3", return its length
}
```

Return 0 **only** when the side to move has no legal move. A move that isn't legal — or no move while legal moves exist — loses the game, on the Play page and in the Arena.

### 4. Evaluation

Count material — pawn 100, knight 320, bishop 330, rook 500, queen 900 — then add piece-square tables. Return the score in centipawns **from White's point of view**, and uncomment `cb_eval` so the Test panel can show it.

### 5. Search

Search the moves with negamax alpha-beta, using iterative deepening (depth 1, 2, 3 …), a quiescence search over captures, and move ordering (best move of the previous iteration first, then captures). Report every finished depth with `sendInfo()` so you can watch your engine think. The heart of it looks like this:

```ts
function negamax(depth: i32, alpha: i32, beta: i32, ply: i32): i32 {
  if (depth == 0) return quiescence(alpha, beta, ply);
  nodes++;
  if ((nodes & 1023) == 0 && stopNow(deadline)) stopped = true;
  if (stopped) return 0; // unwind: the result of this iteration is thrown away
  const count = generateLegalMoves(ply);
  if (count == 0) return inCheck() ? -MATE + ply : 0; // checkmate (sooner = worse) or stalemate
  for (let i = 0; i < count; i++) {
    makeMove(moveAt(ply, i));
    const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
    unmakeMove();
    if (stopped) return 0;
    if (score >= beta) return beta; // the opponent will never allow this line
    if (score > alpha) alpha = score;
  }
  return alpha;
}
```

Inside the search, scores are from the point of view of the side to move: flip your White-POV evaluation for Black.

### 6. Limits and stopping

`cb_go` gets every limit at once; stop at whichever is reached first:

| Argument | Meaning |
| --- | --- |
| `depth > 0` | Don't start iterations deeper than this many plies. |
| `nodes > 0` | Stop after about this many positions (a `f64`). |
| `movetime > 0` | Use at most this many milliseconds. |
| `wtime >= 0 && btime >= 0` | A clock is running: time left for White and Black, increments `winc` / `binc`, and `movestogo` moves to the next time control (0 = the rest of the game). You decide how much to spend. |
| none of these | Infinite analysis: search until `cb_should_stop()` says stop. |

```ts
const startTime = cb_now();
let deadline: f64 = Infinity;
if (movetime > 0) deadline = startTime + <f64>movetime;
if (wtime >= 0 && btime >= 0) {
  const left = <f64>(side == 0 ? wtime : btime);
  const inc = <f64>(side == 0 ? winc : binc);
  deadline = Math.min(deadline, startTime + left / 30 + inc * 0.75); // a simple budget
}
```

Check the clock and `cb_should_stop()` every thousand nodes or so — the skeleton's `stopNow(deadline)` does both — and always return the best move of the last finished depth. When stopped before depth 1 finishes, fall back to the first legal move.

### 7. Optional extras

Uncomment the optional exports in the skeleton when you have what they need: `cb_eval` (static evaluation), `cb_eval_trace` (the evaluation breakdown, one `label\twhite\tblack` line per term), `cb_perft` and `cb_set_option` (for example `Hash=64` for a transposition table). Change `cb_name` to give your engine its name.

## Testing with perft

*Perft* counts the leaf nodes of the legal move tree to a given depth. The counts for well-known positions are published, so a single wrong number proves a bug in move generation or in making and unmaking moves. The Test panel's **Perft** tool does two things:

- **Run perft** counts from the position on the board, to the depth you choose, and shows the reference count when the position is a known one.
- **Check move generation** runs perft 1, 2, 3 … up to the depth you choose on six reference positions and marks every count that doesn't match.

The reference positions and their counts at depths 1 to 5:

| Position | Depth 1 | Depth 2 | Depth 3 | Depth 4 | Depth 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Start position | 20 | 400 | 8 902 | 197 281 | 4 865 609 |
| Kiwipete | 48 | 2 039 | 97 862 | 4 085 603 | 193 690 690 |
| Position 3 | 14 | 191 | 2 812 | 43 238 | 674 624 |
| Position 4 | 6 | 264 | 9 467 | 422 333 | 15 833 292 |
| Position 5 | 44 | 1 486 | 62 379 | 2 103 487 | 89 941 194 |
| Position 6 | 46 | 2 079 | 89 890 | 3 894 594 | 164 075 551 |

Their FENs, to paste into the Test panel's position box:

- **Start position:** `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`
- **Kiwipete:** `r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1`
- **Position 3:** `8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1`
- **Position 4:** `r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1`
- **Position 5:** `rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8`
- **Position 6:** `r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10`

Kiwipete is full of castling, en passant and promotion traps; position 3 catches en-passant captures that would expose the king; positions 4 and 5 test promotions and castling rights.

When a count is wrong, narrow it down: play one move on the board, run perft one level shallower, and compare with a correct engine such as **Classic** on the same position. The move whose subtree differs leads you to the bug. Typical culprits are castling rights after a rook is captured, castling through an attacked square, en passant, and under-promotions.

## Debugging

- `log("...")` prints to the engine console — the most useful debugging tool there is.
- An out-of-range array index or a failed `assert` stops the engine with an error message, and the app restarts the engine. Integer division by zero does the same.
- The compiler only checks code that is used: a function nobody calls yet can hide mistakes until you call it.
- The [AssemblyScript tips](#/help/eval-api?section=assemblyscript-for-typescript-users) cover the differences from TypeScript that trip people up most.

## Making the minimal engine stronger

Sprout's header suggests these improvements, roughly in order of how much they help:

1. a transposition table (its Zobrist keys are ready for one),
2. null-move pruning and late move reductions,
3. more evaluation: pawn structure, mobility, king safety, the bishop pair,
4. the history heuristic for ordering quiet moves.

[Full engine code](#/help/full-engine?section=how-the-search-works) describes how the template engine does each of them, and [the Arena](#/help/play-and-arena) tells you whether your version helped.
