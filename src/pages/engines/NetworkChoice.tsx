// Radio list of the user's NNUE networks (plus "None") for the new-engine wizard.
import { Link } from "@/app/router";
import { Spinner } from "@/components";
import { ACTIVATION_NAMES } from "@/nnue/format";
import { useNetworks } from "@/storage";
import type { NetworkRecord } from "@/types";
import { formatCount, formatRelativeTime } from "@/utils/format";
import { cx, formatSize } from "./ui";

export interface NetworkChoiceProps {
  value: string | null;
  onChange: (networkId: string | null) => void;
  /** Radio group name (unique per form). */
  name: string;
  "aria-labelledby"?: string;
}

function describeNetwork(n: NetworkRecord): string {
  const parts = [`${n.hidden} hidden`, ACTIVATION_NAMES[n.activation] ?? "", formatSize(n.sizeBytes)];
  const seen = n.stats?.positionsSeen ?? 0;
  parts.push(seen > 0 ? `${formatCount(seen)} positions seen in training` : "untrained");
  if (typeof n.stats?.valLoss === "number") parts.push(`val loss ${n.stats.valLoss.toFixed(4)}`);
  parts.push(`updated ${formatRelativeTime(n.updatedAt)}`);
  return parts.filter(Boolean).join(" · ");
}

export function NetworkChoice({ value, onChange, name, "aria-labelledby": labelledBy }: NetworkChoiceProps) {
  const networks = useNetworks();
  if (networks === undefined) return <Spinner label="Loading networks…" />;
  const missing = value !== null && !networks.some((n) => n.id === value);
  const selected = missing ? null : value;
  return (
    <div className="stack-sm">
      {missing && <div className="callout warn small">The selected network no longer exists. Pick another one, or none.</div>}
      <div className="engines-options engines-options--scroll" role="radiogroup" aria-labelledby={labelledBy}>
        <label className={cx("engines-option", selected === null && "is-selected")}>
          <input type="radio" name={name} checked={selected === null} onChange={() => onChange(null)} />
          <span className="engines-option-text">
            <span className="engines-option-title">None</span>
            <span className="engines-option-desc">Uses the fallback evaluation until you choose one</span>
          </span>
        </label>
        {networks.map((n) => (
          <label key={n.id} className={cx("engines-option", selected === n.id && "is-selected")}>
            <input type="radio" name={name} checked={selected === n.id} onChange={() => onChange(n.id)} />
            <span className="engines-option-text">
              <span className="engines-option-title truncate">{n.name || "Untitled network"}</span>
              <span className="engines-option-desc">{describeNetwork(n)}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="field-hint">
        {networks.length === 0 ? "You have no networks yet. Train or import one in the " : "Networks are trained and imported in the "}
        <Link to="/lab">NNUE Lab</Link>
        {networks.length === 0 ? " — you can attach it to this engine later." : "."}
      </p>
    </div>
  );
}
