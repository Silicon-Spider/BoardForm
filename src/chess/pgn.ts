// PGN import: first game of a PGN text → headers, start FEN and UCI moves.
// Comments ({...} and ;...), variations (nested parentheses), NAGs ($n), move numbers,
// annotation glyphs (!, ?, !?, ...), "e.p." markers and the result token are ignored.
import { ChessGame } from "./game";

export interface ParsedPgn {
  headers: Record<string, string>;
  /** Full FEN of the start position (START_FEN unless a FEN tag is present). */
  startFen: string;
  /** Moves in UCI. */
  moves: string[];
}

const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "½-½", "*"]);
const HEADER_RE = /\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/g;

function unescapeTag(v: string): string {
  return v.replace(/\\(["\\])/g, "$1");
}

/** Splits a PGN into its header section and movetext (first game only). */
function splitSections(text: string): { headerText: string; moveText: string } {
  const lines = text.split("\n");
  let i = 0;
  const headerLines: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("%")) {
      if (headerLines.length > 0 && line === "") {
        i++;
        break;
      }
      continue;
    }
    if (line.startsWith("[")) headerLines.push(line);
    else break;
  }
  return { headerText: headerLines.join("\n"), moveText: lines.slice(i).join("\n") };
}

/** Cleans a SAN token: move-number prefix, glyphs, "e.p." and zero-castling. */
function cleanSan(token: string): string {
  let t = token.replace(/^\d+\.+/, "");
  t = t.replace(/e\.p\.?$/i, "");
  t = t.replace(/[!?]+$/, "");
  if (/^[0O]-[0O](-[0O])?[+#]?$/i.test(t)) t = t.replace(/0/g, "O").replace(/o/g, "O");
  return t;
}

export function parsePgn(pgn: string): ParsedPgn | null {
  const text = pgn.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (text.trim() === "") return null;

  const { headerText, moveText } = splitSections(text);
  const headers: Record<string, string> = {};
  for (const m of headerText.matchAll(HEADER_RE)) headers[m[1]] = unescapeTag(m[2]);

  let game: ChessGame;
  try {
    game = new ChessGame(headers.FEN && headers.FEN.trim() !== "" ? headers.FEN : "startpos");
  } catch {
    return null;
  }

  let depth = 0;
  let pos = 0;
  const src = moveText;
  const n = src.length;
  while (pos < n) {
    const ch = src[pos];
    if (/\s/.test(ch)) {
      pos++;
      continue;
    }
    if (ch === "{") {
      const end = src.indexOf("}", pos + 1);
      pos = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === ";") {
      const end = src.indexOf("\n", pos + 1);
      pos = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "%" && (pos === 0 || src[pos - 1] === "\n")) {
      const end = src.indexOf("\n", pos + 1);
      pos = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      pos++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      pos++;
      continue;
    }
    if (ch === "[") {
      // A tag pair outside a variation: the next game begins.
      if (depth === 0) break;
      pos++;
      continue;
    }
    // Read one token.
    let end = pos;
    while (end < n && !/[\s{}();[]/.test(src[end])) end++;
    const token = src.slice(pos, end);
    pos = end;
    if (depth > 0) continue;
    if (RESULT_TOKENS.has(token)) break;
    if (/^\$\d+$/.test(token) || /^\d+\.*$/.test(token) || /^\.+$/.test(token) || /^[!?]+$/.test(token)) continue;
    if (/^e\.p\.?$/i.test(token)) continue;
    const san = cleanSan(token);
    if (san === "") continue;
    if (RESULT_TOKENS.has(san)) break;
    if (!game.play(san)) return null;
  }

  return { headers, startFen: game.startFen, moves: game.history().uci };
}
