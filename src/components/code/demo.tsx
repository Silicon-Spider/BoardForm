// Gallery demo of the code components (#/dev/code): a miniature Workshop with a file tree,
// the editor and the API reference wired together. Used for visual checks and e2e tests.
import { useMemo, useState } from "react";
import { toast } from "@/app/toast";
import { templateFiles, variantFiles } from "@/engine-host/templates";
import { ApiReference, CodeEditor, FileTree, type ApiEntry, type CodeEditorDiagnostic } from "./index";
import "./demo.css";

const PST_SAMPLE = `// lib/pst.ts — a piece-square table written as a board diagram (rank 8 first).
import { pstFromDiagram } from "../evalkit";

/** Knights like the centre and dislike the rim. */
export const KNIGHT_TABLE: StaticArray<i32> = pstFromDiagram([
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
]);
`;

const NOTES = `# Notes

Plain-text mode: no highlighting, no completion. Ideas to try:
- passed pawns on the 7th rank
- rooks behind passed pawns
`;

function initialFiles(): Record<string, string> {
  return {
    "eval.ts": templateFiles["eval.ts"] ?? "",
    "main.ts": variantFiles["scratch-minimal/main.ts"] ?? "",
    "lib/pst.ts": PST_SAMPLE,
    "notes.md": NOTES,
  };
}

/** Sample compiler problems for eval.ts, placed on real lines of the template. */
function sampleDiagnostics(source: string): CodeEditorDiagnostic[] {
  const lines = source.split("\n");
  const at = (needle: string, word: string) => {
    const index = lines.findIndex((l) => l.includes(needle));
    const line = index < 0 ? 1 : index + 1;
    const column = index < 0 ? 1 : Math.max(1, lines[index].indexOf(word) + 1);
    return { line, column };
  };
  return [
    { ...at("const isolatedW", "popcount"), severity: "error", message: "Type 'u64' is not assignable to type 'i32'. (TS2322)" },
    { ...at("const tempoW", "TEMPO"), severity: "warning", message: "Conversion from type 'f64' to 'i32' will require an explicit cast. (AS200)" },
    { ...at("function kingDanger", "kingDanger"), severity: "info", message: "Function 'kingDanger' is never inlined: it is called from 2 places." },
  ];
}

function languageOf(path: string) {
  return path.endsWith(".ts") ? "assemblyscript" : path.endsWith(".md") ? "markdown" : "text";
}

export function CodeComponentsDemo() {
  const [original] = useState(initialFiles);
  const [files, setFiles] = useState<Record<string, string>>(original);
  const [active, setActive] = useState<string | null>("eval.ts");
  const [entry, setEntry] = useState("main.ts");
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const [readOnly, setReadOnly] = useState(false);
  const [showProblems, setShowProblems] = useState(true);
  const [reveal, setReveal] = useState<{ line: number; column?: number; nonce: number }>();
  const [insert, setInsert] = useState<{ text: string; entry?: ApiEntry; nonce: number }>();
  const [lastEvent, setLastEvent] = useState("—");

  const paths = useMemo(() => Object.keys(files), [files]);
  const diagnostics = useMemo(() => (showProblems ? sampleDiagnostics(original["eval.ts"]) : []), [showProblems, original]);
  const errorCounts = useMemo((): Record<string, number> => ({ "eval.ts": diagnostics.filter((d) => d.severity === "error").length }), [diagnostics]);
  const value = active ? files[active] ?? "" : "";

  const event = (text: string) => setLastEvent(text);

  return (
    <div className="cb-code-demo" data-testid="code-demo">
      <div className="cb-code-demo-toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={showProblems} onChange={(e) => setShowProblems(e.target.checked)} /> Sample problems in eval.ts
        </label>
        <div className="cb-code-demo-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setActive("eval.ts");
              setReveal({ line: diagnostics[0]?.line ?? 40, column: diagnostics[0]?.column, nonce: Date.now() });
            }}
          >
            Reveal first problem
          </button>
          <button type="button" className="btn btn-sm" disabled={!active || files[active] === original[active]} onClick={() => active && setFiles((f) => ({ ...f, [active]: original[active] ?? "" }))}>
            Reset file
          </button>
        </div>
      </div>

      <div className="cb-code-demo-grid">
        <div className="panel cb-code-demo-tree">
          <FileTree
            files={paths}
            active={active}
            entry={entry}
            readOnly={readOnly}
            dirty={dirty}
            errorCounts={errorCounts}
            onSelect={(p) => {
              setActive(p);
              event(`onSelect(${p})`);
            }}
            onCreate={(p) => {
              setFiles((f) => ({ ...f, [p]: `// ${p}\n` }));
              setActive(p);
              event(`onCreate(${p})`);
            }}
            onRename={(from, to) => {
              setFiles((f) => {
                const next: Record<string, string> = {};
                for (const [k, v] of Object.entries(f)) next[k === from ? to : k] = v;
                return next;
              });
              if (active === from) setActive(to);
              if (entry === from) setEntry(to);
              event(`onRename(${from} → ${to})`);
            }}
            onDelete={(p) => {
              setFiles((f) => {
                const next = { ...f };
                delete next[p];
                return next;
              });
              if (active === p) setActive(null);
              event(`onDelete(${p})`);
            }}
            onSetEntry={(p) => {
              setEntry(p);
              event(`onSetEntry(${p})`);
            }}
          />
        </div>

        <div className="panel cb-code-demo-editor">
          <div className="panel-header cb-code-demo-editor-head">
            <span className="mono truncate">{active ?? "No file open"}</span>
            {active && dirty.has(active) && <span className="badge badge-accent">Edited</span>}
            {readOnly && <span className="badge">Read-only</span>}
            <span className="spacer" />
            <span className="small faint cb-code-demo-keys">
              <kbd>Ctrl</kbd>+<kbd>F</kbd> find · <kbd>Ctrl</kbd>+<kbd>Space</kbd> complete · <kbd>Ctrl</kbd>+<kbd>S</kbd> save
            </span>
          </div>
          <div className="cb-code-demo-editor-body">
            {active ? (
              <CodeEditor
                value={value}
                documentId={active}
                language={languageOf(active)}
                readOnly={readOnly}
                diagnostics={active === "eval.ts" ? diagnostics : undefined}
                revealLine={reveal}
                insert={insert}
                aria-label={`Source of ${active}`}
                onChange={(text) => {
                  setFiles((f) => ({ ...f, [active]: text }));
                  setDirty((d) => (d.has(active) ? d : new Set(d).add(active)));
                }}
                onSave={() => {
                  setDirty((d) => {
                    const next = new Set(d);
                    next.delete(active);
                    return next;
                  });
                  toast(`Saved ${active}`, { kind: "success", timeoutMs: 1800 });
                  event(`onSave(${active})`);
                }}
              />
            ) : (
              <div className="cb-code-demo-none">Select a file on the left.</div>
            )}
          </div>
        </div>

        <div className="panel cb-code-demo-api">
          <ApiReference
            onInsert={(text, e) => {
              setInsert({ text, entry: e, nonce: Date.now() });
              event(`onInsert(${text})`);
            }}
          />
        </div>
      </div>
      <div className="small muted cb-code-demo-event" data-testid="code-demo-event">
        Last event: <span className="mono">{lastEvent}</span>
      </div>
    </div>
  );
}
