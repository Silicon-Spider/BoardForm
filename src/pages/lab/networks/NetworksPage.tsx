// All NNUE networks (#/lab/networks): size, activation, loss, lineage and per-row actions.
import { useMemo, useState } from "react";
import { Link, navigate } from "@/app/router";
import { EmptyState, Icon, useConfirm } from "@/components";
import { useEngines, useNetworks, useTrainingRuns } from "@/storage";
import { ACTIVATION_NAMES } from "@/nnue/format";
import type { NetworkRecord } from "@/types";
import { formatBytes, formatCount } from "@/utils/format";
import { createEngineForNetwork, enginesUsing, exportNetwork, importNetworkFromFile } from "../actions";
import { formatLoss } from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { LoadingBlock, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { RenameNetworkDialog, deleteNetworkFlow } from "./networkActions";

export function NetworksPage() {
  const networks = useNetworks();
  const engines = useEngines();
  const runs = useTrainingRuns();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState<NetworkRecord | null>(null);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);

  const sorted = useMemo(() => [...(networks ?? [])].sort((a, b) => b.createdAt - a.createdAt), [networks]);
  const q = query.trim().toLowerCase();
  const shown = q ? sorted.filter((n) => n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q)) : sorted;
  const byId = useMemo(() => new Map(sorted.map((n) => [n.id, n] as const)), [sorted]);

  const doImport = async () => {
    setImporting(true);
    try {
      const id = await importNetworkFromFile();
      if (id) navigate(`/lab/networks/${id}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="stack lab-section">
      <header className="page-header lab-header">
        <div>
          <h1>Networks</h1>
          <p className="page-subtitle">Trained NNUE evaluations. Put one in an engine to play with it, or keep training it.</p>
        </div>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => void doImport()} disabled={importing}>
          {importing ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <LabIcon name="upload" />} Import .nnue
        </button>
      </header>

      {networks === undefined ? (
        <LoadingBlock label="Loading networks…" />
      ) : networks.length === 0 ? (
        <EmptyState
          icon={<LabIcon name="network" size={22} />}
          title="No networks yet"
          description="Networks come out of training runs. You can also import a .nnue file (CBNN format) trained elsewhere."
          action={
            <>
              <Link to="/lab/new" className="btn btn-primary">
                <Icon name="plus" /> New training run
              </Link>
              <button type="button" className="btn" onClick={() => void doImport()}>
                <LabIcon name="upload" /> Import .nnue
              </button>
            </>
          }
        />
      ) : (
        <div className="panel">
          {networks.length > 6 && (
            <div className="lab-table-tools">
              <div className="lab-log-search">
                <Icon name="search" size={14} />
                <input className="input input-sm" type="search" placeholder="Filter networks…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter networks" />
              </div>
              <span className="small muted">
                {shown.length === networks.length ? `${networks.length} networks` : `${shown.length} of ${networks.length}`}
              </span>
            </div>
          )}
          <div className="lab-table-wrap">
            <table className="table lab-networks-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Hidden</th>
                  <th>Activation</th>
                  <th className="num lab-col-optional">File size</th>
                  <th className="num">Val loss</th>
                  <th className="num lab-col-optional">Positions seen</th>
                  <th className="lab-col-optional">Parent</th>
                  <th className="lab-col-optional">Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((n) => {
                  const parent = n.parentId ? byId.get(n.parentId) : undefined;
                  const users = enginesUsing(n.id, engines).length;
                  return (
                    <tr key={n.id}>
                      <td className="lab-cell-name">
                        <Link to={`/lab/networks/${n.id}`} className="lab-strong truncate" title={n.description || n.name}>
                          {n.name}
                        </Link>
                        {n.builtin && <span className="badge">Starter</span>}
                        {users > 0 && (
                          <span className="badge badge-ok" title={`${users} ${users === 1 ? "engine uses" : "engines use"} this network`}>
                            {users === 1 ? "In 1 engine" : `In ${users} engines`}
                          </span>
                        )}
                      </td>
                      <td className="num">{n.hidden}</td>
                      <td>{ACTIVATION_NAMES[n.activation]}</td>
                      <td className="num lab-col-optional">{formatBytes(n.sizeBytes)}</td>
                      <td className="num">{formatLoss(n.stats.valLoss)}</td>
                      <td className="num lab-col-optional">{n.stats.positionsSeen > 0 ? formatCount(n.stats.positionsSeen) : "—"}</td>
                      <td className="lab-col-optional">
                        {n.parentId ? (
                          parent ? (
                            <Link to={`/lab/networks/${parent.id}`} className="truncate lab-cell-link">
                              {parent.name}
                            </Link>
                          ) : (
                            <span className="faint">Deleted</span>
                          )
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="lab-col-optional small muted">
                        <TimeAgo ts={n.createdAt} />
                      </td>
                      <td className="lab-cell-actions">
                        <ActionMenu
                          label={`Actions for ${n.name}`}
                          items={[
                            { label: "Open", icon: <LabIcon name="network" />, onSelect: () => navigate(`/lab/networks/${n.id}`) },
                            { label: "Create an engine", icon: <LabIcon name="engine" />, onSelect: () => void createEngineForNetwork(n.id, `${n.name} engine`) },
                            { label: "Continue training", icon: <LabIcon name="loop" />, onSelect: () => navigate(`/lab/new?networkId=${encodeURIComponent(n.id)}&mode=continue`) },
                            { label: "Widen", icon: <LabIcon name="widen" />, onSelect: () => navigate(`/lab/new?networkId=${encodeURIComponent(n.id)}&mode=widen`) },
                            "separator",
                            { label: "Rename…", icon: <LabIcon name="edit" />, onSelect: () => setRenaming(n) },
                            { label: "Export .nnue", icon: <LabIcon name="download" />, onSelect: () => void exportNetwork(n.id, n.name) },
                            "separator",
                            { label: "Delete…", icon: <Icon name="trash" />, danger: true, onSelect: () => void deleteNetworkFlow(n, { confirm, engines, runs }) },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="lab-table-empty">
                      No network matches “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <RenameNetworkDialog network={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}
