// Live dashboard of one training run (#/lab/runs/:id): header with phase stepper and controls,
// live progress, loss charts, network history, sample evaluations, settings and log.
import { useMemo, useState } from "react";
import { Link, navigate } from "@/app/router";
import { toast } from "@/app/toast";
import { Icon } from "@/components";
import { useDatasets, useEngines, useNetworks, useTrainingRun } from "@/storage";
import { training, useActiveRunIds, useLiveRun, type LiveRunState } from "@/training";
import type { TrainingRunRecord } from "@/types";
import { playAgainstNetwork } from "../actions";
import {
  canStartStatus,
  countOf,
  errorMessage,
  formatInt,
  formatLoss,
  isActiveStatus,
  PHASE_LABELS,
  persistedPhase,
  startLabel,
  wasInterrupted,
  type RunPhase,
} from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { Breadcrumbs, LoadingBlock, NotFoundState, Panel, RunStatusBadge, Switch } from "../ui/common";
import { ConfigSummary } from "../ui/ConfigSummary";
import { LabIcon } from "../ui/icons";
import { SampleEvalTable, useSampleEvals } from "../ui/SampleEvals";
import { DeleteRunDialog } from "./DeleteRunDialog";
import { useLivePoints, useLockHeld, useOptimisticToggle, useSettled } from "./hooks";
import { LiveProgress } from "./LiveProgress";
import { NetworkHistory } from "./NetworkHistory";
import { PhaseStepper } from "./PhaseStepper";
import { RunCharts } from "./RunCharts";
import { RunLog } from "./RunLog";

type Busy = null | "start" | "pause" | "stop" | "play";

export function RunDashboard({ runId }: { runId: string }) {
  const run = useTrainingRun(runId);
  const live = useLiveRun(runId);
  const activeIds = useActiveRunIds();
  const livePoints = useLivePoints(live);
  const activeHere = activeIds.includes(runId) || live !== null;
  const persistedActive = run ? isActiveStatus(run.status) : false;
  const lockHeld = useLockHeld(runId, !!run && persistedActive && !activeHere);
  const settled = useSettled(2000, runId);

  if (run === undefined) return <LoadingBlock label="Loading the training run…" />;
  if (run === null) return <NotFoundState what="training run" backTo="/lab/runs" backLabel="All training runs" />;
  return (
    <RunDashboardView
      run={run}
      live={live}
      activeHere={activeHere}
      elsewhere={!activeHere && persistedActive && lockHeld === true}
      stale={!activeHere && persistedActive && lockHeld !== true && settled}
      livePoints={livePoints}
    />
  );
}

function RunDashboardView({
  run,
  live,
  activeHere,
  elsewhere,
  stale,
  livePoints,
}: {
  run: TrainingRunRecord;
  live: LiveRunState | null;
  activeHere: boolean;
  elsewhere: boolean;
  stale: boolean;
  livePoints: ReturnType<typeof useLivePoints>;
}) {
  const networks = useNetworks();
  const engines = useEngines();
  const datasets = useDatasets();
  const [busy, setBusy] = useState<Busy>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status = live?.status ?? run.status;
  const phase: RunPhase = live ? live.phase : persistedPhase(run);
  const cycle = live?.cycle ?? run.cycle;
  const cfg = run.config;

  // Newest network (any) and the newest accepted one (what the published engine uses).
  const history = useMemo(() => [...run.networkHistory].sort((a, b) => a.cycle - b.cycle || a.createdAt - b.createdAt), [run.networkHistory]);
  const newest = history.length ? history[history.length - 1] : null;
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const accepted = [...history].reverse().find((h) => !h.gating || h.gating.accepted) ?? null;
  const playNetworkId = accepted?.networkId ?? run.networkId;
  const publishedEngine = run.engineId ? (engines?.find((e) => e.id === run.engineId) ?? null) : null;

  // A continued / widened run starts from an existing network: show it before the first new
  // network exists, and compare the first new network against it.
  const sourceNetworkId = cfg.network.mode === "new" ? null : cfg.network.networkId;
  const sourceExists = !!sourceNetworkId && !!networks?.some((n) => n.id === sourceNetworkId);
  const evalCurrentId = newest?.networkId ?? run.networkId ?? (sourceExists ? sourceNetworkId : null);
  const evalPreviousId = previous?.networkId ?? (newest && sourceExists ? sourceNetworkId : null);
  const newestEvals = useSampleEvals(evalCurrentId);
  const previousEvals = useSampleEvals(evalPreviousId);
  const currentEvalLabel =
    !newest && !run.networkId ? "Starting network" : cfg.loop.enabled ? `Cycle ${(newest?.cycle ?? cycle) + 1}` : evalPreviousId ? "After" : "Network";
  const previousEvalLabel = previous ? `Cycle ${previous.cycle + 1}` : cfg.loop.enabled ? "Start" : "Before";

  const act = async (kind: Exclude<Busy, null>, fn: () => Promise<void>, failure: string) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast(failure, { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const start = () => act("start", () => training.start(run.id), "Could not start the run");
  const pause = () => act("pause", () => training.pause(run.id), "Could not pause the run");
  const stop = () => act("stop", () => training.stop(run.id), "Could not stop the run");
  const play = () =>
    act(
      "play",
      async () => {
        if (!playNetworkId) return;
        await playAgainstNetwork(playNetworkId, engines, publishedEngine?.id ?? null);
      },
      "Could not open Play",
    );
  const [autoResume, savingAuto, setAuto] = useOptimisticToggle(run.autoResume, (on) => training.setAutoResume(run.id, on), "Could not change auto-resume");

  // An errored run gets its Retry button in the error notice instead.
  const canStart = !activeHere && !elsewhere && status !== "error" && (canStartStatus(status) || stale);
  const canPause = activeHere && status !== "paused";
  const canStop = !elsewhere && (activeHere || status === "paused" || stale) && status !== "finished" && status !== "stopped";
  const interrupted = !activeHere && wasInterrupted(run);

  const captions: Partial<Record<"selfplay" | "training" | "evaluating" | "next", string>> = {
    selfplay: live?.selfPlay
      ? `${formatInt(live.selfPlay.gamesDone)} / ${live.selfPlay.gamesTotal === null ? "∞" : formatInt(live.selfPlay.gamesTotal)} games`
      : cfg.data.selfPlay
        ? countOf(cfg.data.selfPlay.games, "game")
        : undefined,
    training: live?.train ? `epoch ${Math.min(live.train.epochs, live.train.epoch + 1)} / ${live.train.epochs}` : countOf(cfg.hyper.epochs, "epoch"),
    evaluating: live?.gating ? `${live.gating.played} / ${live.gating.total} games` : cfg.loop.gating ? countOf(cfg.loop.gating.games, "game") : undefined,
    // `cycle` is 0-based: cycle + 1 is the one running now, cycle + 2 the next.
    next: cfg.loop.enabled ? (cfg.loop.cycles !== null && cycle + 1 >= cfg.loop.cycles ? "this is the last" : `then cycle ${cycle + 2}`) : undefined,
  };

  const panelTitle =
    live && live.phase !== "idle"
      ? `${live.phase === "evaluating" ? "Gating match" : PHASE_LABELS[live.phase]}${cfg.loop.enabled ? ` · cycle ${cycle + 1}` : ""}`
      : "Progress";

  return (
    <div className="lab-run">
      <Breadcrumbs items={[{ label: "NNUE Lab", to: "/lab" }, { label: "Runs", to: "/lab/runs" }, { label: cfg.name }]} />

      <header className="card lab-run-header">
        <div className="lab-run-titlebar">
          <div className="lab-run-name">
            <h1 className="truncate" title={cfg.name}>
              {cfg.name}
            </h1>
            <RunStatusBadge status={status} live={activeHere && isActiveStatus(status)} />
          </div>
          <div className="lab-run-controls">
            {canStart && (
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy !== null}>
                {busy === "start" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="play" size={14} />}
                {stale ? "Resume" : startLabel(status)}
              </button>
            )}
            {canPause && (
              <button type="button" className="btn" onClick={() => void pause()} disabled={busy !== null}>
                {busy === "pause" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="pause" size={14} />}
                Pause
              </button>
            )}
            {canStop && (
              <button type="button" className="btn" onClick={() => void stop()} disabled={busy !== null} title="End the run now and keep the best network so far">
                {busy === "stop" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <LabIcon name="stop" size={14} />}
                Stop
              </button>
            )}
            <ActionMenu
              size="md"
              label="More run actions"
              items={[
                ...(playNetworkId
                  ? [
                      {
                        label: "Continue training the newest network",
                        icon: <LabIcon name="loop" />,
                        onSelect: () => navigate(`/lab/new?networkId=${encodeURIComponent(playNetworkId)}&mode=continue`),
                      },
                      {
                        label: "Widen the newest network",
                        icon: <LabIcon name="widen" />,
                        onSelect: () => navigate(`/lab/new?networkId=${encodeURIComponent(playNetworkId)}&mode=widen`),
                      },
                      "separator" as const,
                    ]
                  : []),
                { label: "Delete run…", icon: <Icon name="trash" />, danger: true, onSelect: () => setDeleteOpen(true) },
              ]}
            />
          </div>
        </div>

        <PhaseStepper run={{ config: cfg, status, cycle }} phase={phase} running={activeHere} captions={captions} />

        <div className="lab-run-subbar">
          <Switch
            checked={autoResume}
            disabled={savingAuto}
            onChange={setAuto}
            label="Keep training when I reopen the app"
            description="Browsers pause background work when the tab closes; this picks the run up again."
          />
          <div className="lab-run-play">
            {publishedEngine && (
              <span className="small muted">
                Engine:{" "}
                <Link to={`/engines/${publishedEngine.id}`} title="Open in the Workshop">
                  {publishedEngine.name}
                </Link>
              </span>
            )}
            <button
              type="button"
              className="btn btn-ok"
              disabled={!playNetworkId || busy !== null}
              onClick={() => void play()}
              title={playNetworkId ? undefined : "Available once the first network is trained"}
            >
              {busy === "play" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <img src="/pieces/chessnut/wN.svg" alt="" className="lab-btn-piece" />}
              Play against the newest network
            </button>
          </div>
        </div>
      </header>

      <RunNotices
        run={run}
        status={status}
        elsewhere={elsewhere}
        stale={stale}
        interrupted={interrupted}
        busy={busy !== null}
        onStart={() => void start()}
        playNetworkId={playNetworkId}
      />

      <div className="lab-run-grid">
        <div className="lab-run-col">
          <Panel title={panelTitle} icon={<LabIcon name={phase === "training" ? "chart" : phase === "evaluating" ? "target" : "loop"} />} id="lab-run-now">
            <LiveProgress run={run} live={live} elsewhere={elsewhere} />
          </Panel>
          <Panel title="Training curves" icon={<LabIcon name="chart" />} id="lab-run-charts">
            <RunCharts run={run} livePoints={livePoints} />
          </Panel>
        </div>
        <div className="lab-run-col">
          <Panel
            title="Networks"
            icon={<LabIcon name="network" />}
            id="lab-run-networks"
            actions={history.length > 0 ? <span className="small muted">{countOf(history.length, "network")}</span> : undefined}
          >
            <NetworkHistory run={run} networks={networks} engines={engines} />
          </Panel>
          <Panel title="Sample evaluations" icon={<LabIcon name="target" />} id="lab-run-evals">
            {evalCurrentId ? (
              <div className="stack-sm">
                {!newest && !run.networkId && (
                  <p className="muted small" style={{ margin: 0 }}>
                    No network trained yet — these are the evaluations of the network this run starts from.
                  </p>
                )}
                <SampleEvalTable
                  current={newestEvals}
                  previous={evalPreviousId ? previousEvals : null}
                  currentLabel={currentEvalLabel}
                  previousLabel={previousEvalLabel}
                />
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Once a network is trained, its evaluations of six standard positions appear here — next to the previous network's, so you can see what changed.
              </p>
            )}
          </Panel>
        </div>
      </div>

      <details className="panel lab-details">
        <summary className="panel-header">
          <Icon name="chevronDown" className="lab-details-chevron" />
          <span className="lab-panel-title">Run settings</span>
          <span className="small muted lab-details-hint">
            {cfg.network.mode === "new" ? `HL${cfg.network.hidden}` : cfg.network.mode === "widen" ? `→ HL${cfg.network.newHidden}` : "continued"} · {countOf(cfg.hyper.epochs, "epoch")}
            {cfg.data.selfPlay ? ` · ${countOf(cfg.data.selfPlay.games, "game")} per cycle` : ""}
          </span>
        </summary>
        <div className="panel-body">
          <ConfigSummary config={cfg} ctx={{ networks, engines, datasets }} />
        </div>
      </details>

      <Panel title="Log" icon={<LabIcon name="list" />} id="lab-run-log" actions={<span className="small muted">{countOf(run.log.length, "line")}</span>}>
        <RunLog log={run.log} />
      </Panel>

      <DeleteRunDialog run={run} open={deleteOpen} onClose={() => setDeleteOpen(false)} onDeleted={() => navigate("/lab/runs")} />
    </div>
  );
}

function RunNotices({
  run,
  status,
  elsewhere,
  stale,
  interrupted,
  busy,
  onStart,
  playNetworkId,
}: {
  run: TrainingRunRecord;
  status: TrainingRunRecord["status"];
  elsewhere: boolean;
  stale: boolean;
  interrupted: boolean;
  busy: boolean;
  onStart: () => void;
  playNetworkId: string | null;
}) {
  const notices = [];
  if (status === "error") {
    notices.push(
      <div key="error" className="callout danger lab-notice" role="alert">
        <div className="grow">
          <strong>This run stopped because of an error.</strong>
          {run.error && <pre className="lab-error-text">{run.error}</pre>}
          <div className="small muted">The log below has the details. Retrying continues from the last checkpoint.</div>
        </div>
        <button type="button" className="btn" onClick={onStart} disabled={busy}>
          <Icon name="reset" size={14} /> Retry
        </button>
      </div>,
    );
  }
  if (elsewhere) {
    notices.push(
      <div key="elsewhere" className="callout lab-notice">
        <LabIcon name="external" />
        <div className="grow">
          <strong>Running in another tab.</strong> Only one tab trains a run at a time. Its saved progress shows up here; pause or stop it from that
          tab.
        </div>
      </div>,
    );
  }
  if (stale) {
    notices.push(
      <div key="stale" className="callout warn lab-notice">
        <Icon name="alert" />
        <div className="grow">
          <strong>Not running anywhere right now.</strong> The tab that was training it was probably closed. Resume to continue where it left off.
        </div>
        <button type="button" className="btn btn-sm" onClick={onStart} disabled={busy}>
          Resume
        </button>
      </div>,
    );
  }
  if (interrupted) {
    notices.push(
      <div key="interrupted" className="callout warn lab-notice">
        <Icon name="pause" />
        <div className="grow">
          <strong>Interrupted.</strong> The app was closed while this run was working, so it was paused. Resume to continue where it left off
          {run.autoResume ? "." : " — or turn on “Keep training when I reopen the app” to do this automatically."}
        </div>
      </div>,
    );
  }
  if (status === "finished") {
    // The network the run ended with: the newest one that passed gating (or was not gated).
    const current = [...run.networkHistory].reverse().find((h) => !h.gating || h.gating.accepted) ?? null;
    notices.push(
      <div key="finished" className="callout ok lab-notice">
        <Icon name="check" />
        <div className="grow">
          <strong>Finished.</strong> {countOf(run.networkHistory.length, "network")} trained
          {current
            ? `; the current one${run.config.loop.enabled ? ` (cycle ${current.cycle + 1})` : ""} has validation loss ${formatLoss(current.valLoss)}`
            : ""}
          .
        </div>
        {playNetworkId && (
          <Link to={`/lab/new?networkId=${encodeURIComponent(playNetworkId)}&mode=continue`} className="btn btn-sm">
            Train it further
          </Link>
        )}
      </div>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="stack-sm">{notices}</div>;
}
