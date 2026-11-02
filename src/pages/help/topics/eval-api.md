# Evaluation code

An **Eval code** engine is the stock BoardForm search with an evaluation function you write yourself, in a single file: `eval.ts`. The search — iterative deepening, alpha-beta, the transposition table, time management — comes from the current template, so you can concentrate on one question: *how good is this position?*

The starter engine **Classic** is an Eval code engine, and a new Eval code engine starts with the same `eval.ts`: a tapered hand-crafted evaluation with PeSTO's material values and piece-square tables, mobility, pawn structure, the bishop pair, rooks on open files, king safety and a bonus for the side to move. Read it, change a weight, or replace it completely.

The code is **AssemblyScript**: TypeScript syntax, compiled to WebAssembly. If you know TypeScript or JavaScript you can read it right away; the few important differences are listed in [AssemblyScript for TypeScript users](#assemblyscript-for-typescript-users).

In the Workshop, an Eval code engine opens on its `eval.ts`. Next to the editor you find:

- **Test** — evaluate, search and benchmark any position (see [Testing your evaluation](#testing-your-evaluation)).
- **API reference** — every function and constant of the engine template, with **Insert** to put a snippet at the cursor.
- **Engine source** — the other template files, read-only, so you can see exactly what you are calling.
- **Build log** — compiler messages; errors also appear in the editor at the right line.

**Reset eval.ts to the template** above the editor brings back the original file if you want to start over.

## The contract

`eval.ts` must export one function:

```ts
import { Position } from "./position";

/** Static evaluation in centipawns from WHITE's point of view (positive = good for White). */
export function evaluate(pos: Position): i32
```

- **Centipawns, from White's point of view.** 100 means White is a pawn better, −250 means Black is two and a half pawns better — no matter whose turn it is. The search turns the score around for Black by itself.
- **Look, don't touch.** `evaluate` must not change `pos` (no `makeMove`, no edits to its fields).
- **No allocation.** `evaluate` runs at every leaf of the search tree, often millions of times per move. Don't create objects, arrays or strings inside it: declare tables as constants at module level.
- **Stay below mate scores.** Mate scores start at ±31000 (`MATE_BOUND`). The search clamps evaluations to ±30999 so they can never be mistaken for a mate, but a sensible evaluation stays far below that.

Everything else is up to you: add helper functions and constants, import anything the template exports, and split the work however you like.

## Your first evaluation

The simplest evaluation that plays real chess counts material. This is a complete `eval.ts` — paste it over the whole file:

```ts eval
import { Position } from "./position";
import { WHITE, BLACK } from "./types";
import { material } from "./evalkit";
import { tracing, traceTerm } from "./trace";

/** Material only: pawn 100, knight 320, bishop 330, rook 500, queen 900. */
export function evaluate(pos: Position): i32 {
  const white = material(pos, WHITE, 100, 320, 330, 500, 900);
  const black = material(pos, BLACK, 100, 320, 330, 500, 900);
  if (tracing) traceTerm("material", white, black);
  return white - black;
}
```

`material(pos, color, pawn, knight, bishop, rook, queen)` multiplies the number of each piece type by the value you give it. `traceTerm` reports the term to the [evaluation breakdown](#the-evaluation-breakdown).

This engine never blunders material, but it has no idea where pieces belong: in the starting position every move looks equally good, so it simply plays the first one it generates — `b1a3`, a knight to the rim. Positional terms fix that.

## Adding a term

Terms are computed the same way for both colours and subtracted. Here a bonus for every pawn on its 7th rank joins the material count — the code version of the [Blocks editor](#/help/blocks?section=worked-example-a-pawn-on-the-7th-rank) example:

```ts eval
import { Position } from "./position";
import { WHITE, BLACK, PAWN } from "./types";
import { material, countOn, relativeRankMask } from "./evalkit";
import { tracing, traceTerm } from "./trace";

const SEVENTH_RANK_BONUS: i32 = 20;

export function evaluate(pos: Position): i32 {
  let score = 0;

  const materialW = material(pos, WHITE, 100, 320, 330, 500, 900);
  const materialB = material(pos, BLACK, 100, 320, 330, 500, 900);
  if (tracing) traceTerm("material", materialW, materialB);
  score += materialW - materialB;

  // relativeRankMask(color, 6) is "the 7th rank" seen from that colour's side:
  // rank 7 for White, rank 2 for Black (ranks are counted from 0 in code).
  const bonusW = countOn(pos, WHITE, PAWN, relativeRankMask(WHITE, 6)) * SEVENTH_RANK_BONUS;
  const bonusB = countOn(pos, BLACK, PAWN, relativeRankMask(BLACK, 6)) * SEVENTH_RANK_BONUS;
  if (tracing) traceTerm("pawns on the 7th rank", bonusW, bonusB);
  score += bonusW - bonusB;

  return score;
}
```

Writing every term as *"White's value − Black's value, computed by the same code"* keeps the evaluation **symmetric**: a position and its colour-flipped twin get exactly opposite scores. An asymmetric evaluation makes an engine play one colour better than the other — usually a bug.

## Reading the position

`Position` (from `position.ts`) holds the board. These are the members an evaluation uses:

| Member | Type | Meaning |
| --- | --- | --- |
| `pos.side` | `i32` | Side to move: `WHITE` (0) or `BLACK` (1). |
| `pos.pieces(color, type)` | `u64` | Bitboard of one colour's pieces of one type, e.g. `pos.pieces(WHITE, KNIGHT)`. |
| `pos.colorBB(color)` | `u64` | All pieces of one colour. |
| `pos.occupied()` | `u64` | All pieces of both colours. |
| `pos.pieceBB(piece)` | `u64` | Bitboard of one piece code (0–11). |
| `pos.pieceOn(sq)` | `i32` | Piece code on a square, or `NO_PIECE`. |
| `pos.kingSquare(color)` | `i32` | Where that king stands. |
| `pos.count(color, type)` | `i32` | Number of such pieces. |
| `pos.phase()` | `i32` | Game phase, 24 (all pieces) … 0 (kings and pawns): N = B = 1, R = 2, Q = 4, capped at 24. |
| `pos.nonPawnMaterial(color)` | `i32` | Knights and bishops 3, rooks 5, queens 9 ("pawn units"). |
| `pos.inCheck()` | `bool` | Is the side to move in check? |
| `pos.isAttacked(sq, byColor)` | `bool` | Does any piece of `byColor` attack `sq`? |
| `pos.attackersTo(sq, occ)` | `u64` | Pieces of both colours attacking `sq`, sliders blocked by `occ`. |
| `pos.checkers()` | `u64` | Enemy pieces giving check to the side to move. |
| `pos.castling` | `i32` | Castling rights: a combination of `CASTLE_WK`, `CASTLE_WQ`, `CASTLE_BK`, `CASTLE_BQ`. |
| `pos.epSquare` | `i32` | En-passant target square, or `NO_SQUARE` (only set when a capture there is possible). |
| `pos.halfmove` | `i32` | Fifty-move counter in plies. |
| `pos.key` | `u64` | Zobrist hash of the position — handy if you want to cache results. |

The vocabulary lives in `types.ts`:

- Colours `WHITE = 0` and `BLACK = 1`; the other colour is `color ^ 1`.
- Piece types `PAWN = 0`, `KNIGHT = 1`, `BISHOP = 2`, `ROOK = 3`, `QUEEN = 4`, `KING = 5`. A piece code is `color * 6 + type` (`makePiece`, `pieceColor`, `pieceType`); `NO_PIECE = 12`.
- Squares are numbered a1 = 0, b1 = 1 … h1 = 7, a2 = 8 … h8 = 63, with constants `A1` … `H8`. `fileOf(sq) = sq & 7` (0 = a-file) and `rankOf(sq) = sq >> 3` (0 = 1st rank). `NO_SQUARE = 64`.
- **Relative ranks** count from a colour's own side: `relativeRank(WHITE, E7) == 6` and `relativeRank(BLACK, E2) == 6` — both are "the 7th rank".

## Bitboards

A **bitboard** is a `u64` in which bit *n* is set when square *n* belongs to a set. Set operations are single instructions: union `a | b`, intersection `a & b`, "everything except" `a & ~b`, "is empty" `a == 0`. `popcount(b)` counts the squares in a set.

To visit every square of a set, take the lowest bit and clear it until nothing is left — the idiom used everywhere in the engine:

```ts
let knights = pos.pieces(WHITE, KNIGHT);
while (knights != 0) {
  const sq = lsb(knights); // index of the lowest set bit = one knight's square
  knights &= knights - 1;  // clear that bit
  // ... look at the knight on sq
}
```

The most useful helpers from `bitboard.ts`:

| Helper | Returns |
| --- | --- |
| `FILE_A` … `FILE_H`, `RANK_1` … `RANK_8`, `FILE_BB[f]`, `RANK_BB[r]` | Masks of files and ranks. |
| `CENTER`, `BIG_CENTER`, `LIGHT_SQUARES`, `DARK_SQUARES`, `ALL_SQUARES` | d4/e4/d5/e5, c3–f6, the square colours, everything. |
| `sqBB(sq)` | The set with only `sq`. |
| `popcount(b)`, `lsb(b)`, `msb(b)` | Number of squares; lowest / highest square (64 for an empty set). |
| `makeSquare(file, rank)`, `fileOf(sq)`, `rankOf(sq)` | Square ⇄ file and rank. |
| `relativeRank(color, sq)`, `relativeSquare(color, sq)`, `relativeRankBB(color, rank)` | Ranks and squares seen from a colour's side. |
| `squareDistance(a, b)`, `manhattanDistance(a, b)` | King-move distance; files + ranks apart. |
| `knightAttacks(sq)`, `kingAttacks(sq)`, `pawnAttacks(color, sq)` | Squares one piece attacks. |
| `bishopAttacks(sq, occ)`, `rookAttacks(sq, occ)`, `queenAttacks(sq, occ)` | Slider attacks, blocked by the pieces in `occ`. |
| `attacksOf(type, color, sq, occ)` | Attacks of any piece type. |
| `pawnAttacksBB(color, pawns)` | All squares a set of pawns attacks. |
| `shiftNorth(b)` … `shiftSouthWest(b)`, `pawnPushBB(color, b)` | Move a whole set one step. |
| `forwardFileBB(color, sq)`, `adjacentFilesBB(file)`, `passedPawnSpan(color, sq)` | Pawn-structure geometry. |
| `betweenBB(a, b)` | Squares strictly between two aligned squares (0 if not aligned). |

## The evalkit helpers

`evalkit.ts` answers the questions evaluations usually ask. Nothing in it allocates, so everything is safe to call from `evaluate`. (The Blocks editor generates calls to these same functions, which is why their names and parameters never change.)

| Helper | Returns |
| --- | --- |
| `material(pos, color, pawn, knight, bishop, rook, queen)` | Σ count × value (kings don't count). |
| `countOn(pos, color, type, mask)` | How many such pieces stand on the squares of `mask`. |
| `relativeRankMask(color, rank0to7)` | One rank counted from `color`'s side. |
| `relativeBB(color, b)` | The set seen from `color`'s side (mirrored for Black). |
| `passedPawns`, `isolatedPawns`, `doubledPawns`, `connectedPawns`, `backwardPawns` `(pos, color)` | Bitboards of pawns with that feature (count them with `popcount`). A doubled pawn is one with a friendly pawn in front of it on the same file. |
| `pawnAttacks(pos, color)` | Every square `color`'s pawns attack. |
| `attackedSquares(pos, color)` | Every square `color` attacks, king included. |
| `pieceAttacks(pos, color, type)` | Union of the attacks of all pieces of one type. |
| `mobility(pos, color, type)` | Σ over those pieces of the squares they attack that are neither own pieces nor attacked by enemy pawns. |
| `pieceMobility(pos, color, type, sq)` | The same for the single piece on `sq` (a pawn counts its moves). |
| `pawnMoves(pos, color, sq)` | Squares the pawn on `sq` can move to (no en passant). |
| `openFiles(pos)`, `halfOpenFiles(pos, color)` | Masks of whole files with no pawns / with no own pawn but an enemy pawn. |
| `rooksOnOpenFiles(pos, color)`, `rooksOnHalfOpenFiles(pos, color)` | Rook counts. |
| `kingShield(pos, color)` | Own pawns on the king's file ±1, one or two ranks in front of the king. |
| `kingZoneAttacks(pos, color)` | Enemy attacks (piece × square) on the king and its neighbours. |
| `kingDistance(pos)`, `centerDistance(sq)` | Distance between the kings; 0 (centre) … 3 (edge). |
| `bishopPair(pos, color)` | `true` with bishops on both square colours. |
| `hanging(pos, color)` | Own non-pawn pieces attacked by the enemy and not defended. |
| `taper(mg, eg, phase)`, `PHASE_MAX` | Blend a middlegame and an endgame value (see below). |
| `pst(table, color, sq)`, `pstSum(pos, color, type, table)`, `pstFromDiagram(rows)` | [Piece-square tables](#piece-square-tables). |

> **Note** There are two functions called `pawnAttacks`: evalkit's `pawnAttacks(pos, color)` (all squares a side's pawns attack) and bitboard.ts's `pawnAttacks(color, sq)` (the squares one pawn on `sq` attacks). To use both in one file, rename one when you import it: `import { pawnAttacks as pawnAttacksFrom } from "./bitboard";`.

## Tapered evaluation

Many terms matter differently in the middlegame and in the endgame. A **tapered** evaluation computes two values, *mg* and *eg*, and blends them by the game phase:

```ts
taper(mg, eg, phase) == (mg * phase + eg * (24 - phase)) / 24  // phase = pos.phase()
```

Phase 24 (all pieces on the board) gives `mg`, phase 0 (only kings and pawns) gives `eg`, and everything in between is a smooth mix. The default `eval.ts` keeps a middlegame and an endgame value for every term. Here is a smaller complete example with tapered material and a king that changes its mind about where to stand:

```ts eval
import { Position } from "./position";
import { WHITE, BLACK, KNIGHT, KING } from "./types";
import { taper, material, pstSum, pstFromDiagram } from "./evalkit";
import { tracing, traceTerm } from "./trace";

// Tables are written as board diagrams from White's side: rank 8 on the first line,
// rank 1 on the last. pstFromDiagram() converts them once, when the module loads.
const KNIGHT_PST = pstFromDiagram([
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
]);

// In the middlegame the king hides behind its pawns ...
const KING_MG = pstFromDiagram([
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
]);

// ... and in the endgame it walks to the centre.
const KING_EG = pstFromDiagram([
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
]);

export function evaluate(pos: Position): i32 {
  const phase = pos.phase(); // 24 = all pieces on the board ... 0 = only kings and pawns
  let score = 0;

  // Material: knights lose a little value and rooks gain some as the board empties.
  const matW = taper(material(pos, WHITE, 100, 320, 330, 480, 900), material(pos, WHITE, 100, 300, 330, 520, 900), phase);
  const matB = taper(material(pos, BLACK, 100, 320, 330, 480, 900), material(pos, BLACK, 100, 300, 330, 520, 900), phase);
  if (tracing) traceTerm("material", matW, matB);
  score += matW - matB;

  const knightsW = pstSum(pos, WHITE, KNIGHT, KNIGHT_PST);
  const knightsB = pstSum(pos, BLACK, KNIGHT, KNIGHT_PST);
  if (tracing) traceTerm("knight squares", knightsW, knightsB);
  score += knightsW - knightsB;

  const kingW = taper(pstSum(pos, WHITE, KING, KING_MG), pstSum(pos, WHITE, KING, KING_EG), phase);
  const kingB = taper(pstSum(pos, BLACK, KING, KING_MG), pstSum(pos, BLACK, KING, KING_EG), phase);
  if (tracing) traceTerm("king square", kingW, kingB);
  score += kingW - kingB;

  return score;
}
```

Integer division rounds toward zero, which treats positive and negative values alike, so tapering never breaks the symmetry of an evaluation.

## Piece-square tables

A piece-square table (PST) is a `StaticArray<i32>` of 64 values: the bonus for one kind of piece on each square.

- The engine indexes tables **a1 = 0 … h8 = 63, from White's point of view**. For a black piece the square is mirrored vertically (`sq ^ 56`), so one table serves both colours. `pst(table, color, sq)` does this for one piece and `pstSum(pos, color, type, table)` adds it up over all pieces of a type.
- In source code it is easier to write a table the way a board is printed, rank 8 first. `pstFromDiagram(rows)` converts such a diagram into the engine's order. Call it **once, at module level** — it allocates the new table.
- A table must have 64 entries; `pstSum` stops the engine with an error message if it is shorter.

## Loops over pieces

When a term depends on *where* each piece is, loop over its bitboard. This complete example rewards passed pawns by how far they have advanced, adds a little mobility for the minor pieces and rewards pawns that defend each other:

```ts eval
import { Position } from "./position";
import { WHITE, BLACK, PAWN, KNIGHT, BISHOP } from "./types";
import { lsb, relativeRank, pawnAttacksBB } from "./bitboard";
import { taper, material, passedPawns, mobility } from "./evalkit";
import { tracing, traceTerm } from "./trace";

// Bonus for a passed pawn by its rank counted from its own side
// (index 1 = 2nd rank ... index 6 = 7th rank; pawns never stand on the 1st or 8th).
const PASSED_MG: StaticArray<i32> = [0, 0, 5, 10, 20, 35, 55, 0];
const PASSED_EG: StaticArray<i32> = [0, 10, 15, 25, 45, 75, 110, 0];

/** Passed-pawn bonus of one side, middlegame and endgame blended by the phase. */
function passed(pos: Position, color: i32, phase: i32): i32 {
  let mg = 0;
  let eg = 0;
  let pawns = passedPawns(pos, color); // a bitboard with one bit per passed pawn
  while (pawns != 0) {
    const sq = lsb(pawns); // the lowest set bit is one pawn's square
    pawns &= pawns - 1; // remove that pawn from the set
    const rank = relativeRank(color, sq); // 0 ... 7, counted from this side's back rank
    mg += unchecked(PASSED_MG[rank]); // rank is always 0 ... 7, so skipping the bounds check is safe
    eg += unchecked(PASSED_EG[rank]);
  }
  return taper(mg, eg, phase);
}

/** A few points for every safe square the knights and bishops can reach. */
function minorMobility(pos: Position, color: i32): i32 {
  return 4 * mobility(pos, color, KNIGHT) + 5 * mobility(pos, color, BISHOP);
}

/** Pawns that defend each other: the squares our pawns attack that hold one of our pawns. */
function pawnChain(pos: Position, color: i32): i32 {
  const pawns = pos.pieces(color, PAWN);
  return 3 * popcountOf(pawnAttacksBB(color, pawns) & pawns);
}

/** Number of squares in a bitboard (the same as popcount() in bitboard.ts). */
@inline
function popcountOf(b: u64): i32 {
  return <i32>popcnt<u64>(b);
}

export function evaluate(pos: Position): i32 {
  const phase = pos.phase();
  let score = 0;

  const matW = material(pos, WHITE, 100, 320, 330, 500, 900);
  const matB = material(pos, BLACK, 100, 320, 330, 500, 900);
  if (tracing) traceTerm("material", matW, matB);
  score += matW - matB;

  const passedW = passed(pos, WHITE, phase);
  const passedB = passed(pos, BLACK, phase);
  if (tracing) traceTerm("passed pawns", passedW, passedB);
  score += passedW - passedB;

  const mobilityW = minorMobility(pos, WHITE);
  const mobilityB = minorMobility(pos, BLACK);
  if (tracing) traceTerm("mobility", mobilityW, mobilityB);
  score += mobilityW - mobilityB;

  const chainW = pawnChain(pos, WHITE);
  const chainB = pawnChain(pos, BLACK);
  if (tracing) traceTerm("pawn chains", chainW, chainB);
  score += chainW - chainB;

  return score;
}
```

The tables are declared once at module level, the loop clears one bit per step, and nothing is allocated while the search runs.

## The evaluation breakdown

The Workshop's **Test** panel (**Evaluate**) can show your evaluation term by term. To take part, call `traceTerm` once per term:

```ts
if (tracing) traceTerm("passed pawns", whiteBonus, blackBonus);
```

- `white` and `black` are the term's contributions for each side, **positive = good for that side**. The term's effect on the White-POV score is `white − black`.
- While the breakdown is being computed, `tracing` is `true`; during normal searches it is `false`, so the `if (tracing)` check costs a single comparison.
- Label terms with string literals (they are stored once and cost nothing). Avoid naming a term `total`: the breakdown ends with a `total` line holding the result of `evaluate`.
- The breakdown also receives the real result of `evaluate`. When the rows don't add up to it, some part of the score was never traced — every addition to the score should have its own `traceTerm`.

## AssemblyScript for TypeScript users

AssemblyScript looks like TypeScript but compiles to WebAssembly ahead of time, so a few things work differently:

- **Real number types.** `i32` (the default for integer literals: use it for scores, squares and counts), `i64`, `u32`, `u64` (bitboards), `f64` (the default for decimal literals; `number` is another name for `f64`), `bool`, and smaller ones like `u8`. There is no `any`, no `undefined` and no union types — `T | null` works for objects, but `i32 | null` is an error.
- **Conversions are explicit.** Write `<i32>x` or `<f64>n`. Converting a float to an integer truncates toward zero (`<i32>5.75 == 5`). An integer variable can't silently become a float: `let n = 5; n = 2.5;` and `count + 2.5` (with `count: i32`) fail with *"Conversion from type 'f64' to 'i32' requires an explicit cast."* The same goes for `u64` → `i32`: `popcnt<u64>(b)` returns a `u64`, which is why the template's `popcount(b)` returns `<i32>popcnt<u64>(b)`.
- **Integers wrap around.** `i32` arithmetic overflows silently: `50000 * 50000` is `-1794967296`. Division rounds toward zero (`-7 / 2 == -3`, `-7 % 2 == -1`).
- **Integer division by zero crashes the engine** ("divide by zero"), and so does `i32.MIN_VALUE / -1`. Check the divisor first.
- **Shifts and bitboards.** A bare `1 << sq` is an `i32`, so `const b = 1 << 40;` gives 256, not bit 40. Use `sqBB(sq)` (or `(<u64>1) << <u64>sq`) for squares. `>>` keeps the sign of signed numbers; `>>>` shifts in zeros.
- **Fixed-size arrays.** `StaticArray<i32>` is a fixed-length array and the fastest kind. Create tables once at module level: `const BONUS: StaticArray<i32> = [0, 5, 10];`. Indexing is bounds-checked: an index out of range stops the engine with an error. `unchecked(BONUS[i])` skips the check — use it only when the index is certainly in range.
- **No closures.** An arrow function can't use local variables of the function around it (*"Not implemented: Closures"*). Write a normal top-level function and pass the values as parameters.
- **No exceptions.** `try` / `catch` is not supported (*"Not implemented: Exceptions"*); a `throw` or a failed `assert` stops the current call.
- **Built-in helpers** are generic functions: `abs<i32>(x)`, `min<i32>(a, b)`, `max<i32>(a, b)`, `popcnt<u64>(b)`, `ctz<u64>(b)`, `clz<u64>(b)`, `bswap<u64>(b)`. `Math.*` works on `f64`.
- **Decorators.** `@inline` asks the compiler to inline a small function — the template uses it for hot helpers.
- **Unused code isn't checked.** The compiler only compiles code that is used, so a mistake in a function nobody calls shows up only once something calls it.
- **Strings** compare by content with `==`. Building strings allocates, so keep them out of `evaluate` (string literals are fine).
- Module-level `let` variables and constants are fine; the default `eval.ts` uses them to share work between terms.

## Performance tips

The evaluation runs at every leaf of the search and throughout the quiescence search. An evaluation that is twice as slow searches about half as many positions in the same time — and that costs strength in timed games.

- **Never allocate in `evaluate`** or in functions it calls: no `new`, no array literals, no string building. Precompute tables at module level.
- **Think in sets.** One `popcount(pieces & mask)` is much faster than looping over 64 squares. Loop over bitboards (`lsb` and `b &= b - 1`) when you need individual squares.
- **Share work.** If two terms need the same thing (attacks, mobility, pawn structure), compute it once. The default `eval.ts` computes mobility once per side into module-level variables and reads it for the middlegame and the endgame value.
- **Use `unchecked()`** for table lookups whose index is guaranteed in range, such as a relative rank (0–7) or a square (0–63) — but only after the code works.
- **Measure.** Run the Test panel's **Bench** — a fixed-depth search over six positions — before and after a change and compare the speed (nodes per second). Then check strength in the [Arena](#/help/play-and-arena) with a clock: [fixed-node matches](#/help/limits?section=choosing-fair-limits-for-matches) hide speed costs.

## Testing your evaluation

The Workshop's **Test** panel works on any position: play moves on the board, choose one from **Presets**, build one with **Set up…**, or paste a FEN. Your latest code is compiled first when it has changed.

- **Evaluate** shows the score from White's point of view and the breakdown table — **Term**, **White**, **Black**, **Net** and the **Total**. Check a new term in a position where it should apply.
- **Check symmetry.** Evaluate a position and its colour-flipped twin; the scores must be exact opposites. For example, after 1.e4 (`rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1`) and the same position with colours swapped (`rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 1`).
- **Search** runs the engine with a depth, node or time limit — or as infinite analysis until you press **Stop** — and lists every finished depth with its score, nodes, speed, time and principal variation. The engine reports scores from the side to move's point of view; the table shows them from White's, like the evaluation.
- **Bench** searches six fixed positions to a fixed depth and reports the speed — the number to watch when you optimise.
- **Console** shows anything the engine logs.
- **Perft** checks move generation. It doesn't touch the evaluation, but it is the tool for [Full engine code](#/help/full-engine) and [scratch](#/help/scratch) engines.

Then play the engine on the [Play](#/play) page and compare it with the previous version in the [Arena](#/arena).

## Common mistakes

- **Returning the side to move's score** instead of White's. The search turns the score around for Black by itself, so such a score gets turned around twice and the engine misjudges every position in which Black is to move.
- **Forgetting Black.** A term that only looks at White makes the evaluation lopsided. Compute every term for both colours with the same code.
- **Bonuses that dwarf material.** A +400 bonus for a knight in the centre makes the engine give away pieces to get there. Keep positional terms small compared with the pieces.
- **Allocating in `evaluate`** — the engine gets much slower.
- **An `i32` shift where a bitboard was meant** — `1 << sq` instead of `sqBB(sq)`.
- **An index out of range** in a table, which stops the engine with an error; the app restarts it, but the search result is lost.

<!-- include: ENGINE_TEMPLATE.md title="Reference: the engine template" -->
