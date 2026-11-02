// Small helpers for the engine tests: assertions, a seeded PRNG, FEN mirroring and
// chess.js based reference checks.

import { Chess } from "chess.js";

export class AssertionError extends Error {}

export function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

export function assertEq(actual, expected, message) {
  if (actual !== expected) throw new AssertionError(`${message}: expected ${expected}, got ${actual}`);
}

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const swapCase = (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());

/** Colour-flipped equivalent of a FEN: ranks mirrored vertically, colours swapped. */
export function mirrorFen(fen) {
  const [board, side, castling = "-", ep = "-", half = "0", full = "1"] = fen.trim().split(/\s+/);
  const ranks = board.split("/").reverse().map((r) => [...r].map(swapCase).join(""));
  let rights = "-";
  if (castling !== "-") {
    const swapped = new Set([...castling].map(swapCase));
    rights = ["K", "Q", "k", "q"].filter((c) => swapped.has(c)).join("") || "-";
  }
  const epOut = ep === "-" ? "-" : ep[0] + String(9 - Number(ep[1]));
  return [ranks.join("/"), side === "w" ? "b" : "w", rights, epOut, half, full].join(" ");
}

/** UCI strings of all legal moves (chess.js reference). */
export function legalUci(chess) {
  return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
}

/** Plays a UCI move on a chess.js game; returns false if illegal. */
export function playUci(chess, uci) {
  try {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
    return true;
  } catch {
    return false;
  }
}

/** chess.js game set up from an ABI position command ("startpos ..." / "fen ... moves ..."). */
export function chessFromCommand(command) {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  let chess;
  if (tokens[i] === "startpos") {
    chess = new Chess();
    i++;
  } else if (tokens[i] === "fen") {
    i++;
    const fields = [];
    while (i < tokens.length && tokens[i] !== "moves") fields.push(tokens[i++]);
    chess = new Chess(fields.join(" "));
  } else {
    throw new Error("bad command " + command);
  }
  if (tokens[i] === "moves") {
    for (i++; i < tokens.length; i++) {
      if (!playUci(chess, tokens[i])) throw new Error(`illegal reference move ${tokens[i]}`);
    }
  }
  return chess;
}

/**
 * Positions from seeded random playouts (deterministic), as FENs. Includes some positions
 * where the game is over (checkmate / stalemate) if a playout ends there.
 */
export function randomPositions(count, seed) {
  const rng = makeRng(seed);
  const out = [];
  // chess.js computes SAN for every move of moves({ verbose: true }), which makes long
  // playouts slow; its internal SAN-free generator is used when available (chess.js 1.x).
  const fast = typeof Chess.prototype._moves === "function" && typeof Chess.prototype._makeMove === "function";
  while (out.length < count) {
    const chess = new Chess();
    const plies = 2 + Math.floor(rng() * 120);
    for (let p = 0; p < plies; p++) {
      const moves = fast ? chess._moves({ legal: true }) : chess.moves({ verbose: true });
      if (moves.length === 0) break;
      // Prefer captures a little so that material imbalances and endgames appear.
      const captures = moves.filter((m) => m.captured);
      const pool = captures.length && rng() < 0.35 ? captures : moves;
      const move = pool[Math.floor(rng() * pool.length)];
      if (fast) chess._makeMove(move);
      else chess.move(move);
    }
    out.push(chess.fen());
  }
  return out;
}

/** Checks that a PV (list of UCI moves) is a legal sequence from `fen`; returns the final game. */
export function playPv(fen, pv) {
  const chess = new Chess(fen);
  for (const uci of pv) {
    if (!playUci(chess, uci)) return { ok: false, chess, failedAt: uci };
  }
  return { ok: true, chess };
}

export { Chess };
