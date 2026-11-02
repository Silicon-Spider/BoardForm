// PGN export (used by ChessGame.pgn).
import type { GameResult } from "@/types";
import { START_FEN } from "./fen";

const ROSTER = ["Event", "Site", "Date", "Round", "White", "Black", "Result"] as const;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function escapeTag(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

/** Wraps movetext tokens at `width` columns (PGN export format recommends 80). */
function wrap(tokens: string[], width = 80): string {
  const lines: string[] = [];
  let line = "";
  for (const t of tokens) {
    if (line.length === 0) line = t;
    else if (line.length + 1 + t.length <= width) line += " " + t;
    else {
      lines.push(line);
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function buildPgn(opts: {
  startFen: string;
  san: readonly string[];
  headers?: Record<string, string>;
  result: GameResult;
}): string {
  const { startFen, san, result } = opts;
  const tags: Record<string, string> = {
    Event: "?",
    Site: "Chess Builder",
    Date: today(),
    Round: "?",
    White: "?",
    Black: "?",
    ...opts.headers,
    Result: result,
  };
  if (startFen !== START_FEN) {
    tags.SetUp = "1";
    tags.FEN = startFen;
  } else {
    delete tags.SetUp;
    delete tags.FEN;
  }
  const lines: string[] = [];
  for (const key of ROSTER) lines.push(`[${key} "${escapeTag(tags[key] ?? "?")}"]`);
  for (const [key, value] of Object.entries(tags)) {
    if ((ROSTER as readonly string[]).includes(key)) continue;
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    lines.push(`[${key} "${escapeTag(String(value))}"]`);
  }

  const fields = startFen.split(" ");
  let moveNo = Math.max(1, parseInt(fields[5] ?? "1", 10) || 1);
  let white = fields[1] !== "b";
  const tokens: string[] = [];
  san.forEach((m, i) => {
    if (white) tokens.push(`${moveNo}.`);
    else if (i === 0) tokens.push(`${moveNo}...`);
    tokens.push(m);
    if (!white) moveNo++;
    white = !white;
  });
  tokens.push(result);
  return `${lines.join("\n")}\n\n${wrap(tokens)}\n`;
}
