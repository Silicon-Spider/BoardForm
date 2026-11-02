// Build log tab: the last build (in memory for this session) with its diagnostics — clicking one
// opens the file at that line — and the raw compiler output; otherwise the saved build's info.
import { memo } from "react";
import { EmptyState, Icon } from "@/components";
import type { CompileDiagnostic, EngineRecord } from "@/types";
import { formatBytes, formatDuration, formatRelativeTime } from "@/utils/format";
import type { EngineBuildState } from "./build-store";

const SEVERITY_ORDER: Record<CompileDiagnostic["severity"], number> = { error: 0, warning: 1, info: 2 };

function location(d: CompileDiagnostic): string | null {
  if (!d.file) return null;
  return d.line != null ? `${d.file}:${d.line}${d.column != null ? `:${d.column}` : ""}` : d.file;
}

export const BuildLog = memo(function BuildLog({
  view,
  build,
  sourceHash,
  canOpen,
  onOpen,
  onBuild,
}: {
  view: EngineRecord;
  build: EngineBuildState;
  /** Hash of the current sources (null while unknown). */
  sourceHash: string | null;
  canOpen(file: string): boolean;
  onOpen(file: string, line: number | null, column: number | null): void;
  onBuild(): void;
}) {
  const last = build.last;
  const diagnostics = [...(last?.result?.diagnostics ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const saved = view.build;
  const editedSinceLast = !!last && !!sourceHash && !!last.sourceHash && last.sourceHash !== sourceHash;
  const editedSinceSaved = !!saved && !!sourceHash && saved.sourceHash !== sourceHash;

  return (
    <div className="workshop-buildlog">
      {build.running > 0 && (
        <div className="callout workshop-buildlog-running" role="status">
          <span className="spinner workshop-btn-spinner" aria-hidden="true" /> {build.statusText ?? "Building…"}
        </div>
      )}

      {last ? (
        <div className={"workshop-buildlog-summary " + (last.ok ? "ok" : "failed")}>
          <div className="row">
            <Icon name={last.ok ? "check" : "alert"} size={18} />
            <strong>{last.ok ? (last.compiled ? "Build succeeded" : "Already up to date") : last.problem ? "Cannot build" : "Build failed"}</strong>
            <span className="spacer" />
            <span className="small faint">{formatRelativeTime(last.at)}</span>
          </div>
          <div className="small muted num workshop-buildlog-meta">
            {last.ok && last.sizeBytes !== null && <span>{formatBytes(last.sizeBytes)}</span>}
            {last.compiled && last.result && <span>compiled in {formatDuration(last.result.timeMs)}</span>}
            {last.compiled && <span>total {formatDuration(last.wallMs)}</span>}
            {last.result && (
              <span>
                {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
              </span>
            )}
            {last.result?.compilerVersion && <span>{last.result.compilerVersion}</span>}
          </div>
          {last.problem && <p className="workshop-buildlog-problem">{last.problem}</p>}
          {!last.ok && editedSinceLast && <p className="small muted">You changed the code since this build — build again to check your fixes.</p>}
          {last.ok && editedSinceLast && <p className="small muted">The code changed since this build — build again to compile the new version.</p>}
        </div>
      ) : saved ? (
        <div className="workshop-buildlog-summary ok">
          <div className="row">
            <Icon name="check" size={18} />
            <strong>Last successful build</strong>
            <span className="spacer" />
            <span className="small faint">{formatRelativeTime(saved.builtAt)}</span>
          </div>
          <div className="small muted num workshop-buildlog-meta">
            <span>{formatBytes(saved.sizeBytes)}</span>
            <span>compiled in {formatDuration(saved.compileMs)}</span>
            <span>
              {saved.warnings} warning{saved.warnings === 1 ? "" : "s"}
            </span>
            <span>{saved.compiler}</span>
          </div>
          <p className="small muted">
            {editedSinceSaved ? "The code changed since then — build to compile the new version." : "The compiler's messages are shown here after you build in this session."}
          </p>
        </div>
      ) : (
        <EmptyState
          compact
          title="Not built yet"
          description="Build compiles the engine's AssemblyScript to WebAssembly. Errors and warnings show up here."
          action={
            <button type="button" className="btn btn-primary" onClick={onBuild} disabled={build.running > 0}>
              Build now
            </button>
          }
        />
      )}

      {diagnostics.length > 0 && (
        <section>
          <div className="section-title">Messages</div>
          <ul className="workshop-diags">
            {diagnostics.map((d, i) => {
              const where = location(d);
              const openable = !!d.file && canOpen(d.file);
              const body = (
                <>
                  <span className={`workshop-diag-icon ${d.severity}`} aria-label={d.severity}>
                    <Icon name={d.severity === "info" ? "info" : "alert"} size={14} />
                  </span>
                  <span className="workshop-diag-text">
                    {where && <span className="workshop-diag-where mono">{where}</span>}
                    <span className="workshop-diag-msg">{d.message}</span>
                    {d.code ? <span className="workshop-diag-code mono">{d.code < 1000 ? "AS" : "TS"}{d.code}</span> : null}
                  </span>
                </>
              );
              return (
                <li key={i}>
                  {openable ? (
                    <button type="button" className={`workshop-diag ${d.severity}`} onClick={() => onOpen(d.file!, d.line, d.column)} title="Show in the editor">
                      {body}
                    </button>
                  ) : (
                    <div className={`workshop-diag ${d.severity}`}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {last?.result?.log && last.result.log.trim() && (
        <details className="workshop-buildlog-raw">
          <summary>Compiler output</summary>
          <pre>{last.result.log}</pre>
        </details>
      )}
    </div>
  );
});
