// Interactive chessboard: click-to-move and drag-and-drop (pointer events, mouse + touch),
// legal-move hints, last-move / check / selection / custom highlights, arrows (plus
// right-click-drawn arrows and circles), coordinates, promotion picker and move animation.
// The board is controlled: it renders `fen` and reports complete legal moves through onMove.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChessGame, fenTurn, parseFenBoard, squareIndex, squareName, type Color, type MoveInput, type PieceCode } from "@/chess";
import {
  ArrowLayer,
  BoardSquares,
  Coordinates,
  DragGhost,
  HighlightLayer,
  PieceLayer,
  PromotionPicker,
  cx,
  ghostTransform,
  squareAtPoint,
  squareCenter,
  useTrackedPieces,
  type HighlightItem,
  type Orientation,
  type ShapeView,
} from "./boardCore";
import "./Chessboard.css";

export interface ChessboardArrow {
  from: string;
  /** Same as `from` draws a circle around the square. */
  to: string;
  /** Any CSS colour (drawn at ~80% opacity). Default: var(--cb-arrow), a blue. */
  color?: string;
}

export interface ChessboardProps {
  /** Position to show ("startpos" or FEN). */
  fen: string;
  /** Which side is at the bottom. Default "white". */
  orientation?: Orientation;
  /** Who may move pieces (only ever the side to move). Default: "both" with onMove, else "none". */
  interactive?: "white" | "black" | "both" | "none";
  /** Called with complete legal moves only (promotion already chosen). */
  onMove?: (move: MoveInput) => void;
  /** Highlighted last move: { from, to } or a UCI string. */
  lastMove?: { from: string; to: string } | string | null;
  /**
   * Check highlight: undefined/true = the king of the side to move when it is in check,
   * a square name = that square, false/null = none.
   */
  check?: boolean | string | null;
  arrows?: ChessboardArrow[];
  /** Extra square colours, e.g. { e4: "rgba(255,0,0,.4)" }. */
  squareHighlights?: Record<string, string>;
  /** Default true. */
  showCoordinates?: boolean;
  /** Piece slide duration when the position changes by one move. Default 150; 0 disables. */
  animationMs?: number;
  className?: string;
  style?: CSSProperties;
  /** Show legal-move dots for the selected piece. Default true. */
  showLegalMoves?: boolean;
  /** Right-click drag draws arrows, right-click a square draws a circle (left click clears). Default true. */
  drawable?: boolean;
  /** Any left click on a square (after selection logic). */
  onSquareClick?: (square: string) => void;
  "aria-label"?: string;
}

interface PieceDrag {
  kind: "piece";
  from: number;
  code: PieceCode;
  startX: number;
  startY: number;
  x: number;
  y: number;
  pointerId: number;
  touch: boolean;
  started: boolean;
  /** The square was already selected before this press (a second click deselects). */
  wasSelected: boolean;
}

interface DrawGesture {
  kind: "draw";
  from: number;
  to: number;
  color: string;
}

const BRUSH = { green: "#15781b", red: "#882020", blue: "#003088", yellow: "#e68f00" };

function brushFor(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string {
  const mod = e.ctrlKey || e.altKey || e.metaKey;
  if (e.shiftKey && mod) return BRUSH.yellow;
  if (e.shiftKey) return BRUSH.red;
  if (mod) return BRUSH.blue;
  return BRUSH.green;
}

interface PositionInfo {
  board: Array<PieceCode | null>;
  turn: Color;
  /** origin index → destination indices */
  dests: Map<number, number[]>;
  /** from * 64 + to for moves that need a promotion piece */
  promotions: Set<number>;
  checkIndex: number;
}

function analyse(fen: string): PositionInfo {
  const board = parseFenBoard(fen);
  const dests = new Map<number, number[]>();
  const promotions = new Set<number>();
  let turn: Color = fenTurn(fen);
  let checkIndex = -1;
  try {
    const game = new ChessGame(fen);
    turn = game.turn();
    for (const uci of game.legalMoves()) {
      const f = squareIndex(uci.slice(0, 2));
      const t = squareIndex(uci.slice(2, 4));
      const list = dests.get(f);
      if (!list) dests.set(f, [t]);
      else if (!list.includes(t)) list.push(t);
      if (uci.length === 5) promotions.add(f * 64 + t);
    }
    const cs = game.checkSquare();
    checkIndex = cs ? squareIndex(cs) : -1;
  } catch {
    /* invalid FEN: show the pieces, allow no moves */
  }
  return { board, turn, dests, promotions, checkIndex };
}

function parseLastMove(lm: ChessboardProps["lastMove"]): [number, number] | null {
  if (!lm) return null;
  const from = typeof lm === "string" ? lm.slice(0, 2) : lm.from;
  const to = typeof lm === "string" ? lm.slice(2, 4) : lm.to;
  const f = squareIndex(from);
  const t = squareIndex(to);
  return f >= 0 && t >= 0 ? [f, t] : null;
}

export function Chessboard(props: ChessboardProps) {
  const {
    fen,
    orientation = "white",
    interactive,
    lastMove,
    check,
    arrows,
    squareHighlights,
    showCoordinates = true,
    animationMs = 150,
    className,
    style,
    showLegalMoves = true,
    drawable = true,
  } = props;

  // Latest callbacks without making them part of memo dependencies.
  const onMoveRef = useRef(props.onMove);
  const onSquareClickRef = useRef(props.onSquareClick);
  onMoveRef.current = props.onMove;
  onSquareClickRef.current = props.onSquareClick;

  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<PieceDrag | DrawGesture | null>(null);
  const noAnimate = useRef<{ from: number; to: number; at: number } | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Current ghost transform: the single source of truth for renders and imperative updates. */
  const ghostTf = useRef("translate(-9999px, -9999px)");

  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; code: PieceCode; size: number; touch: boolean } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [promotion, setPromotion] = useState<{ from: number; to: number; color: Color } | null>(null);
  const [shapes, setShapes] = useState<ShapeView[]>([]);
  const [drawing, setDrawing] = useState<ShapeView | null>(null);

  const pos = useMemo(() => analyse(fen), [fen]);
  const pieces = useTrackedPieces(fen, noAnimate);
  const mode = interactive ?? (props.onMove ? "both" : "none");
  const canInteract = mode !== "none" && !!props.onMove;

  // A new position invalidates any selection, pending promotion or drag.
  useLayoutEffect(() => {
    setSelected(null);
    setPromotion(null);
    setHover(null);
    if (gesture.current?.kind === "piece") gesture.current = null;
    setDrag(null);
  }, [fen]);

  useEffect(
    () => () => {
      if (snapTimer.current) clearTimeout(snapTimer.current);
    },
    [],
  );

  const movable = useCallback(
    (color: Color) => {
      if (!onMoveRef.current || mode === "none" || color !== pos.turn) return false;
      return mode === "both" || (mode === "white" ? color === "w" : color === "b");
    },
    [mode, pos.turn],
  );

  /** Destination actually played for from→to (maps "king onto own rook" to castling), or -1. */
  const resolveTarget = useCallback(
    (from: number, to: number): number => {
      const list = pos.dests.get(from);
      if (!list) return -1;
      if (list.includes(to)) return to;
      const piece = pos.board[from];
      if (piece?.[1] === "K" && pos.board[to] === `${piece[0]}R` && from >> 3 === to >> 3) {
        const castle = to > from ? from + 2 : from - 2;
        if (list.includes(castle)) return castle;
      }
      return -1;
    },
    [pos],
  );

  const finishSnap = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = null;
    setDrag(null);
  }, []);

  /** Plays from→to (or opens the promotion picker). Returns false when not legal. */
  const attemptMove = useCallback(
    (from: number, to: number, dropped: boolean): boolean => {
      const target = resolveTarget(from, to);
      if (target < 0) return false;
      setSelected(null);
      if (pos.promotions.has(from * 64 + target)) {
        setPromotion({ from, to: target, color: pos.board[from]![0] as Color });
        return true;
      }
      noAnimate.current = dropped ? { from, to: target, at: performance.now() } : null;
      onMoveRef.current?.({ from: squareName(from), to: squareName(target) });
      return true;
    },
    [pos, resolveTarget],
  );

  const pickPromotion = useCallback(
    (piece: "q" | "r" | "b" | "n") => {
      const p = promotion;
      if (!p) return;
      setPromotion(null);
      onMoveRef.current?.({ from: squareName(p.from), to: squareName(p.to), promotion: piece });
    },
    [promotion],
  );

  // Escape cancels a pending promotion or selection.
  useEffect(() => {
    if (!promotion && selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPromotion(null);
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promotion, selected]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (promotion) return;
    const sq = squareAtPoint(rootRef.current, e.clientX, e.clientY, orientation);
    if (e.button === 2) {
      if (drawable && sq >= 0) {
        e.preventDefault();
        const g: DrawGesture = { kind: "draw", from: sq, to: sq, color: brushFor(e) };
        gesture.current = g;
        setDrawing({ from: sq, to: sq, color: g.color, preview: true });
        try {
          rootRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* not supported (tests) */
        }
      }
      return;
    }
    if (e.button !== 0) return;
    if (snapTimer.current) finishSnap();
    if (shapes.length > 0) setShapes([]);
    if (sq < 0) {
      setSelected(null);
      return;
    }
    onSquareClickRef.current?.(squareName(sq));
    if (!canInteract) return;
    if (selected !== null && selected !== sq && resolveTarget(selected, sq) >= 0) {
      e.preventDefault();
      attemptMove(selected, sq, false);
      return;
    }
    const code = pos.board[sq];
    if (code && movable(code[0] as Color)) {
      e.preventDefault();
      gesture.current = {
        kind: "piece",
        from: sq,
        code,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        touch: e.pointerType === "touch",
        started: false,
        wasSelected: selected === sq,
      };
      setSelected(sq);
      try {
        rootRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* not supported (tests) */
      }
      return;
    }
    setSelected(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const sq = squareAtPoint(rootRef.current, e.clientX, e.clientY, orientation);
    if (!g) {
      // Mouse hover feedback over legal destinations of the selected piece.
      if (selected !== null && e.pointerType === "mouse") {
        const h = sq >= 0 && resolveTarget(selected, sq) >= 0 ? sq : null;
        setHover((prev) => (prev === h ? prev : h));
      }
      return;
    }
    if (g.kind === "draw") {
      if (sq >= 0 && sq !== g.to) {
        g.to = sq;
        setDrawing({ from: g.from, to: sq, color: g.color, preview: true });
      }
      return;
    }
    g.x = e.clientX;
    g.y = e.clientY;
    if (!g.started) {
      const threshold = g.touch ? 6 : 3;
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < threshold) return;
      g.started = true;
      const size = (rootRef.current?.getBoundingClientRect().width ?? 320) / 8;
      ghostTf.current = ghostTransform(e.clientX, e.clientY, size, g.touch);
      setDrag({ from: g.from, code: g.code, size, touch: g.touch });
    } else if (drag) {
      ghostTf.current = ghostTransform(e.clientX, e.clientY, drag.size, drag.touch);
      if (ghostRef.current) ghostRef.current.style.transform = ghostTf.current;
    }
    setHover((h) => (h === sq ? h : sq));
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    const sq = cancelled ? -1 : squareAtPoint(rootRef.current, e.clientX, e.clientY, orientation);
    if (g.kind === "draw") {
      setDrawing(null);
      if (cancelled) return;
      const to = sq >= 0 ? sq : g.to;
      setShapes((list) => {
        const i = list.findIndex((s) => s.from === g.from && s.to === to);
        if (i >= 0 && list[i].color === g.color) return list.filter((_, k) => k !== i);
        const rest = i >= 0 ? list.filter((_, k) => k !== i) : list;
        return [...rest, { from: g.from, to, color: g.color }];
      });
      return;
    }
    setHover(null);
    if (!g.started) {
      if (g.wasSelected) setSelected(null);
      return;
    }
    if (sq >= 0 && sq !== g.from && attemptMove(g.from, sq, true)) {
      setDrag(null);
      return;
    }
    if (sq === g.from) {
      setDrag(null);
      return;
    }
    // Illegal drop: glide the ghost back to its square, then show the piece again.
    const ghost = ghostRef.current;
    const root = rootRef.current;
    if (ghost && root && drag) {
      const c = squareCenter(root, g.from, orientation);
      ghostTf.current = ghostTransform(c.x, c.y, drag.size, false);
      ghost.style.transition = "transform 140ms ease";
      ghost.style.transform = ghostTf.current;
      snapTimer.current = setTimeout(finishSnap, 150);
    } else setDrag(null);
  };

  // ------------------------------------------------------------------------- derived layers
  const lastPair = parseLastMove(lastMove);
  const lastKey = lastPair ? `${lastPair[0]}-${lastPair[1]}` : "";
  const highlightKey = squareHighlights ? Object.entries(squareHighlights).map(([k, v]) => `${k}=${v}`).join("|") : "";
  const checkIndex =
    check === false || check === null ? -1 : typeof check === "string" ? squareIndex(check) : pos.checkIndex;

  const highlights = useMemo(() => {
    const items: HighlightItem[] = [];
    if (lastPair) {
      items.push({ index: lastPair[0], kind: "last" }, { index: lastPair[1], kind: "last" });
    }
    if (squareHighlights) {
      for (const [sq, color] of Object.entries(squareHighlights)) {
        const i = squareIndex(sq);
        if (i >= 0) items.push({ index: i, kind: "custom", color });
      }
    }
    if (checkIndex >= 0) items.push({ index: checkIndex, kind: "check" });
    const origin = promotion ? promotion.from : selected;
    if (origin !== null) items.push({ index: origin, kind: "selected" });
    if (selected !== null && showLegalMoves && !promotion) {
      for (const d of pos.dests.get(selected) ?? []) items.push({ index: d, kind: pos.board[d] ? "capture" : "dest" });
    }
    const hoverOrigin = drag ? drag.from : selected;
    if (hoverOrigin !== null && hover !== null && hover !== hoverOrigin && !promotion && pos.dests.get(hoverOrigin)?.includes(hover)) {
      items.push({ index: hover, kind: "hover" });
    }
    return items;
  }, [lastKey, highlightKey, checkIndex, selected, promotion, showLegalMoves, pos, drag, hover]);

  const arrowKey = arrows ? arrows.map((a) => `${a.from}${a.to}${a.color ?? ""}`).join(",") : "";
  const shapeViews = useMemo(() => {
    const list: ShapeView[] = [];
    for (const a of arrows ?? []) {
      const f = squareIndex(a.from);
      const t = squareIndex(a.to);
      if (f >= 0 && t >= 0) list.push({ from: f, to: t, color: a.color ?? "var(--cb-arrow)" });
    }
    list.push(...shapes);
    if (drawing) list.push(drawing);
    return list;
  }, [arrowKey, shapes, drawing]);

  const dragging = drag !== null;

  return (
    <div
      ref={rootRef}
      className={cx("cb-board", canInteract && "cb-board--interactive", dragging && "cb-board--dragging", className)}
      style={{ ["--cb-anim" as string]: `${Math.max(0, animationMs)}ms`, ...style }}
      data-orientation={orientation}
      role="application"
      aria-label={props["aria-label"] ?? "Chessboard"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endGesture(e, false)}
      onPointerCancel={(e) => endGesture(e, true)}
      onLostPointerCapture={(e) => {
        if (gesture.current?.kind === "piece" && gesture.current.started) endGesture(e, true);
      }}
      onPointerLeave={() => {
        if (!gesture.current) setHover(null);
      }}
      onContextMenu={drawable || canInteract ? (e) => e.preventDefault() : undefined}
    >
      <BoardSquares />
      <HighlightLayer items={highlights} orientation={orientation} />
      {showCoordinates && <Coordinates orientation={orientation} />}
      <PieceLayer
        pieces={pieces}
        orientation={orientation}
        faded={drag ? drag.from : null}
        hidden={promotion ? promotion.from : null}
      />
      <ArrowLayer shapes={shapeViews} orientation={orientation} />
      {promotion && (
        <PromotionPicker
          to={promotion.to}
          color={promotion.color}
          orientation={orientation}
          onPick={pickPromotion}
          onCancel={() => setPromotion(null)}
        />
      )}
      {drag && <DragGhost ref={ghostRef} code={drag.code} size={drag.size} transform={ghostTf.current} />}
    </div>
  );
}
