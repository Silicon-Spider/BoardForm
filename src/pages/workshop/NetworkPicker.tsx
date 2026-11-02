// NNUE network selection for engines that load a network: a select over the saved networks
// ("None" included) with the chosen network's size and a link to it in the NNUE Lab.
import { useId } from "react";
import { Link } from "@/app/router";
import { useNetworks } from "@/storage";
import { ACTIVATION_NAMES } from "@/nnue/format";
import type { EngineRecord, NetworkRecord } from "@/types";
import { formatBytes, formatCount } from "@/utils/format";
import type { EngineDraft } from "./draft";

export function networkSummary(n: NetworkRecord): string {
  return `${n.hidden} hidden · ${ACTIVATION_NAMES[n.activation] ?? "?"} · ${formatBytes(n.sizeBytes)}`;
}

export function NetworkSelect({ view, draft, id }: { view: EngineRecord; draft: EngineDraft; id?: string }) {
  const networks = useNetworks();
  const current = view.networkId ?? "";
  const missing = !!current && networks !== undefined && !networks.some((n) => n.id === current);
  return (
    <select
      id={id}
      className="select workshop-network-select"
      value={current}
      disabled={networks === undefined}
      onChange={(e) => {
        draft.edit({ networkId: e.target.value || null });
        void draft.flush();
      }}
    >
      <option value="">None (fallback evaluation)</option>
      {missing && <option value={current}>Missing network (deleted)</option>}
      {(networks ?? []).map((n) => (
        <option key={n.id} value={n.id}>
          {n.name} — {n.hidden} · {ACTIVATION_NAMES[n.activation] ?? "?"}
        </option>
      ))}
    </select>
  );
}

/** Details of the selected network (or what to do when there is none). */
export function NetworkDetails({ view, compact }: { view: EngineRecord; compact?: boolean }) {
  const networks = useNetworks();
  if (networks === undefined) return <span className="small faint">Loading networks…</span>;
  const net = view.networkId ? networks.find((n) => n.id === view.networkId) : undefined;
  if (view.networkId && !net) {
    return <span className="small text-danger">The attached network was deleted. Choose another one, or None.</span>;
  }
  if (!net) {
    return networks.length === 0 ? (
      <span className="small muted">
        No networks yet — <Link to="/lab/new">train one in the NNUE Lab</Link>.
      </span>
    ) : (
      <span className="small muted">No network: the engine plays with its fallback evaluation (material + piece-square tables).</span>
    );
  }
  return (
    <span className="small muted workshop-network-details">
      <span className="num">{networkSummary(net)}</span>
      {!compact && net.stats.positionsSeen > 0 && <span className="num"> · trained on {formatCount(net.stats.positionsSeen)} positions</span>}
      {" · "}
      <Link to={`/lab/networks/${encodeURIComponent(net.id)}`}>Open in the NNUE Lab</Link>
    </span>
  );
}

/** Strip above the NNUE engine's editor. */
export function NetworkBar({ view, draft }: { view: EngineRecord; draft: EngineDraft }) {
  const id = useId();
  return (
    <div className="workshop-networkbar">
      <label htmlFor={id} className="workshop-networkbar-label">
        Network
      </label>
      <NetworkSelect view={view} draft={draft} id={id} />
      <NetworkDetails view={view} />
    </div>
  );
}
