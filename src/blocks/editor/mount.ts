// Creates a Blockly workspace inside a container element and wires it to the generator.
// Lazily imported by <BlocksEditor> so Blockly only loads when the editor is shown.

import * as Blockly from "blockly";
import { generateEval, type EvalGeneration } from "../generator";
import { sanitizeWorkspace } from "../sanitize";
import { buildToolbox } from "../toolbox";
import { blocklyMediaPath, patchMediaImages } from "./media";
import { registerBlocks } from "./register";
import { RENDERER_NAME, registerRenderer } from "./renderer";
import { currentTheme } from "./theme";

export interface MountOptions {
  workspace: object;
  readOnly: boolean;
  /** Debounced; only called when the serialization actually changed. */
  onChange(workspace: object, code: string): void;
  /** Every time the blocks are (re)generated, including the initial load. */
  onDiagnostics(result: EvalGeneration): void;
  /** A problem while loading the stored blocks (null when the load was clean). */
  onLoadProblem(message: string | null): void;
  /** Whether the workspace has no blocks at all (for the empty state). */
  onEmptyChange?(empty: boolean): void;
}

export interface EditorController {
  /**
   * Loads new workspace JSON, unless it equals what the editor shows or is an echo of something
   * the editor itself emitted recently. Returns true when it was loaded. A pending (debounced)
   * edit is dropped when new content is loaded — remount the editor (React `key`) to switch engines.
   */
  setWorkspace(workspace: object): boolean;
  /** Scrolls to a block and selects it. */
  focusBlock(id: string): void;
  /** Delivers a pending (debounced) change immediately. */
  flush(): void;
  /** Adds an Evaluation block (user action: undoable, reported through onChange). */
  addEvaluationBlock(): void;
  /** Replaces the workspace with `json` as a user action (undoable, reported through onChange). */
  replaceWithUndo(json: object): void;
  dispose(): void;
}

const DEBOUNCE_MS = 300;
const WARNING_ID = "chess-builder";

export function mountBlocksEditor(container: HTMLElement, opts: MountOptions): EditorController {
  registerBlocks();
  registerRenderer();

  const ws = Blockly.inject(container, {
    toolbox: opts.readOnly ? undefined : buildToolbox(),
    theme: currentTheme(),
    renderer: RENDERER_NAME,
    media: blocklyMediaPath(),
    readOnly: opts.readOnly,
    trashcan: !opts.readOnly,
    maxTrashcanContents: 32,
    sounds: false,
    comments: true,
    collapse: true,
    disable: true,
    toolboxPosition: "start",
    grid: { spacing: 24, length: 2, colour: "#262c36", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.72, maxScale: 2, minScale: 0.3, scaleSpeed: 1.15, pinch: true },
    move: { scrollbars: true, drag: true, wheel: true },
  });
  container.classList.add("blocks-editor-injected");
  const unpatchMedia = patchMediaImages(container);

  let disposed = false;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastText = "";
  let lastEmitted: object | null = null;
  /** Serializations recently sent through onChange (echoes of these are ignored). */
  const recentTexts: string[] = [];
  const appliedWarnings = new Map<string, string>();

  const save = (): object => Blockly.serialization.workspaces.save(ws) as object;

  function applyDiagnostics(result: EvalGeneration): void {
    const wanted = new Map<string, string[]>();
    for (const d of result.diagnostics) {
      if (!d.blockId) continue;
      // Shadow blocks can't show icons: attach the message to the nearest real block.
      let target: Blockly.Block | null = ws.getBlockById(d.blockId);
      while (target && target.isShadow()) target = target.getParent();
      if (!target) continue;
      const list = wanted.get(target.id) ?? [];
      const msg = (d.severity === "error" ? "Error: " : "") + capitalize(d.message);
      if (!list.includes(msg)) list.push(msg);
      wanted.set(target.id, list);
    }
    Blockly.Events.disable();
    try {
      for (const id of [...appliedWarnings.keys()]) {
        if (wanted.has(id)) continue;
        const b = ws.getBlockById(id);
        if (b instanceof Blockly.BlockSvg) b.setWarningText(null, WARNING_ID);
        appliedWarnings.delete(id);
      }
      for (const [id, msgs] of wanted) {
        const text = msgs.join("\n\n");
        if (appliedWarnings.get(id) === text) continue;
        const b = ws.getBlockById(id);
        if (b instanceof Blockly.BlockSvg) {
          b.setWarningText(text, WARNING_ID);
          appliedWarnings.set(id, text);
        }
      }
    } finally {
      Blockly.Events.enable();
    }
  }

  let lastEmpty: boolean | null = null;
  function regenerate(json: object): EvalGeneration {
    const result = generateEval(json);
    applyDiagnostics(result);
    opts.onDiagnostics(result);
    const empty = ws.getTopBlocks(false).length === 0 && ws.getTopComments(false).length === 0;
    if (empty !== lastEmpty) {
      lastEmpty = empty;
      opts.onEmptyChange?.(empty);
    }
    return result;
  }

  function scrollToStart(): void {
    const tops = ws.getTopBlocks(true);
    if (!tops.length) return;
    let minX = Infinity;
    let minY = Infinity;
    for (const b of tops) {
      const xy = b.getRelativeToSurfaceXY();
      minX = Math.min(minX, xy.x);
      minY = Math.min(minY, xy.y);
    }
    const pad = 24;
    ws.scroll(pad - minX * ws.scale, pad - minY * ws.scale);
  }

  function load(json: object): void {
    loading = true;
    const problems: string[] = [];
    const { workspace: clean, removed } = sanitizeWorkspace(json, (t) => Boolean(Blockly.Blocks[t]));
    if (removed.length) {
      const kinds = [...new Set(removed)].join(", ");
      problems.push(`${removed.length} block${removed.length === 1 ? " was" : "s were"} left out because ${removed.length === 1 ? "its type is" : "their types are"} unknown (${kinds}).`);
    }
    Blockly.Events.disable();
    try {
      try {
        Blockly.serialization.workspaces.load(clean, ws, { recordUndo: false });
      } catch (e) {
        // Fall back to loading the stacks one at a time so one bad stack doesn't lose the rest.
        ws.clear();
        const vars = Array.isArray(clean.variables) ? clean.variables : [];
        for (const v of vars) {
          try {
            ws.getVariableMap().createVariable(v.name, v.type ?? "", v.id);
          } catch {
            /* duplicate or invalid variable: skip */
          }
        }
        let failed = 0;
        for (const top of clean.blocks?.blocks ?? []) {
          try {
            Blockly.serialization.blocks.append(top as Blockly.serialization.blocks.State, ws, { recordUndo: false });
          } catch {
            failed++;
          }
        }
        problems.push(
          `Some blocks could not be loaded${failed ? ` (${failed} stack${failed === 1 ? "" : "s"} skipped)` : ""}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      Blockly.Events.enable();
      loading = false;
    }
    ws.clearUndo();
    appliedWarnings.clear();
    opts.onLoadProblem(problems.length ? problems.join(" ") : null);
    const saved = save();
    lastText = JSON.stringify(saved);
    regenerate(saved);
    scrollToStart();
  }

  function flush(): void {
    if (!timer || disposed) return;
    clearTimeout(timer);
    timer = null;
    const json = save();
    const text = JSON.stringify(json);
    const result = regenerate(json);
    if (text === lastText) return;
    lastText = text;
    lastEmitted = json;
    recentTexts.push(text);
    if (recentTexts.length > 12) recentTexts.shift();
    opts.onChange(json, result.code);
  }

  const onWorkspaceEvent = (e: Blockly.Events.Abstract): void => {
    if (loading || disposed || e.isUiEvent) return;
    if (e.type === Blockly.Events.FINISHED_LOADING) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };
  ws.addChangeListener(onWorkspaceEvent);

  // Keep the SVG sized to the container.
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => Blockly.svgResize(ws)) : null;
  resizeObserver?.observe(container);

  // Follow the app theme (html[data-theme]).
  const themeObserver = new MutationObserver(() => ws.setTheme(currentTheme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Don't lose the last edits when the tab is hidden or closed.
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  // Also on beforeunload: an edit delivered only at pagehide comes too late for the app to store it
  // (the old document is torn down before an IndexedDB write started then can finish).
  window.addEventListener("beforeunload", flush);

  load(opts.workspace);

  return {
    setWorkspace(next: object) {
      if (disposed || next === lastEmitted) return false;
      let text: string;
      try {
        text = JSON.stringify(next);
      } catch {
        text = "";
      }
      if (text === lastText || recentTexts.includes(text)) return false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastEmitted = null;
      recentTexts.length = 0;
      load(next);
      return true;
    },
    focusBlock(id: string) {
      const b = ws.getBlockById(id);
      if (!b) return;
      ws.centerOnBlock(id);
      if (b instanceof Blockly.BlockSvg) b.select();
    },
    flush,
    addEvaluationBlock() {
      if (disposed || opts.readOnly) return;
      const metrics = ws.getMetricsManager().getViewMetrics(true);
      const state = { type: "cb_evaluation", x: Math.round(metrics.left + 40), y: Math.round(metrics.top + 40) };
      Blockly.serialization.blocks.append(state, ws, { recordUndo: true });
    },
    replaceWithUndo(json: object) {
      if (disposed || opts.readOnly) return;
      const { workspace: clean } = sanitizeWorkspace(json, (t) => Boolean(Blockly.Blocks[t]));
      Blockly.Events.setGroup(true);
      try {
        Blockly.serialization.workspaces.load(clean, ws, { recordUndo: true });
      } finally {
        Blockly.Events.setGroup(false);
      }
      scrollToStart();
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      if (timer) clearTimeout(timer);
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      unpatchMedia();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      ws.removeChangeListener(onWorkspaceEvent);
      Blockly.hideChaff();
      Blockly.DropDownDiv.hideWithoutAnimation();
      Blockly.WidgetDiv.hide();
      ws.dispose();
      container.classList.remove("blocks-editor-injected");
    },
  };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
