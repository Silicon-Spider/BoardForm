# Getting started

Chess Builder is a workshop for chess engines. You build an engine — by snapping blocks together, by writing code, or by training a neural network — and Chess Builder compiles it to WebAssembly right here in your browser. Then you play against it, analyse with it, and pit it against other engines to see whether your ideas make it stronger.

Nothing needs to be installed and nothing is uploaded: the compiler, the engines and the training all run on your computer, inside this browser tab.

## The starter engines

The first time you open Chess Builder, three engines are waiting on the [Engines](#/engines) page. Each one shows a different way of building an engine:

| Engine | Kind | What it shows |
| --- | --- | --- |
| **Blocky** | Blocks | An evaluation made of drag-and-drop blocks: material, piece-square tables, mobility, the bishop pair, passed pawns, a pawn on the 7th rank, pawn structure, rooks on open files, king safety and a bonus for having the move. Every number and every dropdown can be changed. |
| **Classic** | Eval code | The stock search with a classic tapered evaluation written in code (`eval.ts`). Edit the evaluation and leave the rest to the template. |
| **Sprout** | Scratch | A small engine in a single file, written from scratch to be read and changed: a 0x88 board, alpha-beta search, quiescence search and time control. |

> **Note** Sprout is deliberately simple — it has no transposition table and no pruning tricks — so it plays much weaker than Blocky and Classic. That makes it a good sparring partner and a good place to learn.

The starter engines are ordinary engines: change them, duplicate them or delete them. If you delete them, **Restore starter engines** in [Settings](#/settings) adds fresh copies. Before you experiment, **Duplicate** the engine you start from: the unchanged original is the opponent that tells you whether your change helped.

## Ways to build an engine

Click **New engine** on the [Engines](#/engines) page and choose how you want to build it. Every engine has a *kind*, shown as a coloured badge on its card, and the kind decides what you can edit:

| Kind | You edit | The rest comes from | Learn more |
| --- | --- | --- | --- |
| **Blocks** | The evaluation, as drag-and-drop blocks | The stock template engine | [Blocks editor](#/help/blocks) |
| **Eval code** | `eval.ts`, the evaluation function in AssemblyScript | The stock template engine | [Evaluation code](#/help/eval-api) |
| **Full code** | Every file of the engine: search, move generation, time management … | Nothing — it is your own copy | [Full engine code](#/help/full-engine) |
| **Scratch** | Your own engine: start from a small working engine or from an empty skeleton | Nothing at all | [From scratch](#/help/scratch) |
| **NNUE** | A neural network you train in the NNUE Lab (and optionally `eval.ts`) | The stock template engine | [NNUE networks](#/help/nnue) |
| **WASM** | Nothing in the app: you upload a compiled `.wasm` file, for example written in C, Rust or Zig | Your own toolchain | [Engine ABI](#/help/abi) |

All engines that you build inside the app are written in **AssemblyScript**, a language that looks like TypeScript and compiles to WebAssembly. You don't need to know it to use the Blocks editor; the [Evaluation code](#/help/eval-api?section=assemblyscript-for-typescript-users) topic explains what is different from TypeScript when you start writing code.

> **Tip** Not sure where to start? Open **Blocky**, change a bonus, and play a game against the old version. That one loop teaches you most of the app.

## The build, test, play, match loop

Improving an engine is a cycle. Chess Builder has a place for every step:

1. **Build.** Open an engine to edit it in the Workshop. **Build** (<kbd>Ctrl</kbd>+<kbd>B</kbd>, or <kbd>⌘</kbd>+<kbd>B</kbd> on a Mac) compiles its AssemblyScript to WebAssembly right in the browser — and whenever you test or play an engine whose code has changed, it is compiled automatically. The very first build loads the compiler and takes a few seconds; after that builds are quick. Compile errors in the **Build log** point to the file, line and column.
2. **Test.** The Workshop's **Test** panel works on any position you set up: **Evaluate** shows the static evaluation and its breakdown term by term, **Search** lets you watch the engine think, **Perft** checks move generation, **Bench** measures speed and **Console** shows what the engine logs.
3. **Play.** On the [Play](#/play) page you play against your engine, let two engines play each other, or analyse a position or game with an engine.
4. **Match.** In the [Arena](#/arena) your engines play many games against each other. The standings tell you, with an Elo estimate and its error margin, whether a change really helped.

Then go back to step 1. Small changes, measured with real games, are how engines get strong.

## Where things are

The bar at the top of the window takes you to every part of the app:

| Page | What you do there |
| --- | --- |
| [Engines](#/engines) | Your engine library: create, duplicate, import, export and delete engines. Click an engine to open it in the Workshop. |
| **Workshop** | Opens when you open an engine: the editor (blocks or code), the **Test** panel, the build log and the engine's settings. **Play** and **Match** buttons take the engine straight to a game or an Arena match. |
| [Play](#/play) | You against an engine, engine against engine, analysis, and your saved games. |
| [Arena](#/arena) | Matches and tournaments between engines, with live boards, standings and Elo. |
| [NNUE Lab](#/lab) | Datasets of positions, training runs (including self-play) and your networks. |
| [Settings](#/settings) | Theme and board appearance, engine defaults such as the hash size, how much background work may run at once, backups and your data. |
| [Help](#/help) | This documentation. Press <kbd>/</kbd> to search it. |

## Everything is saved in this browser

Chess Builder saves as you go: engines, blocks, code, networks, datasets, games, matches and training runs are stored in your browser's database (IndexedDB) the moment they change. Close the tab, reopen it tomorrow, and everything is still there — including training runs, which can resume where they stopped.

Your data stays in *this* browser on *this* computer. It is not synced between browsers or devices, and clearing your browser's site data deletes it. Export a backup from [Settings](#/settings) now and then; [Saving and backups](#/help/storage) explains the details.

## What to read next

- [Blocks editor](#/help/blocks) — change Blocky without writing code.
- [Evaluation code](#/help/eval-api) — write your own `evaluate()` function.
- [Play and the Arena](#/help/play-and-arena) — play your engine and measure its strength.
- [NNUE networks](#/help/nnue) — train a neural network with self-play.
