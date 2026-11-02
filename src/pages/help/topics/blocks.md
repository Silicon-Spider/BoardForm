# Blocks editor

The Blocks editor lets you write an engine's *evaluation* — the part that looks at a position and decides who is better — by snapping blocks together. No code needed. BoardForm turns your blocks into AssemblyScript (`eval.ts`) and compiles it together with the stock search, so a blocks engine searches exactly as well as the Classic engine; only its judgement is yours.

The starter engine **Blocky** is a complete blocks evaluation. Open it from the [Engines](#/engines) page to follow along.

## How a blocks evaluation works

A blocks evaluation is a stack of three layers:

1. The **Evaluation** block is the root. It says *score = White's terms − Black's terms*. An engine uses one Evaluation block; if there are more, only the first counts.
2. Inside it go **Term** blocks — `term "My term"`. A term is one idea, such as "material" or "rooks on open files". Its name is what you see in the [evaluation breakdown](#reading-the-evaluation-breakdown).
3. Inside a term go the blocks that do the work: **add points** blocks, conditions (**if**), loops (**for each of our …**) and variables.

Points are *centipawns*: 100 points are worth one pawn. A score of +150 means White is about one and a half pawns better; −40 means Black is slightly better.

Blocks that are not connected to the Evaluation block have no effect, and neither does a term that sits outside it — the editor warns you about both.

## Us and them

Every term is worked out **twice**: once with White as "us" and once with Black as "us". The final score adds up, for every term, White's points minus Black's points.

So you describe each rule only once, from "our" side — *"add 10 points if any of our pawns is on our 7th rank"* — and it automatically applies to both colours in the mirrored way. With White as "us", "our 7th rank" is rank 7; with Black as "us", it is rank 2. This makes every blocks evaluation **symmetric**: a position and its colour-flipped twin always get opposite scores.

"Their" and "them" mean the opponent of whoever is "us" at that moment. A term such as *"subtract 30 points for each of our hanging pieces"* already punishes the opponent's hanging pieces too, because it is also worked out with the colours swapped. You rarely need "their" for a simple bonus; use it when the rule compares the two sides, like "push *their* king to the edge".

## Middlegame and endgame

Pieces and plans change value as the board empties: a king should hide in the middlegame but walk to the centre in the endgame. That is why every term keeps two totals, a **middlegame** total and an **endgame** total, and blends them by the *game phase*:

- The phase counts the pieces left on the board: knights and bishops count 1, rooks 2, queens 4. It is **24** at the start of the game (capped at 24) and **0** when only kings and pawns are left.
- The term's value is `(middlegame × phase + endgame × (24 − phase)) / 24`, rounded toward zero.

| Block | Middlegame total | Endgame total |
| --- | --- | --- |
| `add 10 points` | +10 | +10 |
| `add 10 in the middlegame and 30 in the endgame` | +10 | +30 |

With all pieces on the board (phase 24) the second block is worth 10; halfway (phase 12) it is worth (10 × 12 + 30 × 12) / 24 = 20; in a pawn ending (phase 0) it is worth 30. This blending is called a *tapered evaluation*.

## Editing blocks

- **Change a value.** Click a number to type a new one, or click a word with a ▾ to pick another option — for example "pawns" → "knights" or "7th" → "6th". The engine only uses whole numbers.
- **Add blocks.** Drag them in from the toolbox on the left. The **Ready-made terms** category holds complete terms you can drop straight into the Evaluation block and tweak.
- **Plug values into slots.** Number slots take number blocks, condition slots take yes/no blocks and square slots take blocks from the **Squares** category; a block that doesn't fit won't snap in. Any number slot accepts any number block, so `add (10) points` becomes `add (number of our passed pawns) points` by dropping a block into the slot.
- **Right-click a block** for **Duplicate**, **Add Comment**, **Collapse Block**, **Disable Block** and **Delete Block**. A disabled block is ignored, which is handy for testing an idea on and off. Terms with a comment show a **?** icon: click it to read the comment.
- **Undo** with <kbd>Ctrl</kbd>+<kbd>Z</kbd> (<kbd>Cmd</kbd>+<kbd>Z</kbd> on a Mac). Drag blocks to the trash can to delete them.
- **Move around** by dragging the background or scrolling; zoom with the **+** / **−** buttons in the corner or with <kbd>Ctrl</kbd> + scroll.

Every change is saved automatically and the evaluation is regenerated a moment later.

## Worked example: a pawn on the 7th rank

Let's add the classic rule *"increase the evaluation by 1 if any of our pawns is on our 7th rank"*.

1. Drag a **Term** block (Structure category) into the Evaluation block and name it `Pawn on our 7th rank`.
2. From **Logic**, drag an **if** block into the term.
3. From **Pieces**, drag `any of our pawns on our 7th rank` into the **if** slot.
4. From **Add points**, drag `add 10 points` into the **do** part of the **if**, and change 10 to **1**.

The term now reads:

```text
term  Pawn on our 7th rank
  if   any of [our] [pawns] on ( [our] [7th] rank )
  do   add (1) points
```

**Change the piece:** click **pawns** and choose **rooks** — now it rewards a rook on the 7th rank. **Change the rank:** click **7th** in the rank block and choose another one, or drop a different block from the **Squares** category into that slot (a file, a single square, the centre, …). **Change the bonus:** click the number. One point is a hundredth of a pawn, so it barely matters; Blocky uses 10.

To reward *each* such pawn instead of "any", use `add 10 points for each …` with `number of our pawns on our 7th rank` in its last slot.

This is the complete `eval.ts` that BoardForm generates for an Evaluation block holding only this term (the Workshop's **Generated code** tab shows the code generated from your own blocks):

```ts eval
// eval.ts — generated by BoardForm from your blocks. Don't edit this file by hand: it is
// rewritten every time the blocks change. (Duplicate the engine as a code engine to hand-edit it.)
//
// How it works: every term below is worked out twice, once with White as `us` and once with
// Black as `us`. The evaluation is the sum over all terms of (White's points − Black's points),
// in centipawns from White's point of view (100 = one pawn). Each term keeps separate middlegame
// (mg) and endgame (eg) points and blends them by the game phase (24 = opening … 0 = endgame):
//   taper(mg, eg, phase) = (mg × phase + eg × (24 − phase)) / 24

import { Position } from "./position";
import { BLACK, PAWN, WHITE } from "./types";
import { relativeRankMask, taper } from "./evalkit";
import { traceTerm, tracing } from "./trace";

/** Scores are kept well inside the mate range used by the search (MATE_BOUND = 31000). */
const EVAL_LIMIT: i32 = 30000;

// ── Term 1: Pawn on our 7th rank ────────────────────────────────────────
function term_1_pawn_on_our_7th_rank(pos: Position, us: i32, phase: i32): i32 {
  let mg: i32 = 0; // middlegame points for us
  let eg: i32 = 0; // endgame points for us

  if ((pos.pieces(us, PAWN) & relativeRankMask(us, 6)) != 0) {
    mg += 1;
    eg += 1;
  }
  return taper(mg, eg, phase);
}

/** Static evaluation in centipawns from White's point of view (positive = good for White). */
export function evaluate(pos: Position): i32 {
  const phase: i32 = pos.phase();
  let score: i32 = 0;
  let white: i32 = 0;
  let black: i32 = 0;

  // Pawn on our 7th rank
  white = term_1_pawn_on_our_7th_rank(pos, WHITE, phase);
  black = term_1_pawn_on_our_7th_rank(pos, BLACK, phase);
  score += white - black;
  if (tracing) traceTerm("Pawn on our 7th rank", white, black);

  if (score > EVAL_LIMIT) score = EVAL_LIMIT;
  if (score < -EVAL_LIMIT) score = -EVAL_LIMIT;
  return score;
}
```

The term became a function that is called once with `WHITE` and once with `BLACK` as `us`. `relativeRankMask(us, 6)` is "the 7th rank seen from `us`" (ranks are counted from 0 in code). An Evaluation block with no terms at all scores every position 0.

## More examples

**A bonus that grows as pawns advance.** From **For each piece**, drag `for each of our [knights]` into a term and switch it to **pawns**. Inside it put `add … in the middlegame and 0 in the endgame` and drop **pick by rank** (Math) into the middlegame slot, with **its rank** (For each piece) in its rank slot. Each of our pawns now earns the number listed for the rank it stands on: 10 on the 3rd rank, 20 on the 4th … 100 on the 7th, by default.

**Rooks on the 7th rank.** Drag the ready-made term **Rook on the 7th** in: `add 20 points for each (number of our rooks on our 7th rank)`.

**King safety only in the middlegame.** `add 8 in the middlegame and 0 in the endgame for each (number of pawns shielding our king)` rewards a pawn shield while pieces are on the board and fades to nothing in the endgame. Blocky's **King safety** term does exactly this, plus a penalty for enemy attacks near the king.

**Trade down when ahead.** The ready-made term **Push the enemy king to the edge** only scores when `material difference (ours − theirs)` is greater than 300: then it adds endgame points for each step their king is away from the centre, which teaches the engine to drive a lone king into a corner.

**Knight outposts.** The ready-made term **Knight outposts** loops over our knights and rewards each one that `is on their half of the board` *and* stands on `squares attacked by our pawns`.

## Piece-square tables

A piece-square table gives each of the 64 squares a bonus or penalty for one kind of piece. The **piece-square table for our …** blocks (Classic eval) show their table as a little 8 × 8 heat map: green squares are bonuses, red squares penalties.

Click the little board to open the table editor:

- The grid is drawn **from White's side, rank 8 at the top**, like a printed diagram. Black automatically uses the mirror image, so a black knight on c6 scores what a white knight on c3 scores.
- Click a square and type a value in centipawns (−2000 to 2000). The arrow keys move between squares; <kbd>Enter</kbd> moves to the next square in reading order.
- **Presets…** replaces the whole table with a shape — *All zero*, *Centralization*, *Advancement*, *Avoid the edges*, *King shelter* — or with PeSTO's tuned middlegame or endgame table for any piece.
- **Mirror** copies the queenside (files a–d) onto the kingside, mirrored. **Symmetrize** averages every square with its mirror image across the d/e line. **Clear** sets every square to 0.
- **Paste** 64 numbers (rank 8 first, as in most chess programming articles) into any square to fill the whole table at once.
- Press **Done** or <kbd>Esc</kbd> when you are finished.

`piece-square table for our [king]` with a **middlegame** and an **endgame** board blends the two by the game phase. Blocky's *Piece-square tables* term uses one such block per piece type, filled with PeSTO's values. Inside a **for each** loop, `value of its square in [table]` looks up a single piece instead.

## The block categories

Dropdowns are shown in [brackets] with the choice the toolbox starts with, and slots in (parentheses).

### Structure

| Block | What it does |
| --- | --- |
| **Evaluation** | The root: *score = White's terms − Black's terms*. Holds Term blocks. |
| **term** "My term" | A named part of the evaluation. The name appears in the breakdown. |

### Add points

Each of these has an **[add / subtract]** dropdown.

| Block | What it adds to *our* score |
| --- | --- |
| `add (10) points` | The amount, in both the middlegame and the endgame total. |
| `add (10) in the middlegame and (20) in the endgame` | Different amounts per phase ([tapered](#middlegame-and-endgame)). |
| `add (10) points for each (count)` | The amount times the count, e.g. per passed pawn. |
| `add (5) in the middlegame and (10) in the endgame for each (count)` | Both at once. |

### Ready-made terms

Complete terms to drop into the Evaluation block: **Pawn on our 7th rank**, **Bishop pair**, **Rook on the 7th**, **Knight outposts**, **Centralize the king in the endgame**, **Push the enemy king to the edge**, **Don't leave pieces hanging** and **Attack the enemy king**. Change their numbers or rebuild them — they are made of the ordinary blocks described here.

### Classic eval

| Block | Meaning |
| --- | --- |
| `count material  pawn 100 knight 320 bishop 330 rook 500 queen 900` | Adds the value of all our pieces. The king has no material value. |
| `count material` with a **middlegame** and an **endgame** row | Material with separate values per phase. Defaults are PeSTO's tuned values (middlegame 82 / 337 / 365 / 477 / 1025, endgame 94 / 281 / 297 / 512 / 936). |
| `piece-square table for our [knights]` | Adds the table value of the square each such piece stands on. |
| `piece-square table for our [king]` with middlegame / endgame boards | The same, blended by the game phase. |
| `mobility of [our] [knights]` | How many squares these pieces can move to, not counting squares with their own pieces or squares attacked by enemy pawns. Options: knights, bishops, rooks, queens, king, or pieces (N + B + R + Q). |
| `number of [our] [passed] pawns` | Pawns with a structural feature: **passed** (no enemy pawn can stop it), **isolated** (no friendly pawn on a neighbouring file), **doubled** (another friendly pawn in front of it on the same file), **connected** (defended by, or standing beside, a friendly pawn), **backward** (its neighbours have advanced past it and the square in front of it is attacked by an enemy pawn). |
| `number of [our] passed pawns on the [5th] rank or further` | Passed pawns that have reached at least that rank, counted from their own side (2nd … 7th). |
| `number of [our] rooks on [open] files` | **Open**: no pawns at all on the file. **Half-open**: none of our pawns, but at least one of theirs. |
| `[we] have the bishop pair` | Yes if that side has bishops on both light and dark squares. |
| `number of pawns shielding [our] king` | Own pawns on the king's file and the two files beside it, one or two ranks in front of the king. |
| `enemy attacks near [our] king` | How many times enemy pieces attack the king's square and the squares around it; each piece–square pair counts once. |
| `distance between the kings` | King moves from one king to the other (1–7). |
| `[our] king's distance from the center` | 0 on d4, e4, d5 or e5, up to 3 on the edge. |
| `number of [our] hanging pieces` | Knights, bishops, rooks and queens attacked by the enemy and not defended at all. |

### Pieces

| Block | Meaning |
| --- | --- |
| `any of [our] [pawns] on (squares)` | Yes if at least one such piece stands on the squares in the slot. |
| `number of [our] [pawns] on (squares)` | How many of them stand there. |
| `number of [our] [queens]` | How many this side has on the board. |
| `[our] material  pawn … queen …` | The total value of that side's pieces, with the values you set. |
| `material difference (ours − theirs)  pawn … queen …` | Our material minus theirs; positive when we are ahead. |

The piece dropdowns offer pawns, knights, bishops, rooks, queens, king and **pieces (any kind)**.

### Squares

Square blocks describe a group of squares *seen from our side*. They fit the square slots of other blocks.

| Block | Meaning |
| --- | --- |
| `[our] [7th] rank` | A whole rank, counted from that side: our 1st rank is our back rank. |
| `[our] [5th] to [7th] rank` | Several ranks in a row. |
| `the [d]-file` | A whole file (the same for both sides). |
| `square [e][4] (mirrored for Black)` | One square as White sees it; for Black it is mirrored, so e4 means e5. |
| `[the center (d4 e4 d5 e5)]` | A common area: the center, the big center (c3–f6), our half of the board, their half of the board, light squares, dark squares, the edge of the board, the queenside (files a–d), the kingside (files e–h), empty squares or the whole board. Light and dark squares are the real square colours and are not mirrored. |
| `squares attacked by [their] [pawns]` | Every square those pieces attack right now (pieces, pawns, knights, bishops, rooks, queens or king). |
| `squares around [their] king` | The king's square and its neighbours. |
| `squares of [our] [pawns]` | The squares those pieces stand on. |
| `[open files (no pawns)]` | Open files, half-open files for us, or half-open files for them. |
| `(squares) [or] (squares)` | Combine two groups: **or** (in either), **and also in** (in both), **but not** (in the first but not the second). |

### Game state

| Block | Meaning |
| --- | --- |
| `game phase (24 = opening … 0 = endgame)` | The phase described in [Middlegame and endgame](#middlegame-and-endgame). |
| `it is an endgame (game phase ≤ (8))` | Yes when the phase is at most the number. |
| `it is our turn to move` | Yes when "us" is the side to move. Having the move is worth a little (a *tempo*). |
| `[we are] in check` | Yes when that side's king is attacked. |
| `[we] can still castle [either way]` | Yes while that side still has the right to castle (either way, king side or queen side). |
| `moves since the last capture or pawn move` | The fifty-move counter, in half-moves; the game is drawn at 100. |

### For each piece

`for each of our [knights]` runs the blocks inside it once for every one of our pieces of that kind. Inside the loop, the **it** blocks describe the piece currently being looked at (they only work inside a loop):

| Block | Meaning |
| --- | --- |
| `its rank (1 – 8 from our side)` | 1 = our back rank, 7 = one step from promotion. |
| `its file (a = 1 … h = 8)` | The file it stands on. |
| `it is attacked by them` / `it is defended by us` | Yes if an enemy piece attacks it / another of our pieces protects it. |
| `its mobility` | Squares it can move to, not counting squares with our own pieces or attacked by enemy pawns. A pawn counts its forward moves and captures. |
| `it is a passed pawn` | Yes for a pawn no enemy pawn can stop (always no for other pieces). |
| `its distance to [their] king` | King moves between it and that king (0–7). |
| `its distance from the center (0 – 3)` | 0 on d4, e4, d5 or e5, 3 on the edge. |
| `it is on [an open] file` | An open or a half-open file. |
| `it is on (squares)` | Yes if it stands on those squares. |
| `number of squares it attacks in (squares)` | For example the squares around their king. |
| `value of its square in [table]` | Looks its square up in a piece-square table (mirrored for Black). |

Pieces are visited starting from our own back rank, the same way for both colours, so loops stay symmetric.

### Logic

The standard blocks: **if / do**, also with **else** or **else if** branches (the toolbox has all three versions), comparisons (=, ≠, <, ≤, >, ≥), **and** / **or**, **not**, **true** / **false**, and **test / if true / if false**, which picks one of two values.

### Math

| Block | Meaning |
| --- | --- |
| a number | A whole number. |
| `(1) [+] (1)` | +, −, ×, ÷ or remainder. Division rounds toward zero, and dividing by zero gives 0 instead of crashing the engine. |
| `the [smaller] of (a) and (b)` | The smaller or the larger of two numbers. |
| `[absolute value of] (x)` | Absolute value or negative. |
| `limit (x) between (lo) and (hi)` | Keeps a number inside a range. |
| `pick by rank (r)` with eight values | One of eight numbers chosen by a rank 1–8 (smaller ranks count as 1, larger as 8). Plug in **its rank** for a bonus that grows as pawns advance. |

### Variables

**Create variable…** makes a named whole number; **set … to** and **change … by** update it, and the variable block reads it. A variable starts at 0 in every term each time the term is worked out (once for each colour), so it never leaks from one term or colour into another.

## How values combine

- A **yes/no** value used as a number counts as 1 (yes) or 0 (no). A **group of squares** used as a number counts its squares; used as a condition it means "is not empty". A number used as a condition means "is not 0".
- An **empty slot** counts as a neutral value — 0, *no* or *no squares* — and the editor warns you about it.
- The final score is limited to ±30000 so it can never be mistaken for a checkmate score.

## Problems and warnings

The status pill in the top-right corner of the editor reads *"10 terms · no problems"* when everything is fine (Blocky has ten terms), or counts the errors and warnings. Click it to list them, and click a problem to jump to its block. Blocks with a problem also show a warning icon; click it to read the message.

Problems never stop the engine from building: a broken block simply counts as a neutral value until you fix it. Typical messages explain an empty slot, a term outside the Evaluation block, an **it** block outside a **for each** loop, or two terms with the same name.

An empty editor offers **Start from the starter evaluation** (Blocky's terms) and **Add an empty Evaluation block**.

## Reading the evaluation breakdown

Open the Workshop's **Test** panel and choose **Evaluate**. Set up a position — play moves on the board, pick one from **Presets**, build one with **Set up…**, or paste a FEN — and the table lists every term with its name and its **White**, **Black** and **Net** points, followed by the **Total**. All values are after tapering, in centipawns, and the net values add up to the total (unless the evaluation hit the ±30000 limit). The engine is compiled first if your blocks changed.

Use it to check a new term: set up a position where the rule should apply and look at the term's row. Then set up the same situation with the colours swapped and check that the White and Black numbers swap places.

## From blocks to code

Blocks are a great way to sketch ideas, and code is more flexible. Because the generated `eval.ts` is ordinary AssemblyScript, it is the perfect starting point for an [Eval code](#/help/eval-api) engine: in the Workshop, open the **⋯** menu and choose **Convert to code**. That creates a *new* engine whose `eval.ts` is the generated code, ready to edit by hand. The blocks engine itself stays as it is — its `eval.ts` is rewritten whenever its blocks change, which is why you edit the converted copy instead.
