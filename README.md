# BoardForm

Build your own chess engine — a hand-crafted evaluation (HCE) or a trained NNUE — in an easy, simple
coding interface, right in your browser.

BoardForm compiles every engine to **WebAssembly** in the browser. Build one by snapping blocks
together, by writing just the evaluation function, by editing the whole engine, or by starting from
an empty file. Train neural networks with self-play and watch them learn. Then play your engines,
or let them play each other. Everything is saved in the browser, so your work is still there when
you close the tab and come back.

## What you can do

**Build an engine**

- **Blocks**: drag and drop evaluation rules, for example *"+1 for every pawn on the 7th rank"*.
  Every piece, square, rank and number in a block can be changed. BoardForm turns the blocks into
  AssemblyScript and shows you the generated code.
- **Eval code**: keep the stock search (alpha-beta with PVS, transposition table, null move,
  LMR, quiescence…) and write only `eval.ts`. A documented evaluation API (`evalkit`) helps with
  material, piece-square tables, mobility, pawn structure and more.
- **Full engine**: unlock every file of the template (search, move generation, time management,
  NNUE inference) and change anything.
- **From scratch**: start from a minimal single-file engine, or from an empty skeleton that only
  speaks the [engine ABI](docs/ENGINE_ABI.md).
- **Upload a `.wasm` file** built with any language that targets WebAssembly and implements the ABI
  (a small WASI shim is included).

The **Workshop** has a code editor with autocompletion and inline compiler errors, a build log, and
a test bench: evaluate a position with a term-by-term breakdown, run a search, perft and a
move-generation check.

**Train an NNUE network** in the **NNUE Lab**

- Generate datasets by self-play with any of your engines, or import them (`.cbds` binary or
  `fen | score | result` text).
- Train a new network (768 → HL) × 2 → 1 with CReLU or SCReLU, continue training an existing one,
  or widen it to a larger hidden size.
- Watch the training live: loss charts, self-play boards, sample evaluations, gating matches
  between generations. Pause, resume, or let a loop (self-play → train → gate) run in the
  background, and resume it automatically the next time you open the app.

**Play**

- Play against any engine, or watch two engines play, with clocks (increment, moves per control),
  or a fixed time, depth or node limit per move.
- Analyse positions with infinite analysis, load FENs and PGNs, review saved games with an eval
  graph.
- Run **Arena** matches and tournaments (round robin or gauntlet) between your engines, with
  opening books, adjudication, a crosstable, Elo estimates and PGN export.

**Keep your work**

All engines, networks, datasets, games and matches are stored in the browser (IndexedDB). Export a
single engine to share it, or back up everything to one file and restore it elsewhere.

## Starter engines

A fresh install comes with four engines to play against and learn from:

| Engine      | Kind      | What it shows                                                                              |
| ----------- | --------- | ------------------------------------------------------------------------------------------ |
| **Blocky**  | Blocks    | A complete evaluation made of blocks: material, PSTs, mobility, passed pawns and more.      |
| **Classic** | Eval code | The stock search with a classic tapered evaluation in `eval.ts`.                            |
| **Sprout**  | Scratch   | A small single-file engine (0x88 board, alpha-beta, quiescence) written to be read.          |
| **Neuron**  | NNUE      | The stock search with the starter network: HL 128, SCReLU, trained on 5M self-play positions. |

## Getting started

Requirements: [Node.js](https://nodejs.org) 20.19+ or 22.12+, and a recent desktop browser (BoardForm is
developed and tested in Chromium-based browsers such as Chrome and Edge).

```sh
npm install
npm run dev
```

Then open <http://localhost:5173>. The in-app **Help** pages explain every part of the app.

### Production build

```sh
npm run build     # type-checks, then writes the static site to dist/
npm run preview   # serves dist/ on http://localhost:4173
```

`dist/` is a static site and can be hosted anywhere. For instant engine stops and shared training
buffers, serve it with these headers (the dev and preview servers already send them):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the app still works, but stopping a search early restarts the engine's worker, which is slower.

## Tests

```sh
npm run typecheck     # TypeScript, strict
npm test              # unit tests (vitest)
npm run test:engine   # the AssemblyScript engine template in Node (perft, search, eval)
npm run test:scratch  # the from-scratch engine variants
npm run test:nnue     # NNUE inference: engine vs reference implementation, bit for bit
npm run test:all      # all of the above
npm run test:e2e      # end-to-end tests in headless Chromium (Playwright)
```

Before you run the e2e tests for the first time, install the browser with `npx playwright install chromium`.

## Project layout

| Path                                       | What                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `src/pages/`                               | The app's pages: engines, workshop, play, arena, lab, settings, help |
| `src/blocks/`                              | Block definitions, the Blockly editor and the code generator         |
| `src/compiler/`                            | The in-browser AssemblyScript compiler (runs in a worker)            |
| `src/engine-host/`                         | Loading, building and talking to engines (workers, ABI checks)       |
| `src/nnue/`                                | Network format, trainer (in workers), reference inference            |
| `src/training/`, `src/arena/`              | Background services: training runs and datasets, matches             |
| `src/storage/`                             | IndexedDB repositories, backups, cross-tab change events             |
| `engine/template/`                         | The engine template (AssemblyScript) that built engines start from   |
| `engine/variants/`                         | The from-scratch engines                                             |
| `docs/`                                    | Architecture and the normative specs                                 |

Specs: [Engine ABI](docs/ENGINE_ABI.md) · [Engine template](docs/ENGINE_TEMPLATE.md) ·
[NNUE format](docs/NNUE_FORMAT.md) · [Architecture](docs/ARCHITECTURE.md)

## Credits

BoardForm is built with [React](https://react.dev), [Vite](https://vite.dev),
[AssemblyScript](https://www.assemblyscript.org) and [Binaryen](https://github.com/WebAssembly/binaryen),
[Blockly](https://github.com/google/blockly), [CodeMirror](https://codemirror.net),
[chess.js](https://github.com/jhlywa/chess.js), [zustand](https://github.com/pmndrs/zustand),
[idb](https://github.com/jakearchibald/idb) and [marked](https://marked.js.org).
The piece set is [Chessnut](https://github.com/LexLuengas/chessnut-pieces) by Alexis Luengas
(Apache-2.0, see `public/pieces/chessnut/NOTICE.txt`). The template evaluation and the starter
blocks use Ronald Friederich's
[PeSTO](https://www.chessprogramming.org/PeSTO%27s_Evaluation_Function) piece-square tables.

## License

[GPL-3.0](LICENSE)
