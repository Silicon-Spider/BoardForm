// Display helpers for the test bench (pure).
import { normalizeFen } from "@/chess";
import type { SearchInfo } from "@/types";
import { formatScore } from "@/utils/format";

/** Side to move of a FEN. */
export function sideOf(fen: string): "w" | "b" {
  return normalizeFen(fen).split(" ")[1] === "b" ? "b" : "w";
}

/** Full-move number of a FEN (1 when missing / garbled). */
export function moveNumberOf(fen: string): number {
  const n = Number(normalizeFen(fen).split(" ")[5]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * SAN moves with move numbers, starting from the FEN's side and move number:
 * "12. Nf3 Nc6 13. Bb5" (White to move) or "12... Nc6 13. Bb5" (Black to move).
 */
export function numberedLine(fen: string, sans: readonly string[]): string {
  let n = moveNumberOf(fen);
  let white = sideOf(fen) === "w";
  const parts: string[] = [];
  sans.forEach((san, i) => {
    if (white) parts.push(`${n}. ${san}`);
    else parts.push(i === 0 ? `${n}... ${san}` : san);
    if (!white) n++;
    white = !white;
  });
  return parts.join(" ");
}

/** A search score converted from the side to move's point of view to White's. */
export function whitePovScore(info: Pick<SearchInfo, "scoreCp" | "mate">, sideToMove: "w" | "b"): { cp: number | null; mate: number | null } {
  const flip = sideToMove === "b" ? -1 : 1;
  return {
    cp: info.scoreCp === null ? null : info.scoreCp * flip,
    mate: info.mate === null ? null : info.mate * flip,
  };
}

/** Formatted White-POV score of a search info line. */
export function formatInfoScore(info: Pick<SearchInfo, "scoreCp" | "mate">, sideToMove: "w" | "b"): string {
  const s = whitePovScore(info, sideToMove);
  return formatScore(s.cp, s.mate);
}

/** Signed integer with a real minus sign: 35 → "+35", -12 → "−12", 0 → "0". */
export function signedInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const v = Math.round(n);
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0";
}

/** Thousands separators: 197281 → "197,281". */
export function groupDigits(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/**
 * A friendly message when the text does not even have the shape of a FEN (the strict validator's
 * messages assume it does), else null. "8 ranks separated by /, then the side to move".
 */
export function fenShapeProblem(text: string): string | null {
  const fields = text.trim().split(/\s+/);
  if (fields[0] === "") return "Paste or type a FEN, e.g. the start position: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const ranks = fields[0].split("/").length;
  if (ranks !== 8) return `A FEN starts with the 8 ranks of the board separated by “/” (this has ${ranks}).`;
  if (fields.length < 2) return "The side to move is missing: add “ w” or “ b” after the pieces.";
  return null;
}
