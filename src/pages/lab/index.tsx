// NNUE Lab (docs/ARCHITECTURE.md §6): #/lab, #/lab/runs[/:id], #/lab/networks[/:id],
// #/lab/datasets[/:id], #/lab/new (?networkId=<id>&mode=continue|widen, ?datasetIds=<id>,<id>).
import type { PageProps } from "@/app/router";
import { Link } from "@/app/router";
import { EmptyState, Icon } from "@/components";
import { DatasetDetail } from "./datasets/DatasetDetail";
import { DatasetsPage } from "./datasets/DatasetsPage";
import { NetworkDetail } from "./networks/NetworkDetail";
import { NetworksPage } from "./networks/NetworksPage";
import { OverviewPage } from "./overview/OverviewPage";
import { RunDashboard } from "./runs/RunDashboard";
import { RunsPage } from "./runs/RunsPage";
import { LabNav, type LabSection } from "./ui/LabNav";
import { NewRunWizard } from "./wizard/NewRunWizard";
import "./lab.css";

export default function LabPage({ params, query }: PageProps) {
  const section = params.section ?? "";
  const id = params.id ?? "";
  let active: LabSection = "overview";
  let content;
  switch (section) {
    case "":
      content = <OverviewPage />;
      break;
    case "runs":
      active = "runs";
      content = id ? <RunDashboard key={id} runId={id} /> : <RunsPage />;
      break;
    case "networks":
      active = "networks";
      content = id ? <NetworkDetail key={id} networkId={id} /> : <NetworksPage />;
      break;
    case "datasets":
      active = "datasets";
      content = id ? <DatasetDetail key={id} datasetId={id} /> : <DatasetsPage />;
      break;
    case "new":
      active = "new";
      content = id ? <LabNotFound /> : <NewRunWizard query={query} />;
      break;
    default:
      content = <LabNotFound />;
  }
  return (
    <div className="page lab-page">
      <LabNav active={active} />
      {content}
    </div>
  );
}

function LabNotFound() {
  return (
    <EmptyState
      icon={<Icon name="search" size={22} />}
      title="This part of the Lab doesn't exist"
      action={
        <Link to="/lab" className="btn">
          Go to the Lab overview
        </Link>
      }
    />
  );
}
