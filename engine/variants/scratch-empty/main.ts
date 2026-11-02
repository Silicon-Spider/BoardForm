// =============================================================================
//  Your engine — start here                                    (Engine ABI v1)
// =============================================================================
//
//  This is an empty chess engine. It already talks to Chess Builder correctly:
//  every function the app calls exists and the text plumbing is done. What it
//  can't do yet is play chess: cb_go() answers "no move". Everything else is up
//  to you. This file explains the contract and suggests an order to build in.
//
//  Where to look things up
//    * The Engine ABI page in Help (docs/ENGINE_ABI.md): the exact rules for
//      every cb_ function.
//    * The "Minimal" from-scratch starter (engine/variants/scratch-minimal/main.ts):
//      a complete small engine (0x88 board, alpha-beta search) written for
//      learning. Peek at it whenever you get stuck.
//    * https://www.chessprogramming.org — the encyclopedia of engine techniques.
//
//  The language is AssemblyScript: TypeScript syntax, compiled to WebAssembly.
//  Things that differ from TypeScript:
//    * Numbers have fixed types: i32 (int), u64 (64-bit, handy for bitboards),
//      f64 (float), bool, u8 ... Convert explicitly: <f64>count, <i32>value.
//    * Use StaticArray<i32> for fixed-size tables and create them once at the
//      top level, e.g.   const board = new StaticArray<i32>(64);
//      Allocating inside the search (new, string concatenation) makes it slow.
//    * Only code that is actually used gets compiled: a typo inside a function
//      nobody calls yet won't show an error until something calls it.
//
// -----------------------------------------------------------------------------
//  HOW THE APP USES YOUR ENGINE
// -----------------------------------------------------------------------------
//
//    cb_init()                 once, right after loading: build tables here
//    cb_new_game()             before every game: forget game-specific data
//    cb_position(len)          set up a position, e.g. "startpos moves e2e4 e7e5"
//    cb_go(depth, nodes, ...)  think, then write your move ("g1f3") to the output
//    ... cb_position + cb_go again for every move of the game ...
//
//  The app never calls two functions at the same time, so you don't need to
//  worry about threads. Text travels through two 64 KiB byte buffers in your
//  engine's memory:
//    INPUT  (cb_in)   the app writes, you read: position commands
//    OUTPUT (cb_out)  you write, the app reads: your move, PV, log text, name
//  readInput() and writeOutput() below convert to and from strings for you.
//
// -----------------------------------------------------------------------------
//  CONVENTIONS
// -----------------------------------------------------------------------------
//
//  Squares  UCI names "a1".."h8" ("a1" is White's queen-side corner). Inside
//           your engine you can number them however you like; a common choice:
//               0 = a1, 1 = b1, ... 7 = h1, 8 = a2, ... 63 = h8
//               file = sq % 8 (0 = a-file), rank = sq / 8 (0 = 1st rank)
//
//  Moves    UCI long algebraic notation: from-square + to-square, plus the
//           promotion piece in lower case: "e2e4", "g8f6", "e7e8q", "a2a1n".
//           Castling is the king's move: "e1g1", "e1c1", "e8g8", "e8c8".
//           En passant is just the pawn's move, e.g. "e5d6".
//
//  Scores   Centipawns: 100 = one pawn.
//             cb_info score   from the SIDE TO MOVE's point of view (+ = good for the mover)
//             cb_eval         from WHITE's point of view (+ = good for White)
//           Mates are reported with cb_info's `mate` argument: "mate in N moves",
//           negative when the side to move is the one getting mated.
//
// -----------------------------------------------------------------------------
//  ROADMAP
// -----------------------------------------------------------------------------
//
//   1. Board + FEN. Pick a board representation (an array of 64 squares is
//      fine to start), then parse `positionCommand`, which cb_position stores:
//      "startpos" or "fen <6 FEN fields>", optionally followed by
//      "moves <uci> <uci> ...". Make cb_position return 0 for anything invalid.
//   2. Move generation. Generate all legal moves, including castling, en passant
//      and promotions. Test it with perft (uncomment cb_perft below and use
//      the Test panel): from the start position depths 1-5 must give
//      20, 400, 8902, 197281, 4865609.
//   3. Play! Make cb_go write the first legal move. Your engine can now play
//      whole games — badly. Rule: return 0 only when there is no legal move.
//   4. Evaluation. Count material (P 100, N 320, B 330, R 500, Q 900), then add
//      piece-square tables. Uncomment cb_eval so the Test panel can show it.
//   5. Search. Negamax with alpha-beta pruning, iterative deepening (depth 1,
//      2, 3, ...), quiescence search on captures, move ordering. Report every
//      finished depth with sendInfo() so you can watch your engine think.
//   6. Limits. Respect depth / nodes / movetime / clock (see cb_go) and stop as
//      soon as stopNow() says so.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. Functions the app provides (imports)
// -----------------------------------------------------------------------------

/** Current time in milliseconds (like performance.now()). Only differences mean anything. */
@external("env", "cb_now")
declare function cb_now(): f64;

/**
 * Returns non-zero when the app wants the current search to end as soon as
 * possible (the user pressed Stop, or a hard time limit was reached). Ask it
 * regularly while searching and finish with your best move so far when it says so.
 */
@external("env", "cb_should_stop")
declare function cb_should_stop(): i32;

/**
 * Reports search progress, normally once per finished depth:
 *   depth, seldepth  the depth you finished, and the deepest ply you reached
 *   score            centipawns from the side to move's point of view
 *   mate             0, or "mate in N moves" (negative: you are getting mated)
 *   nodes, timeMs    positions searched so far and milliseconds used
 *   pvLen            the principal variation ("e2e4 e7e5 g1f3") must already be
 *                    at the start of the output buffer; this is its length in bytes
 * sendInfo() below does all of that for you.
 */
@external("env", "cb_info")
declare function cb_info(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32): void;

/** Shows `len` bytes from the start of the output buffer in the engine console. Use log(). */
@external("env", "cb_log")
declare function cb_log(len: i32): void;

// -----------------------------------------------------------------------------
// 2. Text buffers and helpers
// -----------------------------------------------------------------------------

const BUFFER_SIZE: i32 = 65536;
const INPUT: usize = memory.data(BUFFER_SIZE); // the app writes commands here
const OUTPUT: usize = memory.data(BUFFER_SIZE); // you write answers here

/** Reads the `len` bytes the app wrote into the input buffer as a string. */
function readInput(len: i32): string {
  if (len < 0) len = 0;
  if (len > BUFFER_SIZE) len = BUFFER_SIZE;
  return String.UTF8.decodeUnsafe(INPUT, <usize>len);
}

/**
 * Writes `text` as UTF-8 into the output buffer, starting at byte `at`, and
 * returns the position just after it (= the length when `at` is 0).
 * Text that doesn't fit is not written at all.
 */
function writeOutput(text: string, at: i32 = 0): i32 {
  const size = String.UTF8.byteLength(text);
  if (at < 0 || at + size > BUFFER_SIZE) return at;
  // changetype<usize>(text) is the address of the string's characters in memory.
  String.UTF8.encodeUnsafe(changetype<usize>(text), text.length, OUTPUT + <usize>at);
  return at + size;
}

/** Prints a line in the engine console — your best friend while debugging. */
function log(text: string): void {
  cb_log(writeOutput(text));
}

/**
 * Reports one finished search depth to the app (it shows up in the analysis
 * panel). `pv` is the best line as space-separated UCI moves, best move first.
 * Pass `mateIn` = 0 for a normal score, or N / -N for "mate in N" / "mated in N".
 *
 *     sendInfo(depth, bestScore, 0, <f64>nodes, startTime, "e2e4 e7e5 g1f3");
 */
function sendInfo(depth: i32, scoreCp: i32, mateIn: i32, nodes: f64, startTime: f64, pv: string): void {
  const pvLen = writeOutput(pv);
  cb_info(depth, depth, scoreCp, mateIn, nodes, cb_now() - startTime, pvLen);
}

/**
 * True when the search must end now: the app asked us to stop, or the time we
 * gave ourselves is up. Calling the app costs a little, so inside the search
 * ask only every 1024 nodes or so:
 *
 *     nodes++;
 *     if ((nodes & 1023) == 0 && stopNow(deadline)) stopped = true;
 *     if (stopped) return 0;   // unwind, then play the best move of the last finished depth
 */
function stopNow(deadline: f64): bool {
  return cb_should_stop() != 0 || cb_now() >= deadline;
}

// -----------------------------------------------------------------------------
// 3. Your engine's state
// -----------------------------------------------------------------------------

// The last position command, e.g. "startpos moves e2e4 e7e5". Parse it into your
// own board representation (TODO, roadmap step 1).
let positionCommand: string = "startpos";

// -----------------------------------------------------------------------------
// 4. The functions Chess Builder calls (required by Engine ABI v1)
// -----------------------------------------------------------------------------

/** Tells the app which version of the ABI this engine implements. Keep it 1. */
export function cb_abi_version(): i32 {
  return 1;
}

/** Called once after loading, before anything else. */
export function cb_init(): void {
  // TODO: build lookup tables (attack tables, Zobrist keys, ...) and set up the
  // start position.
}

/** Address of the input buffer (the app writes position commands there). */
export function cb_in(): i32 {
  return <i32>INPUT;
}

/** Address of the output buffer (you write moves, PV and log text there). */
export function cb_out(): i32 {
  return <i32>OUTPUT;
}

/** Called before every new game. */
export function cb_new_game(): void {
  // TODO: clear anything learned during the previous game (hash table,
  // killer moves, history tables, ...).
}

/**
 * The app wrote `len` bytes into the input buffer: the arguments of a UCI
 * "position" command, for example
 *     startpos
 *     startpos moves e2e4 e7e5 g1f3
 *     fen rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2 moves g1f3
 * Return 1 if you understood it, 0 if it is invalid (bad FEN, illegal move).
 */
export function cb_position(len: i32): i32 {
  positionCommand = readInput(len);
  // TODO: set up your board from positionCommand instead of only storing it.
  // Splitting it into words is a good start:   positionCommand.split(" ")
  return 1;
}

/**
 * Think about the current position and write the best move to the output
 * buffer; return its length in bytes (4, or 5 for a promotion like "e7e8q").
 * Return 0 only when the side to move has no legal move (checkmate/stalemate).
 *
 * Limits — any combination; stop at the first one reached:
 *   depth > 0         don't start iterations deeper than `depth` plies
 *   nodes > 0         stop after roughly `nodes` positions
 *   movetime > 0      use at most `movetime` milliseconds
 *   wtime, btime >= 0 a game clock is running: milliseconds left for White and
 *                     Black, plus increments winc/binc per move; movestogo > 0
 *                     moves until the next time control (0 = rest of the game).
 *                     You decide how much to use, e.g. timeLeft / 30 + inc * 3 / 4.
 *   none of the above "infinite" analysis: search until stopNow() says stop
 *
 * Always return a legal move if there is one — even when stopped after a few
 * nodes (fall back to the first legal move you generated).
 */
export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  // TODO (roadmap steps 3-6). The shape of a typical cb_go:
  //   1. startTime = cb_now(); work out a deadline from movetime / the clock
  //   2. for depth 1, 2, 3, ...: search, remember the best move, sendInfo(...)
  //      and stop when a limit is reached
  //   3. return writeOutput(bestMoveAsUci)
  log("cb_go: no search yet (empty skeleton) - TODO: generate moves and return one. Position: " + positionCommand);
  return 0; // = "I have no move". Replace this once you can generate moves.
}

/** The name shown for your engine. Make it yours! */
export function cb_name(): i32 {
  return writeOutput("My Engine 0.1");
}

// -----------------------------------------------------------------------------
// 5. Optional functions — uncomment them once you have what they need
// -----------------------------------------------------------------------------
//
// /** Static evaluation in centipawns from WHITE's point of view (Test panel → Eval). */
// export function cb_eval(): i32 {
//   return evaluate();          // your evaluation function
// }
//
// /** Number of leaf nodes of the legal move tree `depth` plies deep (Test panel → Perft). */
// export function cb_perft(depth: i32): f64 {
//   return perft(depth);        // your perft function
// }
//
// /** Evaluation breakdown for the Test panel: one "label\twhite\tblack\n" line per
//  *  term (each side's share, positive = good for that side), then "total\t<score>\t0\n". */
// export function cb_eval_trace(): i32 {
//   let text = "Material\t" + whiteMaterial.toString() + "\t" + blackMaterial.toString() + "\n";
//   text += "total\t" + evaluate().toString() + "\t0\n";
//   return writeOutput(text);
// }
//
// /** Options, called before cb_new_game with "name=value", e.g. "Hash=64" (MiB for a
//  *  transposition table). Return 1 if you know the option, 0 otherwise. */
// export function cb_set_option(len: i32): i32 {
//   const option = readInput(len);
//   return 0;
// }
