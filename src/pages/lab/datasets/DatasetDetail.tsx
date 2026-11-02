// One dataset (#/lab/datasets/:id): live generation progress, source, sample positions, runs
// that use it.
import { useEffect, useState } from "react";
import { Link, navigate } from "@/app/router";
import { toast } from "@/app/toast";
import { Icon, MiniBoard, useConfirm } from "@/components";
import { useDataset, useEngines, useNetworks, useTrainingRuns } from "@/storage";
import { datasets as datasetService, useDatasetJob, type DatasetSample } from "@/training";
import type { DatasetRecord } from "@/types";
import { formatBytes, formatCount, formatDateTime } from "@/utils/format";
import { exportDataset } from "../actions";
import { NETWORK_ENGINE_ID, datasetBytes, describeEngineLimits, errorMessage, formatCp, resultText } from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { Breadcrumbs, LoadingBlock, NotFoundState, Panel, StatGrid, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { SelfPlayProgressView } from "../ui/LiveBoards";
import { deleteDatasetFlow } from "./datasetActions";
import { GenerateDatasetDialog } from "./GenerateDatasetDialog";

const SAMPLE_STEP = 12;
const SAMPLE_MAX = 96;

export function DatasetDetail({ datasetId }: { datasetId: string }) {
  const dataset = useDataset(datasetId);
  if (dataset === undefined) return <LoadingBlock label="Loading the dataset…" />;
  if (dataset === null) return <NotFoundState what="dataset" backTo="/lab/datasets" backLabel="All datasets" />;
  return <DatasetView dataset={dataset} />;
}

function DatasetView({ dataset: d }: { dataset: DatasetRecord }) {
  const job = useDatasetJob(d.id);
  const engines = useEngines();
  const networks = useNetworks();
  const runs = useTrainingRuns();
  const confirm = useConfirm();
  const [stopping, setStopping] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const generating = job?.status === "running";

  const src = d.source;
  const engine = src.engineId && src.engineId !== NETWORK_ENGINE_ID ? engines?.find((e) => e.id === src.engineId) : undefined;
  const network = src.networkId ? networks?.find((n) => n.id === src.networkId) : undefined;
  const run = src.trainingRunId ? runs?.find((r) => r.id === src.trainingRunId) : undefined;
  const usedBy = (runs ?? []).filter((r) => r.config.data.datasetIds.includes(d.id) || r.datasetIds.includes(d.id));
  const positions = generating ? Math.max(d.positions, job.progress.positions) : d.positions;
  const games = generating ? Math.max(d.games, job.progress.gamesDone) : d.games;

  const stop = async () => {
    setStopping(true);
    try {
      await datasetService.stop(d.id);
      toast("Stopped generating", { kind: "success", detail: "The games played so far are kept." });
    } catch (e) {
      toast("Could not stop", { kind: "error", detail: errorMessage(e) });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="stack lab-section">
      <Breadcrumbs items={[{ label: "NNUE Lab", to: "/lab" }, { label: "Datasets", to: "/lab/datasets" }, { label: d.name }]} />
      <header className="page-header lab-header lab-detail-header">
        <div className="grow">
          <div className="row-wrap">
            <h1 className="lab-detail-title">{d.name}</h1>
            {generating && (
              <span className="badge badge-accent">
                <span className="lab-live-dot" aria-hidden="true" />
                Generating
              </span>
            )}
          </div>
          {d.description && <p className="page-subtitle">{d.description}</p>}
        </div>
        <div className="row-wrap lab-detail-actions">
          {generating ? (
            <button type="button" className="btn" onClick={() => void stop()} disabled={stopping}>
              {stopping ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <LabIcon name="stop" />} Stop generating
            </button>
          ) : (
            <Link to={`/lab/new?datasetIds=${encodeURIComponent(d.id)}`} className="btn btn-primary">
              <LabIcon name="spark" /> Train a network on it
            </Link>
          )}
          <ActionMenu
            size="md"
            label="More dataset actions"
            items={[
              { label: "Add more games…", icon: <Icon name="plus" />, disabled: generating, onSelect: () => setMoreOpen(true) },
              { label: "Export .cbds", icon: <LabIcon name="download" />, disabled: d.positions === 0, onSelect: () => void exportDataset(d.id, d.name) },
              "separator",
              {
                label: "Delete…",
                icon: <Icon name="trash" />,
                danger: true,
                disabled: generating,
                title: generating ? "Stop generating first" : undefined,
                onSelect: async () => {
                  if (await deleteDatasetFlow(d, { confirm, runs })) navigate("/lab/datasets");
                },
              },
            ]}
          />
        </div>
      </header>

      {job && (job.status === "running" || job.status === "error") && (
        <Panel title={generating ? "Generating games" : "Generation stopped with an error"} icon={<LabIcon name="loop" />} id="lab-ds-job">
          {job.status === "error" && <div className="callout danger small lab-notice">{job.error ?? "Something went wrong while generating."}</div>}
          <SelfPlayProgressView p={job.progress} />
        </Panel>
      )}
      {job && job.status === "stopped" && <div className="callout small">Generation was stopped. The {formatCount(d.games)} games played so far are kept.</div>}

      <div className="card">
        <StatGrid
          items={[
            { label: "Positions", value: formatCount(positions), title: positions.toLocaleString() },
            { label: "Games", value: games > 0 || src.kind === "selfplay" ? formatCount(games) : "—" },
            { label: "Positions per game", value: games > 0 ? (positions / games).toFixed(0) : "—" },
            { label: "Size", value: formatBytes(datasetBytes({ positions })) },
            { label: "Chunks", value: String(d.chunks), title: "Stored in chunks of up to 16,384 positions" },
            { label: "Created", value: <TimeAgo ts={d.createdAt} />, title: formatDateTime(d.createdAt) },
          ]}
        />
      </div>

      <div className="lab-detail-grid">
        <div className="lab-run-col">
          <Panel title="Sample positions" icon={<LabIcon name="dice" />} id="lab-ds-samples">
            <SamplePositions dataset={d} />
          </Panel>
        </div>
        <div className="lab-run-col">
          <Panel title="Source" icon={<LabIcon name="engine" />} id="lab-ds-source">
            <dl className="lab-kv">
              <div>
                <dt>Made by</dt>
                <dd>{src.kind === "selfplay" ? "Self-play" : src.kind === "merge" ? "Merging datasets" : "Importing a file"}</dd>
              </div>
              {src.kind === "selfplay" && (
                <div>
                  <dt>Played by</dt>
                  <dd>
                    {src.engineId === NETWORK_ENGINE_ID || (!src.engineId && src.networkId) ? (
                      network ? (
                        <>
                          NNUE network <Link to={`/lab/networks/${network.id}`}>{network.name}</Link>
                        </>
                      ) : (
                        <span className="faint">An NNUE network (deleted)</span>
                      )
                    ) : engine ? (
                      <Link to={`/engines/${engine.id}`}>{engine.name}</Link>
                    ) : !src.engineId && src.engineName ? (
                      <span>{src.engineName}</span>
                    ) : (
                      <span className="faint">{src.engineName ? `${src.engineName} (deleted)` : "A deleted engine"}</span>
                    )}
                  </dd>
                </div>
              )}
              {src.limits && (
                <div>
                  <dt>Search limit</dt>
                  <dd>{describeEngineLimits(src.limits)}</dd>
                </div>
              )}
              {src.randomPlies !== undefined && (
                <div>
                  <dt>Random opening</dt>
                  <dd>
                    {src.randomPlies} {src.randomPlies === 1 ? "ply" : "plies"}
                  </dd>
                </div>
              )}
              {src.trainingRunId && (
                <div>
                  <dt>Training run</dt>
                  <dd>{run ? <Link to={`/lab/runs/${run.id}`}>{run.config.name}</Link> : <span className="faint">A deleted run</span>}</dd>
                </div>
              )}
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(d.updatedAt)}</dd>
              </div>
            </dl>
          </Panel>
          <Panel title="Used by" icon={<LabIcon name="loop" />} id="lab-ds-runs">
            {usedBy.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No training run uses this dataset yet.
              </p>
            ) : (
              <ul className="lab-list">
                {usedBy.map((r) => (
                  <li key={r.id} className="lab-list-row">
                    <Link to={`/lab/runs/${r.id}`} className="truncate">
                      {r.config.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <GenerateDatasetDialog open={moreOpen} onClose={() => setMoreOpen(false)} appendTo={d.id} onStarted={() => undefined} />
    </div>
  );
}

function SamplePositions({ dataset }: { dataset: DatasetRecord }) {
  const [count, setCount] = useState(SAMPLE_STEP);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; items: DatasetSample[]; error?: string }>({ status: "loading", items: [] });
  // Re-sample when the dataset grows past another chunk, not on every saved game.
  const sizeKey = Math.floor(dataset.positions / 16384) + ":" + dataset.chunks;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, status: "loading" }));
    datasetService.samplePositions(dataset.id, count).then(
      (items) => !cancelled && setState({ status: "ready", items }),
      (e: unknown) => !cancelled && setState((s) => ({ status: "error", items: s.items, error: errorMessage(e) })),
    );
    return () => {
      cancelled = true;
    };
  }, [dataset.id, count, sizeKey, nonce]);

  if (dataset.positions === 0 && state.items.length === 0) {
    return <p className="muted small" style={{ margin: 0 }}>No positions yet{dataset.games === 0 ? " — they appear as soon as the first games are saved" : ""}.</p>;
  }
  return (
    <div className="stack">
      {state.status === "error" && <div className="callout warn small">Could not read positions: {state.error}</div>}
      <div className={"lab-sample-grid" + (state.status === "loading" && state.items.length ? " stale" : "")}>
        {state.items.map((s, i) => (
          <figure key={`${i}-${s.fen}`} className="lab-sample">
            <MiniBoard fen={s.fen} title={s.fen} />
            <figcaption>
              <span className="lab-sample-score num" title="Search score, White's point of view">
                {formatCp(s.scoreWhite)}
              </span>
              <span className="lab-sample-meta">
                <span className={"badge" + (s.result === 2 ? " lab-res-w" : s.result === 0 ? " lab-res-b" : "")} title="Game result">
                  {resultText(s.result)}
                </span>
                <span className="faint">{s.fen.split(" ")[1] === "b" ? "Black" : "White"} to move</span>
              </span>
            </figcaption>
          </figure>
        ))}
        {state.status === "loading" &&
          state.items.length === 0 &&
          Array.from({ length: 6 }, (_, i) => <div key={`sk${i}`} className="lab-sample lab-sample-skeleton" aria-hidden="true" />)}
      </div>
      <div className="row-between">
        <span className="small faint">Random positions with the engine's score (White's view) and the game's result.</span>
        <div className="row">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNonce((n) => n + 1)} disabled={state.status === "loading"} title="Draw other positions">
            <Icon name="reset" size={13} /> Shuffle
          </button>
          {count < SAMPLE_MAX && state.items.length >= count && (
            <button type="button" className="btn btn-sm" onClick={() => setCount((c) => Math.min(SAMPLE_MAX, c + SAMPLE_STEP))} disabled={state.status === "loading"}>
              Show more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
