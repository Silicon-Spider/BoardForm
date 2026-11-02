// Finished games of a match (newest first) and the replay viewer for a saved game.
import { useEffect, useMemo, useState } from "react";
import { describeTermination, resolveResults, summaryDetail, whitePoints } from "@/arena";
import { useBoardProps } from "@/app/preferences";
import { navigate } from "@/app/router";
import { ChessGame, START_FEN } from "@/chess";
import { CHART_COLORS, Chessboard, EmptyState, Icon, LineChart, Modal, MoveList, Spinner, formatTimeControl, startPlyFromFen, type ChartSeries } from "@/components";
import { gamesRepo } from "@/storage";
import type { GameRecord, MatchRecord } from "@/types";
import { downloadText, slugify } from "@/utils/misc";
import { formatDateTime, formatDuration } from "@/utils/format";
import { EngineDot, resultText, type ParticipantInfo } from "./shared";

const PAGE = 100;

export function ResultsTable({ record, info, onOpen }: { record: MatchRecord; info: ParticipantInfo; onOpen: (gameId: string) => void }) {
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => {
    const resolved = resolveResults(record.config, record.results);
    // Newest first: by finish time when known, else by schedule index.
    return resolved.sort((a, b) => {
      const fa = (a.summary as { finishedAt?: number }).finishedAt ?? 0;
      const fb = (b.summary as { finishedAt?: number }).finishedAt ?? 0;
      return fb - fa || b.summary.index - a.summary.index;
    });
  }, [record.config, record.results]);

  if (rows.length === 0) {
    return <EmptyState compact title="No finished games yet" description="Results appear here as soon as each game ends." />;
  }
  const saveOff = !record.config.saveGames;
  return (
    <>
      {saveOff && <p className="small muted arena-results-note">Games of this match are not saved, so they cannot be replayed.</p>}
      <div className="arena-table-wrap arena-results-wrap">
        <table className="table arena-results" data-testid="arena-results">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>White</th>
              <th>Black</th>
              <th>Result</th>
              <th>Ending</th>
              <th className="num">Plies</th>
              <th>Opening</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map(({ summary, white, black }) => {
              const gameId = summary.gameId ?? null;
              const wp = whitePoints(summary.result);
              const detail = summaryDetail(summary);
              return (
                <tr
                  key={summary.index}
                  className={gameId ? "arena-row-link" : undefined}
                  tabIndex={gameId ? 0 : undefined}
                  onClick={gameId ? () => onOpen(gameId) : undefined}
                  onKeyDown={
                    gameId
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpen(gameId);
                          }
                        }
                      : undefined
                  }
                  title={gameId ? "Replay this game" : undefined}
                  data-testid="arena-result-row"
                >
                  <td className="num faint">{summary.index + 1}</td>
                  <td>
                    <span className={"arena-engine-cell" + (wp === 1 ? " arena-winner" : "")}>
                      <EngineDot color={info.colors[white]} />
                      <span className="truncate">{info.labels[white]}</span>
                    </span>
                  </td>
                  <td>
                    <span className={"arena-engine-cell" + (wp === 0 ? " arena-winner" : "")}>
                      <EngineDot color={info.colors[black]} />
                      <span className="truncate">{info.labels[black]}</span>
                    </span>
                  </td>
                  <td>
                    <span className={"arena-result" + (wp === 0.5 ? " arena-result--draw" : "")}>{resultText(summary.result)}</span>
                  </td>
                  <td className="arena-ending" title={detail ?? undefined}>
                    {describeTermination(summary.termination, summary.result)}
                    {detail && (summary.termination === "engine-error" || summary.termination === "illegal-move") && <Icon name="info" size={12} className="arena-ending-info" />}
                  </td>
                  <td className="num">{summary.plies}</td>
                  <td className="arena-opening truncate" title={summary.opening ?? undefined}>
                    {summary.opening ?? <span className="faint">Start position</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <div className="arena-more">
          <button className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
          </button>
        </div>
      )}
    </>
  );
}

/** Replay of a saved game: board, move navigation, evaluation chart, PGN and "Open in Play". */
export function GameReplayModal({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const boardProps = useBoardProps();
  const [game, setGame] = useState<GameRecord | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [ply, setPly] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    let alive = true;
    setGame(undefined);
    setError(null);
    gamesRepo.get(gameId).then(
      (g) => alive && setGame(g ?? null),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [gameId]);

  const replay = useMemo(() => (game ? ChessGame.fromMoves(game.startFen, game.moves) : null), [game]);
  const total = game?.moves.length ?? 0;
  const current = ply === null ? total : Math.min(ply, total);
  const fen = replay ? replay.fenAt(current) : START_FEN;
  const lastMove = game && current > 0 ? game.moves[current - 1] : null;
  const series = useMemo<ChartSeries[]>(() => {
    if (!game?.evals) return [];
    const toPawns = (v: number) => Math.max(-10, Math.min(10, v / 100));
    const startBlack = (replay?.startFen ?? START_FEN).split(" ")[1] === "b";
    const w: { x: number; y: number }[] = [];
    const b: { x: number; y: number }[] = [];
    game.evals.forEach((v, i) => {
      if (v === null) return;
      const whiteMoved = (i % 2 === 0) !== startBlack;
      (whiteMoved ? w : b).push({ x: i + 1, y: toPawns(v) });
    });
    return [
      { name: `${game.white.name} (White)`, color: CHART_COLORS[0], points: w },
      { name: `${game.black.name} (Black)`, color: CHART_COLORS[1], points: b },
    ];
  }, [game, replay]);

  // Thinking time per colour (opening plies count 0).
  const startsBlack = (replay?.startFen ?? START_FEN).split(" ")[1] === "b";
  const totalTime = (white: boolean) => (game?.times ?? []).reduce((sum, t, i) => ((i % 2 === 0) !== startsBlack === white ? sum + t : sum), 0);

  return (
    <Modal
      open
      onClose={onClose}
      width={1040}
      className="arena-replay-modal"
      title={game ? `${game.white.name} vs ${game.black.name}` : "Game"}
      footer={
        game ? (
          <>
            <button className="btn" onClick={() => downloadText(game.pgn, `${slugify(`${game.white.name}-vs-${game.black.name}`)}.pgn`, "application/x-chess-pgn")}>
              Download PGN
            </button>
            <button className="btn btn-primary" onClick={() => navigate(`/play?game=${encodeURIComponent(game.id)}`)} data-testid="arena-open-in-play">
              Open in Play
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {error ? (
        <div className="callout danger">{error}</div>
      ) : game === undefined ? (
        <div className="arena-replay-loading">
          <Spinner label="Loading the game…" />
        </div>
      ) : game === null || !replay ? (
        <EmptyState compact title="Game not found" description="It may have been deleted together with its match's games." />
      ) : (
        <div className="arena-replay" data-testid="arena-replay">
          <div className="arena-replay-boardcol">
            <Chessboard {...boardProps} fen={fen} lastMove={lastMove} interactive="none" orientation={flipped ? "black" : "white"} />
            <div className="row-wrap small">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFlipped((f) => !f)}>
                <Icon name="flip" size={14} /> Flip
              </button>
              <span className="spacer" />
              <span className="muted">
                Ply {current} / {total}
              </span>
            </div>
          </div>
          <div className="arena-replay-side">
            <div className="arena-replay-facts">
              <div>
                <span className={"arena-result" + (game.result === "1/2-1/2" ? " arena-result--draw" : "")}>{resultText(game.result)}</span>{" "}
                <span className="muted">{describeTermination(game.termination, game.result)}</span>
              </div>
              <div className="small muted">
                {game.opening ?? "Start position"}
                {game.timeControl?.white ? ` · ${formatTimeControl(game.timeControl.white)}` : ""} · {formatDateTime(game.createdAt)}
              </div>
              <div className="small faint">
                Thinking time: White {formatDuration(totalTime(true))} · Black {formatDuration(totalTime(false))}
              </div>
            </div>
            <MoveList
              className="arena-replay-moves"
              san={game.san}
              currentPly={current}
              onSelectPly={(p) => setPly(p === total ? null : p)}
              startPly={startPlyFromFen(replay.startFen)}
              result={game.result}
              controls
            />
            <div className="arena-replay-chart">
              <div className="section-title">Evaluation (White's view, pawns)</div>
              <LineChart series={series} height={150} xLabel="Ply" formatY={(v) => (v > 0 ? "+" : "") + v.toFixed(1)} emptyText="The engines reported no scores." />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
