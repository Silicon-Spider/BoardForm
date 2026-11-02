// Games being played right now (self-play or gating), as a grid of mini boards, plus the shared
// self-play progress view used by the run dashboard and the dataset page.
import { MiniBoard, ProgressBar } from "@/components";
import type { LiveBoard, SelfPlayProgress } from "@/training";
import { formatCount } from "@/utils/format";
import { countOf, formatInt } from "../model/format";
import { StatGrid } from "./common";

export function LiveBoards({ boards, max = 8, emptyText = "Starting games…" }: { boards: readonly LiveBoard[]; max?: number; emptyText?: string }) {
  if (boards.length === 0) return <div className="lab-boards-empty">{emptyText}</div>;
  const shown = [...boards].sort((a, b) => a.slot - b.slot).slice(0, max);
  return (
    <div className="lab-boards">
      {shown.map((b) => (
        <figure key={b.slot} className="lab-board">
          <MiniBoard fen={b.fen} lastMove={b.lastMove} title={`${b.white} vs ${b.black}, ply ${b.ply}`} />
          <figcaption>
            <span className="truncate" title={`${b.white} vs ${b.black}`}>
              {b.white === b.black ? b.white : (
                <>
                  {b.white} <span className="faint">vs</span> {b.black}
                </>
              )}
            </span>
            <span className="faint num">ply {b.ply}</span>
          </figcaption>
        </figure>
      ))}
      {boards.length > shown.length && <div className="lab-boards-more">+{boards.length - shown.length} more</div>}
    </div>
  );
}

/** "12 / 7 / 9" with a tooltip spelling it out. */
export function ResultsText({ white, draw, black }: { white: number; draw: number; black: number }) {
  return (
    <span title={`${white} White wins, ${draw} draws, ${black} Black wins`} className="lab-wdl">
      <span>{formatCount(white)}</span>
      <span className="faint">/</span>
      <span>{formatCount(draw)}</span>
      <span className="faint">/</span>
      <span>{formatCount(black)}</span>
    </span>
  );
}

export function SelfPlayProgressView({ p, title = "Games" }: { p: SelfPlayProgress; title?: string }) {
  const total = p.gamesTotal;
  return (
    <div className="stack">
      <ProgressBar
        value={total ? p.gamesDone : null}
        max={total ?? 1}
        size="lg"
        label={total ? `${title}: ${formatInt(p.gamesDone)} of ${formatInt(total)}` : `${title}: ${formatInt(p.gamesDone)} (until stopped)`}
      />
      <StatGrid
        items={[
          { label: "Positions", value: formatCount(p.positions), title: `${p.positions.toLocaleString()} positions kept for training` },
          { label: "Positions / s", value: formatCount(Math.round(p.posPerSec)) },
          { label: "White / draw / Black", value: <ResultsText {...p.results} /> },
          { label: "Average length", value: p.avgPlies > 0 ? countOf(Math.round(p.avgPlies), "ply", "plies") : "—" },
          { label: "Workers", value: String(p.workers) },
        ]}
      />
      <LiveBoards boards={p.boards} />
    </div>
  );
}
