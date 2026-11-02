// Position editor: drag pieces from the palette onto the board, drag them around or off the
// board to remove them, paint with a selected piece or the eraser, set side to move, castling
// rights (disabled when impossible), en passant, and edit the FEN directly (validated).
// onChange only ever receives valid FENs; an invalid work-in-progress position stays local.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  START_FEN,
  castlingPossible,
  enPassantCandidates,
  normalizeFen,
  parseFenBoard,
  validateFen,
  type Color,
  type PieceCode,
} from "@/chess";
import {
  BoardSquares,
  Coordinates,
  DragGhost,
  HighlightLayer,
  PieceLayer,
  cx,
  ghostTransform,
  pieceUrl,
  squareAtPoint,
  type HighlightItem,
  type Orientation,
  type TrackedPiece,
} from "./boardCore";
import { Icon } from "./icons";
import "./Chessboard.css";
import "./BoardEditor.css";

export interface BoardEditorProps {
  /** Position to edit ("startpos" or FEN). Changes from outside reset the editor. */
  fen: string;
  /** Called with every new valid position (6-field FEN). */
  onChange: (fen: string) => void;
  /** Initial orientation (the Flip button toggles it). Default "white". */
  orientation?: Orientation;
  className?: string;
}

type CastleRight = "K" | "Q" | "k" | "q";
type Tool = { kind: "move" } | { kind: "erase" } | { kind: "piece"; code: PieceCode };

interface Draft {
  board: Array<PieceCode | null>;
  turn: Color;
  /** Rights the user wants; only those possible on the board are written to the FEN. */
  castling: Record<CastleRight, boolean>;
  /** Chosen en-passant square; dropped when no longer a candidate. */
  ep: string | null;
  halfmove: number;
  fullmove: number;
}

const RIGHTS: CastleRight[] = ["K", "Q", "k", "q"];
const PIECE_ORDER = ["K", "Q", "R", "B", "N", "P"] as const;
const PIECE_NAMES: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };

function draftFromFen(fen: string): Draft {
  const f = normalizeFen(fen).split(" ");
  return {
    board: parseFenBoard(fen),
    turn: f[1] === "b" ? "b" : "w",
    castling: { K: f[2].includes("K"), Q: f[2].includes("Q"), k: f[2].includes("k"), q: f[2].includes("q") },
    ep: /^[a-h][36]$/.test(f[3] ?? "") ? f[3] : null,
    halfmove: Math.max(0, parseInt(f[4] ?? "0", 10) || 0),
    fullmove: Math.max(1, parseInt(f[5] ?? "1", 10) || 1),
  };
}

function placement(board: ReadonlyArray<PieceCode | null>): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = board[rank * 8 + file];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += p[0] === "w" ? p[1] : p[1].toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}

function draftToFen(d: Draft): string {
  const rights = RIGHTS.filter((r) => d.castling[r] && castlingPossible(d.board, r)).join("") || "-";
  const ep = d.ep && enPassantCandidates(d.board, d.turn).includes(d.ep) ? d.ep : "-";
  return `${placement(d.board)} ${d.turn} ${rights} ${ep} ${d.halfmove} ${d.fullmove}`;
}

interface Gesture {
  kind: "drag" | "paint";
  /** drag: the piece being moved / placed. */
  code?: PieceCode;
  /** drag: origin square, null when coming from the palette. */
  from?: number | null;
  /** paint: what each touched square gets (a piece, or null to erase). */
  paint?: PieceCode | null;
  lastSquare?: number;
  startX: number;
  startY: number;
  started: boolean;
  touch: boolean;
}

export function BoardEditor({ fen, onChange, orientation = "white", className }: BoardEditorProps) {
  const fenFieldId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFromFen(fen));
  const [orient, setOrient] = useState<Orientation>(orientation);
  const [tool, setTool] = useState<Tool>({ kind: "move" });
  const [fenText, setFenText] = useState(() => draftToFen(draftFromFen(fen)));
  const [textError, setTextError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drag, setDrag] = useState<{ code: PieceCode; from: number | null; size: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostTf = useRef("translate(-9999px, -9999px)");
  const gesture = useRef<Gesture | null>(null);
  const emitted = useRef(normalizeFen(fen));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => setOrient(orientation), [orientation]);

  // External position changes reset the editor (our own emissions come back unchanged).
  useEffect(() => {
    const n = normalizeFen(fen);
    if (n === emitted.current) return;
    emitted.current = n;
    const d = draftFromFen(n);
    setDraft(d);
    setFenText(draftToFen(d));
    setTextError(null);
  }, [fen]);

  const commit = (next: Draft) => {
    draftRef.current = next;
    setDraft(next);
    const f = draftToFen(next);
    setFenText(f);
    setTextError(null);
    if (f !== emitted.current && validateFen(f).ok) {
      emitted.current = f;
      onChangeRef.current(f);
    }
  };

  const withBoard = (mutate: (board: Array<PieceCode | null>) => void) => {
    const d = draftRef.current;
    const board = d.board.slice();
    mutate(board);
    commit({ ...d, board });
  };

  /** Puts a piece on a square; a second king of a colour moves the existing one. */
  const putPiece = (board: Array<PieceCode | null>, sq: number, code: PieceCode) => {
    if (code[1] === "K") {
      const other = board.findIndex((p, i) => p === code && i !== sq);
      if (other >= 0) board[other] = null;
    }
    board[sq] = code;
  };

  const currentFen = draftToFen(draft);
  const validity = useMemo(() => validateFen(currentFen), [currentFen]);
  const epOptions = enPassantCandidates(draft.board, draft.turn);
  const possible = Object.fromEntries(RIGHTS.map((r) => [r, castlingPossible(draft.board, r)])) as Record<CastleRight, boolean>;

  const pieces = useMemo<TrackedPiece[]>(() => {
    const list: TrackedPiece[] = [];
    draft.board.forEach((code, index) => {
      if (code) list.push({ id: index * 16 + "wKwQwRwBwNwPbKbQbRbBbNbP".indexOf(code) / 2, code, index });
    });
    return list;
  }, [draft.board]);

  // ------------------------------------------------------------------ pointer handling
  const beginCapture = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* unsupported (tests) */
    }
  };

  const onBoardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const sq = squareAtPoint(boardRef.current, e.clientX, e.clientY, orient);
    if (sq < 0) return;
    e.preventDefault();
    const base = { startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType === "touch", lastSquare: sq };
    if (e.button === 2) {
      withBoard((b) => (b[sq] = null));
      return;
    }
    if (e.button !== 0) return;
    if (tool.kind === "erase") {
      withBoard((b) => (b[sq] = null));
      gesture.current = { kind: "paint", paint: null, ...base };
      beginCapture(e);
      return;
    }
    if (tool.kind === "piece") {
      // Clicking the same piece again removes it; dragging keeps doing the same thing.
      const paint = draftRef.current.board[sq] === tool.code ? null : tool.code;
      withBoard((b) => (paint ? putPiece(b, sq, paint) : (b[sq] = null)));
      gesture.current = { kind: "paint", paint, ...base };
      beginCapture(e);
      return;
    }
    const code = draftRef.current.board[sq];
    if (!code) return;
    gesture.current = { kind: "drag", code, from: sq, ...base };
    beginCapture(e);
  };

  const onSparePointerDown = (e: React.PointerEvent<HTMLButtonElement>, code: PieceCode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gesture.current = { kind: "drag", code, from: null, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType === "touch" };
    beginCapture(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const sq = squareAtPoint(boardRef.current, e.clientX, e.clientY, orient);
    if (g.kind === "paint") {
      if (sq >= 0 && sq !== g.lastSquare) {
        g.lastSquare = sq;
        const paint = g.paint ?? null;
        withBoard((b) => (paint ? putPiece(b, sq, paint) : (b[sq] = null)));
      }
      return;
    }
    if (!g.started) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < (g.touch ? 6 : 3)) return;
      g.started = true;
      const size = (boardRef.current?.getBoundingClientRect().width ?? 320) / 8;
      ghostTf.current = ghostTransform(e.clientX, e.clientY, size, g.touch);
      setDrag({ code: g.code!, from: g.from ?? null, size });
    } else if (drag) {
      ghostTf.current = ghostTransform(e.clientX, e.clientY, drag.size, g.touch);
      if (ghostRef.current) ghostRef.current.style.transform = ghostTf.current;
    }
    setHover((h) => (h === sq ? h : sq));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setHover(null);
    setDrag(null);
    if (g.kind !== "drag" || cancelled) return;
    if (!g.started) {
      // A click on a palette piece selects it as the brush (click again to go back to moving).
      if (g.from === null && g.code) {
        const code = g.code;
        setTool((t) => (t.kind === "piece" && t.code === code ? { kind: "move" } : { kind: "piece", code }));
      }
      return;
    }
    const sq = squareAtPoint(boardRef.current, e.clientX, e.clientY, orient);
    const code = g.code!;
    if (g.from === null || g.from === undefined) {
      if (sq >= 0) withBoard((b) => putPiece(b, sq, code));
    } else if (sq < 0) {
      const from = g.from;
      withBoard((b) => (b[from] = null)); // dragged off the board
    } else if (sq !== g.from) {
      const from = g.from;
      withBoard((b) => {
        b[from] = null;
        putPiece(b, sq, code);
      });
    }
  };

  // ------------------------------------------------------------------ controls
  const setTurn = (turn: Color) => commit({ ...draftRef.current, turn });
  const setRight = (r: CastleRight, on: boolean) => commit({ ...draftRef.current, castling: { ...draftRef.current.castling, [r]: on } });
  const setEp = (ep: string | null) => commit({ ...draftRef.current, ep });
  const reset = (to: string) => commit(draftFromFen(to));

  const onFenInput = (text: string) => {
    setFenText(text);
    const trimmed = text.trim();
    if (trimmed === "") {
      setTextError("Enter a FEN, e.g. " + START_FEN);
      return;
    }
    const r = validateFen(trimmed);
    if (!r.ok) {
      setTextError(r.error ?? "Invalid FEN");
      return;
    }
    const normalized = normalizeFen(trimmed);
    const d = draftFromFen(normalized);
    draftRef.current = d;
    setDraft(d);
    setTextError(null);
    const f = draftToFen(d);
    if (f !== emitted.current) {
      emitted.current = f;
      onChangeRef.current(f);
    }
  };

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(currentFen);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const highlights = useMemo<HighlightItem[]>(() => {
    const items: HighlightItem[] = [];
    if (drag && hover !== null && hover >= 0 && hover !== drag.from) items.push({ index: hover, kind: "hover" });
    return items;
  }, [drag, hover]);

  const palette = (color: Color) => (
    <div className="cb-editor-palette" role="toolbar" aria-label={`${color === "w" ? "White" : "Black"} pieces`}>
      <button
        type="button"
        className={cx("cb-editor-tool", tool.kind === "move" && "active")}
        title="Move pieces (drag them; drop outside the board to remove)"
        aria-label="Move pieces"
        aria-pressed={tool.kind === "move"}
        onClick={() => setTool({ kind: "move" })}
      >
        <Icon name="hand" size={18} />
      </button>
      {PIECE_ORDER.map((p) => {
        const code = `${color}${p}` as PieceCode;
        const active = tool.kind === "piece" && tool.code === code;
        return (
          <button
            key={code}
            type="button"
            className={cx("cb-editor-spare", active && "active")}
            data-piece={code}
            title={`${color === "w" ? "White" : "Black"} ${PIECE_NAMES[p]} — drag onto the board, or click to paint`}
            aria-label={`${color === "w" ? "White" : "Black"} ${PIECE_NAMES[p]}`}
            aria-pressed={active}
            onPointerDown={(e) => onSparePointerDown(e, code)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setTool((t) => (t.kind === "piece" && t.code === code ? { kind: "move" } : { kind: "piece", code }));
              }
            }}
          >
            <span style={{ backgroundImage: `url(${pieceUrl(code)})` }} />
          </button>
        );
      })}
      <button
        type="button"
        className={cx("cb-editor-tool", tool.kind === "erase" && "active")}
        title="Eraser (click or drag over pieces)"
        aria-label="Eraser"
        aria-pressed={tool.kind === "erase"}
        onClick={() => setTool((t) => (t.kind === "erase" ? { kind: "move" } : { kind: "erase" }))}
      >
        <Icon name="eraser" size={18} />
      </button>
    </div>
  );

  const status = textError
    ? { ok: false, text: textError, source: "fen" }
    : validity.ok
      ? { ok: true, text: "Valid position", source: "board" }
      : { ok: false, text: validity.error ?? "Invalid position", source: "board" };

  const cursorClass = tool.kind === "erase" ? "cb-editor-board--erase" : tool.kind === "piece" ? "cb-editor-board--paint" : "";

  return (
    <div className={cx("cb-editor-wrap", className)}>
      <div
        className="cb-editor"
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerCancel={(e) => onPointerUp(e, true)}
      >
        <div className="cb-editor-boardcol">
          {palette(orient === "white" ? "b" : "w")}
          <div
            ref={boardRef}
            className={cx("cb-board", "cb-board--interactive", "cb-editor-board", cursorClass, drag && "cb-board--dragging")}
            style={{ ["--cb-anim" as string]: "0ms" }}
            data-orientation={orient}
            role="application"
            aria-label="Board editor"
            onPointerDown={onBoardPointerDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <BoardSquares />
            <HighlightLayer items={highlights} orientation={orient} />
            <Coordinates orientation={orient} />
            <PieceLayer pieces={pieces} orientation={orient} faded={drag?.from ?? null} />
          </div>
          {palette(orient === "white" ? "w" : "b")}
        </div>

        <div className="cb-editor-controls">
          <div className="cb-editor-group">
            <div className="section-title">Side to move</div>
            <div className="btn-group cb-editor-turn" role="radiogroup" aria-label="Side to move">
              {(["w", "b"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.turn === c}
                  className={cx("btn btn-sm", draft.turn === c && "active")}
                  onClick={() => setTurn(c)}
                >
                  <span className={`cb-editor-swatch cb-editor-swatch--${c}`} aria-hidden="true" />
                  {c === "w" ? "White" : "Black"}
                </button>
              ))}
            </div>
          </div>

          <div className="cb-editor-group">
            <div className="section-title">Castling rights</div>
            <div className="cb-editor-castling">
              {(["w", "b"] as const).map((c) => (
                <div key={c} className="cb-editor-castle-row">
                  <span className="cb-editor-castle-side">{c === "w" ? "White" : "Black"}</span>
                  {(c === "w" ? (["K", "Q"] as const) : (["k", "q"] as const)).map((r) => (
                    <label
                      key={r}
                      className={cx("checkbox", !possible[r] && "cb-editor-disabled")}
                      title={possible[r] ? undefined : `Needs the king and rook on their starting squares`}
                    >
                      <input type="checkbox" checked={possible[r] && draft.castling[r]} disabled={!possible[r]} onChange={(e) => setRight(r, e.target.checked)} />
                      <span>{r.toUpperCase() === "K" ? "O-O" : "O-O-O"}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="cb-editor-group">
            <label className="section-title" htmlFor={`${fenFieldId}-ep`}>
              En passant
            </label>
            <select
              id={`${fenFieldId}-ep`}
              className="select select-sm"
              value={draft.ep && epOptions.includes(draft.ep) ? draft.ep : ""}
              disabled={epOptions.length === 0}
              onChange={(e) => setEp(e.target.value || null)}
            >
              <option value="">{epOptions.length === 0 ? "Not possible here" : "None"}</option>
              {epOptions.map((sq) => (
                <option key={sq} value={sq}>
                  {sq}
                </option>
              ))}
            </select>
          </div>

          <div className="cb-editor-group cb-editor-actions">
            <button type="button" className="btn btn-sm" onClick={() => reset(START_FEN)}>
              <Icon name="reset" size={14} /> Start position
            </button>
            <button type="button" className="btn btn-sm" onClick={() => reset("8/8/8/8/8/8/8/8 w - - 0 1")}>
              <Icon name="trash" size={14} /> Clear board
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOrient((o) => (o === "white" ? "black" : "white"))}>
              <Icon name="flip" size={14} /> Flip board
            </button>
          </div>

          <div className="cb-editor-group">
            <label className="section-title" htmlFor={fenFieldId}>
              FEN
            </label>
            <div className="cb-editor-fen">
              <input
                id={fenFieldId}
                className={cx("input input-sm mono", textError && "cb-input-error")}
                value={fenText}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!status.ok}
                aria-describedby={`${fenFieldId}-status`}
                onChange={(e) => onFenInput(e.target.value)}
                onBlur={() => {
                  if (!textError) setFenText(currentFen);
                }}
              />
              <button type="button" className="btn btn-sm btn-icon" title="Copy FEN" aria-label="Copy FEN" onClick={copyFen}>
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
            </div>
            <div id={`${fenFieldId}-status`} className={cx("cb-editor-status", status.ok ? "ok" : "error")} role="status">
              <Icon name={status.ok ? "check" : "alert"} size={14} />
              <span>
                {status.text}
                {!status.ok && status.source === "board" && <span className="faint"> (not saved until fixed)</span>}
              </span>
            </div>
          </div>

          <p className="cb-editor-help">
            Drag pieces from the palettes onto the board and off it to remove them. Click a palette piece to paint with
            it, or use the eraser. Right-click a square to clear it.
          </p>
        </div>
      </div>
      {drag && <DragGhost ref={ghostRef} code={drag.code} size={drag.size} transform={ghostTf.current} />}
    </div>
  );
}
