import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, matchPath, useRoute, type PageProps } from "./router";
import { Toaster } from "./toast";
import { useActivities } from "./activity";
import { useDatabaseStatus } from "@/storage";
import { useApplyBoardTheme } from "./preferences";

const EnginesPage = lazy(() => import("@/pages/engines"));
const WorkshopPage = lazy(() => import("@/pages/workshop"));
const PlayPage = lazy(() => import("@/pages/play"));
const ArenaPage = lazy(() => import("@/pages/arena"));
const LabPage = lazy(() => import("@/pages/lab"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const HelpPage = lazy(() => import("@/pages/help"));
const DevPage = lazy(() => import("@/pages/dev"));

interface RouteDef {
  pattern: string;
  component: ComponentType<PageProps>;
  /** Nav section to highlight. */
  section: string;
}

const ROUTES: RouteDef[] = [
  { pattern: "/", component: EnginesPage, section: "engines" },
  { pattern: "/engines", component: EnginesPage, section: "engines" },
  { pattern: "/engines/:id", component: WorkshopPage, section: "engines" },
  { pattern: "/play", component: PlayPage, section: "play" },
  { pattern: "/arena", component: ArenaPage, section: "arena" },
  { pattern: "/arena/:id", component: ArenaPage, section: "arena" },
  { pattern: "/lab", component: LabPage, section: "lab" },
  { pattern: "/lab/:section", component: LabPage, section: "lab" },
  { pattern: "/lab/:section/:id", component: LabPage, section: "lab" },
  { pattern: "/settings", component: SettingsPage, section: "settings" },
  { pattern: "/help", component: HelpPage, section: "help" },
  { pattern: "/help/:topic", component: HelpPage, section: "help" },
  // Hidden developer playground (component gallery, used by e2e/visual checks).
  { pattern: "/dev", component: DevPage, section: "" },
  { pattern: "/dev/:section", component: DevPage, section: "" },
];

const NAV = [
  { to: "/engines", label: "Engines", section: "engines" },
  { to: "/play", label: "Play", section: "play" },
  { to: "/arena", label: "Arena", section: "arena" },
  { to: "/lab", label: "NNUE Lab", section: "lab" },
];

function resolve(path: string): { def: RouteDef; params: Record<string, string> } | null {
  for (const def of ROUTES) {
    const params = matchPath(def.pattern, path);
    if (params) return { def, params };
  }
  return null;
}

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error) {
    console.error("Page crashed:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="callout danger">
            <h3>Something went wrong on this page</h3>
            <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error.stack ?? this.state.error.message)}</pre>
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ActivityIndicator() {
  const activities = useActivities();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  if (activities.length === 0) return null;
  return (
    <div className="activity" ref={ref}>
      <button className="btn btn-ghost activity-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="activity-dot" />
        <span>
          {activities.length} running
        </span>
      </button>
      {open && (
        <div className="activity-panel">
          {activities.map((a) => (
            <Link key={a.id} to={a.href ?? "/"} className="activity-item" onClick={() => setOpen(false)}>
              <div className="row-between">
                <span style={{ fontWeight: 600 }} className="truncate">
                  {a.label}
                </span>
                {typeof a.progress === "number" && <span className="small muted num">{Math.round(a.progress * 100)}%</span>}
              </div>
              {a.detail && <div className="detail truncate">{a.detail}</div>}
              <div className={`progress ${typeof a.progress === "number" ? "" : "indeterminate"}`} style={{ marginTop: 6 }}>
                <div style={{ width: `${typeof a.progress === "number" ? Math.max(2, a.progress * 100) : 35}%` }} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown when the database needs attention, e.g. a newer version of the app upgraded it in another tab. */
function DatabaseBanner() {
  const status = useDatabaseStatus();
  if (!status || (!status.reloadRequired && status.type !== "blocked")) return null;
  return (
    <div className={`app-banner ${status.reloadRequired ? "danger" : "warn"}`} role="alert">
      <span className="grow">{status.message}</span>
      {status.reloadRequired && (
        <button className="btn btn-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}

function PageFallback() {
  return (
    <div className="page row muted">
      <span className="spinner" /> Loading…
    </div>
  );
}

export default function App() {
  useApplyBoardTheme();
  const route = useRoute();
  const resolved = resolve(route.path);
  const section = resolved?.def.section ?? "";
  const Page = resolved?.def.component;

  return (
    <div className="app">
      <nav className="app-nav">
        <Link to="/engines" className="app-brand">
          <img src="/pieces/chessnut/wN.svg" alt="" />
          BoardForm
        </Link>
        <div className="app-nav-links">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`app-nav-link ${section === n.section ? "active" : ""}`}>
              {n.label}
            </Link>
          ))}
        </div>
        <div className="app-nav-spacer" />
        <ActivityIndicator />
        <Link to="/help" className={`app-nav-link ${section === "help" ? "active" : ""}`}>
          Help
        </Link>
        <Link to="/settings" className={`app-nav-link ${section === "settings" ? "active" : ""}`}>
          Settings
        </Link>
      </nav>
      <DatabaseBanner />
      <main className="app-main">
        <ErrorBoundary resetKey={route.path}>
          <Suspense fallback={<PageFallback />}>
            {Page ? (
              <Page params={resolved!.params} query={route.query} />
            ) : (
              <div className="page">
                <div className="empty-state">
                  <h3>Page not found</h3>
                  <Link to="/engines">Go to your engines</Link>
                </div>
              </div>
            )}
          </Suspense>
        </ErrorBoundary>
      </main>
      <Toaster />
    </div>
  );
}
