// Imperative Lab actions shared by several pages (file import / export, engine creation, play).
// Each reports its outcome with a toast; failures carry the service's user-facing message.
import { navigate } from "@/app/router";
import { dismissToast, toast } from "@/app/toast";
import { datasetsRepo } from "@/storage";
import { datasets, networks } from "@/training";
import type { EngineRecord } from "@/types";
import { downloadBlob, pickFile, slugify } from "@/utils/misc";
import { baseName, errorMessage } from "./model/format";

export const NETWORK_FILE_ACCEPT = ".nnue,.cbnn,.bin,application/octet-stream";
export const DATASET_FILE_ACCEPT = ".cbds,.txt,.bullet,.plain,text/plain,application/octet-stream";

/** Asks for a .nnue file and imports it. Resolves with the new network id (null if cancelled / failed). */
export async function importNetworkFromFile(): Promise<string | null> {
  const file = await pickFile(NETWORK_FILE_ACCEPT);
  if (!file) return null;
  const name = baseName(file.name) || "Imported network";
  try {
    const id = await networks.importFile(file, { name });
    toast(`Imported network “${name}”`, { kind: "success" });
    return id;
  } catch (e) {
    toast("Could not import the network", { kind: "error", detail: errorMessage(e) });
    return null;
  }
}

/** Asks for a .cbds / text file and imports it. Resolves with the new dataset id. */
export async function importDatasetFromFile(): Promise<string | null> {
  const file = await pickFile(DATASET_FILE_ACCEPT);
  if (!file) return null;
  const name = baseName(file.name) || "Imported dataset";
  const t = toast(`Importing “${name}”…`, { timeoutMs: 0 });
  try {
    const id = await datasets.importFile(file, { name });
    const record = await datasetsRepo.get(id).catch(() => undefined);
    // When lines were skipped the service already shows a warning toast (and notes it in the
    // description, "Skipped N invalid …"): one toast per import is enough.
    if (!record?.description.includes("Skipped")) {
      toast(`Imported dataset “${name}”`, { kind: "success", detail: record ? `${record.positions.toLocaleString("en-US")} positions.` : undefined });
    }
    return id;
  } catch (e) {
    toast("Could not import the dataset", { kind: "error", detail: errorMessage(e) });
    return null;
  } finally {
    dismiss(t);
  }
}

export async function exportNetwork(id: string, name: string): Promise<void> {
  try {
    const blob = await networks.exportFile(id);
    downloadBlob(blob, `${slugify(name)}.nnue`);
  } catch (e) {
    toast("Could not export the network", { kind: "error", detail: errorMessage(e) });
  }
}

export async function exportDataset(id: string, name: string): Promise<void> {
  const t = toast(`Preparing “${name}” for download…`, { timeoutMs: 0 });
  try {
    const blob = await datasets.exportFile(id);
    downloadBlob(blob, `${slugify(name)}.cbds`);
  } catch (e) {
    toast("Could not export the dataset", { kind: "error", detail: errorMessage(e) });
  } finally {
    dismiss(t);
  }
}

/** Creates an NNUE engine using the network and opens it in the Workshop. */
export async function createEngineForNetwork(networkId: string, name?: string): Promise<string | null> {
  try {
    const id = await networks.createEngine(networkId, name ? { name } : undefined);
    toast("Engine created", { kind: "success", detail: "It uses this network for its evaluation." });
    navigate(`/engines/${id}`);
    return id;
  } catch (e) {
    toast("Could not create the engine", { kind: "error", detail: errorMessage(e) });
    return null;
  }
}

/**
 * Opens Play against an engine that uses `networkId`: an existing one when there is one (newest
 * first), otherwise a newly created engine.
 */
export async function playAgainstNetwork(networkId: string, engines: readonly EngineRecord[] | undefined, preferEngineId?: string | null): Promise<void> {
  const preferred = preferEngineId ? engines?.find((e) => e.id === preferEngineId) : undefined;
  const existing = preferred ?? [...(engines ?? [])].filter((e) => e.networkId === networkId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (existing) {
    navigate(`/play?engine=${encodeURIComponent(existing.id)}`);
    return;
  }
  try {
    const id = await networks.createEngine(networkId);
    navigate(`/play?engine=${encodeURIComponent(id)}`);
  } catch (e) {
    toast("Could not create an engine for this network", { kind: "error", detail: errorMessage(e) });
  }
}

/** Engines whose evaluation uses this network. */
export function enginesUsing(networkId: string, engines: readonly EngineRecord[] | undefined): EngineRecord[] {
  return (engines ?? []).filter((e) => e.networkId === networkId);
}

/** Progress toasts use timeoutMs 0 (they stay until dismissed). */
function dismiss(id: number): void {
  dismissToast(id);
}
