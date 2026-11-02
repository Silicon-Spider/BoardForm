// The networks a run produced, one row per cycle, with gating results and quick actions.
import { useState } from "react";
import { Link, navigate } from "@/app/router";
import { EmptyState, Icon } from "@/components";
import type { EngineRecord, NetworkRecord, TrainingRunRecord } from "@/types";
import { createEngineForNetwork, playAgainstNetwork } from "../actions";
import { formatLoss, formatScorePct } from "../model/format";
import { ActionMenu } from "../ui/ActionMenu";
import { TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";

export function NetworkHistory({
  run,
  networks,
  engines,
}: {
  run: TrainingRunRecord;
  networks: readonly NetworkRecord[] | undefined;
  engines: readonly EngineRecord[] | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const rows = [...run.networkHistory].sort((a, b) => b.cycle - a.cycle || b.createdAt - a.createdAt);
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={<LabIcon name="network" size={22} />}
        title="No networks yet"
        description={`The first network is saved at the end of ${run.config.loop.enabled ? "cycle 1" : "training"}.`}
      />
    );
  }
  const byId = new Map((networks ?? []).map((n) => [n.id, n] as const));
  const newestAccepted = rows.find((r) => !r.gating || r.gating.accepted)?.networkId ?? null;

  const play = async (networkId: string) => {
    setBusy(networkId);
    try {
      await playAgainstNetwork(networkId, engines, networkId === run.networkId ? run.engineId : null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lab-table-wrap">
      <table className="table lab-history lab-stack-table">
        <thead>
          <tr>
            <th className="num">Cycle</th>
            <th>Network</th>
            <th className="num">Val loss</th>
            <th>Gating</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => {
            const net = byId.get(h.networkId);
            const missing = networks !== undefined && !net;
            return (
              <tr key={`${h.networkId}-${h.cycle}-${h.createdAt}`}>
                <td className="num" data-label="Cycle">
                  {h.cycle + 1}
                </td>
                <td className="lab-cell-name lab-history-name">
                  <span className="lab-history-title">
                    {missing ? (
                      <span className="faint">Deleted network</span>
                    ) : (
                      <Link to={`/lab/networks/${h.networkId}`} className="truncate">
                        {net?.name ?? "…"}
                      </Link>
                    )}
                    {h.networkId === newestAccepted && (
                      <span className="badge badge-accent" title="The newest accepted network — the run's published engine uses it">
                        Current
                      </span>
                    )}
                  </span>
                  <span className="small faint">
                    <TimeAgo ts={h.createdAt} />
                  </span>
                </td>
                <td className="num" data-label="Val loss">
                  {formatLoss(h.valLoss)}
                </td>
                <td className={h.gating ? undefined : "lab-stack-empty"}>
                  {h.gating ? (
                    <span className="lab-gating-cell" title={`Scored ${formatScorePct(h.gating.score, 1)} in ${h.gating.games} games against the previous network`}>
                      <span className={h.gating.accepted ? "badge badge-ok" : "badge badge-danger"}>{h.gating.accepted ? "Accepted" : "Rejected"}</span>
                      <span className="small muted num">
                        {formatScorePct(h.gating.score)} · {h.gating.games}
                      </span>
                    </span>
                  ) : (
                    <span className="faint small">—</span>
                  )}
                </td>
                <td className="lab-cell-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-icon"
                    disabled={missing || busy !== null}
                    onClick={() => void play(h.networkId)}
                    title="Play against this network"
                    aria-label={`Play against ${net?.name ?? "this network"}`}
                  >
                    {busy === h.networkId ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="play" size={14} />}
                  </button>
                  <ActionMenu
                    label={`More actions for ${net?.name ?? "network"}`}
                    items={[
                      { label: "Open network", icon: <LabIcon name="network" />, disabled: missing, onSelect: () => navigate(`/lab/networks/${h.networkId}`) },
                      { label: "Play against it", icon: <Icon name="play" />, disabled: missing || busy !== null, onSelect: () => void play(h.networkId) },
                      {
                        label: "Create an engine",
                        icon: <LabIcon name="engine" />,
                        disabled: missing,
                        onSelect: () => void createEngineForNetwork(h.networkId, net ? `${net.name} engine` : undefined),
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
