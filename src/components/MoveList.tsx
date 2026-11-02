// Numbered SAN move list with clickable plies, current-ply highlight, auto-scroll and
// keyboard navigation (←/→, Home/End) plus optional navigation buttons.
import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import "./MoveList.css";

export interface MoveListProps {
  /** Moves in SAN. */
  san: readonly string[];
  /** Plies shown on the board (0 = start position). Default: san.length (latest). */
  currentPly?: number;
  /** Called with a ply number 0..san.length. */
  onSelectPly?: (ply: number) => void;
  /**
   * Absolute ply of the start position: 0 = White to move on move 1 (default),
   * 1 = Black to move on move 1, 2·(n−1) + (black ? 1 : 0) for move n.
   */
  startPly?: number;
  /** Shown after the last move, e.g. "1-0". */
  result?: string | null;
  /** First / previous / next / last buttons under the list. */
  controls?: boolean;
  /** Shown when there are no moves. */
  emptyText?: ReactNode;
  className?: string;
}

/** startPly for a FEN's side to move and full-move number. */
export function startPlyFromFen(fen: string): number {
  const f = fen.trim().split(/\s+/);
  const moveNo = Math.max(1, parseInt(f[5] ?? "1", 10) || 1);
  return (moveNo - 1) * 2 + (f[1] === "b" ? 1 : 0);
}

function MoveListImpl({ san, currentPly, onSelectPly, startPly = 0, result, controls, emptyText, className }: MoveListProps) {
  const current = currentPly ?? san.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const select = (ply: number) => onSelectPly?.(Math.max(0, Math.min(san.length, ply)));

  // Keep the current move visible (scrolls the list only, never the page).
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    if (current >= san.length) {
      box.scrollTop = box.scrollHeight;
      return;
    }
    const el = box.querySelector<HTMLElement>(".cb-ml-move--current");
    if (!el) {
      if (current === 0) box.scrollTop = 0;
      return;
    }
    const top = el.offsetTop; // .cb-ml-scroll is the offsetParent (position: relative)
    const bottom = top + el.offsetHeight;
    const pad = 8;
    if (top < box.scrollTop + pad) box.scrollTop = Math.max(0, top - pad);
    else if (bottom > box.scrollTop + box.clientHeight - pad) box.scrollTop = bottom - box.clientHeight + pad;
  }, [current, san.length]);

  const rows: ReactNode[] = [];
  const first = startPly % 2 === 1;
  const cell = (i: number) => {
    const ply = i + 1;
    return (
      <button
        key={`m${i}`}
        type="button"
        className={"cb-ml-move" + (ply === current ? " cb-ml-move--current" : "")}
        data-ply={ply}
        onClick={() => select(ply)}
        tabIndex={-1}
        aria-current={ply === current ? "true" : undefined}
      >
        {san[i]}
      </button>
    );
  };
  let i = 0;
  if (first && san.length > 0) {
    const n = Math.floor(startPly / 2) + 1;
    rows.push(
      <div key={`r${n}`} className="cb-ml-row">
        <span className="cb-ml-num">{n}.</span>
        <span className="cb-ml-move cb-ml-move--empty">…</span>
        {cell(0)}
      </div>,
    );
    i = 1;
  }
  for (; i < san.length; i += 2) {
    const n = Math.floor((startPly + i) / 2) + 1;
    rows.push(
      <div key={`r${n}`} className="cb-ml-row">
        <span className="cb-ml-num">{n}.</span>
        {cell(i)}
        {i + 1 < san.length ? cell(i + 1) : <span className="cb-ml-move cb-ml-move--empty" />}
      </div>,
    );
  }

  return (
    <div className={"cb-movelist" + (className ? " " + className : "")}>
      <div
        ref={scrollRef}
        className="cb-ml-scroll"
        tabIndex={0}
        role="listbox"
        aria-label="Moves"
        onKeyDown={(e) => {
          if (!onSelectPly) return;
          const keys: Record<string, number> = {
            ArrowLeft: current - 1,
            ArrowRight: current + 1,
            ArrowUp: current - 2,
            ArrowDown: current + 2,
            Home: 0,
            End: san.length,
          };
          if (e.key in keys) {
            e.preventDefault();
            select(keys[e.key]);
          }
        }}
      >
        {san.length === 0 ? (
          <div className="cb-ml-empty">{emptyText ?? "No moves yet"}</div>
        ) : (
          rows
        )}
        {result && san.length > 0 && <div className="cb-ml-result">{result}</div>}
      </div>
      {controls && (
        <div className="cb-ml-controls">
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Start position" title="Start (Home)" disabled={current <= 0} onClick={() => select(0)}>
            <Icon name="first" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Previous move" title="Previous (←)" disabled={current <= 0} onClick={() => select(current - 1)}>
            <Icon name="prev" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Next move" title="Next (→)" disabled={current >= san.length} onClick={() => select(current + 1)}>
            <Icon name="next" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Latest position" title="Latest (End)" disabled={current >= san.length} onClick={() => select(san.length)}>
            <Icon name="last" />
          </button>
        </div>
      )}
    </div>
  );
}

export const MoveList = memo(MoveListImpl);
