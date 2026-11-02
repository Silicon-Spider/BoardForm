// Delete a training run, optionally together with the networks it trained and the datasets it
// generated. Lists the engines that would lose their network.
import { useMemo, useState } from "react";
import { toast } from "@/app/toast";
import { Modal } from "@/components";
import { useDatasets, useEngines } from "@/storage";
import { training } from "@/training";
import type { TrainingRunRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { countOf, errorMessage } from "../model/format";

/** Networks a run produced (its history plus the newest one). */
export function runNetworkIds(run: Pick<TrainingRunRecord, "networkHistory" | "networkId">): string[] {
  const ids = new Set(run.networkHistory.map((h) => h.networkId));
  if (run.networkId) ids.add(run.networkId);
  return [...ids];
}

export function DeleteRunDialog({ run, open, onClose, onDeleted }: { run: TrainingRunRecord; open: boolean; onClose: () => void; onDeleted?: () => void }) {
  const engines = useEngines();
  const allDatasets = useDatasets();
  const [deleteNetworks, setDeleteNetworks] = useState(false);
  const [deleteDatasets, setDeleteDatasets] = useState(true);
  const [busy, setBusy] = useState(false);

  const netIds = useMemo(() => runNetworkIds(run), [run]);
  const generated = useMemo(() => {
    const configured = new Set(run.config.data.datasetIds);
    const ids = new Set(run.datasetIds.filter((id) => !configured.has(id)));
    for (const d of allDatasets ?? []) if (d.source.trainingRunId === run.id && !configured.has(d.id)) ids.add(d.id);
    const records = (allDatasets ?? []).filter((d) => ids.has(d.id));
    return { count: records.length, positions: records.reduce((a, d) => a + d.positions, 0) };
  }, [run, allDatasets]);
  const affectedEngines = (engines ?? []).filter((e) => e.networkId && netIds.includes(e.networkId));

  const confirm = async () => {
    setBusy(true);
    try {
      await training.deleteRun(run.id, { deleteNetworks: deleteNetworks && netIds.length > 0, deleteDatasets: deleteDatasets && generated.count > 0 });
      toast(`Deleted “${run.config.name}”`, { kind: "success" });
      onClose();
      onDeleted?.();
    } catch (e) {
      toast("Could not delete the run", { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Delete “${run.config.name}”?`}
      onClose={() => !busy && onClose()}
      width={500}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="btn cb-btn-danger-solid" onClick={() => void confirm()} disabled={busy}>
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            Delete run
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          The run's settings, charts and log are deleted. {training.isActive(run.id) ? "It is stopped first. " : ""}This cannot be undone.
        </p>
        <label className={"checkbox lab-check-row" + (netIds.length === 0 ? " disabled" : "")}>
          <input type="checkbox" checked={deleteNetworks && netIds.length > 0} disabled={netIds.length === 0 || busy} onChange={(e) => setDeleteNetworks(e.target.checked)} />
          <span>
            Also delete the {netIds.length > 0 ? countOf(netIds.length, "network") : "networks"} it trained
            {netIds.length === 0 && <span className="faint"> (none yet)</span>}
          </span>
        </label>
        {deleteNetworks && affectedEngines.length > 0 && (
          <div className="callout warn small">
            {affectedEngines.length === 1 ? "The engine " : `${affectedEngines.length} engines use these networks: `}
            <strong>{affectedEngines.map((e) => e.name).join(", ")}</strong>
            {affectedEngines.length === 1 ? " uses one of these networks" : ""}. Without its network an NNUE engine falls back to the basic
            evaluation (material and piece-square tables).
          </div>
        )}
        <label className={"checkbox lab-check-row" + (generated.count === 0 ? " disabled" : "")}>
          <input
            type="checkbox"
            checked={deleteDatasets && generated.count > 0}
            disabled={generated.count === 0 || busy}
            onChange={(e) => setDeleteDatasets(e.target.checked)}
          />
          <span>
            Also delete the {generated.count > 0 ? countOf(generated.count, "dataset") : "datasets"} it generated
            {generated.count > 0 ? <span className="faint"> ({formatCount(generated.positions)} positions)</span> : <span className="faint"> (none)</span>}
          </span>
        </label>
        {run.config.data.datasetIds.length > 0 && (
          <div className="small faint">Datasets you chose for this run yourself are kept.</div>
        )}
      </div>
    </Modal>
  );
}
