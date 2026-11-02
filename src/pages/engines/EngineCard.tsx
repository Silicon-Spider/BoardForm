// One engine in the library grid. The name is a link that covers the whole card (clicking the card
// opens the Workshop); the buttons and the "⋯" menu sit above it. Memoized: the grid re-renders
// only the cards whose engine, network or highlight changed (plus a relative-time tick).
import { memo, useEffect, useRef, type CSSProperties } from "react";
import { Link } from "@/app/router";
import { Icon, KindBadge } from "@/components";
import type { EngineRecord } from "@/types";
import { formatDateTime, formatRelativeTime } from "@/utils/format";
import { useBuildStatus, type BuildStatus } from "./build-status";
import { PageIcon } from "./icons";
import { MenuButton, type MenuItem } from "./MenuButton";
import { cx, formatSize } from "./ui";

export type CardAction = "duplicate" | "export" | "delete";

export interface EngineCardProps {
  engine: EngineRecord;
  /** Name of the attached network; null when the engine has none (or networks are loading). */
  networkName: string | null;
  /** The engine points at a network that no longer exists. */
  networkMissing: boolean;
  now: number;
  /** Briefly highlighted (e.g. a copy that was just created). */
  highlighted: boolean;
  onAction: (action: CardAction, engine: EngineRecord) => void;
}

/** Up to two initials for the avatar ("My blocks engine" → "MB", "Classic (copy)" → "CC"). */
export function engineInitials(name: string): string {
  // The first letter or digit of each word; punctuation such as "(" is skipped.
  const letters = name
    .trim()
    .split(/\s+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c): c is string => !!c);
  return letters.length === 0 ? "?" : letters.slice(0, 2).join("").toLocaleUpperCase();
}

function BuildLine({ status }: { status: BuildStatus }) {
  switch (status.state) {
    case "checking":
      return <li className="faint">Checking build…</li>;
    case "built":
      return (
        <li className="engines-meta-ok" title={`Compiled ${formatDateTime(status.builtAt)}`}>
          <Icon name="check" size={13} /> Built · {formatSize(status.sizeBytes)}
        </li>
      );
    case "stale":
      return (
        <li className="text-warn" title={`Last build ${formatDateTime(status.builtAt)} — it is rebuilt automatically the next time the engine is used`}>
          <span className="engines-meta-dot" aria-hidden="true" /> Sources changed since the last build
        </li>
      );
    case "none":
      return <li className="faint">Not built yet</li>;
    case "uploaded":
      return (
        <li className="engines-meta-ok">
          <PageIcon name="chip" size={13} /> Uploaded module · {formatSize(status.sizeBytes)}
        </li>
      );
    case "no-module":
      return (
        <li className="text-warn">
          <PageIcon name="warning" size={13} /> No module uploaded
        </li>
      );
  }
}

function EngineCardImpl({ engine, networkName, networkMissing, now, highlighted, onAction }: EngineCardProps) {
  const ref = useRef<HTMLElement>(null);
  const status = useBuildStatus(engine);
  const name = engine.name?.trim() || "Untitled engine";
  const href = `/engines/${encodeURIComponent(engine.id)}`;

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlighted]);

  const items: MenuItem[] = [
    { id: "duplicate", label: "Duplicate", icon: <Icon name="copy" />, onSelect: () => onAction("duplicate", engine) },
    { id: "export", label: "Export", icon: <PageIcon name="download" />, onSelect: () => onAction("export", engine) },
    { id: "delete", label: "Delete", icon: <Icon name="trash" />, danger: true, onSelect: () => onAction("delete", engine) },
  ];

  return (
    <article
      ref={ref}
      className={cx("card engines-card", highlighted && "engines-card--new")}
      style={{ "--engine-color": engine.color || "var(--text-faint)" } as CSSProperties}
      data-engine-id={engine.id}
    >
      <div className="engines-card-head">
        <span className="engines-card-avatar" aria-hidden="true">
          {engineInitials(name)}
        </span>
        <div className="engines-card-title">
          <h3 className="engines-card-name">
            <Link to={href} className="engines-card-link" title={name}>
              {name}
            </Link>
          </h3>
          <div className="engines-card-badges">
            <KindBadge kind={engine.kind} small />
            {engine.builtin && (
              <span className="badge badge-accent engines-badge-sm" title="One of the engines BoardForm starts with">
                Starter
              </span>
            )}
          </div>
        </div>
        <MenuButton items={items} label={`More actions for ${name}`} className="engines-card-menu" />
      </div>

      <p className={cx("engines-card-desc", !engine.description?.trim() && "faint")}>{engine.description?.trim() || "No description yet."}</p>

      <ul className="engines-card-meta">
        <li title={`Updated ${formatDateTime(engine.updatedAt)}`}>Updated {formatRelativeTime(engine.updatedAt, now)}</li>
        <BuildLine status={status} />
        {engine.networkId && networkMissing && (
          <li className="text-warn" title="The NNUE network this engine uses was deleted. Choose another one in the Workshop.">
            <PageIcon name="warning" size={13} /> Network missing
          </li>
        )}
        {engine.networkId && networkName && (
          <li className="engines-meta-network" title={`NNUE network: ${networkName}`}>
            <PageIcon name="network" size={13} /> <span className="truncate">{networkName}</span>
          </li>
        )}
        {engine.kind === "nnue" && !engine.networkId && <li className="faint">No network yet · fallback evaluation</li>}
      </ul>

      <div className="engines-card-actions">
        <Link to={href} className="btn btn-sm">
          <PageIcon name="open" size={14} /> Open
        </Link>
        <Link to={`/play?engine=${encodeURIComponent(engine.id)}`} className="btn btn-sm" title={`Play a game against ${name}`}>
          <Icon name="play" size={14} /> Play
        </Link>
        <Link to={`/arena?new=1&engines=${encodeURIComponent(engine.id)}`} className="btn btn-sm" title={`Start a match with ${name}`}>
          <PageIcon name="swords" size={14} /> Match
        </Link>
      </div>
    </article>
  );
}

export const EngineCard = memo(EngineCardImpl);

/** Placeholder card shown while the library loads. */
export function SkeletonCard() {
  return (
    <div className="card engines-card engines-card--skeleton" aria-hidden="true">
      <div className="engines-card-head">
        <span className="engines-skel engines-skel-avatar" />
        <div className="engines-card-title">
          <span className="engines-skel engines-skel-line" style={{ width: "60%" }} />
          <span className="engines-skel engines-skel-line" style={{ width: "30%", height: 12 }} />
        </div>
      </div>
      <span className="engines-skel engines-skel-line" style={{ width: "95%" }} />
      <span className="engines-skel engines-skel-line" style={{ width: "70%" }} />
      <span className="engines-skel engines-skel-line" style={{ width: "45%", height: 10, marginTop: 6 }} />
      <div className="engines-card-actions">
        <span className="engines-skel engines-skel-btn" />
        <span className="engines-skel engines-skel-btn" />
        <span className="engines-skel engines-skel-btn" />
      </div>
    </div>
  );
}
