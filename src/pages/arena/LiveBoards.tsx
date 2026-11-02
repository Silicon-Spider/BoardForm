// Live boards of a running match: a mini board per game slot, and a large viewer with the move
// list and both engines' search info.
import { useMemo, useState } from "react";
import { whitePovScore, type LiveGameView } from "@/arena";
import { useBoardProps } from "@/app/preferences";
import { ChessGame, START_FEN, uciLineToSan } from "@/chess";
import { Chessboard, Clock, EvalBar, Icon, MiniBoard, Modal, MoveList, startPlyFromFen } from "@/components";
import type { SearchInfo } from "@/types";
import { formatCount, formatDuration, formatNps, formatScore } from "@/utils/format";
import { EngineDot, resultText } from "./shared";

type Side = "w" | "b";

/** The last finished search's evaluation in White's view: the engine that moved last. */
function lastEval(view: LiveGameView): { cp: number | null; mate: number | null; depth: number | null } {
  const mover: Side = view.sideToMove === "w" ? "b" : "w";
  const info = mover === "w" ? view.whiteInfo : view.blackInfo;
  if (!info) return { cp: null, mate: null, depth: null };
  const mate = typeof info.mate === "number" && info.mate !== 0 ? (mover === "w" ? info.mate : -info.mate) : null;
  return { cp: mate === null ? whitePovScore(info, mover) : null, mate, depth: info.depth };
}

function evalText(view: LiveGameView): string {
  const e = lastEval(view);
  if (e.cp === null && e.mate === null) return "—";
  return formatScore(e.cp, e.mate);
}

/** Remaining time below which a side's clock turns red (depends on the time control). */
export type LowTimeFn = (view: LiveGameView, side: Side) => number;

function PlayerRow({ view, side, compact, color, lowTimeMs }: { view: LiveGameView; side: Side; compact?: boolean; color: string; lowTimeMs?: number }) {
  const name = side === "w" ? view.white.name : view.black.name;
  const ms = side === "w" ? view.whiteMs : view.blackMs;
  const thinking = view.thinking === side && !view.result;
  if (ms !== null) {
    return (
      <Clock
        compact={compact}
        side={side}
        ms={ms}
        running={thinking}
        lowTimeMs={lowTimeMs}
        label={
          <span className="arena-player-label">
            <EngineDot color={color} />
            <span className="truncate">{name}</span>
          </span>
        }
        className="arena-player-clock"
      />
    );
  }
  return (
    <div className={"arena-player" + (thinking ? " arena-player--thinking" : "") + (compact ? " arena-player--compact" : "")}>
      <span className={`arena-side arena-side--${side}`} aria-hidden="true" />
      <EngineDot color={color} />
      <span className="truncate grow">{name}</span>
      {thinking && <span className="arena-thinking" aria-label="thinking" />}
    </div>
  );
}

export function LiveBoards({ games, colorOf, lowTimeFor, onOpen }: { games: LiveGameView[]; colorOf: (engineId: string) => string; lowTimeFor?: LowTimeFn; onOpen: (slot: number) => void }) {
  const sorted = [...games].sort((a, b) => a.slot - b.slot);
  return (
    <div className="arena-live-grid" data-testid="arena-live">
      {sorted.map((g) => (
        <button key={g.slot} type="button" className="arena-live-card" onClick={() => onOpen(g.slot)} aria-label={`Game ${g.index + 1}: ${g.white.name} vs ${g.black.name}. Open the board.`}>
          <PlayerRow view={g} side="b" compact color={colorOf(g.black.id)} lowTimeMs={lowTimeFor?.(g, "b")} />
          <div className="arena-live-board">
            <MiniBoard fen={g.fen} lastMove={g.lastMove} />
            {g.result && <span className="arena-live-result">{resultText(g.result)}</span>}
          </div>
          <PlayerRow view={g} side="w" compact color={colorOf(g.white.id)} lowTimeMs={lowTimeFor?.(g, "w")} />
          <div className="arena-live-meta small">
            <span className="faint">Game {g.index + 1}</span>
            <span className="faint">· move {Math.floor(g.moves.length / 2) + 1}</span>
            <span className="spacer" />
            <span className="num" title="Evaluation (White's view) and depth of the last move">
              {evalText(g)}
              {lastEval(g).depth ? <span className="faint"> · d{lastEval(g).depth}</span> : null}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

/** FEN of the position an engine's last reported info was searched from. */
function infoFen(view: LiveGameView, side: Side): string {
  const n = view.moves.length;
  let ply: number;
  if (side === view.sideToMove) ply = view.thinking === side ? n : n - 2;
  else ply = n - 1;
  if (ply === n) return view.fen;
  const game = ChessGame.fromMoves(view.startFen, view.moves.slice(0, Math.max(0, ply)));
  return game ? game.fen() : view.fen;
}

function EngineInfo({ view, side, color }: { view: LiveGameView; side: Side; color: string }) {
  const info: SearchInfo | null = side === "w" ? view.whiteInfo : view.blackInfo;
  const name = side === "w" ? view.white.name : view.black.name;
  const thinking = view.thinking === side && !view.result;
  const pv = useMemo(() => {
    if (!info || info.pv.length === 0) return "";
    const fen = infoFen(view, side);
    const san = uciLineToSan(fen === "startpos" ? START_FEN : fen, info.pv.slice(0, 12));
    return san.length > 0 ? san.join(" ") : info.pv.slice(0, 12).join(" ");
  }, [info, view, side]);
  const score = info ? (typeof info.mate === "number" && info.mate !== 0 ? formatScore(null, side === "w" ? info.mate : -info.mate) : formatScore(whitePovScore(info, side))) : "—";
  return (
    <div className={"arena-engine-info" + (thinking ? " arena-engine-info--thinking" : "")} data-testid={`arena-info-${side}`}>
      <div className="arena-engine-info-head">
        <span className={`arena-side arena-side--${side}`} aria-hidden="true" />
        <EngineDot color={color} />
        <span className="truncate grow arena-engine-info-name">{name}</span>
        {thinking ? <span className="badge badge-accent">Thinking</span> : null}
      </div>
      {info ? (
        <>
          <dl className="arena-engine-stats">
            <div>
              <dt>Score</dt>
              <dd className="num">{score}</dd>
            </div>
            <div>
              <dt>Depth</dt>
              <dd className="num">
                {info.depth}
                {info.seldepth > info.depth ? <span className="faint">/{info.seldepth}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Nodes</dt>
              <dd className="num">{formatCount(info.nodes)}</dd>
            </div>
            <div>
              <dt>Speed</dt>
              <dd className="num">{info.nps > 0 ? formatNps(info.nps) : "—"}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd className="num">{formatDuration(info.timeMs)}</dd>
            </div>
          </dl>
          <div className="arena-pv mono small" title="Principal variation">
            {pv || <span className="faint">No line reported</span>}
          </div>
        </>
      ) : (
        <div className="small faint">No search info yet.</div>
      )}
    </div>
  );
}

export function LiveGameModal({ view, colorOf, lowTimeFor, onClose }: { view: LiveGameView | null; colorOf: (engineId: string) => string; lowTimeFor?: LowTimeFn; onClose: () => void }) {
  const boardProps = useBoardProps();
  const [flipped, setFlipped] = useState(false);
  const startFen = view ? (view.startFen === "startpos" ? START_FEN : view.startFen) : START_FEN;
  const e = view ? lastEval(view) : { cp: null, mate: null, depth: null };
  const top: Side = flipped ? "w" : "b";
  const bottom: Side = flipped ? "b" : "w";
  return (
    <Modal
      open
      onClose={onClose}
      width={1040}
      className="arena-livegame-modal"
      title={view ? `Game ${view.index + 1} · ${view.white.name} vs ${view.black.name}` : "Live game"}
    >
      {!view ? (
        <div className="arena-livegame-empty muted">This board is waiting for its next game.</div>
      ) : (
        <div className="arena-livegame">
          <div className="arena-livegame-boardcol">
            <PlayerRow view={view} side={top} color={colorOf(top === "w" ? view.white.id : view.black.id)} lowTimeMs={lowTimeFor?.(view, top)} />
            <div className="arena-livegame-board">
              <EvalBar cp={e.cp} mate={e.mate} fen={view.fen} orientation={flipped ? "black" : "white"} />
              <div className="grow">
                <Chessboard {...boardProps} fen={view.fen} lastMove={view.lastMove} interactive="none" orientation={flipped ? "black" : "white"} />
              </div>
            </div>
            <PlayerRow view={view} side={bottom} color={colorOf(bottom === "w" ? view.white.id : view.black.id)} lowTimeMs={lowTimeFor?.(view, bottom)} />
            <div className="row-wrap small muted">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFlipped((f) => !f)}>
                <Icon name="flip" size={14} /> Flip board
              </button>
              <span className="spacer" />
              {view.opening && <span className="truncate" title={view.opening}>{view.opening}</span>}
            </div>
          </div>
          <div className="arena-livegame-side">
            <EngineInfo view={view} side="w" color={colorOf(view.white.id)} />
            <EngineInfo view={view} side="b" color={colorOf(view.black.id)} />
            <MoveList
              className="arena-livegame-moves"
              san={view.san ?? []}
              startPly={startPlyFromFen(startFen)}
              result={view.result ?? null}
              emptyText="No moves yet"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
