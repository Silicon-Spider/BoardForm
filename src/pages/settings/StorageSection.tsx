// Settings → Storage & data: usage and persistence, record counts, backup export / import and
// restoring the starter engines.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/app/toast";
import { Icon, ProgressBar, useConfirm } from "@/components";
import { errorMessage, restoreStarterEngines } from "@/pages/engines/actions";
import { PageIcon } from "@/pages/engines/icons";
import { cx } from "@/pages/engines/ui";
import {
  enginesRepo,
  exportBackup,
  importBackup,
  requestPersistentStorage,
  storageEstimate,
  subscribe,
  useDatasets,
  useEngines,
  useGames,
  useMatches,
  useNetworks,
  useTrainingRuns,
  type StorageEstimateInfo,
  type StoreCounts,
} from "@/storage";
import { formatBytes, formatCount, formatPercent } from "@/utils/format";
import { debounce, downloadBlob, pickFile } from "@/utils/misc";
import { SettingRow, SettingsSection } from "./controls";
import { backupFileName, duplicateStarterIds, joinList, restoredSummary, usageFraction } from "./settings-logic";

/** Storage usage, refreshed whenever the database changes (debounced) and on demand. */
export function useStorageEstimate(): [StorageEstimateInfo | null, () => void] {
  const [estimate, setEstimate] = useState<StorageEstimateInfo | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    void storageEstimate().then((e) => {
      if (alive.current) setEstimate(e);
    });
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    const later = debounce(refresh, 1000);
    const unsubscribe = subscribe("*", () => later());
    return () => {
      alive.current = false;
      later.cancel();
      unsubscribe();
    };
  }, [refresh]);
  return [estimate, refresh];
}

export function StorageSection() {
  const [estimate, refresh] = useStorageEstimate();
  return (
    <SettingsSection
      id="storage"
      title="Storage & data"
      icon={<PageIcon name="database" size={18} />}
      description="Everything you make is saved in this browser (IndexedDB) — nothing is uploaded. Back it up to keep it safe or move it to another browser."
    >
      <UsageRow estimate={estimate} onRefresh={refresh} />
      <PersistenceRow estimate={estimate} onChanged={refresh} />
      <CountsRow />
      <ExportRow />
      <ImportRow />
      <RestoreStartersRow />
    </SettingsSection>
  );
}

function UsageRow({ estimate, onRefresh }: { estimate: StorageEstimateInfo | null; onRefresh: () => void }) {
  const fraction = estimate ? usageFraction(estimate.usage, estimate.quota) : null;
  const known = estimate !== null && Number.isFinite(estimate.usage);
  return (
    <SettingRow
      title="Storage used"
      stacked
      description={
        estimate === null
          ? "Measuring…"
          : known
            ? Number.isFinite(estimate.quota)
              ? `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} this browser allows for the site${fraction !== null ? ` (${fraction > 0 && fraction < 0.001 ? "under 0.1%" : formatPercent(fraction)})` : ""}.`
              : `${formatBytes(estimate.usage)} used; the browser does not say how much it allows.`
            : "Unknown — this browser does not report storage usage."
      }
    >
      <div className="settings-usage">
        <ProgressBar value={estimate === null ? null : (fraction ?? 0)} variant={fraction !== null && fraction > 0.85 ? "warn" : "accent"} size="sm" className="settings-usage-bar" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRefresh} title="Measure again">
          <PageIcon name="refresh" size={14} /> Refresh
        </button>
      </div>
    </SettingRow>
  );
}

function PersistenceRow({ estimate, onChanged }: { estimate: StorageEstimateInfo | null; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const persisted = estimate?.persisted ?? false;
  const ask = async () => {
    setAsking(true);
    try {
      const ok = await requestPersistentStorage();
      if (ok) toast("Your data is protected", { kind: "success", detail: "The browser will not clear it to free up space." });
      else
        toast("The browser did not grant persistent storage", {
          kind: "warn",
          detail: "Chrome decides by itself (for example for sites you use often or install); Firefox asks you. Your data is still saved — export a backup now and then to be safe.",
          timeoutMs: 9000,
        });
    } finally {
      setAsking(false);
      onChanged();
    }
  };
  return (
    <SettingRow
      title="Keep my data"
      description="When a device runs low on disk space, browsers may delete data of sites that are not marked persistent. Persistent storage asks the browser to keep Chess Builder's data until you delete it."
    >
      <span className={cx("badge settings-status", persisted ? "badge-ok" : "badge-warn")}>
        <span className="settings-status-dot" aria-hidden="true" />
        {estimate === null ? "Checking…" : persisted ? "Protected" : "Not protected"}
      </span>
      {!persisted && (
        <button type="button" className="btn btn-sm" onClick={ask} disabled={asking || estimate === null}>
          {asking ? <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> : <PageIcon name="shield" size={14} />}
          {asking ? "Asking the browser…" : "Keep my data"}
        </button>
      )}
    </SettingRow>
  );
}

function CountsRow() {
  const engines = useEngines();
  const networks = useNetworks();
  const datasets = useDatasets();
  const games = useGames();
  const matches = useMatches();
  const runs = useTrainingRuns();
  const items: Array<[string, unknown[] | undefined]> = [
    ["Engines", engines],
    ["Networks", networks],
    ["Datasets", datasets],
    ["Games", games],
    ["Matches", matches],
    ["Training runs", runs],
  ];
  return (
    <SettingRow title="What's stored" stacked>
      <dl className="settings-counts">
        {items.map(([label, list]) => (
          <div key={label} className="settings-count">
            <dt>{label}</dt>
            <dd className="num">{list === undefined ? <span className="faint">…</span> : formatCount(list.length)}</dd>
          </div>
        ))}
      </dl>
    </SettingRow>
  );
}

function ExportRow() {
  const [includeGames, setIncludeGames] = useState(true);
  const [includeDatasets, setIncludeDatasets] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Bumped to abandon a running export (the reading finishes in the background, nothing is saved).
  const job = useRef(0);
  useEffect(() => () => void job.current++, []);

  const run = async () => {
    const token = ++job.current;
    setExporting(true);
    try {
      const blob = await exportBackup({ includeGames, includeDatasets });
      if (token !== job.current) return;
      const name = backupFileName();
      downloadBlob(blob, name);
      toast("Backup saved", { kind: "success", detail: `${name} · ${formatBytes(blob.size)}` });
    } catch (err) {
      if (token === job.current) toast("Could not create the backup", { kind: "error", detail: errorMessage(err) });
    } finally {
      if (token === job.current) setExporting(false);
    }
  };
  const cancel = () => {
    job.current++;
    setExporting(false);
    toast("Backup cancelled");
  };

  return (
    <SettingRow title="Export a backup" stacked description="One JSON file with your engines, networks, matches, training runs and settings.">
      <div className="settings-backup">
        <label className="checkbox">
          <input type="checkbox" checked={includeGames} onChange={(e) => setIncludeGames(e.target.checked)} disabled={exporting} />
          Include saved games
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={includeDatasets} onChange={(e) => setIncludeDatasets(e.target.checked)} disabled={exporting} />
          Include datasets <span className="faint">(can be large)</span>
        </label>
        <span className="spacer" />
        {exporting && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-sm btn-primary" onClick={run} disabled={exporting}>
          {exporting ? <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> : <PageIcon name="download" size={14} />}
          {exporting ? "Preparing backup…" : "Export backup"}
        </button>
      </div>
    </SettingRow>
  );
}

type ImportOutcome =
  | { ok: true; fileName: string; counts: StoreCounts; duplicates: string[] }
  | { ok: false; fileName: string; message: string };

function ImportRow() {
  const confirm = useConfirm();
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const run = async () => {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    const ok = await confirm({
      title: "Restore this backup?",
      message: (
        <>
          <p>
            <strong>{file.name}</strong> ({formatBytes(file.size)})
          </p>
          <p>Records with the same id are overwritten by the ones in the backup; everything else you have is kept.</p>
        </>
      ),
      confirmLabel: "Restore backup",
    });
    if (!ok) return;
    setImporting(true);
    setOutcome(null);
    try {
      const counts = await importBackup(file);
      const duplicates = duplicateStarterIds(await enginesRepo.list());
      setOutcome({ ok: true, fileName: file.name, counts, duplicates });
      toast("Backup restored", { kind: "success", detail: joinList(restoredSummary(counts)) || undefined });
    } catch (err) {
      setOutcome({ ok: false, fileName: file.name, message: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  const removeDuplicates = async (ids: string[]) => {
    setCleaning(true);
    try {
      for (const id of ids) await enginesRepo.remove(id);
      setOutcome((o) => (o && o.ok ? { ...o, duplicates: [] } : o));
      toast(`Removed ${ids.length === 1 ? "1 duplicate starter engine" : `${ids.length} duplicate starter engines`}`, { kind: "success" });
    } catch (err) {
      toast("Could not remove the duplicates", { kind: "error", detail: errorMessage(err) });
    } finally {
      setCleaning(false);
    }
  };

  const summary = outcome?.ok ? restoredSummary(outcome.counts) : [];
  return (
    <SettingRow title="Restore a backup" description="Bring back a backup file made here or in another browser." stacked={outcome !== null}>
      <div className="stack-sm settings-import">
        <div>
          <button type="button" className="btn btn-sm" onClick={run} disabled={importing}>
            {importing ? <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> : <PageIcon name="upload" size={14} />}
            {importing ? "Restoring…" : "Import backup…"}
          </button>
        </div>
        {outcome?.ok && (
          <div className="callout ok settings-import-result" role="status">
            <div>
              <Icon name="check" className="text-ok" /> Restored from <strong>{outcome.fileName}</strong>
              {summary.length > 0 ? `: ${joinList(summary)}.` : " — the backup contained no records."}
            </div>
            {outcome.duplicates.length > 0 && (
              <div className="settings-import-dupes">
                <span>
                  You now have untouched duplicates of the starter engines ({engineCount(outcome.duplicates.length)}), next to the ones from the backup.
                </span>
                <button type="button" className="btn btn-sm" onClick={() => removeDuplicates(outcome.duplicates)} disabled={cleaning}>
                  {cleaning && <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" />}
                  Remove duplicates
                </button>
              </div>
            )}
          </div>
        )}
        {outcome && !outcome.ok && (
          <div className="callout danger" role="alert">
            <strong>{outcome.fileName} could not be restored.</strong> {outcome.message} Nothing was changed.
          </div>
        )}
      </div>
    </SettingRow>
  );
}

const engineCount = (n: number) => (n === 1 ? "1 engine" : `${n} engines`);

function RestoreStartersRow() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await restoreStarterEngines();
      toast("Starter engines restored", { kind: "success", detail: "Blocky, Classic and Sprout are in your library." });
    } catch (err) {
      toast("Could not restore the starter engines", { kind: "error", detail: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow title="Restore starter engines" description="Adds fresh copies of Blocky, Classic and Sprout to your library. Your own engines — and any starter engines you still have — are not changed.">
      <button type="button" className="btn btn-sm" onClick={run} disabled={busy}>
        {busy ? <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> : <PageIcon name="refresh" size={14} />}
        {busy ? "Restoring…" : "Restore starter engines"}
      </button>
    </SettingRow>
  );
}
