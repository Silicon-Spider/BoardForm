// All datasets (#/lab/datasets): positions, games, size and source; generate, import, export,
// merge and delete.
import { useMemo, useState } from "react";
import { Link, navigate } from "@/app/router";
import { EmptyState, Icon, useConfirm } from "@/components";
import { useDatasets, useEngines, useNetworks, useTrainingRuns } from "@/storage";
import { useDatasetJob } from "@/training";
import type { DatasetRecord, EngineRecord, NetworkRecord } from "@/types";
import { formatBytes, formatCount } from "@/utils/format";
import { exportDataset, importDatasetFromFile } from "../actions";
import { countOf, datasetBytes, describeDatasetSource } from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { LoadingBlock, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { MergeDatasetsDialog, deleteDatasetFlow } from "./datasetActions";
import { GenerateDatasetDialog } from "./GenerateDatasetDialog";

export function DatasetsPage() {
  const datasets = useDatasets();
  const engines = useEngines();
  const networks = useNetworks();
  const runs = useTrainingRuns();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [generateOpen, setGenerateOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [importing, setImporting] = useState(false);

  const sorted = useMemo(() => [...(datasets ?? [])].sort((a, b) => b.createdAt - a.createdAt), [datasets]);
  const chosen = sorted.filter((d) => selected.has(d.id));
  const allChecked = sorted.length > 0 && chosen.length === sorted.length;

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const doImport = async () => {
    setImporting(true);
    try {
      const id = await importDatasetFromFile();
      if (id) navigate(`/lab/datasets/${id}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="stack lab-section">
      <header className="page-header lab-header">
        <div>
          <h1>Datasets</h1>
          <p className="page-subtitle">Positions with search scores and game results — what networks learn from.</p>
        </div>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => void doImport()} disabled={importing}>
          {importing ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <LabIcon name="upload" />} Import
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setGenerateOpen(true)}>
          <LabIcon name="database" /> Generate dataset
        </button>
      </header>

      {datasets === undefined ? (
        <LoadingBlock label="Loading datasets…" />
      ) : datasets.length === 0 ? (
        <EmptyState
          icon={<LabIcon name="database" size={22} />}
          title="No datasets yet"
          description="Let one of your engines play itself to collect positions, or import a .cbds file or a text file with one “FEN | score | result” per line."
          action={
            <>
              <button type="button" className="btn btn-primary" onClick={() => setGenerateOpen(true)}>
                <LabIcon name="database" /> Generate dataset
              </button>
              <button type="button" className="btn" onClick={() => void doImport()}>
                <LabIcon name="upload" /> Import a file
              </button>
            </>
          }
        />
      ) : (
        <div className="panel">
          <div className={"lab-table-tools" + (chosen.length ? " active" : "")} aria-live="polite">
            {chosen.length === 0 ? (
              <span className="small muted">
                {countOf(sorted.length, "dataset")} · {formatCount(sorted.reduce((a, d) => a + d.positions, 0))} positions · tick datasets to merge them or train on them
              </span>
            ) : (
              <>
                <span className="small lab-strong">
                  {countOf(chosen.length, "dataset")} selected · {formatCount(chosen.reduce((a, d) => a + d.positions, 0))} positions
                </span>
                <span className="spacer" />
                <button type="button" className="btn btn-sm" disabled={chosen.length < 2} onClick={() => setMerging(true)} title={chosen.length < 2 ? "Select two or more" : undefined}>
                  <LabIcon name="merge" /> Merge
                </button>
                <Link to={`/lab/new?datasetIds=${chosen.map((d) => encodeURIComponent(d.id)).join(",")}`} className="btn btn-sm">
                  <LabIcon name="spark" /> Train a network on {chosen.length === 1 ? "it" : "them"}
                </Link>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </>
            )}
          </div>
          <div className="lab-table-wrap">
            <table className="table lab-datasets-table">
              <thead>
                <tr>
                  <th className="lab-col-check">
                    <input
                      type="checkbox"
                      aria-label="Select all datasets"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && !allChecked;
                      }}
                      onChange={(e) => setSelected(e.target.checked ? new Set(sorted.map((d) => d.id)) : new Set())}
                    />
                  </th>
                  <th>Name</th>
                  <th className="num">Positions</th>
                  <th className="num">Games</th>
                  <th className="num lab-col-optional">Chunks</th>
                  <th className="num lab-col-optional">Size</th>
                  <th className="lab-col-optional">Source</th>
                  <th className="lab-col-optional">Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <DatasetRow
                    key={d.id}
                    dataset={d}
                    engines={engines}
                    networks={networks}
                    checked={selected.has(d.id)}
                    onCheck={(on) => toggle(d.id, on)}
                    onDelete={async () => {
                      if (await deleteDatasetFlow(d, { confirm, runs })) toggle(d.id, false);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <GenerateDatasetDialog open={generateOpen} onClose={() => setGenerateOpen(false)} />
      {merging && chosen.length >= 2 && <MergeDatasetsDialog items={chosen} onClose={() => setMerging(false)} onMerged={() => setSelected(new Set())} />}
    </div>
  );
}

function DatasetRow({
  dataset: d,
  engines,
  networks,
  checked,
  onCheck,
  onDelete,
}: {
  dataset: DatasetRecord;
  engines: readonly EngineRecord[] | undefined;
  networks: readonly NetworkRecord[] | undefined;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onDelete: () => void;
}) {
  const job = useDatasetJob(d.id);
  const generating = job?.status === "running";
  const positions = generating ? Math.max(d.positions, job.progress.positions) : d.positions;
  const games = generating ? Math.max(d.games, job.progress.gamesDone) : d.games;
  const engineName = d.source.engineId ? engines?.find((e) => e.id === d.source.engineId)?.name : undefined;
  const networkName = d.source.networkId ? networks?.find((n) => n.id === d.source.networkId)?.name : undefined;
  return (
    <tr className={checked ? "lab-row-selected" : undefined}>
      <td className="lab-col-check">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select ${d.name}`} />
      </td>
      <td className="lab-cell-name">
        <Link to={`/lab/datasets/${d.id}`} className="lab-strong truncate" title={d.description || d.name}>
          {d.name}
        </Link>
        {generating && (
          <span className="badge badge-accent">
            <span className="lab-live-dot" aria-hidden="true" />
            Generating
          </span>
        )}
      </td>
      <td className="num">{formatCount(positions)}</td>
      <td className="num">{games > 0 || d.source.kind === "selfplay" ? formatCount(games) : <span className="faint">—</span>}</td>
      <td className="num lab-col-optional">{d.chunks}</td>
      <td className="num lab-col-optional">{formatBytes(datasetBytes({ positions }))}</td>
      <td className="lab-col-optional small muted lab-cell-source" title={describeDatasetSource(d, { engine: engineName, network: networkName })}>
        {describeDatasetSource(d, { engine: engineName, network: networkName })}
      </td>
      <td className="lab-col-optional small muted">
        <TimeAgo ts={d.createdAt} />
      </td>
      <td className="lab-cell-actions">
        <ActionMenu
          label={`Actions for ${d.name}`}
          items={[
            { label: "Open", icon: <LabIcon name="database" />, onSelect: () => navigate(`/lab/datasets/${d.id}`) },
            { label: "Train a network on it", icon: <LabIcon name="spark" />, onSelect: () => navigate(`/lab/new?datasetIds=${encodeURIComponent(d.id)}`) },
            { label: "Export .cbds", icon: <LabIcon name="download" />, disabled: d.positions === 0, onSelect: () => void exportDataset(d.id, d.name) },
            "separator",
            { label: "Delete…", icon: <Icon name="trash" />, danger: true, disabled: generating, title: generating ? "Stop generating first" : undefined, onSelect: onDelete },
          ]}
        />
      </td>
    </tr>
  );
}
