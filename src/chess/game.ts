// ChessGame: a UCI-first wrapper around chess.js used by every package (UI, arena, self-play).
// Moves go in and come out as UCI ("e2e4", "e7e8q", castling as the king move "e1g1");
// SAN is produced alongside for display and PGN.
import { Chess } from "chess.js";
import type { GameResult, Termination } from "@/types";
import { checkFen, normalizeFen, type Color, type PieceCode, parseFenBoard, squareIndex } from "./fen";
import { buildPgn } from "./pgn-writer";

export interface MoveInput {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

export interface PlayedMove {
  uci: string;
  san: string;
}

export interface GameOutcome {
  result: GameResult;
  termination: Termination;
}

/** A legal move in UCI parts. */
interface LegalMove {
  from: string;
  to: string;
  promotion?: string;
  uci: string;
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/;

/** chess.js' internal move record (0x88 squares). Used for fast legal-move generation. */
interface InternalMove {
  from: number;
  to: number;
  promotion?: string;
}

function ox88Name(sq: number): string {
  return "abcdefgh"[sq & 15] + String(8 - (sq >> 4));
}

/**
 * Legal moves of the current position. chess.js' public `moves({ verbose: true })` builds SAN and
 * two FENs per move (quadratic work), so we use its internal generator when it is available
 * (chess.js is pinned to 1.4.0) and fall back to the public API otherwise.
 */
function generateLegalMoves(chess: Chess): LegalMove[] {
  const internal = (chess as unknown as { _moves?: (opts: { legal: boolean }) => InternalMove[] })._moves;
  if (typeof internal === "function") {
    try {
      const list = internal.call(chess, { legal: true });
      if (Array.isArray(list) && (list.length === 0 || typeof list[0].from === "number")) {
        return list.map((m) => {
          const from = ox88Name(m.from);
          const to = ox88Name(m.to);
          return { from, to, promotion: m.promotion, uci: from + to + (m.promotion ?? "") };
        });
      }
    } catch {
      /* fall through to the public API */
    }
  }
  return chess.moves({ verbose: true }).map((m) => ({
    from: m.from,
    to: m.to,
    promotion: m.promotion,
    uci: m.from + m.to + (m.promotion ?? ""),
  }));
}

/** Parses "e2e4" / "e7e8q" (case-insensitive promotion). */
export function parseUci(uci: string): MoveInput | null {
  const m = UCI_RE.exec(uci.trim());
  if (!m) return null;
  const promotion = m[3] ? (m[3].toLowerCase() as MoveInput["promotion"]) : undefined;
  return promotion ? { from: m[1], to: m[2], promotion } : { from: m[1], to: m[2] };
}

/** Strings that would make chess.js play a null move — never accepted as moves. */
const NULL_MOVE_RE = /^(--|0000|z0|null|pass)$/i;

export class ChessGame {
  /** Canonical 6-field FEN of the starting position ("startpos" is expanded to the full FEN). */
  readonly startFen: string;
  private chess: Chess;
  private uciList: string[] = [];
  private sanList: string[] = [];
  /** fens[i] = position after i plies. */
  private fens: string[];
  private legalCache: LegalMove[] | null = null;

  /** @param startFen "startpos" (default) or a FEN. Throws on an invalid FEN. */
  constructor(startFen: string = "startpos") {
    const check = checkFen(startFen);
    if (!check.ok || !check.chess) throw new Error(`Invalid FEN: ${check.error ?? startFen}`);
    // Reload from chess.js' canonical output so the internal en-passant state (and therefore
    // repetition hashing) matches what clones built from `startFen` will see.
    const canonical = check.chess.fen();
    this.chess = canonical === check.fen ? check.chess : new Chess(canonical);
    this.startFen = canonical;
    this.fens = [canonical];
  }

  /** Builds a game from a start position and UCI moves; null when the FEN or a move is illegal. */
  static fromMoves(startFen: string, moves: readonly string[]): ChessGame | null {
    let game: ChessGame;
    try {
      game = new ChessGame(startFen);
    } catch {
      return null;
    }
    for (const m of moves) if (!game.play(m)) return null;
    return game;
  }

  fen(): string {
    return this.fens[this.fens.length - 1];
  }

  turn(): Color {
    return this.chess.turn();
  }

  /** Plies played since the start position. */
  ply(): number {
    return this.uciList.length;
  }

  /** Full-move number of the current position (as in the FEN). */
  moveNumber(): number {
    return this.chess.moveNumber();
  }

  private moves(): LegalMove[] {
    if (!this.legalCache) this.legalCache = generateLegalMoves(this.chess);
    return this.legalCache;
  }

  /** Legal moves in UCI. */
  legalMoves(): string[] {
    return this.moves().map((m) => m.uci);
  }

  /** Legal destinations by origin square (promotions collapse to one destination). */
  legalMovesMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const m of this.moves()) {
      const list = map.get(m.from);
      if (!list) map.set(m.from, [m.to]);
      else if (!list.includes(m.to)) list.push(m.to);
    }
    return map;
  }

  /** Piece on a square of the current position. */
  pieceAt(square: string): PieceCode | null {
    const p = this.chess.get(square as Parameters<Chess["get"]>[0]);
    return p ? (`${p.color}${p.type.toUpperCase()}` as PieceCode) : null;
  }

  /**
   * Finds the legal move matching from/to/promotion exactly. Also accepts castling written as
   * "king takes own rook" (e1h1 → e1g1), which some engines emit.
   */
  private findMove(input: MoveInput): LegalMove | null {
    const promo = input.promotion?.toLowerCase();
    const exact = this.moves().find((m) => m.from === input.from && m.to === input.to && m.promotion === promo);
    if (exact) return exact;
    if (promo) return null;
    const piece = this.pieceAt(input.from);
    const target = this.pieceAt(input.to);
    if (piece && piece[1] === "K" && target === `${piece[0]}R` && input.from[1] === input.to[1]) {
      const kingside = input.to.charCodeAt(0) > input.from.charCodeAt(0);
      const to = (kingside ? "g" : "c") + input.from[1];
      return this.moves().find((m) => m.from === input.from && m.to === to && !m.promotion) ?? null;
    }
    return null;
  }

  private resolve(move: string | MoveInput): MoveInput | null {
    if (typeof move !== "string") {
      return squareIndex(move.from) >= 0 && squareIndex(move.to) >= 0 ? move : null;
    }
    return parseUci(move);
  }

  /** True when the move (UCI, SAN or MoveInput) is legal in the current position. */
  isLegal(move: string | MoveInput): boolean {
    const parsed = this.resolve(move);
    if (parsed) return this.findMove(parsed) !== null;
    if (typeof move !== "string" || NULL_MOVE_RE.test(move.trim())) return false;
    try {
      new Chess(this.fen()).move(move.trim());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Plays a move given as UCI (preferred), SAN ("Nf3", "O-O", "e8=Q") or a MoveInput.
   * Returns the played move or null when it is illegal (the game is unchanged then).
   */
  play(move: string | MoveInput): PlayedMove | null {
    const parsed = this.resolve(move);
    let from: string;
    let to: string;
    let promotion: string | undefined;
    let san: string;
    let after: string;
    if (parsed) {
      const legal = this.findMove(parsed);
      if (!legal) return null;
      try {
        const m = this.chess.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
        ({ san, after } = m);
      } catch {
        return null;
      }
      ({ from, to, promotion } = legal);
    } else {
      if (typeof move !== "string") return null;
      const text = move.trim();
      if (text === "" || NULL_MOVE_RE.test(text)) return null;
      try {
        const m = this.chess.move(text);
        ({ from, to, promotion, san, after } = m);
      } catch {
        return null;
      }
    }
    const uci = from + to + (promotion ?? "");
    this.legalCache = null;
    this.uciList.push(uci);
    this.sanList.push(san);
    this.fens.push(after);
    return { uci, san };
  }

  /** Takes back the last move. */
  undo(): PlayedMove | null {
    if (this.uciList.length === 0) return null;
    if (!this.chess.undo()) return null;
    this.legalCache = null;
    this.fens.pop();
    return { uci: this.uciList.pop()!, san: this.sanList.pop()! };
  }

  /** Takes back moves until `ply` plies remain. */
  truncate(ply: number): void {
    const target = Math.max(0, Math.floor(ply));
    while (this.uciList.length > target) this.undo();
  }

  history(): { uci: string[]; san: string[] } {
    return { uci: this.uciList.slice(), san: this.sanList.slice() };
  }

  lastMove(): { from: string; to: string } | null {
    const last = this.uciList[this.uciList.length - 1];
    return last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null;
  }

  inCheck(): boolean {
    return this.chess.inCheck();
  }

  /** Square of the king in check (side to move), or null. */
  checkSquare(): string | null {
    if (!this.chess.inCheck()) return null;
    return this.chess.findPiece({ type: "k", color: this.chess.turn() })[0] ?? null;
  }

  /**
   * Game end by the rules, or null while the game goes on.
   * Precedence: checkmate > stalemate > insufficient material > threefold > fifty-move.
   */
  outcome(): GameOutcome | null {
    if (this.moves().length === 0) {
      if (this.chess.inCheck()) return { result: this.chess.turn() === "w" ? "0-1" : "1-0", termination: "checkmate" };
      return { result: "1/2-1/2", termination: "stalemate" };
    }
    if (this.chess.isInsufficientMaterial()) return { result: "1/2-1/2", termination: "insufficient-material" };
    if (this.chess.isThreefoldRepetition()) return { result: "1/2-1/2", termination: "threefold" };
    if (this.chess.isDrawByFiftyMoves()) return { result: "1/2-1/2", termination: "fifty-move" };
    return null;
  }

  isGameOver(): boolean {
    return this.outcome() !== null;
  }

  /** FEN after `ply` plies (0 = start position); clamped to the played range. */
  fenAt(ply: number): string {
    const i = Math.min(Math.max(0, Math.floor(ply)), this.fens.length - 1);
    return this.fens[i];
  }

  /** Independent copy including history (so repetition detection keeps working). */
  clone(): ChessGame {
    const copy = new ChessGame(this.startFen);
    for (const uci of this.uciList) {
      const m = parseUci(uci)!;
      copy.chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    }
    copy.uciList = this.uciList.slice();
    copy.sanList = this.sanList.slice();
    copy.fens = this.fens.slice();
    return copy;
  }

  /**
   * PGN text. Seven-tag roster first (missing tags get sensible defaults), SetUp/FEN added for
   * non-standard starts. Result: `result` argument, else headers.Result, else the rules outcome, else "*".
   */
  pgn(headers: Record<string, string> = {}, result?: GameResult): string {
    const res = result ?? (headers.Result as GameResult | undefined) ?? this.outcome()?.result ?? "*";
    return buildPgn({ startFen: this.startFen, san: this.sanList, headers, result: res });
  }

  /** Piece placement of the current position (64 entries, a1 = 0). */
  board(): Array<PieceCode | null> {
    return parseFenBoard(this.fen());
  }
}

/** SAN for a UCI move in a position, or null when the FEN or move is invalid. */
export function uciToSan(fen: string, uci: string): string | null {
  try {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    return new ChessGame(fen).play(parsed)?.san ?? null;
  } catch {
    return null;
  }
}

/** UCI for a SAN move in a position (lenient: "Nf3", "Nf3+", "O-O", "0-0", "e8=Q", "e8Q"), or null. */
export function sanToUci(fen: string, san: string): string | null {
  try {
    return new ChessGame(fen).play(san)?.uci ?? null;
  } catch {
    return null;
  }
}

/**
 * Converts a UCI line (e.g. an engine PV) to SAN, stopping at the first illegal move.
 * Handy for showing principal variations.
 */
export function uciLineToSan(fen: string, line: readonly string[]): string[] {
  let game: ChessGame;
  try {
    game = new ChessGame(normalizeFen(fen));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const uci of line) {
    const parsed = parseUci(uci);
    const played = parsed ? game.play(parsed) : null;
    if (!played) break;
    out.push(played.san);
  }
  return out;
}
