// One engine-vs-engine game: the move loop shared by matches (and usable by any page).
//
// Written against the small GameEngine interface (./types) so it runs with real EngineClients in
// the browser and with fake engines in unit tests. No React, no workers, no storage.
//
// Per move: position(start, moves) + go(limits) for the side to move, where the limits come from
// toSearchLimits() with the side's caps and both clocks. The search's duration (measured in the
// engine's worker, so a busy page never costs an engine time) is charged to the mover's clock.
//
// The game ends on (checked in this order):
//   rules endings (mate, stalemate, insufficient material, threefold, fifty moves) via ChessGame;
//   a crash (stopReason "error") or a rejected position → the mover loses, "engine-error";
//   a time forfeit (stopReason "timeout", or the clock below zero) → the mover loses, "timeout"
//     (a draw when the opponent cannot mate at all);
//   no move although legal moves exist → "engine-error"; a move that is not legal → "illegal-move";
//   adjudication (./adjudication) → "resign" / "adjudication"; the ply limit → draw, "max-moves";
//   the AbortSignal → result "*", "aborted".
import { ChessGame, START_FEN } from "@/chess";
import { toSearchLimits } from "@/engine-host/limits";
import type { GameResult, SearchInfo, SearchResult, Termination } from "@/types";
import { Adjudicator, MATE_SCORE } from "./adjudication";
import { chargeMove, hasMatingMaterial, initialClockMs } from "./clock";
import { pgnTermination, pgnTimeControl, withFinalComment } from "./pgn";
import type { GameEngine, LiveGameView, PlayEngineGameOptions, PlayedGame } from "./types";

type Side = "w" | "b";

interface GameEnd {
  result: GameResult;
  termination: Termination;
  detail: string | null;
}

/** UCI move syntax (promotion letter case-insensitive, as ChessGame accepts it). */
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/;

const COLOR_NAME: Record<Side, string> = { w: "White", b: "Black" };
const other = (s: Side): Side => (s === "w" ? "b" : "w");
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** White-POV score of a search's final info (mate → ±MATE_SCORE), or null when unknown. */
export function whitePovScore(info: SearchInfo | null | undefined, side: Side): number | null {
  if (!info) return null;
  let s: number;
  if (typeof info.mate === "number" && info.mate !== 0) s = info.mate > 0 ? MATE_SCORE : -MATE_SCORE;
  else if (typeof info.scoreCp === "number" && Number.isFinite(info.scoreCp)) s = Math.max(-MATE_SCORE, Math.min(MATE_SCORE, info.scoreCp));
  else return null;
  return side === "w" ? s : -s || 0; // `|| 0` turns -0 into 0
}

function loss(side: Side, termination: Termination, detail: string): GameEnd {
  return { result: side === "w" ? "0-1" : "1-0", termination, detail };
}

/**
 * Plays one game between two engines. Resolves when the game is over (or aborted: result "*",
 * termination "aborted"). Rejects only for an invalid start FEN.
 */
export async function runEngineGame(opts: PlayEngineGameOptions, engines: { white: GameEngine; black: GameEngine }): Promise<PlayedGame> {
  const { white, black, adjudication, signal } = opts;
  const game = new ChessGame(opts.startFen); // throws "Invalid FEN: ..."
  const positionFen = game.startFen === START_FEN ? "startpos" : game.startFen;
  const label = (s: Side) => `${COLOR_NAME[s]} (${s === "w" ? white.name : black.name})`;
  const log = (level: "info" | "warn" | "error", text: string) => {
    try {
      opts.onLog?.(level, text);
    } catch (err) {
      console.error("playEngineGame onLog callback failed", err);
    }
  };

  const evals: Array<number | null> = [];
  const times: number[] = [];

  // --- opening moves (not on the clock, no scores) ---
  let openingPlies = 0;
  for (const move of opts.openingMoves ?? []) {
    if (game.isGameOver()) break;
    if (!game.play(move)) {
      log("warn", `Opening move ${move} is not legal after ${openingPlies} plies; the engines take over from there.`);
      break;
    }
    evals.push(null);
    times.push(0);
    openingPlies++;
  }

  const tc = { w: white.config.timeControl ?? null, b: black.config.timeControl ?? null };
  const clock: Record<Side, number | null> = { w: initialClockMs(tc.w), b: initialClockMs(tc.b) };
  const movesOnClock: Record<Side, number> = { w: 0, b: 0 };
  const info: Record<Side, SearchInfo | null> = { w: null, b: null };
  const adjudicator = new Adjudicator(adjudication);
  const maxPlies = typeof adjudication.maxPlies === "number" && adjudication.maxPlies > 0 ? Math.floor(adjudication.maxPlies) : null;
  let thinking: Side | null = null;

  // --- throttled live updates ---
  const interval = Math.max(0, opts.updateIntervalMs ?? 100);
  let lastEmitAt = -Infinity;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  const snapshot = (): Omit<LiveGameView, "slot" | "index"> => {
    const h = game.history();
    return {
      white: { id: white.engineId, name: white.name },
      black: { id: black.engineId, name: black.name },
      startFen: opts.startFen,
      fen: game.fen(),
      moves: h.uci,
      san: h.san,
      lastMove: h.uci.length > 0 ? h.uci[h.uci.length - 1] : null,
      sideToMove: game.turn(),
      whiteMs: clock.w,
      blackMs: clock.b,
      whiteInfo: info.w,
      blackInfo: info.b,
      opening: opts.opening ?? null,
      openingPlies,
      thinking,
    };
  };
  const emitNow = () => {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    lastEmitAt = performance.now();
    try {
      opts.onUpdate?.(snapshot());
    } catch (err) {
      console.error("playEngineGame onUpdate callback failed", err);
    }
  };
  const emit = () => {
    if (!opts.onUpdate) return;
    const wait = interval - (performance.now() - lastEmitAt);
    if (wait <= 0) emitNow();
    else if (!emitTimer) emitTimer = setTimeout(emitNow, wait);
  };

  let end: GameEnd | null = null;

  // --- new game for both engines ---
  for (const side of ["w", "b"] as const) {
    if (end || signal?.aborted) break;
    try {
      await (side === "w" ? engines.white : engines.black).newGame();
    } catch (err) {
      if (!signal?.aborted) end = loss(side, "engine-error", `${label(side)}'s engine failed to start a new game: ${messageOf(err)}`);
    }
  }
  emit();

  // --- move loop ---
  while (!end) {
    if (signal?.aborted) {
      end = { result: "*", termination: "aborted", detail: "The game was stopped before it ended" };
      break;
    }
    const outcome = game.outcome();
    if (outcome) {
      end = { ...outcome, detail: null };
      break;
    }
    if (maxPlies !== null && game.ply() >= maxPlies) {
      end = { result: "1/2-1/2", termination: "max-moves", detail: `Drawn after reaching the limit of ${maxPlies} plies` };
      break;
    }

    const side = game.turn();
    const engine = side === "w" ? engines.white : engines.black;
    const config = side === "w" ? white.config : black.config;

    let accepted: boolean;
    try {
      accepted = await engine.position(positionFen, game.history().uci);
    } catch (err) {
      if (signal?.aborted) continue;
      end = loss(side, "engine-error", `${label(side)}'s engine failed while setting up the position: ${messageOf(err)}`);
      break;
    }
    if (signal?.aborted) continue;
    if (!accepted) {
      end = loss(side, "engine-error", `${label(side)}'s engine rejected the position after ${game.ply()} plies`);
      break;
    }

    const limits = toSearchLimits({
      limits: config.limits ?? {},
      whiteTc: tc.w,
      blackTc: tc.b,
      whiteMs: clock.w,
      blackMs: clock.b,
      sideToMove: side,
      // Moves played on the clock (book moves are not): only used for moves-to-go.
      movesPlayed: movesOnClock.w + movesOnClock.b,
    });

    thinking = side;
    emit();
    const onAbort = () => engine.stop();
    signal?.addEventListener("abort", onAbort);
    let res: SearchResult;
    try {
      res = await engine.go(limits, (i) => {
        info[side] = i;
        emit();
      });
    } catch (err) {
      res = { bestMove: null, info: null, elapsedMs: 0, stopReason: "error", error: messageOf(err) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    thinking = null;
    if (signal?.aborted) continue;
    if (res.info) info[side] = res.info;

    if (res.stopReason === "error") {
      end = loss(side, "engine-error", `${label(side)}'s engine crashed: ${res.error ?? "unknown error"}`);
      break;
    }

    const elapsed = Number.isFinite(res.elapsedMs) ? Math.max(0, res.elapsedMs) : 0;
    const charge = chargeMove(tc[side], clock[side], elapsed, movesOnClock[side]);
    if (res.stopReason === "timeout" || charge.flagged) {
      if (clock[side] !== null) clock[side] = 0;
      const detail =
        clock[side] !== null
          ? `${label(side)} ran out of time`
          : `${label(side)}'s search did not stop within its limit and had to be cut short`;
      end = hasMatingMaterial(game.fen(), other(side))
        ? loss(side, "timeout", detail)
        : { result: "1/2-1/2", termination: "timeout", detail: `${detail}, but ${COLOR_NAME[other(side)]} has no mating material` };
      break;
    }

    const best = (res.bestMove ?? "").trim();
    if (!best) {
      end = loss(side, "engine-error", `${label(side)}'s engine produced no move although legal moves exist`);
      break;
    }
    if (!UCI_MOVE.test(best) || !game.isLegal(best)) {
      end = loss(side, "illegal-move", `${label(side)} played "${best.slice(0, 16)}", which is not a legal move in this position`);
      break;
    }
    game.play(best);
    clock[side] = charge.remaining;
    movesOnClock[side]++;
    times.push(elapsed);
    const score = whitePovScore(res.info, side);
    evals.push(score);
    emit();

    const adjudicated = adjudicator.record(side, score, game.ply());
    if (adjudicated && !game.outcome()) {
      end = adjudicated;
      break;
    }
  }

  // --- result ---
  const final = end;
  const tags: Record<string, string> = {
    Event: opts.event ?? "Engine game",
    Site: "Chess Builder",
    Round: opts.round ?? "?",
    White: white.name,
    Black: black.name,
    Termination: pgnTermination(final.termination),
    TimeControl: pgnTimeControl(tc.w),
    PlyCount: String(game.ply()),
  };
  if (pgnTimeControl(tc.w) !== pgnTimeControl(tc.b)) {
    tags.TimeControl = "?";
    tags.WhiteTimeControl = pgnTimeControl(tc.w);
    tags.BlackTimeControl = pgnTimeControl(tc.b);
  }
  if (opts.opening) tags.Opening = opts.opening;
  if (opts.eco) tags.ECO = opts.eco;
  const history = game.history();
  const pgn = withFinalComment(game.pgn(tags, final.result), final.detail);

  if (emitTimer) clearTimeout(emitTimer);
  if (opts.onUpdate) emitNow();
  if (final.detail && final.termination !== "aborted") {
    const level = final.termination === "engine-error" || final.termination === "illegal-move" ? "error" : final.termination === "timeout" ? "warn" : "info";
    log(level, final.detail);
  }

  return {
    startFen: opts.startFen,
    moves: history.uci,
    san: history.san,
    result: final.result,
    termination: final.termination,
    evals,
    times,
    pgn,
    opening: opts.opening ?? null,
    detail: final.detail,
    openingPlies,
  };
}
