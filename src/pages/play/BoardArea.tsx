// The board column of the Play page: a player bar above and below the board (name, engine kind,
// captured material, clock), the eval bar, the board itself and a small toolbar underneath.
import type { ReactNode } from "react";
import type { MoveInput, PieceCode } from "@/chess";
import { Chessboard, Clock, EvalBar, KindBadge, pieceUrl, type ChessboardArrow, type Orientation } from "@/components";
import { useBoardProps } from "@/app/preferences";
import type { EngineKind } from "@/types";
import type { MaterialSide } from "./rules";
import type { Score, Side } from "./types";

export interface PlayerBarProps {
  side: Side;
  name: string;
  engineKind?: EngineKind | null;
  /** Remaining ms (as of now); null = this side has no clock. */
  clockMs?: number | null;
  clockRunning?: boolean;
  material?: MaterialSide | null;
  /** Short status under the name ("Thinking…", "Your move", "1 s per move"). */
  status?: ReactNode;
  /** Highlight as the side to move. */
  active?: boolean;
  /** Small result badge at the end of a game. */
  result?: "win" | "loss" | "draw" | null;
}

/** Captured-material strip: opponent pieces this side is up by, plus the lead in pawns. */
function Captured({ material }: { material: MaterialSide }) {
  if (material.pieces.length === 0 && material.lead === 0) return null;
  // Group equal pieces so they overlap like a stack.
  const groups: Array<{ code: PieceCode; count: number }> = [];
  for (const code of material.pieces) {
    const last = groups[groups.length - 1];
    if (last && last.code === code) last.count++;
    else groups.push({ code, count: 1 });
  }
  const label = `Up ${material.pieces.length ? material.pieces.length + " piece" + (material.pieces.length > 1 ? "s" : "") : ""}${material.lead ? ` (+${material.lead})` : ""}`;
  return (
    <span className="play-captured" aria-label={label} title={label}>
      {groups.map((g) => (
        <span key={g.code} className="play-captured-group">
          {Array.from({ length: g.count }, (_, i) => (
            <img key={i} src={pieceUrl(g.code)} alt="" className={`play-captured-piece play-captured-piece--${g.code[0]}`} draggable={false} />
          ))}
        </span>
      ))}
      {material.lead > 0 && <span className="play-captured-lead">+{material.lead}</span>}
    </span>
  );
}

const RESULT_TEXT = { win: "1", loss: "0", draw: "½" } as const;

export function PlayerBar({ side, name, engineKind, clockMs = null, clockRunning = false, material, status, active, result }: PlayerBarProps) {
  return (
    <div className={"play-player" + (active ? " play-player--active" : "")} data-side={side}>
      <span className={`play-player-side play-player-side--${side}`} aria-label={side === "w" ? "White" : "Black"} role="img" />
      <div className="play-player-main">
        <div className="play-player-name">
          <span className="truncate" title={name}>
            {name}
          </span>
          {engineKind && <KindBadge kind={engineKind} small />}
          {result && <span className={`play-player-result play-player-result--${result}`}>{RESULT_TEXT[result]}</span>}
        </div>
        {((material && (material.pieces.length > 0 || material.lead > 0)) || status) && (
          <div className="play-player-sub">
            {material && <Captured material={material} />}
            {status && <span className="play-player-status truncate">{status}</span>}
          </div>
        )}
      </div>
      {clockMs !== null && <Clock ms={clockMs} running={clockRunning} side={side} compact className="play-player-clock" />}
    </div>
  );
}

export interface BoardAreaProps {
  top: ReactNode;
  bottom: ReactNode;
  fen: string;
  orientation: Orientation;
  interactive: "white" | "black" | "both" | "none";
  onMove?: (move: MoveInput) => void;
  lastMove?: string | null;
  arrows?: ChessboardArrow[];
  /** White-POV score for the eval bar; the bar is hidden when showEval is false. */
  evalScore?: Score | null;
  showEval: boolean;
  /** Toolbar under the board. */
  tools?: ReactNode;
  /** A line between the board and the bottom bar (e.g. "Viewing move 12"). */
  note?: ReactNode;
  "aria-label"?: string;
}

export function BoardArea(props: BoardAreaProps) {
  const boardProps = useBoardProps();
  const { top, bottom, fen, orientation, interactive, onMove, lastMove, arrows, evalScore, showEval, tools, note } = props;
  return (
    <div className="play-board-col">
      {top}
      <div className="play-board-row">
        {showEval && <EvalBar cp={evalScore?.cp ?? null} mate={evalScore?.mate ?? null} orientation={orientation} className="play-evalbar" />}
        <div className="play-board">
          <Chessboard
            {...boardProps}
            fen={fen}
            orientation={orientation}
            interactive={interactive}
            onMove={onMove}
            lastMove={lastMove ?? null}
            arrows={arrows}
            aria-label={props["aria-label"] ?? "Chessboard"}
          />
        </div>
      </div>
      {bottom}
      {(tools || note) && (
        <div className="play-board-tools">
          {tools}
          {note}
        </div>
      )}
    </div>
  );
}
