// PGN helpers for arena games: header values and the per-match PGN file.
import type { GameRecord, GameResult, TimeControl, Termination } from "@/types";

/** PGN "Termination" tag value (the standard's vocabulary where it has one). */
export function pgnTermination(t: Termination): string {
  switch (t) {
    case "checkmate":
    case "stalemate":
    case "threefold":
    case "fifty-move":
    case "insufficient-material":
    case "draw-agreed":
      return "normal";
    case "timeout":
      return "time forfeit";
    case "resign":
    case "adjudication":
    case "max-moves":
      return "adjudication";
    case "illegal-move":
      return "rules infraction";
    case "engine-error":
      return "abandoned";
    case "aborted":
      return "unterminated";
    case "unterminated":
    default:
      return "unterminated";
  }
}

function secondsText(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

/** PGN "TimeControl" tag value: "300+2" (seconds), "40/5400+30", or "-" without a clock. */
export function pgnTimeControl(tc: TimeControl | null | undefined): string {
  if (!tc) return "-";
  const base = secondsText(tc.baseMs);
  const inc = tc.incMs > 0 ? `+${secondsText(tc.incMs)}` : "";
  return tc.movesPerControl && tc.movesPerControl > 0 ? `${tc.movesPerControl}/${base}${inc}` : `${base}${inc}`;
}

/** Short, human-readable description of how a game ended (for result lists). */
export function describeTermination(t: Termination, result: GameResult): string {
  const winner = result === "1-0" ? "White" : result === "0-1" ? "Black" : null;
  const loser = result === "1-0" ? "Black" : result === "0-1" ? "White" : null;
  switch (t) {
    case "checkmate":
      return "Checkmate";
    case "stalemate":
      return "Stalemate";
    case "threefold":
      return "Threefold repetition";
    case "fifty-move":
      return "Fifty-move rule";
    case "insufficient-material":
      return "Insufficient material";
    case "timeout":
      return loser ? `${loser} lost on time` : "Time out (no mating material)";
    case "resign":
      return loser ? `${loser} resigned (adjudicated)` : "Resigned";
    case "draw-agreed":
      return "Draw agreed";
    case "adjudication":
      return winner ? `Adjudicated for ${winner}` : "Draw by adjudication";
    case "illegal-move":
      return loser ? `${loser} played an illegal move` : "Illegal move";
    case "engine-error":
      return loser ? `${loser}'s engine failed` : "Engine error";
    case "max-moves":
      return "Move limit reached";
    case "aborted":
      return "Aborted";
    case "unterminated":
    default:
      return "Unfinished";
  }
}

/**
 * Inserts a PGN comment ({text}) right before the result token at the end of the movetext, e.g.
 * the reason an engine lost. Braces in the text are replaced (PGN comments cannot nest).
 */
export function withFinalComment(pgn: string, comment: string | null | undefined): string {
  if (!comment) return pgn;
  const text = comment.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\s+/g, " ").trim();
  const m = /(\s)(1-0|0-1|1\/2-1\/2|\*)\s*$/.exec(pgn);
  if (!m) return pgn;
  const at = m.index + 1;
  return `${pgn.slice(0, at)}{${text}} ${pgn.slice(at).trimEnd()}\n`;
}

/** One PGN file with the given games (in the given order), separated by blank lines. */
export function joinPgn(games: ReadonlyArray<Pick<GameRecord, "pgn">>): string {
  return games.map((g) => g.pgn.trim()).filter(Boolean).join("\n\n") + "\n";
}
