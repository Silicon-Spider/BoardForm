// Standings table (rank, W/D/L, points, score, Elo ± 95%, LOS) and, for more than two engines,
// a crosstable.
import { useMemo } from "react";
import { computeStandings, crosstable, formatPoints, resolveResults, type StandingRow } from "@/arena";
import { Tooltip } from "@/components";
import type { MatchRecord } from "@/types";
import { formatPercent } from "@/utils/format";
import { EngineDot, formatEloEstimate, type ParticipantInfo } from "./shared";

function eloCell(row: StandingRow) {
  if (row.games === 0) return <span className="faint">—</span>;
  return <span className={row.elo.elo > 0 ? "text-ok" : row.elo.elo < 0 ? "text-danger" : undefined}>{formatEloEstimate(row.elo)}</span>;
}

export function StandingsTable({ record, info }: { record: MatchRecord; info: ParticipantInfo }) {
  const rows = useMemo(() => computeStandings(record.config, record.results), [record.config, record.results]);
  const n = record.config.participants.length;
  const anyGames = record.results.length > 0;
  return (
    <div className="arena-table-wrap">
      <table className="table arena-standings" data-testid="arena-standings">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Engine</th>
            <th className="num">Games</th>
            <th className="num">W</th>
            <th className="num">D</th>
            <th className="num">L</th>
            <th className="num">Points</th>
            <th className="num">Score</th>
            <th className="num">
              <Tooltip content={n === 2 ? "Elo difference to the opponent, ± the 95% confidence interval." : "Elo difference to the average opponent, ± the 95% confidence interval."}>
                <span className="arena-th-help">Elo</span>
              </Tooltip>
            </th>
            <th className="num">
              <Tooltip content="Likelihood of superiority: how sure we can be that this engine is stronger than its opponents (draws ignored).">
                <span className="arena-th-help">LOS</span>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.participant}>
              <td className="num faint">{anyGames ? r.rank : "–"}</td>
              <td>
                <span className="arena-engine-cell">
                  <EngineDot color={info.colors[r.participant]} />
                  <span className={"truncate" + (info.exists[r.participant] ? "" : " faint")}>{info.labels[r.participant]}</span>
                </span>
              </td>
              <td className="num">{r.games}</td>
              <td className="num">{r.wins}</td>
              <td className="num">{r.draws}</td>
              <td className="num">{r.losses}</td>
              <td className="num arena-points">{formatPoints(r.points)}</td>
              <td className="num">{r.games > 0 ? formatPercent(r.score) : "—"}</td>
              <td className="num">{eloCell(r)}</td>
              <td className="num">{r.games > 0 && r.wins + r.losses > 0 ? formatPercent(r.elo.los, 0) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Crosstable({ record, info }: { record: MatchRecord; info: ParticipantInfo }) {
  const { order, cells } = useMemo(() => {
    const standings = computeStandings(record.config, record.results);
    return { order: standings.map((r) => r.participant), cells: crosstable(record.config, resolveResults(record.config, record.results)) };
  }, [record.config, record.results]);
  return (
    <div className="arena-table-wrap">
      <table className="table arena-cross" data-testid="arena-crosstable">
        <thead>
          <tr>
            <th>Engine</th>
            {order.map((p, k) => (
              <th key={p} className="num" title={info.labels[p]}>
                {k + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((p, k) => (
            <tr key={p}>
              <td>
                <span className="arena-engine-cell">
                  <span className="faint num arena-cross-rank">{k + 1}</span>
                  <EngineDot color={info.colors[p]} />
                  <span className="truncate">{info.labels[p]}</span>
                </span>
              </td>
              {order.map((q) => {
                if (p === q) return <td key={q} className="num arena-cross-self" aria-label="same engine" />;
                const c = cells[p][q];
                const plays = record.config.format === "round-robin" || p === 0 || q === 0;
                if (!plays) return <td key={q} className="num faint">·</td>;
                return (
                  <td key={q} className={"num" + (c.games === 0 ? " faint" : c.points * 2 > c.games ? " text-ok" : c.points * 2 < c.games ? " text-danger" : "")}>
                    {c.games === 0 ? "–" : `${formatPoints(c.points)}/${c.games}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
