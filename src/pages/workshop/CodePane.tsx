// Wrapper around the shared CodeEditor with an imperative "insert at the cursor" for the API
// reference's Insert buttons (the editor's `insert` prop does the work, including adding the
// import from the template module), and a container that gives the editor its height.
import { forwardRef, useImperativeHandle, useState } from "react";
import { CodeEditor, type ApiEntry, type CodeEditorProps } from "@/components/code";
import { AreaBoundary } from "./AreaBoundary";

export interface CodePaneHandle {
  /** Inserts text at the cursor (replacing the selection) and focuses the editor. */
  insert(text: string, entry?: ApiEntry): void;
}

export type CodePaneProps = Omit<CodeEditorProps, "insert"> & { paneClassName?: string };

export const CodePane = forwardRef<CodePaneHandle, CodePaneProps>(function CodePane({ paneClassName, ...props }, ref) {
  const [insert, setInsert] = useState<CodeEditorProps["insert"]>(undefined);

  useImperativeHandle(
    ref,
    () => ({
      insert(text: string, entry?: ApiEntry) {
        setInsert((prev) => ({ text, entry, nonce: (prev?.nonce ?? 0) + 1 }));
      },
    }),
    [],
  );

  return (
    <div className={"workshop-code" + (paneClassName ? " " + paneClassName : "")}>
      <AreaBoundary label="The code editor">
        <CodeEditor {...props} insert={insert} />
      </AreaBoundary>
    </div>
  );
});
