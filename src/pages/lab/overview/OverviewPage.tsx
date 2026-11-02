// NNUE Lab overview (#/lab): what the Lab does, runs in progress, quick actions, recent networks
// and datasets, and a three-step guide for new users.
import { useMemo, useState, type ReactNode } from "react";
import { Link, navigate } from "@/app/router";
import { useActivities } from "@/app/activity";
import { toast } from "@/app/toast";
import { Icon, ProgressBar } from "@/components";
import { useDatasets, useEngines, useNetworks, useTrainingRuns } from "@/storage";
import { training, useActiveRunIds, useLiveRun } from "@/training";
import { ACTIVATION_NAMES } from "@/nnue/format";
import type { TrainingRunRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { importDatasetFromFile, importNetworkFromFile, playAgainstNetwork } from "../actions";
import { PHASE_LABELS, countOf, cycleText, errorMessage, formatInt, formatLoss, isActiveStatus, latestValLoss, progressFraction, wasInterrupted } from "../model/format";
import { GenerateDatasetDialog } from "../datasets/GenerateDatasetDialog";
import { LoadingBlock, RunStatusBadge, TimeAgo } from "../ui/common";
import { LabIcon, type LabIconName } from "../ui/icons";

export function OverviewPage() {
  const runs = useTrainingRuns();
  const networks = useNetworks();
  const datasets = useDatasets();
  const engines = useEngines();
  const activeIds = useActiveRunIds();
  const activities = useActivities();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [busy, setBusy] = useState<null | "net" | "data" | "play">(null);

  const loading = runs === undefined || networks === undefined || datasets === undefined;
  const inProgress = useMemo(
    () => (runs ?? []).filter((r) => isActiveStatus(r.status) || r.status === "paused" || activeIds.includes(r.id)),
    [runs, activeIds],
  );
  const recentNetworks = useMemo(() => [...(networks ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5), [networks]);
  const recentDatasets = useMemo(() => [...(datasets ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5), [datasets]);
  const generating = activities.filter((a) => a.id.startsWith("dataset:"));
  const trainedNetworks = (networks ?? []).filter((n) => !n.builtin);
  const isNewUser = !loading && (runs?.length ?? 0) === 0 && trainedNetworks.length === 0;

  const importNet = async () => {
    setBusy("net");
    try {
      const id = await importNetworkFromFile();
      if (id) navigate(`/lab/networks/${id}`);
    } finally {
      setBusy(null);
    }
  };
  const importData = async () => {
    setBusy("data");
    try {
      const id = await importDatasetFromFile();
      if (id) navigate(`/lab/datasets/${id}`);
    } finally {
      setBusy(null);
    }
  };
  const playNewest = async () => {
    const net = [...trainedNetworks].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!net) return;
    setBusy("play");
    try {
      await playAgainstNetwork(net.id, engines);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lab-stack-lg lab-section">
      <header className="lab-hero">
        <div className="lab-hero-text">
          <h1>NNUE Lab</h1>
          <p>
            Train a neural network to evaluate chess positions: an engine plays games against itself, and the network learns to predict the engine's
            scores and the games' results. Then put the network in an engine and play it — or let a run repeat that loop by itself, getting stronger
            every cycle.
          </p>
        </div>
      </header>

      <div className="lab-quick" role="group" aria-label="Quick actions">
        <QuickAction icon="spark" title="New training run" text="Pick a network and the games it learns from." primary onClick={() => navigate("/lab/new")} />
        <QuickAction icon="database" title="Generate dataset" text="Let an engine play itself to collect positions." onClick={() => setGenerateOpen(true)} />
        <QuickAction icon="upload" title="Import network" text=".nnue files in the CBNN format." busy={busy === "net"} onClick={() => void importNet()} />
        <QuickAction icon="layers" title="Import dataset" text=".cbds files or “FEN | score | result” text." busy={busy === "data"} onClick={() => void importData()} />
      </div>

      {loading ? (
        <LoadingBlock label="Loading the Lab…" />
      ) : (
        <>
          {isNewUser && (
            <GettingStarted
              hasDataset={(datasets?.length ?? 0) > 0}
              onGenerate={() => setGenerateOpen(true)}
              onPlay={() => void playNewest()}
              canPlay={trainedNetworks.length > 0}
            />
          )}

          {(inProgress.length > 0 || generating.length > 0) && (
            <section className="panel lab-panel" aria-labelledby="lab-active-title">
              <header className="panel-header">
                <LabIcon name="loop" />
                <h2 className="lab-panel-title" id="lab-active-title">
                  In progress
                </h2>
                <span className="spacer" />
                <Link to="/lab/runs" className="btn btn-ghost btn-sm">
                  All runs <LabIcon name="arrowRight" size={14} />
                </Link>
              </header>
              <div className="lab-active-list">
                {inProgress.map((r) => (
                  <ActiveRunRow key={r.id} run={r} activeHere={activeIds.includes(r.id)} />
                ))}
                {generating.map((a) => (
                  <Link key={a.id} to={a.href ?? "/lab/datasets"} className="lab-active lab-active-link">
                    <div className="lab-active-main">
                      <div className="lab-active-title">
                        <LabIcon name="database" />
                        <span className="truncate lab-strong">{a.label}</span>
                        <span className="badge badge-accent">
                          <span className="lab-live-dot" aria-hidden="true" />
                          Generating
                        </span>
                      </div>
                      {a.detail && <div className="small muted truncate">{a.detail}</div>}
                    </div>
                    <div className="lab-active-progress">
                      <ProgressBar value={typeof a.progress === "number" ? a.progress : null} size="sm" />
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <div className="lab-overview-grid">
            <section className="panel lab-panel" aria-labelledby="lab-recent-nets">
              <header className="panel-header">
                <LabIcon name="network" />
                <h2 className="lab-panel-title" id="lab-recent-nets">
                  Recent networks
                </h2>
                <span className="spacer" />
                <Link to="/lab/networks" className="btn btn-ghost btn-sm">
                  All networks <LabIcon name="arrowRight" size={14} />
                </Link>
              </header>
              {recentNetworks.length === 0 ? (
                <div className="panel-body muted small">No networks yet. They appear here when a training run saves one, or when you import a .nnue file.</div>
              ) : (
                <ul className="lab-recent">
                  {recentNetworks.map((n) => (
                    <li key={n.id}>
                      <Link to={`/lab/networks/${n.id}`} className="lab-recent-row">
                        <span className="lab-recent-name truncate">{n.name}</span>
                        <span className="lab-recent-meta">
                          HL{n.hidden} {ACTIVATION_NAMES[n.activation]}
                          {n.stats.valLoss !== null ? ` · loss ${formatLoss(n.stats.valLoss)}` : n.builtin ? " · starter" : ""}
                        </span>
                        <span className="lab-recent-time small faint">
                          <TimeAgo ts={n.createdAt} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel lab-panel" aria-labelledby="lab-recent-data">
              <header className="panel-header">
                <LabIcon name="database" />
                <h2 className="lab-panel-title" id="lab-recent-data">
                  Recent datasets
                </h2>
                <span className="spacer" />
                <Link to="/lab/datasets" className="btn btn-ghost btn-sm">
                  All datasets <LabIcon name="arrowRight" size={14} />
                </Link>
              </header>
              {recentDatasets.length === 0 ? (
                <div className="panel-body muted small">No datasets yet. Generate one with an engine, or import a file.</div>
              ) : (
                <ul className="lab-recent">
                  {recentDatasets.map((d) => (
                    <li key={d.id}>
                      <Link to={`/lab/datasets/${d.id}`} className="lab-recent-row">
                        <span className="lab-recent-name truncate">{d.name}</span>
                        <span className="lab-recent-meta">
                          {formatCount(d.positions)} positions{d.games > 0 ? ` · ${countOf(d.games, "game")}` : ""}
                        </span>
                        <span className="lab-recent-time small faint">
                          <TimeAgo ts={d.createdAt} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
      <GenerateDatasetDialog open={generateOpen} onClose={() => setGenerateOpen(false)} />
    </div>
  );
}

function QuickAction({ icon, title, text, onClick, primary, busy }: { icon: LabIconName; title: string; text: string; onClick: () => void; primary?: boolean; busy?: boolean }) {
  return (
    <button type="button" className={"lab-quick-card" + (primary ? " primary" : "")} onClick={onClick} disabled={busy}>
      <span className="lab-quick-icon">{busy ? <span className="spinner" /> : <LabIcon name={icon} size={20} />}</span>
      <span className="lab-quick-text">
        <span className="lab-quick-title">{title}</span>
        <span className="lab-quick-desc">{text}</span>
      </span>
    </button>
  );
}

function ActiveRunRow({ run, activeHere }: { run: TrainingRunRecord; activeHere: boolean }) {
  const live = useLiveRun(activeHere ? run.id : null);
  const [busy, setBusy] = useState(false);
  const status = live?.status ?? run.status;
  const cycle = live?.cycle ?? run.cycle;
  let progress: number | null = progressFraction(run.progress);
  // Persisted phases can also be statuses ("paused", "error"…), which the badge already shows.
  let detail: ReactNode = (PHASE_LABELS as Record<string, string>)[run.progress.phase] ?? null;
  if (live?.phase === "selfplay" && live.selfPlay) {
    const p = live.selfPlay;
    progress = p.gamesTotal ? p.gamesDone / p.gamesTotal : null;
    detail = `Self-play · ${formatInt(p.gamesDone)}${p.gamesTotal ? ` / ${formatInt(p.gamesTotal)}` : ""} games · ${formatCount(p.positions)} positions`;
  } else if (live?.phase === "training" && live.train) {
    const t = live.train;
    const total = t.epochs * t.stepsPerEpoch;
    progress = total > 0 ? (t.epoch * t.stepsPerEpoch + t.step) / total : null;
    detail = `Training · epoch ${Math.min(t.epochs, t.epoch + 1)} of ${t.epochs} · loss ${formatLoss(t.trainLoss)}`;
  } else if (live?.phase === "evaluating" && live.gating) {
    const g = live.gating;
    progress = g.total > 0 ? g.played / g.total : null;
    detail = `Gating · ${g.played} / ${g.total} games · ${Math.round(g.score * 100)}%`;
  }
  const loss = latestValLoss(run);
  const resume = async () => {
    setBusy(true);
    try {
      await training.start(run.id);
    } catch (e) {
      toast("Could not resume the run", { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lab-active">
      <div className="lab-active-main">
        <div className="lab-active-title">
          <Link to={`/lab/runs/${run.id}`} className="truncate lab-strong">
            {run.config.name}
          </Link>
          <RunStatusBadge status={status} live={activeHere && isActiveStatus(status)} />
        </div>
        <div className="small muted lab-active-detail">
          <span>{cycleText(cycle, run.config)}</span>
          {detail && <span className="truncate">{detail}</span>}
          {loss !== null && <span>val loss {formatLoss(loss)}</span>}
          {status === "paused" && wasInterrupted(run) && <span className="text-warn">interrupted</span>}
        </div>
      </div>
      <div className="lab-active-progress">
        {status === "paused" ? (
          <button type="button" className="btn btn-sm" onClick={() => void resume()} disabled={busy}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="play" size={13} />} Resume
          </button>
        ) : (
          <ProgressBar value={progress} size="sm" />
        )}
      </div>
      <Link to={`/lab/runs/${run.id}`} className="btn btn-ghost btn-sm lab-active-open" aria-label={`Open ${run.config.name}`}>
        Open <LabIcon name="arrowRight" size={14} />
      </Link>
    </div>
  );
}

function GettingStarted({ hasDataset, onGenerate, onPlay, canPlay }: { hasDataset: boolean; onGenerate: () => void; onPlay: () => void; canPlay: boolean }) {
  const steps: Array<{ n: number; title: string; text: string; done: boolean; action: ReactNode }> = [
    {
      n: 1,
      title: "Generate games with an engine",
      text: "One of your engines — Classic is a good teacher — plays itself. Every position becomes a training example with its score and the game's result.",
      done: hasDataset,
      action: (
        <button type="button" className={hasDataset ? "btn btn-sm" : "btn btn-primary btn-sm"} onClick={onGenerate}>
          <LabIcon name="database" /> Generate dataset
        </button>
      ),
    },
    {
      n: 2,
      title: "Train a network",
      text: "A training run learns from those positions — or plays its own games as it goes. Watch the loss curves fall live.",
      done: false,
      action: (
        <Link to="/lab/new" className={hasDataset ? "btn btn-primary btn-sm" : "btn btn-sm"}>
          <LabIcon name="spark" /> New training run
        </Link>
      ),
    },
    {
      n: 3,
      title: "Play against it",
      text: "The run publishes an engine that uses your network. Play it yourself, or match it against your other engines in the Arena.",
      done: false,
      action: (
        <button type="button" className="btn btn-sm" onClick={onPlay} disabled={!canPlay} title={canPlay ? undefined : "Train a network first"}>
          <Icon name="play" size={13} /> Play
        </button>
      ),
    },
  ];
  return (
    <section className="card lab-guide" aria-labelledby="lab-guide-title">
      <div className="lab-guide-head">
        <h2 id="lab-guide-title">Your first network in three steps</h2>
        <p className="muted">Networks need lots of examples: expect a few thousand games (a few hundred thousand positions) before one plays as well as a simple material count. Everything is saved, so you can stop and come back at any time.</p>
      </div>
      <ol className="lab-guide-steps">
        {steps.map((s) => (
          <li key={s.n} className={"lab-guide-step" + (s.done ? " done" : "")}>
            <span className="lab-guide-num" aria-hidden="true">
              {s.done ? <Icon name="check" size={14} /> : s.n}
            </span>
            <div className="lab-guide-body">
              <h3>
                {s.title}
                {s.done && <span className="lab-sr"> (done)</span>}
              </h3>
              <p className="muted small">{s.text}</p>
              <div>{s.action}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="small faint lab-guide-foot">
        Want the details? <Link to="/help/nnue">How NNUE training works</Link>
      </p>
    </section>
  );
}
