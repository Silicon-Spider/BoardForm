// Route table of the hash router (docs/ARCHITECTURE.md §6): which page renders for a path, which
// nav section it belongs to, and its default document title. Pages that know more (the Workshop
// shows the engine's name, Help the topic) set a more specific title themselves.
import { lazy, type ComponentType } from "react";
import { matchPath, type PageProps } from "./router";

const EnginesPage = lazy(() => import("@/pages/engines"));
const WorkshopPage = lazy(() => import("@/pages/workshop"));
const PlayPage = lazy(() => import("@/pages/play"));
const ArenaPage = lazy(() => import("@/pages/arena"));
const LabPage = lazy(() => import("@/pages/lab"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const HelpPage = lazy(() => import("@/pages/help"));
const DevPage = lazy(() => import("@/pages/dev"));

export const APP_NAME = "BoardForm";

export interface RouteDef {
  pattern: string;
  component: ComponentType<PageProps>;
  /** Which page component this is (routes of the same page share it; used as a React key). */
  page: string;
  /** Nav section to mark as current ("" = none). */
  section: string;
  /** Title before " · BoardForm", from the route params. */
  title: (params: Record<string, string>) => string;
}

/** NNUE Lab sections: [list page, detail page]. */
const LAB_SECTIONS: Record<string, readonly [string, string]> = {
  runs: ["Training runs", "Training run"],
  networks: ["Networks", "Network"],
  datasets: ["Datasets", "Dataset"],
  new: ["New training run", "New training run"],
};
const labTitle = (section: string, detail: boolean) => {
  const names = LAB_SECTIONS[section];
  return names ? `${names[detail ? 1 : 0]} · NNUE Lab` : "NNUE Lab";
};

export const ROUTES: readonly RouteDef[] = [
  { pattern: "/", component: EnginesPage, page: "engines", section: "engines", title: () => "Engines" },
  { pattern: "/engines", component: EnginesPage, page: "engines", section: "engines", title: () => "Engines" },
  { pattern: "/engines/:id", component: WorkshopPage, page: "workshop", section: "engines", title: () => "Workshop" },
  { pattern: "/play", component: PlayPage, page: "play", section: "play", title: () => "Play" },
  { pattern: "/arena", component: ArenaPage, page: "arena", section: "arena", title: () => "Arena" },
  { pattern: "/arena/:id", component: ArenaPage, page: "arena", section: "arena", title: () => "Match · Arena" },
  { pattern: "/lab", component: LabPage, page: "lab", section: "lab", title: () => "NNUE Lab" },
  { pattern: "/lab/:section", component: LabPage, page: "lab", section: "lab", title: (p) => labTitle(p.section, false) },
  { pattern: "/lab/:section/:id", component: LabPage, page: "lab", section: "lab", title: (p) => labTitle(p.section, true) },
  { pattern: "/settings", component: SettingsPage, page: "settings", section: "settings", title: () => "Settings" },
  { pattern: "/help", component: HelpPage, page: "help", section: "help", title: () => "Help" },
  { pattern: "/help/:topic", component: HelpPage, page: "help", section: "help", title: () => "Help" },
  // Hidden developer playground (component gallery, used by e2e/visual checks).
  { pattern: "/dev", component: DevPage, page: "dev", section: "", title: () => "Component gallery" },
  { pattern: "/dev/:section", component: DevPage, page: "dev", section: "", title: () => "Component gallery" },
];

export function resolveRoute(path: string): { def: RouteDef; params: Record<string, string> } | null {
  for (const def of ROUTES) {
    const params = matchPath(def.pattern, path);
    if (params) return { def, params };
  }
  return null;
}

/** "Arena · BoardForm"; unknown paths get "Page not found · BoardForm". */
export function documentTitleFor(path: string): string {
  const resolved = resolveRoute(path);
  return `${resolved ? resolved.def.title(resolved.params) : "Page not found"} · ${APP_NAME}`;
}
