// Dataset merge dialog and delete confirmation.
import { useState } from "react";
import { navigate } from "@/app/router";
import { toast } from "@/app/toast";
import { Modal, type ConfirmFn } from "@/components";
import { datasets as datasetService } from "@/training";
import type { DatasetRecord, TrainingRunRecord } from "@/types";
import { formatBytes, formatCount } from "@/utils/format";
import { countOf, datasetBytes, errorMessage } from "../model/format";
import { Field } from "../ui/common";

export function MergeDatasetsDialog({ items, onClose, onMerged }: { items: readonly DatasetRecord[]; onClose: () => void; onMerged?: () => void }) {
  const [name, setName] = useState(`Merged · ${items.map((d) => d.name).slice(0, 2).join(" + ")}${items.length > 2 ? " + …" : ""}`.slice(0, 120));
  const [busy, setBusy] = useState(false);
  const positions = items.reduce((a, d) => a + d.positions, 0);
  const merge = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const id = await datasetService.merge(
        items.map((d) => d.id),
        name.trim(),
      );
      toast(`Merged ${countOf(items.length, "dataset")}`, { kind: "success", detail: "The originals are kept." });
      onClose();
      onMerged?.();
      navigate(`/lab/datasets/${id}`);
    } catch (e) {
      toast("Could not merge the datasets", { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`Merge ${countOf(items.length, "dataset")}`}
      onClose={() => !busy && onClose()}
      width={500}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void merge()} disabled={busy || !name.trim()}>
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            Merge
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void merge();
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          Creates one new dataset with all their positions ({formatCount(positions)}, about {formatBytes(datasetBytes({ positions }))}). The originals are kept.
        </p>
        <ul className="lab-list small">
          {items.map((d) => (
            <li key={d.id} className="lab-list-row">
              <span className="truncate">{d.name}</span>
              <span className="spacer" />
              <span className="faint num">{formatCount(d.positions)}</span>
            </li>
          ))}
        </ul>
        <Field label="Name of the merged dataset" htmlFor="lab-merge-name">
          <input id="lab-merge-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
      </form>
    </Modal>
  );
}

/** Confirms and deletes a dataset; resolves true when deleted. */
export async function deleteDatasetFlow(d: DatasetRecord, ctx: { confirm: ConfirmFn; runs: readonly TrainingRunRecord[] | undefined }): Promise<boolean> {
  const runs = (ctx.runs ?? []).filter((r) => r.config.data.datasetIds.includes(d.id) || r.datasetIds.includes(d.id));
  const ok = await ctx.confirm({
    title: `Delete “${d.name}”?`,
    danger: true,
    confirmLabel: "Delete dataset",
    message: (
      <div className="stack-sm">
        <p>
          Its {formatCount(d.positions)} positions ({formatBytes(datasetBytes(d))}) are deleted. Networks already trained on it keep working. This cannot be
          undone.
        </p>
        {runs.length > 0 && (
          <div className="callout warn">
            Used by {runs.length === 1 ? "the run" : `${runs.length} runs`} <strong>{runs.map((r) => r.config.name).join(", ")}</strong>. From now on{" "}
            {runs.length === 1 ? "it trains" : "they train"} without these positions; a run with no other data cannot continue.
          </div>
        )}
      </div>
    ),
  });
  if (!ok) return false;
  try {
    await datasetService.remove(d.id);
    toast(`Deleted “${d.name}”`, { kind: "success" });
    return true;
  } catch (e) {
    toast("Could not delete the dataset", { kind: "error", detail: errorMessage(e) });
    return false;
  }
}
