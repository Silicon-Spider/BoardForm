// Network rename dialog and the delete confirmation (lists the engines that use the network).
import { useEffect, useState } from "react";
import { toast } from "@/app/toast";
import { Modal, type ConfirmFn } from "@/components";
import { networks as networkService } from "@/training";
import type { EngineRecord, NetworkRecord, TrainingRunRecord } from "@/types";
import { enginesUsing } from "../actions";
import { errorMessage } from "../model/format";
import { Field } from "../ui/common";

export function RenameNetworkDialog({ network, onClose }: { network: NetworkRecord | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (network) {
      setName(network.name);
      setDescription(network.description ?? "");
    }
  }, [network]);
  if (!network) return null;
  const trimmed = name.trim();
  const save = async () => {
    if (!trimmed) return;
    setBusy(true);
    try {
      await networkService.rename(network.id, trimmed, description.trim());
      toast("Network renamed", { kind: "success" });
      onClose();
    } catch (e) {
      toast("Could not rename the network", { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Rename network"
      onClose={() => !busy && onClose()}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !trimmed}>
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            Save
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="lab-rename-name">
          <input id="lab-rename-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="Description" htmlFor="lab-rename-desc" hint="Optional — what makes this network special?">
          <textarea id="lab-rename-desc" className="textarea" rows={3} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {!trimmed && <span className="field-error">Give the network a name.</span>}
      </form>
    </Modal>
  );
}

/** Confirms and deletes a network. Resolves true when it was deleted. */
export async function deleteNetworkFlow(
  network: NetworkRecord,
  ctx: { confirm: ConfirmFn; engines: readonly EngineRecord[] | undefined; runs: readonly TrainingRunRecord[] | undefined },
): Promise<boolean> {
  const users = enginesUsing(network.id, ctx.engines);
  const runs = (ctx.runs ?? []).filter((r) => r.networkId === network.id || r.networkHistory.some((h) => h.networkId === network.id));
  const ok = await ctx.confirm({
    title: `Delete “${network.name}”?`,
    danger: true,
    confirmLabel: "Delete network",
    message: (
      <div className="stack-sm">
        <p>The network's weights are deleted. This cannot be undone{users.length === 0 ? "." : ":"}</p>
        {users.length > 0 && (
          <div className="callout warn">
            <strong>{users.length === 1 ? "1 engine uses it" : `${users.length} engines use it`}:</strong> {users.map((e) => e.name).join(", ")}.
            <br />
            {users.length === 1 ? "It" : "They"} can't play until you choose another network for {users.length === 1 ? "it" : "them"} in the Workshop.
          </div>
        )}
        {runs.length > 0 && <p className="small">It stays listed in the history of {runs.length === 1 ? "the run" : `${runs.length} runs`} that trained it, marked as deleted.</p>}
      </div>
    ),
  });
  if (!ok) return false;
  try {
    await networkService.remove(network.id);
    toast(`Deleted “${network.name}”`, { kind: "success" });
    return true;
  } catch (e) {
    toast("Could not delete the network", { kind: "error", detail: errorMessage(e) });
    return false;
  }
}
