// Public types of @/components/code (docs/ARCHITECTURE.md §5 "@/components/code").
// Kept free of runtime code so headless modules (tests, workers) can import them cheaply.

/** One problem shown in the editor. Positions are 1-based, like compiler output. */
export interface CodeEditorDiagnostic {
  /** 1-based. Out-of-range values are clamped to the document. */
  line: number;
  /** 1-based (UTF-16 code units, like CodeMirror and the compiler). */
  column: number;
  /** 1-based, inclusive line of the end position. */
  endLine?: number;
  /**
   * 1-based column just past the last character (exclusive end, as produced by the compiler).
   * Without endLine / endColumn the token at line:column is underlined.
   */
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface CodeEditorProps {
  /**
   * The document text (controlled). When it changes from outside (switching files, reset to
   * template) the document is replaced; when it equals the current text nothing happens, so
   * echoing back what `onChange` reported never moves the cursor.
   *
   * Undo history never leaks between files:
   * - without `documentId`, every replacement from outside starts a fresh history (no need to
   *   remount the editor per file, although `key={path}` works too);
   * - with `documentId`, the editor keeps one EditorState per document (history, selection,
   *   scroll position), see `documentId`.
   */
  value: string;
  /** Called with the full text after every edit made in the editor (not for `value` changes). */
  onChange?(value: string): void;
  /** Read-only: selection, search and copy still work. Toggling keeps the history. */
  readOnly?: boolean;
  /** Default "assemblyscript". "markdown" and "text" are shown as plain text. */
  language?: "assemblyscript" | "typescript" | "markdown" | "text";
  /** Shown as underlines + gutter markers + hover text. Re-set whenever the array changes. */
  diagnostics?: CodeEditorDiagnostic[];
  /** Ctrl/Cmd+S inside the editor (the browser's "Save page" dialog is always suppressed there). */
  onSave?(): void;
  /**
   * The user tried to change a read-only document (typed, pasted, cut or dropped text), e.g. to
   * explain why nothing happens and how to get an editable copy. Addition to the original contract.
   */
  onReadOnlyEdit?(): void;
  /**
   * Scrolls to a line, places the cursor there (at `column`, else at the first non-blank
   * character), briefly highlights the line and focuses the editor. Runs again whenever
   * `nonce` changes, so bump it to reveal the same line twice.
   */
  revealLine?: { line: number; column?: number; nonce: number };
  /**
   * Engine-API autocompletion: template functions with signature + docs, Position members after
   * `pos.`, auto-import from the template modules. Default true for "assemblyscript", false
   * otherwise. (AssemblyScript keywords, types and local names are completed either way.)
   * Pass false for engines that do not contain the template modules (e.g. scratch engines).
   */
  completions?: boolean;
  /**
   * Relative path from this file to the engine template's modules: "./" for a file next to them,
   * "../" inside a folder. Lets auto-import (completions and `insert`) add the first import to a
   * file that has none yet; without it such files are never given a guessed import. Addition to
   * the original contract.
   */
  importBase?: string;
  /**
   * Inserts `text` at the cursor (replacing the selection) and focuses the editor, whenever
   * `nonce` changes (addition to the original contract). Made for ApiReference:
   *   onInsert={(text, entry) => setInsert({ text, entry, nonce: Date.now() })}
   * With `entry` (a top-level ENGINE_API symbol) the import from its template module is added
   * too, when the file imports from sibling modules. A "()" ending puts the cursor inside the
   * parentheses. Ignored while read-only. The edit is undoable and reported through onChange.
   */
  insert?: { text: string; nonce: number; entry?: ApiEntry };
  /**
   * Optional identity of the document, e.g. the file path (addition to the original contract).
   * With it, switching `documentId` saves the current document's state and restores the state
   * last seen for the new id (its own undo history, selection and scroll position); a `value`
   * change for the same id (reset to template, regenerated code) becomes one undoable edit.
   */
  documentId?: string;
  /** Extra class for the outer element. The editor fills its container: give the parent a height. */
  className?: string;
  "aria-label"?: string;
}

/** One public symbol of the engine template (parsed from engine/template at runtime). */
export interface ApiEntry {
  /** Symbol name. Class members are qualified: "Position.pieces", "Position.side". */
  name: string;
  /** Template module without extension: "evalkit", "position", "bitboard", "types", ... */
  module: string;
  /** Declaration as written in the source, whitespace-normalised: "popcount(b: u64): i32". */
  signature: string;
  /** Text of the leading doc comment (or trailing line comment), "" when there is none. */
  doc: string;
  /** "method" / "variable" with a qualified name are class members (methods / fields). */
  kind: "function" | "constant" | "class" | "method" | "type" | "variable";
}

export interface FileTreeProps {
  /** File paths; "/" separates folders, e.g. ["main.ts", "lib/util.ts"]. */
  files: string[];
  active: string | null;
  /** The entry file, marked in the tree. */
  entry?: string;
  /** Hides new / rename / delete / set-as-entry. */
  readOnly?: boolean;
  onSelect(path: string): void;
  /** Called with a validated, normalised new path (see validateFilePath). */
  onCreate?(path: string): void;
  onRename?(from: string, to: string): void;
  /** Called after the user confirmed the deletion. */
  onDelete?(path: string): void;
  /**
   * Extra sentence for the delete confirmation, e.g. "main.ts imports it: …" (null / "" for none).
   * Addition to the original contract.
   */
  deleteWarning?(path: string): string | null;
  onSetEntry?(path: string): void;
  /** Files with unsaved / uncompiled changes (shown as a dot). */
  dirty?: ReadonlySet<string>;
  /** Number of compile errors per file path (shown as a red badge). */
  errorCounts?: Record<string, number>;
  className?: string;
}
