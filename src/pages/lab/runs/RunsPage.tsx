// All training runs (#/lab/runs): status, cycle, latest validation loss, network, auto-resume and
// per-row controls.
import { useState } from "react";
import { Link, navigate } from "@/app/router";
import { toast } from "@/app/toast";
import { EmptyState, Icon } from "@/components";
import { useNetworks, useTrainingRuns } from "@/storage";
import { training, useActiveRunIds, useLiveRun } from "@/training";
import type { NetworkRecord, TrainingRunRecord } from "@/types";
import { canStartStatus, cycleShort, errorMessage, formatLoss, isActiveStatus, latestValLoss, startLabel } from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { LoadingBlock, RunStatusBadge, Switch, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { DeleteRunDialog } from "./DeleteRunDialog";

export function RunsPage() {
  const runs = useTrainingRuns();
  const networks = useNetworks();
  const activeIds = useActiveRunIds();
  const [deleting, setDeleting] = useState<TrainingRunRecord | null>(null);

  return (
    <div className="stack lab-section">
      <header className="page-header lab-header">
        <div>
          <h1>Training runs</h1>
          <p className="page-subtitle">Each run plays self-play games, trains a network on them and, if you like, repeats that loop on its own.</p>
        </div>
      </header>

      {runs === undefined ? (
        <LoadingBlock label="Loading training runs…" />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<LabIcon name="loop" size={22} />}
          title="No training runs yet"
          description="A run trains an NNUE network: it generates games with an engine, learns from them and saves a network you can play against."
          action={
            <Link to="/lab/new" className="btn btn-primary">
              <Icon name="plus" /> New training run
            </Link>
          }
        />
      ) : (
        <div className="panel">
          <div className="lab-table-wrap">
            <table className="table lab-runs-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th className="num">Cycle</th>
                  <th className="num">Val loss</th>
                  <th className="lab-col-optional">Network</th>
                  <th className="lab-col-optional">Updated</th>
                  <th title="Keep training when I reopen the app">Auto-resume</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} networks={networks} activeHere={activeIds.includes(r.id)} onDelete={() => setDeleting(r)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {deleting && <DeleteRunDialog run={deleting} open onClose={() => setDeleting(null)} />}
    </div>
  );
}

function RunRow({
  run,
  networks,
  activeHere,
  onDelete,
}: {
  run: TrainingRunRecord;
  networks: readonly NetworkRecord[] | undefined;
  activeHere: boolean;
  onDelete: () => void;
}) {
  const live = useLiveRun(activeHere ? run.id : null);
  const [busy, setBusy] = useState(false);
  const status = live?.status ?? run.status;
  const cycle = live?.cycle ?? run.cycle;
  const net = run.networkId ? networks?.find((n) => n.id === run.networkId) : undefined;
  const loss = live?.train?.valLoss ?? latestValLoss(run);

  const act = async (fn: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(failure, { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const canStart = !activeHere && canStartStatus(status);
  const canPause = activeHere && status !== "paused";
  const canStop = (activeHere || status === "paused") && status !== "finished" && status !== "stopped";

  return (
    <tr>
      <td className="lab-cell-name">
        <Link to={`/lab/runs/${run.id}`} className="lab-strong truncate" title={run.config.name}>
          {run.config.name}
        </Link>
      </td>
      <td>
        <RunStatusBadge status={status} live={activeHere && isActiveStatus(status)} />
      </td>
      <td className="num">{cycleShort(cycle, run.config)}</td>
      <td className="num">{formatLoss(loss)}</td>
      <td className="lab-col-optional">
        {run.networkId ? (
          net ? (
            <Link to={`/lab/networks/${net.id}`} className="truncate lab-cell-link">
              {net.name}
            </Link>
          ) : (
            <span className="faint">{networks ? "Deleted" : "…"}</span>
          )
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="lab-col-optional small muted">
        <TimeAgo ts={run.updatedAt} />
      </td>
      <td>
        <Switch
          checked={run.autoResume}
          aria-label={`Keep training “${run.config.name}” when I reopen the app`}
          disabled={busy}
          onChange={(on) => void act(() => training.setAutoResume(run.id, on), "Could not change auto-resume")}
        />
      </td>
      <td className="lab-cell-actions">
        {canStart && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => training.start(run.id), "Could not start the run")}>
            <Icon name="play" size={13} /> {startLabel(status)}
          </button>
        )}
        {canPause && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => training.pause(run.id), "Could not pause the run")}>
            <Icon name="pause" size={13} /> Pause
          </button>
        )}
        <ActionMenu
          label={`More actions for ${run.config.name}`}
          items={[
            { label: "Open dashboard", icon: <LabIcon name="chart" />, onSelect: () => navigate(`/lab/runs/${run.id}`) },
            {
              label: "Stop",
              icon: <LabIcon name="stop" />,
              disabled: !canStop || busy,
              title: canStop ? "End the run now and keep the best network so far" : "Only a running or paused run can be stopped",
              onSelect: () => void act(() => training.stop(run.id), "Could not stop the run"),
            },
            "separator",
            { label: "Delete…", icon: <Icon name="trash" />, danger: true, onSelect: onDelete },
          ]}
        />
      </td>
    </tr>
  );
}
