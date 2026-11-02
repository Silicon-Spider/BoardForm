// @/components/code — CodeMirror 6 code editor, engine-API reference and file tree
// (docs/ARCHITECTURE.md §5 "@/components/code").
//
// Importing this module pulls in CodeMirror; keep it to lazily loaded pages (the Workshop).
// Code that only needs the API data can import "@/components/code/api" (no CodeMirror).
export type { CodeEditorDiagnostic, CodeEditorProps, ApiEntry, FileTreeProps } from "./types";
export { CodeEditor } from "./CodeEditor";
export { ENGINE_API, ENGINE_API_MODULES, MODULE_ORDER, apiSnippet } from "./api";
export type { ApiModuleInfo } from "./api";
export { ApiReference } from "./ApiReference";
export type { ApiReferenceProps } from "./ApiReference";
export { FileTree } from "./FileTree";
export { validateFilePath, normalizeFilePath } from "./filePaths";
export { diagnosticsForFile, diagnosticRange } from "./diagnostics";
