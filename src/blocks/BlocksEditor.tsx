// <BlocksEditor> — the drag-and-drop evaluation editor. A thin React shell: Blockly itself is
// loaded lazily (./editor/mount) the first time an editor is shown, so it stays out of the
// main bundle. Fills its container; give the parent a height.
//
// Edits reach onChange ~300 ms after they happen (debounced). Code that needs the newest edit at
// once — saving or building right after a change — passes a `ref` and calls `ref.current.flush()`.

import { useEffect, useImperativeHandle, useRef, useState, type JSX, type Ref } from "react";
import type { EvalDiagnostic, EvalGeneration } from "./generator";
import type { EditorController } from "./editor/mount";
import { DEFAULT_WORKSPACE } from "./default-workspace";
import "./blocks-editor.css";

export interface BlocksEditorProps {
  /** Blockly JSON serialization to show. Changing it to something new reloads the editor. */
  workspace: object;
  /** Called (debounced ~300 ms) after a meaningful edit with the new serialization and the generated eval.ts. */
  onChange(workspace: object, code: string): void;
  /** View-only: no toolbox, no editing (zoom and scroll still work). */
  readOnly?: boolean;
  className?: string;
  /** Imperative handle (React 19 ref prop), see BlocksEditorHandle. */
  ref?: Ref<BlocksEditorHandle>;
}

export interface BlocksEditorHandle {
  /**
   * Delivers the newest edit through onChange synchronously, before flush() returns, if there is
   * one that was not reported yet (inside the debounce, or a value still being typed). A no-op when
   * everything was reported, while the editor is still loading, or when it is read-only.
   */
  flush(): void;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

export function BlocksEditor({ workspace, onChange, readOnly = false, className, ref }: BlocksEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EditorController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useImperativeHandle(ref, () => ({ flush: () => controllerRef.current?.flush() }), []);
  // The newest workspace (from props or from our own edits) — used when the editor is re-created.
  const latestRef = useRef<object>(workspace);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [result, setResult] = useState<EvalGeneration | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let controller: EditorController | null = null;
    setStatus({ kind: "loading" });
    import("./editor/mount")
      .then(({ mountBlocksEditor }) => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        controller = mountBlocksEditor(host, {
          workspace: latestRef.current,
          readOnly,
          onChange: (ws, code) => {
            latestRef.current = ws;
            onChangeRef.current(ws, code);
          },
          onDiagnostics: setResult,
          onLoadProblem: setLoadProblem,
          onEmptyChange: setEmpty,
        });
        controllerRef.current = controller;
        setStatus({ kind: "ready" });
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      controller?.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    if (workspace === latestRef.current) return;
    const controller = controllerRef.current;
    // Before the editor exists, the newest prop is what it will load. Afterwards, only
    // content the editor actually loads (not echoes of its own edits) replaces it.
    if (!controller || controller.setWorkspace(workspace)) latestRef.current = workspace;
  }, [workspace]);

  return (
    <div className={`blocks-editor ${className ?? ""}`}>
      <div className="blocks-editor-host" ref={hostRef} />
      {status.kind === "loading" && (
        <div className="blocks-editor-overlay">
          <span className="spinner" /> Loading the block editor…
        </div>
      )}
      {status.kind === "failed" && (
        <div className="blocks-editor-overlay">
          <div className="callout danger blocks-editor-failed">
            <strong>The block editor could not be loaded.</strong>
            <div className="small muted">{status.message}</div>
            <button className="btn btn-sm" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      )}
      {status.kind === "ready" && empty && (
        <div className={`blocks-editor-empty ${readOnly ? "full" : ""}`}>
          <div className="blocks-editor-empty-card">
            <h3>{readOnly ? "This evaluation has no blocks" : "Build your evaluation"}</h3>
            {!readOnly && (
              <>
                <p className="muted">
                  Start with an <strong>Evaluation</strong> block, put <strong>Term</strong> blocks inside it, and fill the
                  terms with blocks from the toolbox. Or begin from the starter evaluation and change it.
                </p>
                <div className="row-wrap" style={{ justifyContent: "center" }}>
                  <button className="btn btn-primary" onClick={() => controllerRef.current?.replaceWithUndo(DEFAULT_WORKSPACE)}>
                    Start from the starter evaluation
                  </button>
                  <button className="btn" onClick={() => controllerRef.current?.addEvaluationBlock()}>
                    Add an empty Evaluation block
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {status.kind === "ready" && loadProblem && (
        <div className="blocks-editor-banner callout warn" role="status">
          <span className="grow">{loadProblem}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setLoadProblem(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {status.kind === "ready" && result && (
        <DiagnosticsPill result={result} onSelect={(id) => controllerRef.current?.focusBlock(id)} />
      )}
    </div>
  );
}

function DiagnosticsPill({ result, onSelect }: { result: EvalGeneration; onSelect(id: string): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  const total = errors.length + warnings.length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (total === 0) setOpen(false);
  }, [total]);

  const terms = result.terms.length;
  const summary =
    total === 0
      ? `${terms} term${terms === 1 ? "" : "s"} · no problems`
      : [errors.length && `${errors.length} error${errors.length === 1 ? "" : "s"}`, warnings.length && `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`]
          .filter(Boolean)
          .join(" · ");
  const tone = errors.length ? "danger" : warnings.length ? "warn" : "ok";

  return (
    <div className="blocks-editor-status" ref={ref}>
      {open && total > 0 && (
        <div className="blocks-editor-problems" role="list">
          {[...errors, ...warnings].map((d, i) => (
            <ProblemRow key={i} d={d} onSelect={onSelect} />
          ))}
        </div>
      )}
      <button
        type="button"
        className={`blocks-editor-pill ${tone}`}
        onClick={() => total > 0 && setOpen((o) => !o)}
        aria-expanded={open}
        title={total ? "Show the problems" : "The blocks generate a valid evaluation"}
      >
        <span className="blocks-editor-dot" />
        {summary}
      </button>
    </div>
  );
}

function ProblemRow({ d, onSelect }: { d: EvalDiagnostic; onSelect(id: string): void }): JSX.Element {
  return (
    <button
      type="button"
      role="listitem"
      className={`blocks-editor-problem ${d.severity}`}
      disabled={!d.blockId}
      onClick={() => d.blockId && onSelect(d.blockId)}
      title={d.blockId ? "Show this block" : undefined}
    >
      <span className={`badge ${d.severity === "error" ? "badge-danger" : "badge-warn"}`}>{d.severity === "error" ? "Error" : "Warning"}</span>
      <span className="blocks-editor-problem-text">{d.text}</span>
    </button>
  );
}
