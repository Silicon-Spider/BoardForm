// "What is happening now" panel of the run dashboard: live self-play / training / gating progress
// when the run executes in this tab, otherwise the persisted progress.
import { useMemo } from "react";
import { ProgressBar } from "@/components";
import type { GatingProgress, LiveRunState } from "@/training";
import type { TrainProgress } from "@/nnue/protocol";
import type { TrainingRunRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { formatInt, formatLoss, formatLr, formatScorePct, isActiveStatus, latestValLoss, persistedPhase, PHASE_LABELS, progressFraction, RUN_STATUS } from "../model/format";
import { buildRunChartData } from "../model/chart";
import { StatGrid } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { LiveBoards, ResultsText, SelfPlayProgressView } from "../ui/LiveBoards";

export function LiveProgress({ run, live, elsewhere }: { run: TrainingRunRecord; live: LiveRunState | null; elsewhere: boolean }) {
  if (live) {
    if (live.phase === "selfplay" && live.selfPlay) return <SelfPlayProgressView p={live.selfPlay} title="Self-play games" />;
    if (live.phase === "training" && live.train) return <TrainingView p={live.train} />;
    if (live.phase === "evaluating" && live.gating) return <GatingView p={live.gating} minScore={run.config.loop.gating?.minScore ?? 0.5} />;
    return (
      <div className="lab-idle">
        <span className="spinner" aria-hidden="true" />
        <div>
          <div className="lab-idle-title">{live.phase === "idle" ? "Getting ready…" : `${PHASE_LABELS[live.phase]}…`}</div>
          {live.lastLog && <div className="small muted">{live.lastLog}</div>}
        </div>
      </div>
    );
  }
  return <PersistedProgress run={run} elsewhere={elsewhere} />;
}

function TrainingView({ p }: { p: TrainProgress }) {
  const totalSteps = p.epochs * p.stepsPerEpoch;
  const doneSteps = Math.min(totalSteps, p.epoch * p.stepsPerEpoch + p.step);
  const epochNo = Math.min(p.epochs, p.epoch + 1);
  return (
    <div className="stack">
      <ProgressBar value={totalSteps > 0 ? doneSteps : null} max={totalSteps || 1} size="lg" label={`Training: epoch ${epochNo} of ${p.epochs}`} />
      <ProgressBar
        value={p.stepsPerEpoch > 0 ? p.step : null}
        max={p.stepsPerEpoch || 1}
        size="sm"
        variant="ok"
        label={`Step ${formatCount(p.step)} of ${formatCount(p.stepsPerEpoch)} in this epoch`}
        showValue="none"
      />
      <StatGrid
        items={[
          { label: "Training loss", value: formatLoss(p.trainLoss) },
          { label: "Validation loss", value: formatLoss(p.valLoss), hint: p.valLoss === null ? "no validation data" : "after the last epoch" },
          { label: "Positions trained on", value: formatCount(p.positionsSeen) },
          { label: "Positions / s", value: formatCount(Math.round(p.posPerSec)) },
          { label: "Learning rate", value: formatLr(p.lr) },
        ]}
      />
    </div>
  );
}

function GatingView({ p, minScore }: { p: GatingProgress; minScore: number }) {
  const pct = Math.max(0, Math.min(1, p.score));
  const passing = p.played > 0 && p.score >= minScore;
  return (
    <div className="stack">
      <ProgressBar value={p.total > 0 ? p.played : null} max={p.total || 1} size="lg" label={`Gating match: ${p.played} of ${p.total} games`} />
      <div className="lab-gate">
        <div className="lab-gate-head">
          <span>
            New network scores <strong>{p.played > 0 ? formatScorePct(p.score) : "—"}</strong>
          </span>
          <span className={passing ? "text-ok" : "muted"}>needs {formatScorePct(minScore)}</span>
        </div>
        <div className="lab-gate-meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={pct} aria-label="Gating score">
          <div className={"lab-gate-fill" + (passing ? " ok" : "")} style={{ width: `${pct * 100}%` }} />
          <div className="lab-gate-mark" style={{ left: `${minScore * 100}%` }} title={`Needed: ${formatScorePct(minScore)}`} />
        </div>
      </div>
      <StatGrid
        items={[
          { label: "Wins / draws / losses", value: <ResultsText white={p.wins} draw={p.draws} black={p.losses} /> },
          { label: "Games left", value: String(Math.max(0, p.total - p.played)) },
        ]}
      />
      <LiveBoards boards={p.boards} />
    </div>
  );
}

function PersistedProgress({ run, elsewhere }: { run: TrainingRunRecord; elsewhere: boolean }) {
  const fraction = progressFraction(run.progress);
  const active = isActiveStatus(run.status);
  const phase = persistedPhase(run);
  const { done, total } = run.progress;
  const progressLabel =
    phase === "selfplay"
      ? `Self-play: ${formatInt(done)} of ${formatInt(total)} games`
      : phase === "training"
        ? `Training: step ${formatInt(done)} of ${formatInt(total)}`
        : phase === "evaluating"
          ? `Gating match: ${formatInt(done)} of ${formatInt(total)} games`
          : `Progress: ${formatInt(done)} of ${formatInt(total)}`;
  const totalTrained = useMemo(() => {
    const rows = buildRunChartData(run.points).rows;
    return rows.length ? rows[rows.length - 1].x : 0;
  }, [run.points]);
  const cyclesDone = new Set(run.networkHistory.map((h) => h.cycle)).size;
  const best = useMemo(() => {
    let min: number | null = null;
    for (const p of run.points) if (p.valLoss !== null && Number.isFinite(p.valLoss) && (min === null || p.valLoss < min)) min = p.valLoss;
    return min ?? latestValLoss(run);
  }, [run]);
  return (
    <div className="stack">
      <div className="lab-idle">
        <LabIcon name={active ? "loop" : run.status === "finished" ? "chart" : "pauseCircle"} size={20} />
        <div>
          <div className="lab-idle-title">
            {elsewhere ? "Running in another tab" : active ? "Not running in this tab" : RUN_STATUS[run.status].label}
          </div>
          <div className="small muted">
            {elsewhere
              ? "Its saved progress updates here every few seconds."
              : active
                ? "Its last saved progress is shown below."
                : run.status === "finished"
                  ? "Every cycle of this run is done."
                  : RUN_STATUS[run.status].description}
          </div>
        </div>
      </div>
      {fraction !== null && run.status !== "finished" && (
        <ProgressBar
          value={done}
          max={total}
          label={progressLabel}
          variant={run.status === "error" ? "danger" : run.status === "paused" ? "warn" : "accent"}
        />
      )}
      {run.resume && run.status !== "finished" && (
        <div className="small muted">
          Continues {run.config.loop.enabled ? `in cycle ${run.resume.cycle + 1} ` : ""}at epoch {run.resume.epoch + 1}
          {run.resume.step > 0 ? `, step ${formatInt(run.resume.step)}` : ""}.
        </div>
      )}
      {(run.networkHistory.length > 0 || totalTrained > 0) && (
        <StatGrid
          dense
          items={[
            run.config.loop.enabled && { label: "Cycles done", value: String(cyclesDone) },
            { label: "Networks", value: String(run.networkHistory.length) },
            { label: "Positions trained on", value: formatCount(totalTrained) },
            { label: "Best validation loss", value: formatLoss(best) },
          ]}
        />
      )}
    </div>
  );
}

