// The shell's own screens: page crash (error boundary), page not found, the lazy-page loading
// state and the database banner.
import { Component, useState, type ReactNode } from "react";
import { useDatabaseStatus } from "@/storage";
import { NavIcon } from "./navIcons";
import { Link } from "./router";

// --- page crash ---------------------------------------------------------------------------------

function CrashDetails({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false);
  // V8 stacks start with "Name: message"; other engines' stacks are frames only.
  const head = `${error.name}: ${error.message}`;
  const text = error.stack ? (error.stack.startsWith(head) ? error.stack : `${head}\n\n${error.stack}`) : head;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text}\n\nPage: ${location.href}\nBrowser: ${navigator.userAgent}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  };
  return (
    <details className="app-crash-details">
      <summary>Technical details</summary>
      <pre>{text}</pre>
      <button type="button" className="btn btn-sm" onClick={copy}>
        {copied ? "Copied" : "Copy details"}
      </button>
    </details>
  );
}

/** Catches a crashing page so the nav bar (and the rest of the app) keeps working. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    // Navigating to another page clears the crash.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: unknown) {
    console.error("Page crashed:", error);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page app-state">
        <div className="app-state-card" role="alert">
          <span className="app-state-icon danger">
            <NavIcon name="alert" size={26} />
          </span>
          <h1>Something went wrong on this page</h1>
          <p className="muted">
            The rest of BoardForm still works, and your engines, networks and games are safe in this browser. Try the page again, or reload
            if it keeps happening.
          </p>
          <p className="app-state-message">{error.message || error.name}</p>
          <div className="app-state-actions">
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <Link to="/engines" className="btn btn-ghost">
              Go to your engines
            </Link>
          </div>
          <CrashDetails error={error} />
        </div>
      </div>
    );
  }
}

// --- page not found -----------------------------------------------------------------------------

export function NotFoundPage({ path }: { path: string }) {
  return (
    <div className="page app-state">
      <div className="app-state-card">
        <span className="app-state-icon">
          <NavIcon name="compass" size={26} />
        </span>
        <h1>Page not found</h1>
        <p className="muted">
          There is no page at <code className="app-state-path">#{path}</code>. The link may be incomplete, or the page has moved.
        </p>
        <div className="app-state-actions">
          <Link to="/engines" className="btn btn-primary">
            Go to your engines
          </Link>
          <Link to="/help" className="btn">
            Open help
          </Link>
        </div>
      </div>
    </div>
  );
}

// --- loading a page -----------------------------------------------------------------------------

/** Shown while a page's code loads (it fades in after a moment, so quick loads do not flash). */
export function PageFallback() {
  return (
    <div className="app-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>Loading…</span>
    </div>
  );
}

// --- database banner ----------------------------------------------------------------------------

/** Shown when the database needs attention, e.g. a newer version of the app upgraded it in another tab. */
export function DatabaseBanner() {
  const status = useDatabaseStatus();
  if (!status || (!status.reloadRequired && status.type !== "blocked")) return null;
  return (
    <div className={`app-banner ${status.reloadRequired ? "danger" : "warn"}`} role="alert">
      <NavIcon name="alert" size={18} className="app-banner-icon" />
      <span className="app-banner-text">{status.message}</span>
      {status.reloadRequired && (
        <button type="button" className="btn btn-sm app-banner-action" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}
