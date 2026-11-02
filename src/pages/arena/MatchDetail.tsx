// #/arena/:id — one match: controls, progress, standings, live boards, results, settings and log.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  arena,
  buildSlots,
  colorStats,
  computeStandings,
  formatPoints,
  joinPgn,
  matchElapsedMs,
  matchExtras,
  useLiveMatch,
  type ArenaLogEntry,
  type LiveGameView,
  type LiveMatchState,
} from "@/arena";
import { Link, navigate, setQuery } from "@/app/router";
import { toast } from "@/app/toast";
import { EmptyState, Icon, ProgressBar, Spinner, Tooltip, useConfirm } from "@/components";
import { gamesRepo, useMatch } from "@/storage";
import type { MatchRecord } from "@/types";
import { formatDateTime, formatDuration, formatPercent, plural } from "@/utils/format";
import { downloadText, slugify } from "@/utils/misc";
import { confirmDeleteMatch } from "./confirmDelete";
import { LiveBoards, LiveGameModal } from "./LiveBoards";
import { GameReplayModal, ResultsTable } from "./Results";
import { Crosstable, StandingsTable } from "./Standings";
import { EngineDot, StatusBadge, formatEloEstimate, useEngineMap, describeConfig, describeParticipant, displayStatus, useNow, useParticipants, type MatchDisplayStatus, type ParticipantInfo } from "./shared";

export function MatchDetail({ id }: { id: string }) {
  const record = useMatch(id);
  const live = useLiveMatch(id);
  if (record === undefined) {
    return (
      <div className="page arena-page">
        <div className="arena-loading">
          <Spinner label="Loading the match…" />
        </div>
      </div>
    );
  }
  if (record === null) {
    return (
      <div className="page arena-page">
        <EmptyState
          title="Match not found"
          description="It may have been deleted, or the link is from another browser."
          action={
            <Link to="/arena" className="btn btn-primary">
              Back to the Arena
            </Link>
          }
        />
      </div>
    );
  }
  return <MatchView record={record} live={live} />;
}

function MatchView({ record, live }: { record: MatchRecord; live: LiveMatchState | null }) {
  const info = useParticipants(record.config);
  const confirm = useConfirm();
  const status = displayStatus(record, live);
  const extras = matchExtras(record);
  const [busy, setBusy] = useState<string | null>(null);
  const [liveSlot, setLiveSlot] = useState<number | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);
  const ticking = status === "running" || status === "preparing" || status === "remote" || status === "stopping";
  const now = useNow(1000, ticking);

  const running = status === "running" || status === "preparing" || status === "stopping";
  // A match whose engine was deleted can never continue (the runner refuses to start it).
  const missingEngine = info.exists.some((e) => !e);
  const canStart = (status === "pending" || status === "paused" || status === "interrupted") && !missingEngine;
  // While stopping, Pause and Abort stay visible but disabled.
  const canPause = status === "running" || status === "preparing" || status === "remote" || status === "stopping";
  const canAbort = canPause || status === "paused" || status === "interrupted";
  const savedGames = record.results.filter((r) => r.gameId).length;
  const lastError = live?.lastError ?? extras.lastError ?? null;
  const slots = useMemo(() => buildSlots(record.config), [record.config]);
  // Clocks turn red in the last 10% of the base time (at most 10 s, at least 0.5 s).
  const lowTimeFor = (view: LiveGameView, side: "w" | "b") => {
    const slot = slots[view.index];
    const base = slot ? record.config.participants[side === "w" ? slot.white : slot.black]?.timeControl?.baseMs : undefined;
    return base ? Math.min(10_000, Math.max(500, base * 0.1)) : 10_000;
  };
  const colorOf = (engineId: string) => {
    const i = record.config.participants.findIndex((p) => p.engineId === engineId);
    return i >= 0 ? info.colors[i] : "var(--text-faint)";
  };

  const act = async (key: string, fn: () => Promise<void>, failure: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast(failure, { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const abort = () =>
    act(
      "abort",
      async () => {
        const ok = await confirm({
          title: "Abort the match?",
          message: "Games in progress are discarded and the match ends with its current standings. An aborted match cannot be resumed.",
          confirmLabel: "Abort match",
          danger: true,
        });
        if (ok) await arena.abort(record.id);
      },
      "Could not abort the match",
    );

  const exportPgn = () =>
    act(
      "pgn",
      async () => {
        const games = await gamesRepo.list({ matchId: record.id });
        if (games.length === 0) {
          toast("This match has no saved games to export", { kind: "warn" });
          return;
        }
        const order = new Map(record.results.map((r) => [r.gameId, r.index] as const));
        games.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
        downloadText(joinPgn(games), `${slugify(record.config.name)}.pgn`, "application/x-chess-pgn");
        toast(`Exported ${plural(games.length, "game")}`, { kind: "success" });
      },
      "Could not export the games",
    );

  const remove = () =>
    act(
      "delete",
      async () => {
        if (await confirmDeleteMatch(confirm, record)) navigate("/arena", { replace: true });
      },
      "Could not delete the match",
    );

  const liveView = liveSlot === null ? null : (live?.games.find((g) => g.slot === liveSlot) ?? null);

  return (
    <div className="page arena-page arena-detail" data-testid="arena-detail" data-status={status}>
      <nav className="arena-breadcrumb small">
        <Link to="/arena">
          <Icon name="prev" size={13} /> Arena
        </Link>
      </nav>
      <header className="page-header arena-detail-header">
        <div className="grow arena-detail-title">
          <div className="row-wrap">
            <h1 className="truncate" title={record.config.name}>
              {record.config.name}
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="page-subtitle">
            {describeConfig(record.config)} · created {formatDateTime(record.createdAt)}
          </div>
        </div>
        <div className="arena-actions" role="group" aria-label="Match controls">
          {canStart && (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => act("start", () => arena.start(record.id), "Could not start the match")} data-testid="arena-start">
              {busy === "start" ? <Spinner size={14} /> : <Icon name="play" size={14} />} {status === "pending" ? "Start" : "Resume"}
            </button>
          )}
          {canPause && (
            <button className="btn" disabled={busy !== null || status === "stopping"} onClick={() => act("pause", () => arena.pause(record.id), "Could not pause the match")} data-testid="arena-pause">
              {busy === "pause" ? <Spinner size={14} /> : <Icon name="pause" size={14} />} Pause
            </button>
          )}
          {canAbort && (
            <button className="btn" disabled={busy !== null || status === "stopping"} onClick={abort} data-testid="arena-abort">
              <Icon name="clear" size={14} /> Abort
            </button>
          )}
          <button className="btn" onClick={() => setQuery({ new: "1", from: record.id })} data-testid="arena-rematch">
            <Icon name="reset" size={14} /> Rematch
          </button>
          <Tooltip content={savedGames === 0 ? (record.config.saveGames ? "No games finished yet" : "This match does not save its games") : `Download all ${savedGames} games as one PGN file`}>
            <button className="btn" disabled={busy !== null || savedGames === 0} onClick={exportPgn} data-testid="arena-export">
              <Icon name="copy" size={14} /> Export PGN
            </button>
          </Tooltip>
          <button className="btn btn-danger btn-icon" aria-label="Delete match" title="Delete match" disabled={busy !== null} onClick={remove} data-testid="arena-delete">
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <Notices
        record={record}
        status={status}
        live={live}
        lastError={lastError}
        missingEngine={missingEngine}
        onResume={() => act("start", () => arena.start(record.id), "Could not start the match")}
        onRematch={() => setQuery({ new: "1", from: record.id })}
      />

      <div className="arena-detail-grid">
        <div className="arena-detail-main">
          <Summary record={record} info={info} status={status} now={now} />

          {running && live && (
            <section className="panel" aria-labelledby="arena-live-title">
              <div className="panel-header">
                <span id="arena-live-title">Live games</span>
                <span className="spacer" />
                {live.games.length === 0 ? null : live.phase === "stopping" ? (
                  <Spinner label={live.status ?? "Stopping…"} />
                ) : (
                  <span className="small muted">Click a board to watch it</span>
                )}
              </div>
              <div className="panel-body">
                {live.games.length > 0 ? (
                  <LiveBoards games={live.games} colorOf={colorOf} lowTimeFor={lowTimeFor} onOpen={setLiveSlot} />
                ) : (
                  <div className="arena-live-waiting muted">
                    <Spinner
                      label={
                        live.phase === "preparing"
                          ? (live.status ?? "Preparing the engines…")
                          : live.phase === "stopping"
                            ? (live.status ?? "Stopping…")
                            : "Starting the engines…"
                      }
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="panel" aria-labelledby="arena-standings-title">
            <div className="panel-header">
              <span id="arena-standings-title">Standings</span>
            </div>
            <div className="panel-body arena-panel-flush">
              <StandingsTable record={record} info={info} />
            </div>
          </section>

          {record.config.participants.length > 2 && (
            <section className="panel" aria-labelledby="arena-cross-title">
              <div className="panel-header">
                <span id="arena-cross-title">Crosstable</span>
                <span className="spacer" />
                <span className="small muted">Points of the row engine against the column engine</span>
              </div>
              <div className="panel-body arena-panel-flush">
                <Crosstable record={record} info={info} />
              </div>
            </section>
          )}

          <section className="panel" aria-labelledby="arena-results-title">
            <div className="panel-header">
              <span id="arena-results-title">Games</span>
              <span className="badge">{record.results.length}</span>
              <span className="spacer" />
              {savedGames > 0 && <span className="small muted">Click a game to replay it</span>}
            </div>
            <div className="panel-body arena-panel-flush">
              <ResultsTable record={record} info={info} onOpen={setReplayId} />
            </div>
          </section>
        </div>

        <aside className="arena-detail-side">
          <SettingsPanel record={record} info={info} />
          <LogPanel log={live?.log ?? []} lastError={extras.lastError ?? null} interrupted={!!extras.interrupted && status === "interrupted"} />
        </aside>
      </div>

      {liveSlot !== null && <LiveGameModal view={liveView} colorOf={colorOf} lowTimeFor={lowTimeFor} onClose={() => setLiveSlot(null)} />}
      {replayId && <GameReplayModal gameId={replayId} onClose={() => setReplayId(null)} />}
    </div>
  );
}

function Notices(props: {
  record: MatchRecord;
  status: MatchDisplayStatus;
  live: LiveMatchState | null;
  lastError: string | null;
  missingEngine: boolean;
  onResume: () => void;
  onRematch: () => void;
}) {
  const { record, status, live, lastError, missingEngine, onResume, onRematch } = props;
  const engines = useEngineMap();
  const errorEngineId = matchExtras(record).lastErrorEngineId ?? null;
  const errorEngine = errorEngineId ? (engines?.get(errorEngineId) ?? null) : null;
  if (status === "remote") {
    return (
      <div className="callout arena-notice" data-testid="arena-remote">
        <strong>This match is running in another tab.</strong> Results appear here as games finish; the live boards are shown in that tab. You can still pause or abort it from here.
      </div>
    );
  }
  if (missingEngine && (status === "pending" || status === "paused" || status === "interrupted")) {
    return (
      <div className="callout warn arena-notice" data-testid="arena-missing-engine">
        <div className="row-wrap">
          <span className="grow">
            <strong>An engine in this match was deleted</strong>, so the match cannot continue.{" "}
            {record.results.length > 0 ? "Its finished games and standings are kept. " : ""}A rematch plays the same settings with another engine.
          </span>
          <button className="btn btn-sm btn-primary" onClick={onRematch}>
            <Icon name="reset" size={13} /> Rematch
          </button>
        </div>
      </div>
    );
  }
  if (status === "interrupted") {
    return (
      <div className="callout warn arena-notice" data-testid="arena-interrupted">
        <div className="row-wrap">
          <span className="grow">
            <strong>This match was interrupted</strong> because its tab was closed or reloaded. Games that were in progress are replayed from the start when you resume.
          </span>
          <button className="btn btn-sm btn-primary" onClick={onResume}>
            <Icon name="play" size={13} /> Resume
          </button>
        </div>
      </div>
    );
  }
  if (lastError && (status === "paused" || (status !== "running" && status !== "preparing" && live?.lastError))) {
    return (
      <div className="callout danger arena-notice" role="alert" data-testid="arena-error">
        <strong>The match stopped because of an error.</strong>
        <div className="arena-error-text">{lastError}</div>
        <div className="row-wrap arena-error-actions">
          <span className="small muted grow">
            {errorEngine ? `Fix ${errorEngine.name} in the Workshop, then resume.` : "Fix the problem, then resume."} Finished games are kept.
          </span>
          {errorEngine && (
            <Link to={`/engines/${errorEngine.id}`} className="btn btn-sm">
              Open {errorEngine.name}
            </Link>
          )}
          <button className="btn btn-sm btn-primary" onClick={onResume}>
            <Icon name="play" size={13} /> Resume
          </button>
        </div>
      </div>
    );
  }
  if (status === "pending" && record.results.length === 0) {
    return (
      <div className="callout arena-notice">
        This match has not started yet. Press <strong>Start</strong> to play its {plural(record.totalGames, "game")}.
      </div>
    );
  }
  return null;
}

function Summary({ record, info, status, now }: { record: MatchRecord; info: ParticipantInfo; status: MatchDisplayStatus; now: number }) {
  const done = record.results.length;
  const total = record.totalGames;
  const elapsed = matchElapsedMs(record, now);
  const stats = colorStats(record.results);
  const avgPlies = done > 0 ? Math.round(record.results.reduce((s, r) => s + r.plies, 0) / done) : null;
  const active = status === "running" || status === "remote";
  const eta = active && done > 0 && done < total ? (elapsed / done) * (total - done) : null;
  const rows = useMemo(() => computeStandings(record.config, record.results), [record.config, record.results]);
  const duel = record.config.participants.length === 2;
  const a = rows.find((r) => r.participant === 0);
  const b = rows.find((r) => r.participant === 1);
  // Everyone ranked first (equal points, tie-break and wins share a rank).
  const leaders = rows.filter((r) => r.rank === 1);
  const ended = status === "finished" || status === "aborted";
  const leaderTitle = leaders.length > 1 ? (ended ? "Shared first place" : "Shared lead") : ended ? "Winner" : "Leader";

  return (
    <section className="card arena-summary" aria-label="Match summary" data-testid="arena-summary">
      {duel && a && b ? (
        <div className="arena-duel">
          <div className="arena-duel-side">
            <EngineDot color={info.colors[0]} />
            <span className="arena-duel-name truncate">{info.labels[0]}</span>
          </div>
          <div className="arena-duel-score num" data-testid="arena-score">
            {formatPoints(a.points)} <span className="faint">–</span> {formatPoints(b.points)}
          </div>
          <div className="arena-duel-side arena-duel-side--right">
            <span className="arena-duel-name truncate">{info.labels[1]}</span>
            <EngineDot color={info.colors[1]} />
          </div>
          {done > 0 && (
            <>
              <div className="arena-wdl" aria-label={`${a.wins} wins, ${a.draws} draws, ${a.losses} losses for ${info.labels[0]}`}>
                <span className="arena-wdl-win" style={{ flexGrow: a.wins }} title={`${info.labels[0]} won ${a.wins}`} />
                <span className="arena-wdl-draw" style={{ flexGrow: a.draws }} title={`${a.draws} draws`} />
                <span className="arena-wdl-loss" style={{ flexGrow: a.losses }} title={`${info.labels[1]} won ${a.losses}`} />
              </div>
              <div className="arena-duel-detail small muted">
                +{a.wins} ={a.draws} −{a.losses} · Elo {formatEloEstimate(a.elo)} · LOS {a.wins + a.losses > 0 ? formatPercent(a.elo.los, 0) : "—"}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="arena-leader">
          {done > 0 && leaders.length > 0 ? (
            <>
              <span className="section-title">{leaderTitle}</span>
              <div className="arena-leader-names">
                {leaders.map((row) => (
                  <div key={row.participant} className="arena-leader-name">
                    <EngineDot color={info.colors[row.participant]} />
                    <span className="truncate">{info.labels[row.participant]}</span>
                    <span className="num muted">
                      {formatPoints(row.points)} / {row.games}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <span className="muted">No games played yet.</span>
          )}
        </div>
      )}
      <ProgressBar
        value={done}
        max={Math.max(1, total)}
        label="Games played"
        showValue="fraction"
        variant={status === "finished" ? "ok" : status === "aborted" ? "danger" : "accent"}
      />
      <dl className="arena-stats">
        <div>
          <dt>Elapsed</dt>
          <dd className="num">{formatDuration(elapsed)}</dd>
        </div>
        <div>
          <dt>Time left</dt>
          <dd className="num">{eta !== null ? `≈ ${formatDuration(eta)}` : status === "finished" ? "Done" : "—"}</dd>
        </div>
        <div>
          <dt>White wins</dt>
          <dd className="num">{stats.white}</dd>
        </div>
        <div>
          <dt>Draws</dt>
          <dd className="num">{stats.draws}</dd>
        </div>
        <div>
          <dt>Black wins</dt>
          <dd className="num">{stats.black}</dd>
        </div>
        <div>
          <dt>Avg. length</dt>
          <dd className="num">{avgPlies !== null ? `${avgPlies} plies` : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

function SettingsPanel({ record, info }: { record: MatchRecord; info: ParticipantInfo }) {
  const c = record.config;
  const a = c.adjudication;
  const openings =
    c.openings.mode === "book" ? `Opening book (seed ${c.openings.seed ?? 1})` : c.openings.mode === "random-plies" ? `${c.openings.randomPlies ?? 0} random plies (seed ${c.openings.seed ?? 1})` : "Start position";
  const adjudication = [
    a.resignScoreCp !== null ? `resign at ${a.resignScoreCp} cp × ${a.resignMoves}` : null,
    a.drawScoreCp !== null ? `draw within ${a.drawScoreCp} cp × ${a.drawMoves} after ply ${a.drawMinPly}` : null,
    a.maxPlies !== null ? `draw after ${a.maxPlies} plies` : null,
  ].filter(Boolean);
  return (
    <section className="panel" aria-labelledby="arena-settings-title">
      <div className="panel-header">
        <span id="arena-settings-title">Settings</span>
      </div>
      <div className="panel-body arena-settings">
        <ul className="arena-settings-engines">
          {c.participants.map((p, i) => (
            <li key={i}>
              <div className="arena-engine-cell">
                <EngineDot color={info.colors[i]} />
                {info.exists[i] ? (
                  <Link to={`/engines/${p.engineId}`} className="truncate">
                    {info.labels[i]}
                  </Link>
                ) : (
                  <span className="truncate faint">{info.labels[i]}</span>
                )}
              </div>
              <div className="small muted">
                {describeParticipant(p)}
                {p.hashMb ? ` · ${p.hashMb} MB hash` : ""}
              </div>
            </li>
          ))}
        </ul>
        <dl className="arena-settings-list">
          <dt>Format</dt>
          <dd>
            {c.format === "gauntlet" ? "Gauntlet" : "Round robin"} · {plural(c.gamesPerPairing, "game")} per pairing
          </dd>
          <dt>Openings</dt>
          <dd>{openings}</dd>
          <dt>Adjudication</dt>
          <dd>{adjudication.length ? adjudication.join("; ") : "Off"}</dd>
          <dt>Games at once</dt>
          <dd>{c.concurrency}</dd>
          <dt>Games saved</dt>
          <dd>{c.saveGames ? "Yes" : "No"}</dd>
        </dl>
      </div>
    </section>
  );
}

function LogPanel({ log, lastError, interrupted }: { log: ArenaLogEntry[]; lastError: string | null; interrupted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const empty = log.length === 0 && !lastError && !interrupted;
  return (
    <section className="panel" aria-labelledby="arena-log-title">
      <div className="panel-header">
        <span id="arena-log-title">Log</span>
        <span className="spacer" />
        <span className="small faint">This session</span>
      </div>
      <div className="panel-body arena-log" ref={ref} data-testid="arena-log">
        {empty ? (
          <div className="small faint">Engine messages and errors appear here while the match runs in this tab.</div>
        ) : (
          <>
            {log.length === 0 && interrupted && <div className="arena-log-line arena-log--warn">The match was interrupted when its tab closed.</div>}
            {log.length === 0 && lastError && <div className="arena-log-line arena-log--error">{lastError}</div>}
            {log.map((e, i) => (
              <div key={i} className={`arena-log-line arena-log--${e.level}`}>
                <span className="arena-log-time num">{time(e.at)}</span>
                <span className="arena-log-text">{e.text}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
