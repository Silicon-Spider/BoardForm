// Section navigation of the NNUE Lab (Overview · Runs · Networks · Datasets) with record counts.
import { Link } from "@/app/router";
import { Icon } from "@/components";
import { useDatasets, useNetworks, useTrainingRuns } from "@/storage";
import { useActiveRunIds } from "@/training";

export type LabSection = "overview" | "runs" | "networks" | "datasets" | "new";

export function LabNav({ active }: { active: LabSection }) {
  const runs = useTrainingRuns();
  const networks = useNetworks();
  const datasets = useDatasets();
  const activeIds = useActiveRunIds();
  const links: Array<{ id: LabSection; to: string; label: string; count?: number; live?: boolean }> = [
    { id: "overview", to: "/lab", label: "Overview" },
    { id: "runs", to: "/lab/runs", label: "Runs", count: runs?.length, live: activeIds.length > 0 },
    { id: "networks", to: "/lab/networks", label: "Networks", count: networks?.length },
    { id: "datasets", to: "/lab/datasets", label: "Datasets", count: datasets?.length },
  ];
  return (
    <div className="lab-nav">
      <nav className="lab-nav-links" aria-label="NNUE Lab">
        {links.map((l) => (
          <Link key={l.id} to={l.to} className={"lab-nav-link" + (active === l.id ? " active" : "")} aria-current={active === l.id ? "page" : undefined}>
            {l.live && <span className="lab-live-dot" title="Training in this tab" />}
            {l.label}
            {l.count !== undefined && l.count > 0 && <span className="lab-nav-count">{l.count}</span>}
          </Link>
        ))}
      </nav>
      {active !== "new" && (
        <Link to="/lab/new" className="btn btn-primary btn-sm lab-nav-new" aria-label="New training run" title="New training run">
          <Icon name="plus" />
          <span>New training run</span>
        </Link>
      )}
    </div>
  );
}
