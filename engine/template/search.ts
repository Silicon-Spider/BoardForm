// =====================================================================================
// search.ts — finding the best move
// =====================================================================================
//
// The search looks ahead through the tree of possible moves and picks the move that leads
// to the best evaluation, assuming both sides play their best ("minimax"). The main ideas:
//
// * Negamax alpha-beta: one function serves both sides by negating scores
//   (my score = -opponent's score). The window [alpha, beta] lets us skip ("prune") moves
//   that cannot change the result: once a move is good enough that the opponent would
//   avoid this line anyway (score >= beta), the remaining moves need no search ("cutoff").
//   The search is "fail-soft": it may return scores outside the window, which are bounds.
//
// * Principal Variation Search (PVS): after the first (hopefully best) move, the others are
//   searched with a null window [alpha, alpha+1], which is much cheaper and only answers
//   "is this move better than alpha?". Only if it is, the move is searched again properly.
//
// * Iterative deepening: search depth 1, then 2, then 3, ... Every iteration fills the
//   transposition table and the move-ordering tables, which makes the next one much faster,
//   and when time runs out we always have the result of the last finished iteration.
//
// * Aspiration windows: from depth 4 on, an iteration starts with a narrow window around the
//   previous score and widens it only when the score falls outside.
//
// * Quiescence search: at depth 0 we keep searching captures (and queen promotions) until the
//   position is quiet, so that the evaluation is never taken in the middle of an exchange.
//   The side to move may "stand pat" (take the static evaluation) instead of capturing.
//
// * Move ordering, best first: transposition-table move, winning/equal captures ordered by
//   MVV-LVA (most valuable victim, least valuable attacker), queen promotions, two "killer"
//   quiet moves per ply (they caused a cutoff in a sibling node), then other quiet moves by
//   their "history" score, then losing captures (judged by static exchange evaluation, SEE).
//
// * Pruning and reductions (only where they are known to be safe enough):
//     - mate distance pruning: no need to look for mates longer than one already found,
//     - reverse futility pruning: far above beta at low depth -> return,
//     - null-move pruning: if passing still keeps us above beta, the position is good enough
//       (not used when only pawns are left: zugzwang),
//     - late move pruning / futility pruning of quiet moves at low depth,
//     - late move reductions (LMR): late quiet moves are searched less deeply first,
//     - check extension: positions in check are searched one ply deeper,
//     - internal iterative reduction: no hash move at a deep node -> search a bit shallower.
//
// * Draws: repetitions (including positions from the game history set up by cb_position),
//   the fifty-move rule and insufficient material score 0.
//
// * Time: a soft limit (do not start another iteration) and a hard limit (abort the search)
//   derived from the clock, plus fixed move time, depth and node limits. The clock and the
//   host's stop flag are polled every 1024 nodes.
//
// Scores are centipawns from the side to move's point of view inside the search.

import { Position } from "./position";
import { evaluate } from "./eval";
import { generateMoves, generateNoisy, hasLegalMove, MAX_MOVES } from "./movegen";
import {
  ttProbe, ttStore, ttNewSearch, ttEntryMove, ttEntryScore, ttEntryEval, ttEntryDepth, ttEntryBound,
  BOUND_EXACT, BOUND_LOWER, BOUND_UPPER, EVAL_NONE,
} from "./tt";
import { now, shouldStop, sendInfo, outReset, outByte, outMove, outLength } from "./io";
import {
  WHITE, PAWN, BISHOP, ROOK, QUEEN, KING, MATE, MATE_BOUND, INFINITE, MAX_PLY, MOVE_NONE,
  FLAG_EN_PASSANT, moveFrom, moveTo, moveFlag, isCapture, isPromotion, promotionType, pieceType, isCastle,
} from "./types";
import { sqBB, lsb, bishopAttacks, rookAttacks } from "./bitboard";

// ------------------------------------------------------------------------ tuning knobs

const ASPIRATION_DELTA: i32 = 18; // initial half-width of the aspiration window (cp)
const RFP_MAX_DEPTH: i32 = 7; // reverse futility pruning up to this depth
const RFP_MARGIN: i32 = 85; // ... with this margin per ply
const NULL_MIN_DEPTH: i32 = 3; // null-move pruning from this depth on
const LMP_MAX_DEPTH: i32 = 4; // late move pruning up to this depth
const FUTILITY_MAX_DEPTH: i32 = 6; // futility pruning of quiet moves up to this depth
const FUTILITY_MARGIN: i32 = 100; // ... margin per ply (+ 50)
const SEE_PRUNE_MAX_DEPTH: i32 = 5; // prune losing captures at low depth
const DELTA_MARGIN: i32 = 200; // quiescence delta pruning margin
const HISTORY_MAX: i32 = 16384; // history scores stay within ±HISTORY_MAX
const MOVE_OVERHEAD: f64 = 30; // ms kept in reserve for communication with the host

// Move ordering scores (higher = searched earlier).
const SCORE_TT_MOVE: i32 = 4000000;
const SCORE_GOOD_CAPTURE: i32 = 2000000;
const SCORE_QUEEN_PROMOTION: i32 = 1900000;
const SCORE_KILLER_1: i32 = 1800000;
const SCORE_KILLER_2: i32 = 1700000;
const SCORE_BAD_CAPTURE: i32 = -2000000;
const SCORE_UNDER_PROMOTION: i32 = -3000000;

/** Piece values used by SEE, MVV-LVA and delta pruning (index 6 = no piece). */
export const SEE_VALUE: StaticArray<i32> = [100, 320, 330, 500, 900, 20000, 0];

/** Evaluations are clamped to this so that they can never be mistaken for mate scores. */
const EVAL_LIMIT: i32 = MATE_BOUND - 1;

// ----------------------------------------------------------------------- search tables

const MOVES = new StaticArray<i32>(MAX_PLY * MAX_MOVES); // move list slice per ply
const MOVE_SCORES = new StaticArray<i32>(MAX_PLY * MAX_MOVES); // ordering score of each move
const QUIETS_TRIED = new StaticArray<i32>(MAX_PLY * 64); // quiet moves searched per ply (history malus)
const PV = new StaticArray<i32>(MAX_PLY * MAX_PLY); // triangular PV table: row = ply
const PV_LENGTH = new StaticArray<i32>(MAX_PLY + 1);
const KILLERS = new StaticArray<i32>(MAX_PLY * 2);
const HISTORY = new StaticArray<i32>(2 * 64 * 64); // [side][from][to]
const EVAL_STACK = new StaticArray<i32>(MAX_PLY + 2); // static eval per ply ("improving")
const LMR_TABLE = new StaticArray<i32>(64 * 64); // [depth][move number]
const BEST_PV = new StaticArray<i32>(MAX_PLY); // PV of the current best root move
const SEE_GAIN = new StaticArray<i32>(40);

// ----------------------------------------------------------------------- search state

let nodes: u64 = 0;
let nodeLimit: u64 = 0; // 0 = no node limit
let startTime: f64 = 0;
let softLimit: f64 = 0; // ms: do not start a new iteration after this (0 = none)
let hardLimit: f64 = 0; // ms: abort the search after this (0 = none)
let timeManaged = false; // a clock or movetime limits this search
let stopped = false;
let selDepth = 0;

let rootBestMove: i32 = MOVE_NONE;
let rootBestScore: i32 = 0;
let bestPvLength: i32 = 0;
let rootMovesSearched = 0;

/** Builds the late-move-reduction table. Called once by cb_init. */
export function initSearch(): void {
  for (let depth = 1; depth < 64; depth++) {
    for (let moveNumber = 1; moveNumber < 64; moveNumber++) {
      const r = 0.75 + Math.log(<f64>depth) * Math.log(<f64>moveNumber) / 2.25;
      LMR_TABLE[depth * 64 + moveNumber] = <i32>r;
    }
  }
}

/** Forgets the move-ordering statistics (new game). */
export function clearSearch(): void {
  for (let i = 0; i < HISTORY.length; i++) HISTORY[i] = 0;
  for (let i = 0; i < KILLERS.length; i++) KILLERS[i] = MOVE_NONE;
}

// ----------------------------------------------------------------- time management

/** Translates the cb_go arguments into the limits used by the search. */
function setupLimits(side: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): void {
  nodeLimit = nodes > 0 && nodes < 9e15 ? <u64>nodes : 0; // also rejects NaN and Infinity
  softLimit = 0;
  hardLimit = 0;
  timeManaged = false;

  if (movetime > 0) {
    // A fixed time per move: use all of it.
    const t = max<f64>(1, <f64>movetime - 5);
    softLimit = t;
    hardLimit = t;
    timeManaged = true;
  }

  if (wtime >= 0 && btime >= 0) {
    // A game clock: plan to use 1/movesToGo of the remaining time plus most of the increment
    // (soft limit), but never more than a quarter of what is left; abort at 3x the plan or
    // 40% of the remaining time (hard limit), whichever comes first.
    const time = <f64>(side == WHITE ? wtime : btime);
    const inc = <f64>(side == WHITE ? winc : binc);
    const available = max<f64>(1, time - MOVE_OVERHEAD);
    const movesToGo = <f64>(movestogo > 0 ? min(movestogo, 40) : 25);
    let soft = available / movesToGo + inc * 0.75;
    soft = min<f64>(soft, available * 0.25);
    let hard = min<f64>(soft * 3, available * 0.4);
    soft = max<f64>(soft, 1);
    hard = max<f64>(hard, 1);
    softLimit = softLimit > 0 ? min<f64>(softLimit, soft) : soft;
    hardLimit = hardLimit > 0 ? min<f64>(hardLimit, hard) : hard;
    timeManaged = true;
  }
}

/** Sets `stopped` when a limit is reached. Called at every node. */
@inline
function checkLimits(): void {
  if (nodeLimit != 0 && nodes >= nodeLimit) {
    stopped = true;
    return;
  }
  if ((nodes & 1023) == 0) {
    if (shouldStop()) stopped = true;
    else if (hardLimit > 0 && now() - startTime >= hardLimit) stopped = true;
  }
}

// ------------------------------------------------------------------------ entry point

/**
 * Searches `pos` with the given limits (same meaning as the cb_go arguments) and returns the
 * best move, or MOVE_NONE if the side to move has no legal move. Sends cb_info after every
 * completed iteration. `pos` is unchanged afterwards.
 */
export function think(pos: Position, depth: i32, nodesLimit: f64, movetime: i32, wtime: i32, btime: i32,
  winc: i32, binc: i32, movestogo: i32): i32 {
  startTime = now();
  setupLimits(pos.side, nodesLimit, movetime, wtime, btime, winc, binc, movestogo);
  const maxDepth = depth > 0 ? min(depth, MAX_PLY - 1) : MAX_PLY - 1;
  nodes = 0;
  stopped = false;
  ttNewSearch();
  for (let i = 0; i < KILLERS.length; i++) KILLERS[i] = MOVE_NONE;
  for (let i = 0; i < HISTORY.length; i++) HISTORY[i] /= 2; // older statistics count less

  // Root moves. With no legal move there is nothing to search.
  const rootEnd = generateMoves(pos, MOVES, 0);
  if (rootEnd == 0) return MOVE_NONE;

  // Fallback: a legal move to return even if the search is stopped immediately. Prefer the
  // hash move from an earlier search of this position.
  rootBestMove = MOVES[0];
  const entry = ttProbe(pos.key);
  if (entry != 0) {
    const hashMove = ttEntryMove(entry);
    for (let i = 0; i < rootEnd; i++) if (MOVES[i] == hashMove) rootBestMove = hashMove;
  }
  rootBestScore = 0;
  BEST_PV[0] = rootBestMove;
  bestPvLength = 1;

  let completedDepth = 0;
  let previousScore = 0;
  let lastReportedNodes: u64 = 0;

  for (let d = 1; d <= maxDepth; d++) {
    selDepth = 0;
    rootMovesSearched = 0;
    const score = aspirationSearch(pos, d, previousScore);
    if (stopped) break;

    completedDepth = d;
    previousScore = score;
    reportInfo(d, score);
    lastReportedNodes = nodes;

    if (timeManaged) {
      const elapsed = now() - startTime;
      if (softLimit > 0 && elapsed >= softLimit) break;
      // A forced mate that is shorter than the depth searched will not change any more.
      if (abs(score) > MATE_BOUND && d >= 2 * (MATE - abs(score)) + 4) break;
    }
  }

  // A final report so that the host sees the total node count and time of the search.
  if (nodes != lastReportedNodes && (completedDepth > 0 || rootMovesSearched > 0)) {
    reportInfo(max(completedDepth, 1), rootBestScore);
  }
  return rootBestMove;
}

/** One iteration of iterative deepening, with an aspiration window around `previous`. */
function aspirationSearch(pos: Position, depth: i32, previous: i32): i32 {
  let delta = ASPIRATION_DELTA;
  let alpha = -INFINITE;
  let beta = INFINITE;
  if (depth >= 4 && abs(previous) < MATE_BOUND) {
    alpha = max(previous - delta, -INFINITE);
    beta = min(previous + delta, INFINITE);
  }
  while (true) {
    const score = negamax(pos, depth, alpha, beta, 0);
    if (stopped) return score;
    if (score <= alpha) {
      // Fail low: the position is worse than expected. Widen downwards.
      beta = (alpha + beta) / 2;
      alpha = max(score - delta, -INFINITE);
    } else if (score >= beta) {
      // Fail high: better than expected. Widen upwards.
      beta = min(score + delta, INFINITE);
    } else {
      return score;
    }
    delta += delta;
    if (delta > 1000) {
      alpha = -INFINITE;
      beta = INFINITE;
    }
  }
}

// --------------------------------------------------------------------- main search

/** Static evaluation from the side to move's point of view, clamped below mate scores. */
@inline
function evaluateForSideToMove(pos: Position): i32 {
  let e = evaluate(pos);
  if (e > EVAL_LIMIT) e = EVAL_LIMIT;
  else if (e < -EVAL_LIMIT) e = -EVAL_LIMIT;
  return pos.side == WHITE ? e : -e;
}

/**
 * Alpha-beta search of `pos` to `depth` plies; `ply` is the distance from the root.
 * Returns a score from the side to move's point of view (fail-soft).
 */
function negamax(pos: Position, depth: i32, alpha: i32, beta: i32, ply: i32): i32 {
  unchecked(PV_LENGTH[ply] = ply);
  const isRoot = ply == 0;
  const isPV = beta - alpha > 1;

  if (!isRoot) {
    // Draws: repetition (also with the game history) and insufficient material.
    if (pos.isRepetition() || pos.insufficientMaterial()) return 0;
    // Mate distance pruning: a mate found now cannot be better than mate in `ply`.
    alpha = max(alpha, -MATE + ply);
    beta = min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;
    if (ply >= MAX_PLY - 1) return evaluateForSideToMove(pos);
  }

  const inCheck = pos.inCheck();
  if (inCheck) depth++; // check extension
  if (depth <= 0) return quiescence(pos, alpha, beta, ply);

  nodes++;
  checkLimits();
  if (stopped) return 0;
  if (ply > selDepth) selDepth = ply;

  // Fifty-move rule (a checkmate on the 100th ply still counts as mate).
  if (!isRoot && pos.halfmove >= 100 && (!inCheck || hasLegalMove(pos))) return 0;

  // ---- transposition table
  let ttMove = MOVE_NONE;
  let ttScore = 0;
  let ttBound = 0;
  let ttEval = EVAL_NONE;
  const entry = ttProbe(pos.key);
  if (entry != 0) {
    ttMove = ttEntryMove(entry);
    ttScore = ttEntryScore(entry, ply);
    ttBound = ttEntryBound(entry);
    ttEval = ttEntryEval(entry);
    if (!isPV && ttEntryDepth(entry) >= depth &&
      (ttBound == BOUND_EXACT || (ttBound == BOUND_LOWER && ttScore >= beta) || (ttBound == BOUND_UPPER && ttScore <= alpha))) {
      return ttScore;
    }
  }
  if (isRoot) ttMove = rootBestMove;

  // ---- static evaluation
  let staticEval = -INFINITE;
  let eval = -INFINITE;
  let improving = false;
  if (!inCheck) {
    staticEval = ttEval != EVAL_NONE ? ttEval : evaluateForSideToMove(pos);
    eval = staticEval;
    // A stored search score is a better estimate than the static evaluation.
    if (entry != 0 && abs(ttScore) < MATE_BOUND &&
      (ttBound == BOUND_EXACT || (ttBound == BOUND_LOWER && ttScore > eval) || (ttBound == BOUND_UPPER && ttScore < eval))) {
      eval = ttScore;
    }
    improving = ply >= 2 && staticEval > unchecked(EVAL_STACK[ply - 2]);
  }
  unchecked(EVAL_STACK[ply] = staticEval);

  // ---- pruning before searching any move (never in PV nodes or in check)
  if (!isPV && !inCheck) {
    // Reverse futility pruning: so far above beta that a shallow search will not drop below it.
    if (depth <= RFP_MAX_DEPTH && abs(beta) < MATE_BOUND &&
      eval - RFP_MARGIN * (improving ? depth - 1 : depth) >= beta) {
      return eval;
    }

    // Null-move pruning: let the opponent move twice. If we are still above beta, a real move
    // will be too. Skipped without pieces (zugzwang) and right after another null move.
    if (depth >= NULL_MIN_DEPTH && eval >= beta && staticEval >= beta && pos.lastMove() != MOVE_NONE &&
      pos.nonPawnMaterial(pos.side) > 0) {
      const reduction = 3 + depth / 4 + min((eval - beta) / 200, 3);
      pos.makeNull();
      const score = -negamax(pos, depth - 1 - reduction, -beta, -beta + 1, ply + 1);
      pos.unmakeNull();
      if (stopped) return 0;
      if (score >= beta) return score >= MATE_BOUND ? beta : score; // do not trust null-move mates
    }
  }

  // Internal iterative reduction: without a hash move this node is probably not important.
  if (depth >= 4 && ttMove == MOVE_NONE) depth--;

  // ---- generate and order the moves
  const start = ply * MAX_MOVES;
  const end = generateMoves(pos, MOVES, start);
  if (end == start) return inCheck ? -MATE + ply : 0; // checkmate or stalemate
  scoreMoves(pos, start, end, ttMove, ply);

  const quietBase = ply * 64;
  let quietsTried = 0;
  let movesSearched = 0;
  let bestScore = -INFINITE;
  let bestMove = MOVE_NONE;

  for (let i = start; i < end; i++) {
    pickMove(i, end);
    const m = unchecked(MOVES[i]);
    const orderScore = unchecked(MOVE_SCORES[i]);
    const quiet = !isCapture(m) && !isPromotion(m);

    // Decide whether this move may be skipped at low depth (we need to know if it checks).
    let prunable = false;
    if (!isRoot && !isPV && !inCheck && bestScore > -MATE_BOUND) {
      if (quiet) {
        // Late move pruning: after enough quiet moves the rest are very unlikely to be best.
        if (depth <= LMP_MAX_DEPTH && quietsTried >= (3 + depth * depth) / (improving ? 1 : 2)) prunable = true;
        // Futility pruning: the static eval is so far below alpha that a quiet move won't help.
        if (depth <= FUTILITY_MAX_DEPTH && eval + FUTILITY_MARGIN * depth + 50 <= alpha) prunable = true;
      } else if (depth <= SEE_PRUNE_MAX_DEPTH && orderScore < 0 && see(pos, m) < -100 * depth) {
        prunable = true; // clearly losing capture
      }
    }

    pos.makeMove(m);
    const givesCheck = pos.inCheck();
    if (prunable && !givesCheck) {
      pos.unmakeMove();
      if (quiet) quietsTried++;
      continue;
    }

    let score: i32;
    const newDepth = depth - 1;
    if (movesSearched == 0) {
      // First move: full window.
      score = -negamax(pos, newDepth, -beta, -alpha, ply + 1);
    } else {
      // Late move reductions for quiet moves that do not give check.
      let reduction = 0;
      if (depth >= 3 && quiet && !inCheck && !givesCheck && movesSearched >= (isPV ? 3 : 2)) {
        reduction = unchecked(LMR_TABLE[min(depth, 63) * 64 + min(movesSearched, 63)]);
        if (!isPV) reduction++;
        if (!improving) reduction++;
        if (orderScore >= SCORE_KILLER_2) reduction -= 2; // killer moves
        else reduction -= orderScore / 8192; // good / bad history
        if (reduction < 0) reduction = 0;
        if (reduction > newDepth - 1) reduction = newDepth - 1;
      }
      // Null-window search (reduced), re-searched at full depth and then with the full window
      // only if the move turns out to be better than alpha.
      score = -negamax(pos, newDepth - reduction, -alpha - 1, -alpha, ply + 1);
      if (score > alpha && reduction > 0) score = -negamax(pos, newDepth, -alpha - 1, -alpha, ply + 1);
      if (score > alpha && score < beta) score = -negamax(pos, newDepth, -beta, -alpha, ply + 1);
    }
    pos.unmakeMove();
    if (stopped) return 0;

    movesSearched++;
    if (isRoot) rootMovesSearched++;
    if (quiet) {
      if (quietsTried < 64) unchecked(QUIETS_TRIED[quietBase + quietsTried] = m);
      quietsTried++;
    }

    if (score > bestScore) {
      bestScore = score;
      if (score > alpha) {
        bestMove = m;
        if (isPV) updatePv(ply, m);
        if (isRoot) {
          rootBestMove = m;
          rootBestScore = score;
          saveRootPv();
        }
        if (score >= beta) {
          if (quiet) updateQuietStats(pos.side, ply, depth, m, quietBase, quietsTried);
          break;
        }
        alpha = score;
      }
    }
  }

  const bound = bestScore >= beta ? BOUND_LOWER : bestMove != MOVE_NONE ? BOUND_EXACT : BOUND_UPPER;
  ttStore(pos.key, bestMove, bestScore, inCheck ? EVAL_NONE : staticEval, depth, bound, ply);
  return bestScore;
}

// --------------------------------------------------------------------- quiescence

/** Searches captures (and queen promotions) until the position is quiet. */
function quiescence(pos: Position, alpha: i32, beta: i32, ply: i32): i32 {
  unchecked(PV_LENGTH[ply] = ply);
  nodes++;
  checkLimits();
  if (stopped) return 0;
  if (ply > selDepth) selDepth = ply;
  if (ply >= MAX_PLY - 1) return evaluateForSideToMove(pos);

  const isPV = beta - alpha > 1;
  let ttMove = MOVE_NONE;
  let ttEval = EVAL_NONE;
  const entry = ttProbe(pos.key);
  if (entry != 0) {
    ttMove = ttEntryMove(entry);
    ttEval = ttEntryEval(entry);
    if (!isPV) {
      const s = ttEntryScore(entry, ply);
      const b = ttEntryBound(entry);
      if (b == BOUND_EXACT || (b == BOUND_LOWER && s >= beta) || (b == BOUND_UPPER && s <= alpha)) return s;
    }
  }

  const inCheck = pos.inCheck();
  let bestScore: i32;
  let standPat = 0;
  if (inCheck) {
    // No standing pat in check: every evasion must be tried (none = checkmate).
    bestScore = -MATE + ply;
  } else {
    standPat = ttEval != EVAL_NONE ? ttEval : evaluateForSideToMove(pos);
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    bestScore = standPat;
  }

  const start = ply * MAX_MOVES;
  const end = generateNoisy(pos, MOVES, start); // all evasions when in check
  if (inCheck && end == start) return -MATE + ply;
  scoreMoves(pos, start, end, ttMove, ply);

  let bestMove = MOVE_NONE;
  for (let i = start; i < end; i++) {
    pickMove(i, end);
    const m = unchecked(MOVES[i]);
    if (!inCheck) {
      // Delta pruning: even winning the captured piece (plus a margin) cannot reach alpha.
      if (!isPromotion(m)) {
        const victim = moveFlag(m) == FLAG_EN_PASSANT ? PAWN : pieceType(pos.pieceOn(moveTo(m)));
        if (standPat + unchecked(SEE_VALUE[victim]) + DELTA_MARGIN <= alpha) continue;
      }
      // SEE pruning: skip captures that lose material (scoreMoves gave them a negative score).
      if (unchecked(MOVE_SCORES[i]) < 0) continue;
    }
    pos.makeMove(m);
    const score = -quiescence(pos, -beta, -alpha, ply + 1);
    pos.unmakeMove();
    if (stopped) return 0;
    if (score > bestScore) {
      bestScore = score;
      if (score > alpha) {
        bestMove = m;
        if (score >= beta) break;
        alpha = score;
      }
    }
  }

  const bound = bestScore >= beta ? BOUND_LOWER : isPV && bestMove != MOVE_NONE ? BOUND_EXACT : BOUND_UPPER;
  ttStore(pos.key, bestMove, bestScore, inCheck ? EVAL_NONE : standPat, 0, bound, ply);
  return bestScore;
}

// ------------------------------------------------------------------- move ordering

/** Gives every move in [start, end) an ordering score in MOVE_SCORES. */
function scoreMoves(pos: Position, start: i32, end: i32, ttMove: i32, ply: i32): void {
  const killer1 = unchecked(KILLERS[ply * 2]);
  const killer2 = unchecked(KILLERS[ply * 2 + 1]);
  const historyBase = pos.side * 4096;
  for (let i = start; i < end; i++) {
    const m = unchecked(MOVES[i]);
    let s: i32;
    if (m == ttMove) {
      s = SCORE_TT_MOVE;
    } else if (isPromotion(m) && promotionType(m) != QUEEN) {
      s = SCORE_UNDER_PROMOTION;
    } else if (isCapture(m)) {
      const victim = moveFlag(m) == FLAG_EN_PASSANT ? PAWN : pieceType(pos.pieceOn(moveTo(m)));
      const attacker = pieceType(pos.pieceOn(moveFrom(m)));
      const mvvLva = unchecked(SEE_VALUE[victim]) * 8 - attacker; // most valuable victim first
      // Captures of an equal or bigger piece never lose material; others are checked with SEE.
      const good = unchecked(SEE_VALUE[victim]) >= unchecked(SEE_VALUE[attacker]) || see(pos, m) >= 0;
      s = (good ? SCORE_GOOD_CAPTURE : SCORE_BAD_CAPTURE) + mvvLva;
    } else if (isPromotion(m)) {
      s = SCORE_QUEEN_PROMOTION;
    } else if (m == killer1) {
      s = SCORE_KILLER_1;
    } else if (m == killer2) {
      s = SCORE_KILLER_2;
    } else {
      s = unchecked(HISTORY[historyBase + (moveFrom(m) << 6) + moveTo(m)]);
    }
    unchecked(MOVE_SCORES[i] = s);
  }
}

/** Moves the best-scored move of [i, end) to position i (selection sort, one step at a time). */
@inline
function pickMove(i: i32, end: i32): void {
  let best = i;
  let bestScore = unchecked(MOVE_SCORES[i]);
  for (let j = i + 1; j < end; j++) {
    const s = unchecked(MOVE_SCORES[j]);
    if (s > bestScore) {
      bestScore = s;
      best = j;
    }
  }
  if (best != i) {
    const m = unchecked(MOVES[i]);
    unchecked(MOVES[i] = unchecked(MOVES[best]));
    unchecked(MOVES[best] = m);
    const s = unchecked(MOVE_SCORES[i]);
    unchecked(MOVE_SCORES[i] = bestScore);
    unchecked(MOVE_SCORES[best] = s);
  }
}

/** A quiet move caused a beta cutoff: remember it as killer and reward it in the history. */
function updateQuietStats(side: i32, ply: i32, depth: i32, move: i32, quietBase: i32, quietsTried: i32): void {
  if (unchecked(KILLERS[ply * 2]) != move) {
    unchecked(KILLERS[ply * 2 + 1] = unchecked(KILLERS[ply * 2]));
    unchecked(KILLERS[ply * 2] = move);
  }
  const bonus = min(depth * depth, 400);
  const base = side * 4096;
  addHistory(base + (moveFrom(move) << 6) + moveTo(move), bonus);
  // The quiet moves searched before it did not cause a cutoff: lower their scores.
  const tried = min(quietsTried, 64);
  for (let i = 0; i < tried; i++) {
    const q = unchecked(QUIETS_TRIED[quietBase + i]);
    if (q != move) addHistory(base + (moveFrom(q) << 6) + moveTo(q), -bonus);
  }
}

/** History update with "gravity": scores saturate smoothly at ±HISTORY_MAX. */
@inline
function addHistory(index: i32, bonus: i32): void {
  const h = unchecked(HISTORY[index]);
  unchecked(HISTORY[index] = h + bonus - h * abs(bonus) / HISTORY_MAX);
}

// ---------------------------------------------------------- static exchange evaluation

/**
 * Static exchange evaluation: the material balance (in SEE_VALUE units) of move `m` followed
 * by the best sequence of recaptures on its target square, both sides always recapturing with
 * their least valuable piece and allowed to stop when continuing would lose material.
 * Positive = the capture wins material.
 */
export function see(pos: Position, m: i32): i32 {
  if (isCastle(m)) return 0;
  const from = moveFrom(m);
  const to = moveTo(m);
  let occ = pos.occupied() ^ sqBB(from);
  let moverType = pieceType(pos.pieceOn(from));
  let gain = 0;
  if (moveFlag(m) == FLAG_EN_PASSANT) {
    gain = unchecked(SEE_VALUE[PAWN]);
    occ ^= sqBB(to ^ 8);
  } else {
    gain = unchecked(SEE_VALUE[pieceType(pos.pieceOn(to))]);
  }
  if (isPromotion(m)) {
    moverType = promotionType(m);
    gain += unchecked(SEE_VALUE[moverType]) - unchecked(SEE_VALUE[PAWN]);
  }
  unchecked(SEE_GAIN[0] = gain);

  const bishopsQueens = pos.pieces(0, BISHOP) | pos.pieces(1, BISHOP) | pos.pieces(0, QUEEN) | pos.pieces(1, QUEEN);
  const rooksQueens = pos.pieces(0, ROOK) | pos.pieces(1, ROOK) | pos.pieces(0, QUEEN) | pos.pieces(1, QUEEN);
  let attackers = pos.attackersTo(to, occ) & occ;
  let onTarget = unchecked(SEE_VALUE[moverType]); // value of the piece that can be captured next
  let side = pos.side ^ 1;
  let d = 0;

  while (d < 38) {
    const mine = attackers & pos.colorBB(side);
    if (mine == 0) break;
    // Least valuable attacker.
    let type = PAWN;
    let candidates: u64 = 0;
    for (; type <= KING; type++) {
      candidates = mine & pos.pieces(side, type);
      if (candidates != 0) break;
    }
    // The king may only recapture if the square is no longer defended.
    if (type == KING && (attackers & pos.colorBB(side ^ 1)) != 0) break;
    d++;
    unchecked(SEE_GAIN[d] = onTarget - unchecked(SEE_GAIN[d - 1]));
    onTarget = unchecked(SEE_VALUE[type]);
    occ ^= sqBB(lsb(candidates));
    // Sliders behind the piece that just captured join in ("x-rays").
    if (type == PAWN || type == BISHOP || type == QUEEN) attackers |= bishopAttacks(to, occ) & bishopsQueens;
    if (type == ROOK || type == QUEEN) attackers |= rookAttacks(to, occ) & rooksQueens;
    attackers &= occ;
    side ^= 1;
  }
  // Each side may stop capturing when that is better: negamax back to the first capture.
  while (d > 0) {
    const a = -unchecked(SEE_GAIN[d - 1]);
    const b = unchecked(SEE_GAIN[d]);
    unchecked(SEE_GAIN[d - 1] = -(a > b ? a : b));
    d--;
  }
  return unchecked(SEE_GAIN[0]);
}

// --------------------------------------------------------------- PV and reporting

/** Triangular PV update: this node's PV = `m` followed by the child's PV. */
@inline
function updatePv(ply: i32, m: i32): void {
  const row = ply * MAX_PLY;
  const childRow = (ply + 1) * MAX_PLY;
  unchecked(PV[row + ply] = m);
  const childLength = unchecked(PV_LENGTH[ply + 1]);
  for (let j = ply + 1; j < childLength; j++) unchecked(PV[row + j] = unchecked(PV[childRow + j]));
  unchecked(PV_LENGTH[ply] = childLength > ply + 1 ? childLength : ply + 1);
}

/** Copies the root PV (row 0 of the PV table) into BEST_PV. */
function saveRootPv(): void {
  const length = unchecked(PV_LENGTH[0]);
  for (let j = 0; j < length; j++) unchecked(BEST_PV[j] = unchecked(PV[j]));
  bestPvLength = length > 0 ? length : 1;
  unchecked(BEST_PV[0] = rootBestMove);
}

/** Converts a search score into "mate in N moves" (0 if it is not a mate score). */
export function mateInMoves(score: i32): i32 {
  if (score > MATE_BOUND) return (MATE - score + 1) / 2;
  if (score < -MATE_BOUND) return -((MATE + score) / 2);
  return 0;
}

/** Writes the best line into the output buffer and calls cb_info. */
function reportInfo(depth: i32, score: i32): void {
  outReset();
  for (let i = 0; i < bestPvLength; i++) {
    if (i > 0) outByte(32);
    outMove(unchecked(BEST_PV[i]));
  }
  const mate = mateInMoves(score);
  sendInfo(depth, max(selDepth, depth), score, mate, <f64>nodes, now() - startTime, outLength());
}
