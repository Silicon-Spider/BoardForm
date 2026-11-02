// Static, very cheap board for lists and thumbnails: one CSS-grid element with background-image
// pieces, no chess logic, memoized by value.
import { memo, type CSSProperties } from "react";
import { parseFenBoard, squareIndex } from "@/chess";
import { pieceUrl, squareToView, type Orientation } from "./boardCore";
import "./MiniBoard.css";

export interface MiniBoardProps {
  fen: string;
  orientation?: Orientation;
  lastMove?: { from: string; to: string } | string | null;
  /** Width in px (number) or any CSS length. Default: fill the container. */
  size?: number | string;
  className?: string;
  title?: string;
  onClick?: () => void;
}

function lastMoveSquares(lm: MiniBoardProps["lastMove"]): number[] {
  if (!lm) return [];
  const from = typeof lm === "string" ? lm.slice(0, 2) : lm.from;
  const to = typeof lm === "string" ? lm.slice(2, 4) : lm.to;
  return [squareIndex(from), squareIndex(to)].filter((i) => i >= 0);
}

function MiniBoardImpl({ fen, orientation = "white", lastMove, size, className, title, onClick }: MiniBoardProps) {
  const board = parseFenBoard(fen);
  const style: CSSProperties | undefined = size === undefined ? undefined : { width: size };
  const cells = [];
  for (const i of lastMoveSquares(lastMove)) {
    const { row, col } = squareToView(i, orientation);
    cells.push(<div key={`h${i}`} className="cb-mini-hl" style={{ gridRow: row + 1, gridColumn: col + 1 }} />);
  }
  for (let i = 0; i < 64; i++) {
    const code = board[i];
    if (!code) continue;
    const { row, col } = squareToView(i, orientation);
    cells.push(
      <div
        key={i}
        className="cb-mini-piece"
        style={{ gridRow: row + 1, gridColumn: col + 1, backgroundImage: `url(${pieceUrl(code)})` }}
      />,
    );
  }
  return (
    <div
      className={["cb-mini", onClick ? "cb-mini--clickable" : "", className ?? ""].filter(Boolean).join(" ")}
      style={style}
      title={title}
      role={onClick ? "button" : "img"}
      aria-label={title ?? "Chess position"}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {cells}
    </div>
  );
}

function sameLastMove(a: MiniBoardProps["lastMove"], b: MiniBoardProps["lastMove"]): boolean {
  if (a === b) return true;
  return lastMoveSquares(a).join() === lastMoveSquares(b).join();
}

export const MiniBoard = memo(
  MiniBoardImpl,
  (a, b) =>
    a.fen === b.fen &&
    a.orientation === b.orientation &&
    a.size === b.size &&
    a.className === b.className &&
    a.title === b.title &&
    a.onClick === b.onClick &&
    sameLastMove(a.lastMove, b.lastMove),
);
