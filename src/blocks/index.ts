// @/blocks — the drag-and-drop evaluation editor (docs/ARCHITECTURE.md §5).
//
//   DEFAULT_WORKSPACE      starter hand-crafted eval (Blockly JSON serialization)
//   generateEvalSource(ws) → { code, errors, warnings }   headless, never throws
//   <BlocksEditor workspace onChange(ws, code) readOnly? />
//
// Importing this module does not load Blockly: the editor loads it lazily on first render.
// Code that only needs the generator (workers, build code) can import "@/blocks/generator"
// and "@/blocks/default-workspace" directly to avoid pulling in React.

export { DEFAULT_WORKSPACE } from "./default-workspace";
export {
  generateEvalSource,
  generateEval,
  GENERATOR_VERSION,
  SUPPORTED_BLOCK_TYPES,
  type EvalDiagnostic,
  type EvalGeneration,
} from "./generator";
export { BlocksEditor, type BlocksEditorProps } from "./BlocksEditor";
