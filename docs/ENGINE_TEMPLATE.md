# The AssemblyScript engine template (`engine/`)

Every engine built inside BoardForm (except uploaded `.wasm` files) is compiled from
AssemblyScript sources. The canonical sources live in `engine/template/` and are bundled into
the web app as raw strings. Users can edit just `eval.ts`, generate it from blocks, or edit every
file. `engine/variants/` holds alternative starting points.

The app compiles with (see `src/compiler/`):

```
asc main.ts --outFile engine.wasm -O3 --runtime incremental --enable simd --noColors
```

## Files

| File | Purpose | Editable in mode |
|---|---|---|
| `main.ts` | ABI exports (`cb_*`, see `ENGINE_ABI.md`); owns the global `Position` | full |
| `io.ts` | input/output buffers, string ↔ buffer helpers, host imports (`cb_now`, `cb_info`, `cb_log`, `cb_should_stop`) | full |
| `types.ts` | colors, piece types, squares, move encoding, score constants | full |
| `bitboard.ts` | bitboard constants & helpers, attack tables, slider attacks | full |
| `position.ts` | `Position` class: board state, FEN, make/unmake, Zobrist, attacks | full |
| `movegen.ts` | pseudo-legal & legal move generation, perft | full |
| `tt.ts` | transposition table | full |
| `search.ts` | iterative deepening PVS alpha-beta, quiescence, ordering, pruning, time management | full |
| `evalkit.ts` | evaluation helper library (pawn structure, mobility, king safety, PST helpers, `taper`) | full |
| `trace.ts` | evaluation breakdown support (`tracing`, `traceTerm`) | full |
| `eval.ts` | **`evaluate(pos)` — the evaluation function** (default: tapered hand-crafted eval) | eval, blocks (generated), full |
| `nnue.ts` | NNUE network loading and inference (`NNUE_FORMAT.md`) | full |
| `variants/eval-nnue.ts` | replacement `eval.ts` that evaluates with the loaded NNUE | (used by kind `nnue`) |
| `variants/scratch-empty/main.ts` | bare ABI skeleton with TODOs | scratch |
| `variants/scratch-minimal/main.ts` | small self-contained single-file engine (0x88 board) to learn from | scratch |

## The evaluation contract

```ts
// eval.ts
import { Position } from "./position";
/** Static evaluation in centipawns from WHITE's point of view (positive = good for White). */
export function evaluate(pos: Position): i32
```

`search.ts` converts to side-to-move POV itself. `evaluate` must not modify `pos`.
`evaluate` is called at every leaf, so it should not allocate (use `StaticArray` constants
declared at module level, no `new` inside the function).

Breakdown for the editor's test panel: if `tracing` (from `trace.ts`) is true, `evaluate` should
call `traceTerm(label, white, black)` once per term, where `white`/`black` are that term's
centipawn contributions for each side (positive = good for that side). `main.ts`'s
`cb_eval_trace` sets `tracing`, calls `evaluate`, and serialises the terms.

## Conventions

* Colors: `WHITE = 0`, `BLACK = 1`. `them = us ^ 1`.
* Piece types: `PAWN = 0, KNIGHT = 1, BISHOP = 2, ROOK = 3, QUEEN = 4, KING = 5`.
* Piece codes: `piece = color * 6 + type` (0..11); `NO_PIECE = 12`.
* Squares LERF: `a1 = 0 … h1 = 7, a2 = 8 … h8 = 63`; `fileOf(sq) = sq & 7` (0 = a-file),
  `rankOf(sq) = sq >> 3` (0 = 1st rank). `NO_SQUARE = 64`. Named constants `A1 … H8` exist.
* **Relative ranks** are 0-based from a color's own side: `relativeRank(WHITE, e7) = 6`,
  `relativeRank(BLACK, e2) = 6` ("the 7th rank" for that color).
* Piece-square tables are `StaticArray<i32>` of 64 entries, indexed LERF **from White's
  point of view** (index 0 = a1, 63 = h8). For Black, look up `table[sq ^ 56]` (that is what
  `pst(table, color, sq)` does). When printed as a board, write rank 8 first.
* Phase: `pos.phase()` ∈ [0, 24], 24 = all pieces on board (opening), 0 = only kings & pawns.
  Weights N = 1, B = 1, R = 2, Q = 4 (clamped to 24). `taper(mg, eg, phase)` =
  `(mg * phase + eg * (24 - phase)) / 24`.
* Scores: `MATE = 32000`; mate-in-n scores are `±(MATE - ply)`; `MATE_BOUND = 31000`
  (|score| > MATE_BOUND ⇒ mate score); `INFINITE = 32001`; `MAX_PLY = 128`.
* Moves are `u16`-range `i32`: `from | (to << 6) | (flag << 12)`; flags: `0` quiet, `1` double
  pawn push, `2` king-side castle, `3` queen-side castle, `4` capture, `5` en-passant capture,
  `8..11` promotion to N/B/R/Q, `12..15` capture-promotion to N/B/R/Q. `MOVE_NONE = 0`.
  Helpers: `moveFrom, moveTo, moveFlag, isCapture, isPromotion, promotionType, makeMove, moveToUci`.

## `types.ts`

```ts
WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, NO_PIECE, NO_SQUARE
A1 … H8                                   // i32 square constants
makePiece(color, type): i32   pieceColor(piece): i32   pieceType(piece): i32
MATE, MATE_BOUND, INFINITE, MAX_PLY, MOVE_NONE
moveFrom(m), moveTo(m), moveFlag(m), isCapture(m): bool, isPromotion(m): bool, promotionType(m): i32,
encodeMove(from, to, flag): i32, moveToUci(m): string
CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8
```

## `bitboard.ts`

```ts
FILE_A … FILE_H, RANK_1 … RANK_8: u64        FILE_BB, RANK_BB: StaticArray<u64> (8 each)
LIGHT_SQUARES, DARK_SQUARES, CENTER (d4 e4 d5 e5), BIG_CENTER (c3–f6), ALL_SQUARES: u64
initBitboards(): void                       // build attack tables; called by cb_init
sqBB(sq): u64      popcount(b): i32      lsb(b): i32      msb(b): i32      // lsb/msb of 0 = 64
fileOf(sq), rankOf(sq), makeSquare(file, rank): i32
relativeRank(color, sq): i32    relativeSquare(color, sq): i32    relativeRankBB(color, rank0to7): u64
squareDistance(a, b): i32 (king/Chebyshev)    manhattanDistance(a, b): i32
shiftNorth/South/East/West/NorthEast/NorthWest/SouthEast/SouthWest(b): u64
pawnPushBB(color, b): u64                    // one step forward
knightAttacks(sq), kingAttacks(sq), pawnAttacks(color, sq): u64
pawnAttacksBB(color, pawns): u64             // all squares attacked by a pawn set
bishopAttacks(sq, occ), rookAttacks(sq, occ), queenAttacks(sq, occ): u64
attacksOf(type, color, sq, occ): u64         // any piece type
forwardFileBB(color, sq): u64                // squares in front of sq on its file
adjacentFilesBB(file): u64
passedPawnSpan(color, sq): u64               // front squares on own + adjacent files
betweenBB(a, b): u64                         // squares strictly between two aligned squares, else 0
```

## `position.ts`

```ts
class Position {
  side: i32            // side to move
  castling: i32        // CASTLE_* flags
  epSquare: i32        // en-passant target square or NO_SQUARE
  halfmove: i32        // fifty-move counter (plies)
  fullmove: i32
  key: u64             // Zobrist hash
  ply: i32             // plies made since the last setFen (search depth bookkeeping)

  pieces(color, type): u64     pieceBB(piece): u64     colorBB(color): u64     occupied(): u64
  pieceOn(sq): i32 (piece code or NO_PIECE)            kingSquare(color): i32
  count(color, type): i32      phase(): i32             nonPawnMaterial(color): i32   // N=3,B=3,R=5,Q=9 units
  inCheck(): bool              isAttacked(sq, byColor): bool     attackersTo(sq, occ): u64
  checkers(): u64
  setFen(fen: string): bool    toFen(): string           setStartpos(): void
  makeMove(m: i32): void       unmakeMove(): void         makeNull(): void   unmakeNull(): void
  isRepetition(): bool         isDraw(): bool             // repetition, 50-move, insufficient material
  isLegal(m): bool             parseUci(uci: string): i32 // MOVE_NONE if not legal here
}
```

## `evalkit.ts` (stable API used by the Blocks generator — do not rename)

```ts
PHASE_MAX = 24
taper(mg, eg, phase): i32
material(pos, color, pawn, knight, bishop, rook, queen): i32        // Σ count × value
countOn(pos, color, type, mask: u64): i32                            // popcount(pieces & mask)
relativeRankMask(color, rank0to7): u64
passedPawns(pos, color): u64       isolatedPawns(pos, color): u64
doubledPawns(pos, color): u64      // own pawns with another own pawn in front on the same file
connectedPawns(pos, color): u64    // own pawns defended by an own pawn or with an own pawn beside them
backwardPawns(pos, color): u64
pawnAttacks(pos, color): u64       attackedSquares(pos, color): u64  // all squares color attacks
pieceAttacks(pos, color, type): u64                                 // union over pieces of that type
mobility(pos, color, type): i32    // Σ popcount(attacks & ~own pieces & ~enemy pawn attacks)
openFiles(pos): u64                halfOpenFiles(pos, color): u64   // masks of whole files
rooksOnOpenFiles(pos, color): i32  rooksOnHalfOpenFiles(pos, color): i32
kingShield(pos, color): i32        // own pawns on the king's file ±1, 1–2 ranks in front of it
kingZoneAttacks(pos, color): i32   // enemy attacks (piece×square) on our king and adjacent squares
kingDistance(pos): i32             // distance between the kings
centerDistance(sq): i32            // 0 (d4/e4/d5/e5) … 3 (edge)
bishopPair(pos, color): bool
hanging(pos, color): i32           // own non-pawn pieces attacked by enemy and not defended
pst(table: StaticArray<i32>, color, sq): i32
pstSum(pos, color, type, table: StaticArray<i32>): i32              // Σ pst over pieces of that type
pstFromDiagram(rows: StaticArray<i32>): StaticArray<i32>            // rank-8-first diagram → LERF table
relativeBB(color, b: u64): u64       // mirror a square set vertically for Black (identity for White)
pawnMoves(pos, color, sq): u64       // pushes onto empty squares (+ double step) and captures; no e.p.
pieceMobility(pos, color, type, sq): i32 // one piece's moves not onto own pieces / enemy-pawn-attacked squares
```

## `trace.ts`

```ts
export let tracing: bool                    // set by cb_eval_trace
traceTerm(label: string, white: i32, black: i32): void
traceReset(): void
traceWrite(): i32                           // serialise into the output buffer, returns length
```

## `nnue.ts`

```ts
nnueAlloc(size: i32): usize          // backs cb_nnue_alloc
nnueLoad(size: i32): bool            // backs cb_nnue_load; validates per NNUE_FORMAT.md
nnueReady(): bool
nnueEvaluate(pos: Position): i32     // side-to-move POV centipawns (exact reference semantics)
```

`variants/eval-nnue.ts` = an `eval.ts` whose `evaluate` returns the NNUE score converted to
White's POV (falls back to a simple material eval if no network is loaded).
