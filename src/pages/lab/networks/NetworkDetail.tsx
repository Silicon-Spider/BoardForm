// One network (#/lab/networks/:id): stats, lineage, engines using it, sample evaluations.
import { useState } from "react";
import { Link, navigate } from "@/app/router";
import { Icon, KindBadge, useConfirm } from "@/components";
import { useDatasets, useEngines, useNetwork, useNetworks, useTrainingRuns } from "@/storage";
import { ACTIVATION_NAMES } from "@/nnue/format";
import { parameterCount } from "@/nnue/init";
import type { NetworkRecord } from "@/types";
import { formatBytes, formatCount, formatDateTime } from "@/utils/format";
import { createEngineForNetwork, enginesUsing, exportNetwork, playAgainstNetwork } from "../actions";
import { formatLoss } from "../model/format";
import { childrenOf, parentChain } from "../model/lineage";
import { ActionMenu } from "../ui/ActionMenu";
import { Breadcrumbs, LoadingBlock, NotFoundState, Panel, StatGrid, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { SampleEvalGrid, useSampleEvals } from "../ui/SampleEvals";
import { RenameNetworkDialog, deleteNetworkFlow } from "./networkActions";

export function NetworkDetail({ networkId }: { networkId: string }) {
  const network = useNetwork(networkId);
  if (network === undefined) return <LoadingBlock label="Loading the network…" />;
  if (network === null) return <NotFoundState what="network" backTo="/lab/networks" backLabel="All networks" />;
  return <NetworkView network={network} />;
}

function NetworkView({ network: n }: { network: NetworkRecord }) {
  const all = useNetworks();
  const engines = useEngines();
  const runs = useTrainingRuns();
  const datasets = useDatasets();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState<null | "play" | "engine">(null);
  const evals = useSampleEvals(n.id, String(n.updatedAt));

  const users = enginesUsing(n.id, engines);
  const chain = all ? parentChain(n, all) : [];
  const lineage: Array<{ id: string; network: NetworkRecord | null }> = [{ id: n.id, network: n }, ...chain];
  const children = all ? childrenOf(n.id, all) : [];
  const run = n.stats.trainingRunId ? runs?.find((r) => r.id === n.stats.trainingRunId) : undefined;
  const trainedOn = (n.stats.datasetIds ?? []).map((id) => ({ id, record: datasets?.find((d) => d.id === id) }));

  const play = async () => {
    setBusy("play");
    try {
      await playAgainstNetwork(n.id, engines);
    } finally {
      setBusy(null);
    }
  };
  const createEngine = async () => {
    setBusy("engine");
    try {
      await createEngineForNetwork(n.id, `${n.name} engine`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack lab-section">
      <Breadcrumbs items={[{ label: "NNUE Lab", to: "/lab" }, { label: "Networks", to: "/lab/networks" }, { label: n.name }]} />
      <header className="page-header lab-header lab-detail-header">
        <div className="grow">
          <div className="row-wrap">
            <h1 className="lab-detail-title">{n.name}</h1>
            <span className="badge badge-accent">HL{n.hidden}</span>
            <span className="badge">{ACTIVATION_NAMES[n.activation]}</span>
            {n.builtin && <span className="badge">Starter</span>}
          </div>
          {n.description && <p className="page-subtitle">{n.description}</p>}
        </div>
        <div className="row-wrap lab-detail-actions">
          <button type="button" className="btn btn-ok" onClick={() => void play()} disabled={busy !== null}>
            {busy === "play" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <img src="/pieces/chessnut/wN.svg" alt="" className="lab-btn-piece" />}
            Play against it
          </button>
          <button type="button" className="btn" onClick={() => navigate(`/lab/new?networkId=${encodeURIComponent(n.id)}&mode=continue`)}>
            <LabIcon name="loop" /> Continue training
          </button>
          <ActionMenu
            size="md"
            label="More network actions"
            items={[
              { label: "Create an engine", icon: <LabIcon name="engine" />, disabled: busy !== null, onSelect: () => void createEngine() },
              { label: "Widen", icon: <LabIcon name="widen" />, onSelect: () => navigate(`/lab/new?networkId=${encodeURIComponent(n.id)}&mode=widen`) },
              { label: "Export .nnue", icon: <LabIcon name="download" />, onSelect: () => void exportNetwork(n.id, n.name) },
              { label: "Rename…", icon: <LabIcon name="edit" />, onSelect: () => setRenaming(true) },
              "separator",
              {
                label: "Delete…",
                icon: <Icon name="trash" />,
                danger: true,
                onSelect: async () => {
                  if (await deleteNetworkFlow(n, { confirm, engines, runs })) navigate("/lab/networks");
                },
              },
            ]}
          />
        </div>
      </header>

      <div className="card">
        <StatGrid
          items={[
            { label: "Hidden size", value: `${n.hidden} neurons` },
            { label: "Parameters", value: formatCount(parameterCount(n.hidden)), title: parameterCount(n.hidden).toLocaleString() },
            { label: "File size", value: formatBytes(n.sizeBytes) },
            { label: "Validation loss", value: formatLoss(n.stats.valLoss) },
            { label: "Training loss", value: formatLoss(n.stats.trainLoss) },
            { label: "Positions seen", value: n.stats.positionsSeen > 0 ? formatCount(n.stats.positionsSeen) : "—" },
            { label: "Epochs", value: n.stats.epochs > 0 ? String(n.stats.epochs) : "—" },
            // A starter network was not created here: it was added when the app first started.
            { label: n.builtin ? "Added" : "Created", value: <TimeAgo ts={n.createdAt} />, title: formatDateTime(n.createdAt) },
          ]}
        />
      </div>

      <div className="lab-detail-grid">
        <div className="lab-run-col">
          <Panel title="Sample evaluations" icon={<LabIcon name="target" />} id="lab-net-evals">
            <SampleEvalGrid state={evals} />
          </Panel>
        </div>
        <div className="lab-run-col">
          <Panel title="Engines using it" icon={<LabIcon name="engine" />} id="lab-net-engines">
            {engines === undefined ? (
              <div className="muted small">Loading engines…</div>
            ) : users.length === 0 ? (
              <div className="stack-sm">
                <p className="muted small" style={{ margin: 0 }}>
                  No engine uses this network yet. An NNUE engine runs the stock search with this network as its evaluation.
                </p>
                <div>
                  <button type="button" className="btn btn-sm" onClick={() => void createEngine()} disabled={busy !== null}>
                    {busy === "engine" ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="plus" size={14} />} Create an engine
                  </button>
                </div>
              </div>
            ) : (
              <ul className="lab-list">
                {users.map((e) => (
                  <li key={e.id} className="lab-list-row">
                    <span className="lab-dot" style={{ background: e.color }} aria-hidden="true" />
                    <Link to={`/engines/${e.id}`} className="truncate lab-strong">
                      {e.name}
                    </Link>
                    <KindBadge kind={e.kind} small />
                    <span className="spacer" />
                    <Link to={`/play?engine=${encodeURIComponent(e.id)}`} className="btn btn-sm">
                      <Icon name="play" size={13} /> Play
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Lineage" icon={<LabIcon name="layers" />} id="lab-net-lineage">
            <ol className="lab-lineage">
              {lineage.map((item, i) => {
                const below = lineage[i + 1];
                const relation = below?.network && item.network ? (item.network.hidden > below.network.hidden ? "widened from" : "continued from") : below ? "trained from" : null;
                return (
                  <li key={item.id} className={i === 0 ? "current" : undefined}>
                    <span className="lab-lineage-dot" aria-hidden="true" />
                    <span className="lab-lineage-text">
                      {!item.network ? (
                        <span className="faint">A deleted network</span>
                      ) : i === 0 ? (
                        <span className="lab-strong">{item.network.name}</span>
                      ) : (
                        <Link to={`/lab/networks/${item.id}`}>{item.network.name}</Link>
                      )}
                      {item.network && (
                        <span className="small faint">
                          HL{item.network.hidden}
                          {i === 0 ? " · this network" : ""}
                          {relation ? ` · ${relation} ↓` : ""}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
              {chain.length === 0 && <li className="lab-lineage-root small muted">Not derived from another network{n.builtin ? " (starter network)" : ""}.</li>}
            </ol>
            {children.length > 0 && (
              <div className="stack-sm lab-children">
                <div className="section-title">Trained further into</div>
                <ul className="lab-list">
                  {children.map((c) => (
                    <li key={c.id} className="lab-list-row">
                      <Link to={`/lab/networks/${c.id}`} className="truncate">
                        {c.name}
                      </Link>
                      <span className="small faint">HL{c.hidden}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <Panel title="Training" icon={<LabIcon name="chart" />} id="lab-net-training">
            <dl className="lab-kv">
              <div>
                <dt>Run</dt>
                <dd>
                  {run ? (
                    <Link to={`/lab/runs/${run.id}`}>{run.config.name}</Link>
                  ) : n.stats.trainingRunId ? (
                    <span className="faint">A deleted run</span>
                  ) : n.builtin ? (
                    <span className="faint">Trained before it shipped with BoardForm</span>
                  ) : (
                    <span className="faint">{n.stats.positionsSeen > 0 ? "—" : "Not trained here (imported or created)"}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Datasets</dt>
                <dd>
                  {trainedOn.length === 0 ? (
                    <span className="faint">{n.builtin ? "Not included in the app" : "—"}</span>
                  ) : (
                    <span className="lab-inline-list">
                      {trainedOn.map((d) =>
                        d.record ? (
                          <Link key={d.id} to={`/lab/datasets/${d.id}`}>
                            {d.record.name}
                          </Link>
                        ) : (
                          <span key={d.id} className="faint">
                            deleted dataset
                          </span>
                        ),
                      )}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(n.updatedAt)}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
      {renaming && <RenameNetworkDialog network={n} onClose={() => setRenaming(false)} />}
    </div>
  );
}
