# NNUE networks in Chess Builder

This file is the single source of truth shared by the trainer (TypeScript, `src/nnue/`),
the JS reference inference (`src/nnue/reference.ts`) and the engine-side inference
(AssemblyScript, `engine/template/nnue.ts`). All three MUST agree bit-for-bit on the
quantized evaluation of any position.

## Architecture: `(768 → HL) ×2 → 1`

* Two perspectives (White, Black) share one feature transformer `W1` (768×HL) and bias `b1` (HL).
* `HL` (hidden size) is chosen per network: any multiple of 8 between 8 and 2048
  (UI offers 16, 32, 64, 128, 256, 512; default 128).
* Activation: `CReLU` (id 0) or `SCReLU` (id 1, default).
* Output layer: `W2` (2·HL) and bias `b2` (1). The first HL weights apply to the accumulator of the
  **side to move**, the next HL to the accumulator of the **other side**.
* Output is from the **side to move's** point of view.

### Feature index

Piece types: `P=0, N=1, B=2, R=3, Q=4, K=5`. Colors: `WHITE=0, BLACK=1`. Squares LERF:
`a1=0, b1=1, …, h1=7, a2=8, …, h8=63` (`file = sq & 7`, `rank = sq >> 3`).

```
feature(persp, color, type, sq) =
    persp == WHITE:  (color == WHITE ? 0 : 384) + type*64 + sq
    persp == BLACK:  (color == BLACK ? 0 : 384) + type*64 + (sq ^ 56)
```

i.e. "own pieces first, then enemy pieces", board flipped vertically for Black.

### Float model (training)

```
acc_p[j] = b1[j] + Σ_{f ∈ features(p)} W1[f][j]
act(x)   = clamp(x, 0, 1)          (CReLU)
act(x)   = clamp(x, 0, 1)^2        (SCReLU)
out      = Σ_j act(acc_stm[j])·W2[j] + Σ_j act(acc_nstm[j])·W2[HL+j] + b2
eval_cp  = out · SCALE              (SCALE = 400)
```

### Quantization

`QA = 255`, `QB = 64`, `SCALE = 400`.

Before quantizing (and after every optimizer step during training) `W1`, `b1`, `W2` are clipped
to `[-1.98, 1.98]`. Then (JS `Math.round` semantics):

```
W1q = round(W1·QA)   (i16)     b1q = round(b1·QA)   (i16)
W2q = round(W2·QB)   (i16)     b2q = round(b2·QA·QB) (i32)
```

### Quantized inference (exact integer semantics — reference)

```
acc_p[j] = b1q[j] + Σ_{f ∈ features(p)} W1q[f·HL + j]          (fits in i16 thanks to clipping)
cr(x)    = min(max(x, 0), QA)

CReLU:   sum = Σ_j cr(acc_stm[j])·W2q[j] + Σ_j cr(acc_nstm[j])·W2q[HL+j]
         out = sum + b2q
SCReLU:  sum = Σ_j cr(acc_stm[j])²·W2q[j] + Σ_j cr(acc_nstm[j])²·W2q[HL+j]
         out = trunc(sum / QA) + b2q

eval_cp  = trunc(out · SCALE / (QA·QB))        // side-to-move POV
```

`trunc` = integer division rounding toward zero (C / AssemblyScript `i64` division,
JS `Math.trunc`). `sum` must be computed exactly: use 64-bit accumulation (AssemblyScript
`i64`, JS `Number` — exact below 2^53). Engines may clamp the final eval to ±(mate bound − 1).

## Network file format `CBNN` v1 (little-endian)

| Offset | Type | Field |
|---|---|---|
| 0 | `char[4]` | magic `"CBNN"` |
| 4 | `u32` | version = `1` |
| 8 | `u32` | inputs = `768` |
| 12 | `u32` | hidden = `HL` |
| 16 | `u32` | activation (`0` CReLU, `1` SCReLU) |
| 20 | `u32` | QA = `255` |
| 24 | `u32` | QB = `64` |
| 28 | `u32` | scale = `400` |
| 32 | `u32` | flags = `0` (reserved) |
| 36 | `u8[28]` | reserved, zero |
| 64 | `i16[768·HL]` | `W1q`, feature-major: element `(f, j)` at index `f·HL + j` |
| 64 + 1536·HL | `i16[HL]` | `b1q` |
| 64 + 1538·HL | `i16[2·HL]` | `W2q` (stm half first) |
| 64 + 1542·HL | `i32` | `b2q` |

Total size: `68 + 1542·HL` bytes (HL=128 → 197 444 bytes). Files use extension `.nnue`.

Loaders must reject: wrong magic/version, inputs ≠ 768, HL not a multiple of 8 or > 2048,
unknown activation, QA/QB/scale other than 255/64/400, or a size mismatch.

## Float checkpoint (stored in IndexedDB, used to continue training)

```ts
interface FloatNetwork {
  hidden: number; activation: 0 | 1;
  w1: Float32Array;  // 768*HL, feature-major (same layout as W1q)
  b1: Float32Array;  // HL
  w2: Float32Array;  // 2*HL
  b2: Float32Array;  // 1
}
interface OptimizerState { step: number; m: FloatNetwork; v: FloatNetwork }   // AdamW moments
```

"Widening" an existing network (growing HL→HL'): copy old weights, initialise the new hidden
neurons' `W1/b1` with small random values and their `W2` entries with **zero**, so the widened
network computes exactly the same function before further training.

## Training data: `PackedPosition` (32 bytes, little-endian)

| Offset | Type | Field |
|---|---|---|
| 0 | `u64` | occupancy bitboard (bit `sq` set if any piece on `sq`) |
| 8 | `u8[16]` | piece codes, 4 bits each: the k-th set bit of occupancy (k=0 = least significant) has its code in nibble k: `(byte[8 + (k>>1)] >> ((k&1)·4)) & 15`. Code = `color·6 + type` (white P..K = 0..5, black P..K = 6..11). |
| 24 | `i16` | search score, centipawns, **White's POV**, clamped to [-32000, 32000] |
| 26 | `u8` | game result, White's POV: `0` Black won, `1` draw, `2` White won |
| 27 | `u8` | side to move: `0` White, `1` Black |
| 28 | `u32` | reserved (0) |

Datasets are stored as chunks of up to 16 384 positions (`count·32` bytes each).

Self-play generators should skip positions where the side to move is in check, where the
chosen move is a capture or promotion, and where |score| ≥ 3000, and should skip the
first few (random-opening) plies of each game.

## Training target and loss

```
score_stm  = stm == WHITE ? score : -score
result_stm = stm == WHITE ? result/2 : 1 - result/2
target     = λ·σ(score_stm / 400) + (1 − λ)·result_stm        (λ = "eval weight", default 0.75)
pred       = σ(out)                                            (out × 400 = predicted cp)
loss       = (pred − target)²
```

Optimizer: AdamW (β1 0.9, β2 0.999, ε 1e-8, weight decay 0.01 by default), mini-batches
(default 4096), learning-rate schedule (constant / step / cosine), clipping after each step.

## Dataset files (import / export)

Two formats are accepted by the Lab's dataset import; export always writes the binary one.

**Binary `.cbds` (little-endian):** a 16-byte header followed by `count` PackedPositions.

| Offset | Type | Field |
|---|---|---|
| 0 | `u8[4]` | magic `"CBDS"` |
| 4 | `u32` | version = 1 |
| 8 | `u32` | `count` (number of positions) |
| 12 | `u32` | reserved (0) |
| 16 | `PackedPosition[count]` | 32 bytes each, as above |

Readers reject a wrong magic or version, or a file whose size is not `16 + 32·count`; positions that
fail validation (`validatePacked`) are skipped and counted in a warning.

**Text (one position per line):** `<FEN> | <score> | <result>` where `score` is centipawns from
**White's** point of view and `result` is `1.0` (White won), `0.5` (draw) or `0.0` (Black won) —
the common "bullet" text format. Blank lines and lines starting with `#` are ignored; malformed
lines are skipped and reported.

## Training-run guidance (Lab defaults)

Measured with the in-browser trainer (see the WP-NNUE-VERIFY report):

* Keep (and publish) the epoch-end checkpoint with the **lowest validation loss**, not the last
  one — small datasets overfit after a few epochs.
* Small datasets need enough optimizer steps: below ~1 000 total steps the network barely learns.
  The run wizard warns and suggests a smaller batch or more epochs (`steps = ceil(train/batch) × epochs`).
* As a rule of thumb, a network needs a few hundred thousand positions before it beats the
  material + piece-square fallback, and millions to compete with the hand-crafted evaluation.
