# NNUE networks

Instead of writing evaluation rules by hand, you can let an engine **learn** them. BoardForm trains small neural networks of the NNUE kind — the technique behind today's strongest engines — from games your engines play against themselves. You can watch the training live, let it run in the background, and keep improving a network over many sessions.

## What NNUE is

NNUE stands for *efficiently updatable neural network*. The network looks at every piece on the board and outputs a score; nobody tells it that knights like the centre or that passed pawns are dangerous — it learns that from data.

The "efficiently updatable" part is the trick that makes it fast enough for a search: the first layer is just a sum of one weight row per piece, so when a move changes two or three pieces the sum can be updated instead of recomputed. (BoardForm's engine recomputes the sums at every evaluation, using SIMD to stay fast. Updating them incrementally is a great [Full engine code](#/help/full-engine?section=ideas-to-try) project.)

## The network

Every BoardForm network has the shape **(768 → HL) × 2 → 1**:

- **768 inputs:** one for every combination of colour (2), piece type (6) and square (64). A position switches on one input per piece on the board.
- **A hidden layer of HL neurons, seen from both sides.** The inputs are numbered twice — from White's point of view and from Black's, each time "own pieces first", with the board flipped for Black. Both perspectives share the same weights and produce two *accumulators* of HL numbers each.
- **An activation:** **CReLU** clamps every value to 0…1; **SCReLU** clamps and then squares it (the default).
- **One output:** a weighted sum of both accumulators — the side to move's first — plus a bias. Multiplied by 400 it is the evaluation in centipawns, from the side to move's point of view.

The hidden size HL can be any multiple of 8 from 8 to 2048; the Lab offers 16, 32, 64, 128, 256 and 512 (default 128). Bigger networks can learn more but evaluate and train more slowly. A network has `771 × HL + 1` parameters — 98 689 for HL = 128 — and its file is `68 + 1542 × HL` bytes (197 444 bytes for HL = 128).

Inside the engine the weights are stored as integers (*quantized*), and the app computes exactly the same integer result in JavaScript, so a network scores a position identically everywhere.

## Training data

A network learns from **positions with known outcomes**. BoardForm makes them with *self-play*: an engine plays many games against itself, starting each game with a few random moves so the games differ. For every position it records:

- the **search score** the engine found (White's point of view), and
- the **result** of the game (White won, draw, Black won).

Positions that would teach the wrong thing are skipped: positions in check, positions where the move played was a capture or promotion, scores of ±3000 or more, and the first few moves of each game. The network is trained to predict a blend of both signals: `λ × sigmoid(score / 400) + (1 − λ) × result`, where λ — the *eval weight* — is 0.75 by default.

Positions are stored compactly (32 bytes each) in **datasets**, in chunks of 16 384 positions.

> **Note** The app comes with a **starter network** (HL = 128, SCReLU) and the engine **Neuron** that plays it. It was trained on 5 million positions from self-play of the stock hand-crafted evaluation, and plays about as strong as Classic. Pick it as the starting point of a run to **continue** training it or to **widen** it.

## The NNUE Lab

The [NNUE Lab](#/lab) has four sections: **Overview**, [Runs](#/lab/runs), [Networks](#/lab/networks) and [Datasets](#/lab/datasets).

### Datasets

A dataset is a collection of training positions. On the Datasets page you can:

- **Generate dataset** with self-play. Choose **who plays** — one of your engines, or an NNUE network inside the stock engine — and its search limits (a node limit such as 5 000 is typical), then the number of **games**, the **workers** that play in parallel, the **random opening plies**, the **max plies per game** (longer games count as draws) and how many opening plies to **skip**. **Save to** a new dataset or add the games to an existing one. Generation runs in the background with live progress and can be stopped at any time.
- **Import** positions from a file — the binary `.cbds` format or a text file with one `FEN | score | result` line per position — and **Export .cbds**.
- Tick several datasets to **Merge** them into one (the originals are kept) or to **train a network on them**.
- Open a dataset to see its statistics, **sample positions** with their scores and results, where it came from, and which runs use it. **Add more games…** extends it with more self-play.

### Training runs

A training run turns datasets into a network. **New training run** opens a wizard with five steps:

1. **Network** — *Train a new network* (hidden size and activation), *Continue training a network* or *Widen a network* (see [below](#continue-or-widen-a-network)).
2. **Data** — existing datasets, fresh **self-play games** generated before training (about 100 training positions per game), or both.
3. **Training** — a preset (**Quick test**, **Balanced**, **Long run**) or custom settings: epochs (passes over the data), batch size (positions per optimizer step), learning rate and its schedule (**Constant**, **Step** or **Cosine**), *what the network learns* — a slider between game results only and search scores only, the eval weight λ — plus weight decay, the validation split, training threads and a seed.
4. **Loop & publishing** — the [reinforcement loop and gating](#the-reinforcement-loop-and-gating), **Publish an engine** (an NNUE engine that always uses the run's newest network, ready to play or to enter in the Arena) and **Keep training when I reopen the app**.
5. **Review** — a name and a summary.

All along, the wizard shows an **estimate per cycle** — positions, steps per epoch, optimizer steps and parameters — and warns about settings that won't work well, most often too few optimizer steps (see [Practical guidance](#practical-guidance)).

### Continue or widen a network

- **Continue training** trains an existing network further, with its saved full-precision weights and optimizer state — on new data, or for more epochs.
- **Widen** grows a network to a larger hidden size. The new neurons start with output weights of zero, so the widened network plays exactly like the old one until it is trained — nothing learned is lost.

Both are on every network's menu on the Networks page, and a run's page offers **Continue training the newest network** and **Widen the newest network**.

### The reinforcement loop and gating

With **Repeat self-play and training**, a run works in cycles — a number of them, or **until I stop it**. Turn on **Self-play with the newest network after the first cycle** and better play makes better data, which makes a better network. **Data kept for training** decides whether each cycle trains on the games of all cycles or only the newest ones.

With **gating** (*Only keep networks that play at least as well*), every new network first plays a short match against the previous one — you set the number of games, the search limits and the **minimum score** — and it is only kept if it reaches that score. 50 % means "not worse"; higher is stricter. That keeps a bad cycle from making things worse.

### Watching training

A run's page shows what it is doing — self-play, training or evaluating — and how far it has got: live progress with the self-play games as they are played, **training curves** of the training and validation loss, the **networks** each cycle produced (with their gating results), **sample evaluations** of a few positions, the run's settings and a log. Lower loss is better; when the validation loss starts rising while the training loss keeps falling, the network has begun to memorise its data (*overfitting*).

### Running in the background

Training and dataset generation are not tied to the Lab page: switch to another page — play a game, run a match — and they keep going. The header shows how many jobs are running; click it to see their progress.

Browsers can't run anything once the tab is closed, so runs save checkpoints to the database as they go (self-play games at least every 10 seconds, training checkpoints at least every 20); a run cut off by a closed tab repeats at most that much work. **Pause** saves a checkpoint and stops the workers; **Stop** ends the run now and keeps the best network so far. Runs with **Keep training when I reopen the app** switched on start again by themselves when you reopen BoardForm; others are marked as interrupted and wait for you. If you open the app in several tabs, only one of them runs a given job.

How many workers may run at once — self-play workers, Arena games played at the same time and trainer threads — is set under **Background workers** in [Settings](#/settings?section=engines).

## Using a network in an engine

An **NNUE** engine is the stock template engine with an `eval.ts` that asks the attached network for its score, plus the network itself. Create one with **Create an engine** on a network's menu in the Lab, or choose **NNUE** in the **New engine** wizard on the [Engines](#/engines) page and pick a network (now or later). To switch networks, use **NNUE network** on the engine's **Settings** tab in the Workshop.

In the Workshop's **Evaluate** tool an NNUE engine reports a single breakdown term, **NNUE**, shown on the side the network favours.

> **Warning** If the breakdown shows **Fallback (no network)** instead, no network is loaded — none is attached to the engine, or the engine rejected the file (the engine console says why) — and the engine is evaluating with a simple material-and-tables fallback. Attach a network to the engine. If an engine's network has been deleted, the engine doesn't start at all and tells you to choose another network.

The NNUE `eval.ts` is editable, so you can add hand-written terms on top of the network. A complete example:

```ts eval
import { Position } from "./position";
import { WHITE, BLACK } from "./types";
import { material, bishopPair } from "./evalkit";
import { nnueReady, nnueEvaluate } from "./nnue";
import { tracing, traceTerm } from "./trace";

const BISHOP_PAIR_BONUS: i32 = 20;

export function evaluate(pos: Position): i32 {
  if (!nnueReady()) {
    // No network loaded yet: count material, so the engine still plays sensibly.
    const w = material(pos, WHITE, 100, 320, 330, 500, 900);
    const b = material(pos, BLACK, 100, 320, 330, 500, 900);
    if (tracing) traceTerm("Fallback (no network)", w, b);
    return w - b;
  }

  const stm = nnueEvaluate(pos); // the network's score, from the side to move's point of view ...
  const network = pos.side == WHITE ? stm : -stm; // ... turned into White's point of view
  if (tracing) traceTerm("NNUE", network > 0 ? network : 0, network < 0 ? -network : 0);

  // Your own term on top of the network.
  const pairW = bishopPair(pos, WHITE) ? BISHOP_PAIR_BONUS : 0;
  const pairB = bishopPair(pos, BLACK) ? BISHOP_PAIR_BONUS : 0;
  if (tracing) traceTerm("bishop pair", pairW, pairB);

  return network + pairW - pairB;
}
```

`nnueEvaluate` returns the side to move's point of view, so the code turns it into White's, as [`evaluate` must](#/help/eval-api?section=the-contract). NNUE evaluations are clamped to ±30999 so they can never look like a mate.

## Practical guidance

These rules of thumb come from measurements with the in-browser trainer:

- **Keep the best epoch, not the last.** Small datasets overfit after a few epochs; the checkpoint with the lowest validation loss is the one worth publishing.
- **Give it enough optimizer steps.** `steps = ceil(training positions / batch size) × epochs`. Below about 1000 steps a network barely learns. With 50 000 positions (47 500 after the 5 % validation split) a batch of 4096 gives only 12 steps per epoch — 120 in 10 epochs. A batch of 1024 and 25 epochs gives 1 175.
- **Data matters most.** A network needs a few hundred thousand positions before it beats the simple material-and-tables fallback, and millions to compete with the hand-crafted evaluation of Classic. (For scale: the fallback itself scores only about 35 % against the hand-crafted evaluation at 10 000 nodes per move.)
- **Self-play speed.** With the template engine at 5000 nodes per move, each worker plays roughly 150 positions per second, of which about 70 % pass the filters; games average about 137 plies. So 300 000 training positions take roughly 12 minutes with four workers.
- **Start small and grow.** Train HL 32–128 first, then widen a good network instead of starting over.
- **Close the loop.** Once a network beats the fallback, use it for self-play in a reinforcement run with gating.

## Files

| File | What it is |
| --- | --- |
| `.nnue` | A network in the CBNN format — what engines load. **Export .nnue** to back a network up or use it elsewhere; **Import .nnue** on the Networks page to use one here (its full-precision weights are reconstructed from the integers, so you can keep training it). |
| `.cbds` | A dataset of packed positions. |
| text | One position per line: `<FEN> \| <score> \| <result>`, with the score in centipawns from White's point of view and the result `1.0`, `0.5` or `0.0` (White won, draw, Black won). |

The exact formats are part of the reference below.

<!-- include: NNUE_FORMAT.md title="Reference: network and data formats" -->
