// Main area of a blocks engine: the Blockly editor. Every change saves the workspace together
// with the eval.ts generated from it (so building never needs Blockly).
import { useEffect, useRef } from "react";
import { BlocksEditor, DEFAULT_WORKSPACE, GENERATOR_VERSION, generateEvalSource } from "@/blocks";
import type { EngineRecord } from "@/types";
import type { EngineDraft } from "./draft";
import { blocksPatch } from "./records";

export function BlocksMain({ view, draft }: { view: EngineRecord; draft: EngineDraft }) {
  const regenerated = useRef(false);

  // Code stored by an older generator (or no code at all) is regenerated once when the engine
  // opens, so the Generated code tab, the build and the record agree.
  useEffect(() => {
    if (regenerated.current) return;
    regenerated.current = true;
    const current = draft.view;
    const workspace = (current.blocks as object | null | undefined) ?? null;
    const code = current.files?.["eval.ts"];
    const stale = (current.generatorVersion ?? 0) < GENERATOR_VERSION;
    if (workspace && !stale && code && code.trim()) return;
    const ws = workspace ?? structuredClone(DEFAULT_WORKSPACE);
    const generated = generateEvalSource(ws).code;
    draft.edit(blocksPatch(current, ws, generated, GENERATOR_VERSION));
    void draft.flush();
  }, [draft]);

  const workspace = (view.blocks as object | null | undefined) ?? DEFAULT_WORKSPACE;

  return (
    <div className="workshop-blocks">
      <BlocksEditor
        key={view.id}
        workspace={workspace}
        onChange={(ws, code) => draft.edit(blocksPatch(draft.view, ws, code, GENERATOR_VERSION))}
      />
    </div>
  );
}
