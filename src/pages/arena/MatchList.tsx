// #/arena — every match with its status, progress and score, plus the way to start new ones.
import { useState } from "react";
import { QUICK_TIME_CONTROL, arena, defaultMatchConfig, matchExtras, scoreLine, useLiveMatch } from "@/arena";
import { getDefaultHashMb, getMaxWorkers } from "@/app/preferences";
import { Link, navigate } from "@/app/router";
import { toast } from "@/app/toast";
import { EmptyState, Icon, ProgressBar, Spinner, useConfirm } from "@/components";
import { useEngines, useMatches } from "@/storage";
import type { MatchRecord } from "@/types";
import { formatRelativeTime, plural } from "@/utils/format";
import { confirmDeleteMatch } from "./confirmDelete";
import { ParticipantChips, StatusBadge, describeConfig, displayStatus, useParticipants } from "./shared";

export function MatchList({ onNew }: { onNew: () => void }) {
  const matches = useMatches();
  const engines = useEngines();
  const [quickBusy, setQuickBusy] = useState(false);

  const classic = engines?.find((e) => e.builtin && e.name === "Classic") ?? engines?.find((e) => e.name === "Classic");
  const blocky = engines?.find((e) => e.builtin && e.name === "Blocky") ?? engines?.find((e) => e.name === "Blocky");

  const quickMatch = async () => {
    if (!classic || !blocky) return;
    setQuickBusy(true);
    try {
      const [hashMb, maxWorkers] = await Promise.all([getDefaultHashMb(), getMaxWorkers()]);
      const base = defaultMatchConfig({ engineIds: [classic.id, blocky.id], hashMb, maxWorkers });
      const config = {
        ...base,
        name: "Classic vs Blocky",
        gamesPerPairing: 4,
        participants: base.participants.map((p) => ({ ...p, timeControl: { ...QUICK_TIME_CONTROL } })),
      };
      const id = await arena.createMatch(config, { start: true });
      navigate(`/arena/${id}`);
    } catch (err) {
      toast("Could not start the match", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setQuickBusy(false);
    }
  };

  return (
    <div className="page arena-page">
      <header className="page-header">
        <div className="grow">
          <h1>Arena</h1>
          <div className="page-subtitle">Pit your engines against each other in matches and round-robin tournaments.</div>
        </div>
        <button className="btn btn-primary" onClick={onNew} data-testid="arena-new">
          <Icon name="plus" size={16} /> New match
        </button>
      </header>

      {matches === undefined ? (
        <div className="arena-loading">
          <Spinner label="Loading matches…" />
        </div>
      ) : matches.length === 0 ? (
        <EmptyState
          className="arena-empty"
          icon={<img src="/pieces/chessnut/wN.svg" alt="" className="arena-empty-icon" />}
          title="No matches yet"
          description={
            <>
              A match plays a series of games between two or more of your engines, with the same openings for both colours and the
              time control or search limits you choose, then ranks them with an Elo estimate. Matches keep running while you use
              other pages.
            </>
          }
          action={
            <div className="stack-sm arena-empty-actions">
              <div className="row-wrap arena-empty-buttons">
              <button className="btn btn-primary" onClick={onNew}>
                <Icon name="plus" size={16} /> New match
              </button>
              {classic && blocky && (
                <button className="btn" onClick={quickMatch} disabled={quickBusy} data-testid="arena-quick">
                  {quickBusy ? <Spinner size={14} /> : <Icon name="play" size={14} />} Quick match: Classic vs Blocky
                </button>
              )}
              </div>
              {classic && blocky && <p className="small faint arena-empty-note">The quick match plays 4 games at 10 s + 0.1 s per side, starting right away.</p>}
            </div>
          }
        />
      ) : (
        <div className="arena-list" data-testid="arena-list">
          {matches.map((m) => (
            <MatchCard key={m.id} record={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchCard({ record }: { record: MatchRecord }) {
  const live = useLiveMatch(record.id);
  const info = useParticipants(record.config);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const status = displayStatus(record, live);
  const done = record.results.length;
  const total = record.totalGames;
  const score = scoreLine(record.config, record.results, info.labels, { final: status === "finished" || status === "aborted" });
  const running = status === "running" || status === "preparing";
  // A match whose engine was deleted cannot be resumed (its page offers a rematch instead).
  const resumable = (status === "pending" || status === "paused" || status === "interrupted") && info.exists.every(Boolean);

  const act = async (fn: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(failure, { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card arena-card" data-testid="arena-card" data-match-id={record.id}>
      <div className="arena-card-head">
        <Link to={`/arena/${record.id}`} className="arena-card-title truncate" title={record.config.name}>
          {record.config.name}
        </Link>
        <StatusBadge status={status} />
      </div>
      <div className="small muted truncate">{describeConfig(record.config)}</div>
      <ParticipantChips info={info} />
      <ProgressBar
        size="sm"
        value={done}
        max={Math.max(1, total)}
        label={`${done} / ${plural(total, "game")}`}
        showValue="percent"
        variant={status === "finished" ? "ok" : status === "aborted" ? "danger" : "accent"}
      />
      <div className="arena-card-score">{score ?? <span className="faint">No games played yet</span>}</div>
      {matchExtras(record).lastError && status !== "running" && (
        <div className="small text-danger truncate" title={matchExtras(record).lastError ?? undefined}>
          <Icon name="alert" size={12} /> {matchExtras(record).lastError}
        </div>
      )}
      <div className="arena-card-foot">
        <span className="small faint" title={new Date(record.createdAt).toLocaleString()}>
          Created {formatRelativeTime(record.createdAt)}
        </span>
        <span className="spacer" />
        {running && (
          <button className="btn btn-sm" disabled={busy} onClick={() => act(() => arena.pause(record.id), "Could not pause the match")}>
            <Icon name="pause" size={13} /> Pause
          </button>
        )}
        {resumable && (
          <button className="btn btn-sm" disabled={busy} onClick={() => act(() => arena.start(record.id), "Could not start the match")}>
            <Icon name="play" size={13} /> {status === "pending" ? "Start" : "Resume"}
          </button>
        )}
        <Link to={`/arena/${record.id}`} className="btn btn-sm">
          Open
        </Link>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          aria-label={`Delete ${record.config.name}`}
          title="Delete"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await confirmDeleteMatch(confirm, record);
            }, "Could not delete the match")
          }
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </article>
  );
}
