// Shared building blocks of the interactive boards (Chessboard, BoardEditor): geometry,
// square/coordinate/piece/arrow layers, the drag ghost and the promotion picker.
import { forwardRef, memo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { parseFenBoard, squareName, type Color, type PieceCode } from "@/chess";

export type Orientation = "white" | "black";

const PIECE_BASE = `${import.meta.env.BASE_URL ?? "/"}pieces/chessnut/`;

/** URL of a piece image, e.g. pieceUrl("wN"). */
export function pieceUrl(code: PieceCode): string {
  return `${PIECE_BASE}${code}.svg`;
}

/** Display coordinates (row 0 = top edge) of a square index (a1 = 0). */
export function squareToView(index: number, orientation: Orientation): { row: number; col: number } {
  const file = index & 7;
  const rank = index >> 3;
  return orientation === "white" ? { row: 7 - rank, col: file } : { row: rank, col: 7 - file };
}

export function viewToSquare(row: number, col: number, orientation: Orientation): number {
  return orientation === "white" ? (7 - row) * 8 + col : row * 8 + (7 - col);
}

/** Square index under a client point, or -1 when outside the board. */
export function squareAtPoint(el: HTMLElement | null, x: number, y: number, orientation: Orientation): number {
  if (!el) return -1;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return -1;
  const col = Math.floor(((x - r.left) / r.width) * 8);
  const row = Math.floor(((y - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
  return viewToSquare(row, col, orientation);
}

/** Client-space centre of a square. */
export function squareCenter(el: HTMLElement, index: number, orientation: Orientation): { x: number; y: number; size: number } {
  const r = el.getBoundingClientRect();
  const size = r.width / 8;
  const { row, col } = squareToView(index, orientation);
  return { x: r.left + (col + 0.5) * size, y: r.top + (row + 0.5) * size, size };
}

/** Absolute-position style for an overlay occupying one square. */
export function squareStyle(index: number, orientation: Orientation): CSSProperties {
  const { row, col } = squareToView(index, orientation);
  return { left: `${col * 12.5}%`, top: `${row * 12.5}%` };
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------------------------
// Static layers

/** Checkerboard as one SVG (64 rects are cheaper than 64 DOM nodes and leave no seams). */
export const BoardSquares = memo(function BoardSquares() {
  const rects = [];
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++)
      if ((row + col) % 2 === 1) rects.push(<rect key={row * 8 + col} x={col} y={row} width={1} height={1} />);
  return (
    <svg className="cb-squares" viewBox="0 0 8 8" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
      <rect className="cb-sq-light" width={8} height={8} />
      <g className="cb-sq-dark">{rects}</g>
    </svg>
  );
});

export const Coordinates = memo(function Coordinates({ orientation }: { orientation: Orientation }) {
  const files = orientation === "white" ? "abcdefgh" : "hgfedcba";
  const labels = [];
  for (let row = 0; row < 8; row++) {
    const rank = orientation === "white" ? 8 - row : row + 1;
    labels.push(
      <span key={`r${row}`} className={cx("cb-coord cb-coord-rank", row % 2 === 0 ? "on-light" : "on-dark")} style={{ top: `${row * 12.5}%` }}>
        {rank}
      </span>,
    );
  }
  for (let col = 0; col < 8; col++) {
    labels.push(
      <span key={`f${col}`} className={cx("cb-coord cb-coord-file", (7 + col) % 2 === 0 ? "on-light" : "on-dark")} style={{ left: `${col * 12.5}%` }}>
        {files[col]}
      </span>,
    );
  }
  return (
    <div className="cb-coords" aria-hidden="true">
      {labels}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Pieces with move animation

export interface TrackedPiece {
  id: number;
  code: PieceCode;
  index: number;
}

let nextPieceId = 1;

function distance(a: number, b: number): number {
  return Math.hypot((a & 7) - (b & 7), (a >> 3) - (b >> 3));
}

/**
 * Gives every piece a stable id across positions so a piece that moves keeps its DOM node and
 * its CSS transform transition animates the move. Only small changes (one or two moves:
 * at most 2 squares gained, 3 lost) are matched; bigger jumps get fresh ids (no animation).
 * `noAnimate` marks a move the user just dropped by drag — it must not slide again.
 */
export function trackPieces(
  prev: TrackedPiece[] | null,
  board: ReadonlyArray<PieceCode | null>,
  noAnimate: { from: number; to: number } | null,
): TrackedPiece[] {
  const prevBySquare = new Map<number, TrackedPiece>();
  for (const p of prev ?? []) prevBySquare.set(p.index, p);
  const result: TrackedPiece[] = [];
  const appeared: number[] = [];
  const kept = new Set<number>();
  for (let i = 0; i < 64; i++) {
    const code = board[i];
    if (!code) continue;
    const p = prevBySquare.get(i);
    if (p && p.code === code) {
      result.push(p);
      kept.add(i);
    } else appeared.push(i);
  }
  const vanished = (prev ?? []).filter((p) => !kept.has(p.index));
  const small = prev !== null && appeared.length <= 2 && vanished.length <= 3;
  for (const i of appeared) {
    const code = board[i]!;
    let match: TrackedPiece | null = null;
    if (small) {
      let best = Infinity;
      for (const v of vanished) {
        if (v.code !== code) continue;
        const d = distance(v.index, i);
        if (d < best) {
          best = d;
          match = v;
        }
      }
      if (match) vanished.splice(vanished.indexOf(match), 1);
    }
    const reuse = match !== null && !(noAnimate && match.index === noAnimate.from && i === noAnimate.to);
    result.push({ id: reuse ? match!.id : nextPieceId++, code, index: i });
  }
  // Stable DOM order (by id): re-ordering nodes would cancel running transitions.
  return result.sort((a, b) => a.id - b.id);
}

/** Pieces of `fen` with ids that persist across renders (see trackPieces). */
export function useTrackedPieces(fen: string, noAnimateRef: { current: { from: number; to: number; at: number } | null }): TrackedPiece[] {
  const state = useRef<{ fen: string; pieces: TrackedPiece[] } | null>(null);
  if (!state.current || state.current.fen !== fen) {
    const na = noAnimateRef.current;
    const recent = na && performance.now() - na.at < 3000 ? na : null;
    state.current = { fen, pieces: trackPieces(state.current?.pieces ?? null, parseFenBoard(fen), recent) };
    noAnimateRef.current = null;
  }
  return state.current.pieces;
}

export const PieceLayer = memo(function PieceLayer({
  pieces,
  orientation,
  hidden,
  faded,
}: {
  pieces: TrackedPiece[];
  orientation: Orientation;
  /** Square whose piece is invisible (e.g. a pawn waiting for the promotion choice). */
  hidden?: number | null;
  /** Square whose piece is shown as a translucent placeholder (origin of a drag). */
  faded?: number | null;
}) {
  return (
    <div className="cb-pieces">
      {pieces.map((p) => {
        const { row, col } = squareToView(p.index, orientation);
        return (
          <div
            key={`${orientation[0]}${p.id}`}
            className={cx("cb-piece", p.index === faded && "cb-piece--faded", p.index === hidden && "cb-piece--hidden")}
            data-square={squareName(p.index)}
            data-piece={p.code}
            style={{ transform: `translate(${col * 100}%, ${row * 100}%)`, backgroundImage: `url(${pieceUrl(p.code)})` }}
          />
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Highlights

export interface HighlightItem {
  index: number;
  kind: "last" | "selected" | "check" | "dest" | "capture" | "hover" | "custom";
  color?: string;
}

export const HighlightLayer = memo(function HighlightLayer({ items, orientation }: { items: HighlightItem[]; orientation: Orientation }) {
  return (
    <div className="cb-highlights" aria-hidden="true">
      {items.map((h, i) => (
        <div
          key={`${h.kind}-${h.index}-${i}`}
          className={`cb-hl cb-hl--${h.kind}`}
          data-square={squareName(h.index)}
          style={h.color ? { ...squareStyle(h.index, orientation), background: h.color } : squareStyle(h.index, orientation)}
        />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Arrows & circles

export interface ShapeView {
  from: number;
  to: number;
  color: string;
  /** Slightly transparent preview while drawing. */
  preview?: boolean;
}

function arrowPolygon(x1: number, y1: number, x2: number, y2: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const dx = (x2 - x1) / len;
  const dy = (y2 - y1) / len;
  const nx = -dy;
  const ny = dx;
  const shaft = 0.075; // half widths in squares
  const head = 0.24;
  const headLen = 0.42;
  const tipX = x2 - dx * 0.08;
  const tipY = y2 - dy * 0.08;
  const sx = x1 + dx * 0.12;
  const sy = y1 + dy * 0.12;
  const bx = tipX - dx * headLen;
  const by = tipY - dy * headLen;
  const pts = [
    [sx + nx * shaft, sy + ny * shaft],
    [bx + nx * shaft, by + ny * shaft],
    [bx + nx * head, by + ny * head],
    [tipX, tipY],
    [bx - nx * head, by - ny * head],
    [bx - nx * shaft, by - ny * shaft],
    [sx - nx * shaft, sy - ny * shaft],
  ];
  return pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
}

export const ArrowLayer = memo(function ArrowLayer({ shapes, orientation }: { shapes: ShapeView[]; orientation: Orientation }) {
  if (shapes.length === 0) return null;
  return (
    <svg className="cb-arrows" viewBox="0 0 8 8" aria-hidden="true">
      {shapes.map((s, i) => {
        const a = squareToView(s.from, orientation);
        const b = squareToView(s.to, orientation);
        const opacity = s.preview ? 0.55 : 0.82;
        if (s.from === s.to) {
          return (
            <circle
              key={i}
              cx={a.col + 0.5}
              cy={a.row + 0.5}
              r={0.44}
              fill="none"
              strokeWidth={0.075}
              style={{ stroke: s.color, opacity }}
            />
          );
        }
        return <polygon key={i} points={arrowPolygon(a.col + 0.5, a.row + 0.5, b.col + 0.5, b.row + 0.5)} style={{ fill: s.color, opacity }} />;
      })}
    </svg>
  );
});

// ---------------------------------------------------------------------------------------------
// Drag ghost (portal, position: fixed — never clipped by scrolling ancestors)

export interface GhostProps {
  code: PieceCode;
  size: number;
  /** CSS transform placing the ghost (see ghostTransform); updated imperatively while dragging. */
  transform: string;
}

export function ghostTransform(x: number, y: number, size: number, touch?: boolean): string {
  // On touch the piece is enlarged and lifted above the finger so it stays visible.
  const lift = touch ? size * 0.55 : 0;
  return `translate(${x - size / 2}px, ${y - size / 2 - lift}px) scale(${touch ? 1.5 : 1.08})`;
}

export const DragGhost = forwardRef<HTMLDivElement, GhostProps>(function DragGhost({ code, size, transform }, ref) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="cb-ghost"
      data-piece={code}
      style={{ width: size, height: size, backgroundImage: `url(${pieceUrl(code)})`, transform }}
    />,
    document.body,
  );
});

// ---------------------------------------------------------------------------------------------
// Promotion picker

const PROMOTION_ORDER = ["q", "n", "r", "b"] as const;
const PROMOTION_NAMES: Record<string, string> = { q: "Queen", n: "Knight", r: "Rook", b: "Bishop" };

export function PromotionPicker({
  to,
  color,
  orientation,
  onPick,
  onCancel,
}: {
  to: number;
  color: Color;
  orientation: Orientation;
  onPick: (piece: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) {
  const { row, col } = squareToView(to, orientation);
  const downward = row < 4;
  return (
    <div
      className="cb-promo"
      role="dialog"
      aria-label="Choose promotion piece"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {PROMOTION_ORDER.map((p, i) => {
        const r = downward ? row + i : row - i;
        return (
          <button
            key={p}
            type="button"
            className="cb-promo-piece"
            data-promotion={p}
            aria-label={PROMOTION_NAMES[p]}
            title={PROMOTION_NAMES[p]}
            style={{ left: `${col * 12.5}%`, top: `${r * 12.5}%` }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPick(p)}
          >
            <span style={{ backgroundImage: `url(${pieceUrl(`${color}${p.toUpperCase()}` as PieceCode)})` }} />
          </button>
        );
      })}
    </div>
  );
}
