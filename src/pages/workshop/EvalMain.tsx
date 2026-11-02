// Main area of eval / nnue engines: the code editor for eval.ts (the only file they store; every
// other file comes from the live template), plus the network bar for NNUE engines.
import type { Ref } from "react";
import { diagnosticsForFile } from "@/components/code";
import { Icon } from "@/components";
import { defaultFilesFor } from "@/engine-host";
import type { CompileDiagnostic, EngineRecord } from "@/types";
import { CodePane, type CodePaneHandle } from "./CodePane";
import type { EngineDraft } from "./draft";
import { NetworkBar } from "./NetworkPicker";
import { filePatch } from "./records";
import type { RevealTarget } from "./types";

/** The eval.ts a fresh engine of this kind starts with. */
export function templateEvalFor(kind: EngineRecord["kind"]): string {
  return defaultFilesFor(kind === "nnue" ? "nnue" : "eval")["eval.ts"] ?? "";
}

export function EvalMain({
  view,
  draft,
  diagnostics,
  reveal,
  editorRef,
  onReset,
  onShowSource,
}: {
  view: EngineRecord;
  draft: EngineDraft;
  diagnostics: CompileDiagnostic[];
  reveal: RevealTarget | null;
  editorRef: Ref<CodePaneHandle>;
  onReset(): void;
  onShowSource(): void;
}) {
  const value = view.files?.["eval.ts"] ?? templateEvalFor(view.kind);
  const modified = value !== templateEvalFor(view.kind);
  const errors = diagnostics.filter((d) => d.file === "eval.ts" && d.severity === "error").length;
  return (
    <div className="workshop-eval">
      {view.kind === "nnue" && <NetworkBar view={view} draft={draft} />}
      <div className="workshop-filebar">
        <span className="workshop-filechip">
          <Icon name="copy" size={13} />
          eval.ts
          {errors > 0 && <span className="badge badge-danger">{errors}</span>}
        </span>
        <span className="workshop-filebar-hint small faint truncate">
          {modified ? "Your evaluation" : "Same as the template"} · the rest of the engine is the stock template —{" "}
          <button type="button" className="workshop-linkbtn" onClick={onShowSource}>
            read it
          </button>
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onReset} disabled={!modified} title="Replace eval.ts with the template's version">
          <Icon name="reset" size={14} />
          <span className="workshop-hide-narrow">Reset eval.ts to the template</span>
        </button>
      </div>
      <CodePane
        ref={editorRef}
        value={value}
        onChange={(text) => draft.edit(filePatch(draft.view, "eval.ts", text))}
        onSave={() => void draft.flush()}
        diagnostics={diagnosticsForFile(diagnostics, "eval.ts")}
        revealLine={reveal && reveal.target === "main:eval.ts" ? reveal.reveal : undefined}
        aria-label="eval.ts"
      />
    </div>
  );
}
