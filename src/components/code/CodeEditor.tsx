// CodeMirror 6 editor for engine sources (AssemblyScript / TypeScript, or plain text).
//
// The component owns one EditorView for its lifetime. Props are applied incrementally:
//   * value      -> replaces the document when it differs (fresh history, or one undoable edit
//                   when `documentId` stays the same); echoes of what onChange reported are ignored
//   * documentId -> switches between per-document EditorStates (history, selection, scroll)
//   * readOnly / language / completions / aria-label -> compartments, reconfigured in place
//   * diagnostics -> @codemirror/lint setDiagnostics
//   * revealLine -> scroll + cursor + a short line highlight, whenever its nonce changes
// Everything visual comes from CSS variables (theme.ts, CodeEditor.css), so the editor follows
// the app's dark / light theme without being rebuilt.
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { diagnosticCount, linter, lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { useLayoutEffect, useRef, type JSX } from "react";
import { memberOf } from "./api";
import { assemblyScriptCompletions, importChange } from "./completion";
import { diagnosticRange } from "./diagnostics";
import { isCodeLanguage, languageExtension, type EditorLanguage } from "./language";
import { editorTheme } from "./theme";
import type { CodeEditorDiagnostic, CodeEditorProps } from "./types";
import "./CodeEditor.css";

// ------------------------------------------------------------------ shared extensions

/** Marks transactions that apply a `value` coming from outside (they are not echoed). */
const externalChange = /*@__PURE__*/ Annotation.define<boolean>();

/** Short highlight of a revealed line. */
const flashEffect = /*@__PURE__*/ StateEffect.define<number | null>();
const flashLine = /*@__PURE__*/ Decoration.line({ class: "cb-code-flash" });
const flashField = /*@__PURE__*/ StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) next = e.value === null ? Decoration.none : Decoration.set([flashLine.range(e.value)]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Friendlier labels for CodeMirror's built-in panels. */
const PHRASES: Record<string, string> = {
  Find: "Find",
  Replace: "Replace",
  next: "Next",
  previous: "Previous",
  all: "Select all",
  "match case": "Match case",
  regexp: "Regex",
  "by word": "Whole word",
  replace: "Replace",
  "replace all": "Replace all",
  close: "Close",
  "Go to line": "Go to line",
  go: "Go",
  "Fold line": "Fold",
  "Unfold line": "Unfold",
  "folded code": "folded code",
  unfold: "Unfold",
};

function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = "cb-code-fold" + (open ? "" : " is-folded");
  el.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  return el;
}

let shared: Extension | null = null;

/** Extensions every editor uses (created once; extensions are immutable descriptions). */
function sharedExtensions(): Extension {
  shared ??= [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: foldMarker }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    EditorState.phrases.of(PHRASES),
    flashField,
    // Tab accepts an open completion; otherwise it indents (indentWithTab, below).
    Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab]),
    editorTheme(),
  ];
  return shared;
}

const completionExtensions = new Map<string, Extension>();

function completionExtension(language: EditorLanguage, api: boolean): Extension {
  if (!isCodeLanguage(language)) return NONE;
  const key = String(api);
  let ext = completionExtensions.get(key);
  if (!ext) {
    ext = autocompletion({
      override: [assemblyScriptCompletions({ api })],
      maxRenderedOptions: 80,
      activateOnTypingDelay: 60,
      tooltipClass: () => "cb-code-completions",
    });
    completionExtensions.set(key, ext);
  }
  return ext;
}

let readOnlyExt: Extension | null = null;
function readOnlyExtension(): Extension {
  readOnlyExt ??= [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-readonly": "true" })];
  return readOnlyExt;
}

const NONE: Extension = [];

let lintExt: Extension | null = null;
function lintExtension(): Extension {
  // linter(null) installs the diagnostics state + hover tooltips without a lint source:
  // diagnostics only change through setDiagnostics (positions are mapped through edits).
  lintExt ??= [linter(null), lintGutter()];
  return lintExt;
}

let darkFlags: Extension[] | null = null;
function darkFlag(dark: boolean): Extension {
  darkFlags ??= [EditorView.darkTheme.of(false), EditorView.darkTheme.of(true)];
  return darkFlags[dark ? 1 : 0];
}

const labelExtensions = new Map<string, Extension>();
function labelExtension(label: string): Extension {
  let ext = labelExtensions.get(label);
  if (!ext) labelExtensions.set(label, (ext = EditorView.contentAttributes.of({ "aria-label": label })));
  return ext;
}

// ---------------------------------------------------------------- app theme watcher

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function isDarkTheme(): boolean {
  return typeof document === "undefined" || document.documentElement.dataset.theme !== "light";
}

/** Calls `cb` whenever <html data-theme> changes. Returns the unsubscribe function. */
function watchTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  if (!themeObserver && typeof MutationObserver !== "undefined") {
    themeObserver = new MutationObserver(() => themeListeners.forEach((l) => l()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return () => {
    themeListeners.delete(cb);
    if (themeListeners.size === 0 && themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  };
}

// --------------------------------------------------------------------------- helpers

const normalizeEol = (s: string) => (s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s);

function toCmDiagnostics(state: EditorState, diags: readonly CodeEditorDiagnostic[]): Diagnostic[] {
  return diags
    .map((d): Diagnostic => {
      const { from, to } = diagnosticRange(state.doc, d);
      return { from, to, severity: d.severity, message: d.message };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The smallest single change turning `a` into `b` (keeps cursor, folds and marks in place). */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

interface Config {
  language: EditorLanguage;
  readOnly: boolean;
  api: boolean;
  lint: boolean;
  dark: boolean;
  label: string;
}

function configOf(p: CodeEditorProps): Config {
  const language = p.language ?? "assemblyscript";
  return {
    language,
    readOnly: !!p.readOnly,
    api: p.completions ?? language === "assemblyscript",
    lint: isCodeLanguage(language) || (p.diagnostics?.length ?? 0) > 0,
    dark: isDarkTheme(),
    label: p["aria-label"] ?? "Code editor",
  };
}

/** How many recently reported texts are recognised as stale echoes of our own edits. */
const ECHO_MEMORY = 8;
/** Documents whose state is kept when switching `documentId`. */
const STATE_CACHE_SIZE = 32;

// ------------------------------------------------------------------------- component

/**
 * Code editor (CodeMirror 6). Fills its container: give the parent an explicit height.
 * See CodeEditorProps for the controlled-value and undo-history rules.
 */
export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Per-instance machinery, created once.
  const inst = useRef<{
    comps: { language: Compartment; completion: Compartment; readOnly: Compartment; lint: Compartment; dark: Compartment; attrs: Compartment };
    extensions: Extension;
    /** Texts recently passed to onChange, newest last. */
    echoes: string[];
    documentId: string | undefined;
    states: Map<string, { state: EditorState; scroll: StateEffect<unknown> | null }>;
    flashTimer: ReturnType<typeof setTimeout> | null;
    /** The `insert` nonce already handled (the one present at mount is never applied). */
    insertNonce: number | undefined;
  } | null>(null);
  if (!inst.current) {
    const comps = {
      language: new Compartment(),
      completion: new Compartment(),
      readOnly: new Compartment(),
      lint: new Compartment(),
      dark: new Compartment(),
      attrs: new Compartment(),
    };
    const extensions: Extension = [
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              propsRef.current.onSave?.();
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (!u.transactions.some((tr) => tr.docChanged && !tr.annotation(externalChange))) return;
        const text = u.state.doc.toString();
        const echoes = inst.current!.echoes;
        echoes.push(text);
        if (echoes.length > ECHO_MEMORY) echoes.shift();
        propsRef.current.onChange?.(text);
      }),
    ];
    inst.current = { comps, extensions, echoes: [], documentId: props.documentId, states: new Map(), flashTimer: null, insertNonce: props.insert?.nonce };
  }

  const compartmentsFor = (cfg: Config): Extension[] => {
    const { comps } = inst.current!;
    return [
      comps.language.of(languageExtension(cfg.language)),
      comps.completion.of(completionExtension(cfg.language, cfg.api)),
      comps.readOnly.of(cfg.readOnly ? readOnlyExtension() : NONE),
      comps.lint.of(cfg.lint ? lintExtension() : NONE),
      comps.dark.of(darkFlag(cfg.dark)),
      comps.attrs.of(labelExtension(cfg.label)),
    ];
  };

  // The compartments come first so the lint gutter sits left of the line numbers.
  const createState = (doc: string): EditorState =>
    EditorState.create({ doc, extensions: [compartmentsFor(configOf(propsRef.current)), sharedExtensions(), inst.current!.extensions] });

  /** Brings the compartments of the current state in line with the props. */
  const syncConfig = (view: EditorView) => {
    const cfg = configOf(propsRef.current);
    const { comps } = inst.current!;
    const wanted: Array<[Compartment, Extension]> = [
      [comps.language, languageExtension(cfg.language)],
      [comps.completion, completionExtension(cfg.language, cfg.api)],
      [comps.readOnly, cfg.readOnly ? readOnlyExtension() : NONE],
      [comps.lint, cfg.lint ? lintExtension() : NONE],
      [comps.dark, darkFlag(cfg.dark)],
      [comps.attrs, labelExtension(cfg.label)],
    ];
    // Every extension above is memoised, so identity tells whether anything changed.
    const effects = wanted.filter(([comp, ext]) => comp.get(view.state) !== ext).map(([comp, ext]) => comp.reconfigure(ext));
    if (effects.length) view.dispatch({ effects });
  };

  const applyDiagnostics = (view: EditorView) => {
    const diags = propsRef.current.diagnostics ?? [];
    if (diags.length === 0 && diagnosticCount(view.state) === 0) return;
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state, diags)));
  };

  /** Applies a `value` from outside as one undoable change (same document). */
  const replaceText = (view: EditorView, text: string) => {
    view.dispatch({
      changes: minimalChange(view.state.doc.toString(), text),
      annotations: [externalChange.of(true), isolateHistory.of("full")],
    });
  };

  // Create the view (once; StrictMode's extra mount/unmount re-creates it from the latest props).
  useLayoutEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: createState(normalizeEol(propsRef.current.value)) });
    viewRef.current = view;
    inst.current!.documentId = propsRef.current.documentId;
    const unwatch = watchTheme(() => syncConfig(view));
    return () => {
      unwatch();
      const i = inst.current!;
      if (i.flashTimer) clearTimeout(i.flashTimer);
      i.flashTimer = null;
      view.destroy();
      viewRef.current = null;
    };
    // Created once; later props are applied by the effects below.
  }, []);

  // value / documentId
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const i = inst.current!;
    const { value, documentId } = props;
    const text = normalizeEol(value);

    if (documentId !== i.documentId) {
      // Switching documents: park the current state, restore (or create) the new one.
      if (i.documentId !== undefined) {
        i.states.delete(i.documentId);
        i.states.set(i.documentId, { state: view.state, scroll: view.scrollSnapshot() });
        while (i.states.size > STATE_CACHE_SIZE) i.states.delete(i.states.keys().next().value!);
      }
      i.documentId = documentId;
      const saved = documentId !== undefined ? i.states.get(documentId) : undefined;
      if (saved) {
        view.setState(saved.state);
        syncConfig(view);
        if (saved.state.doc.toString() !== text) replaceText(view, text); // changed while hidden
        else if (saved.scroll) view.dispatch({ effects: saved.scroll });
      } else {
        view.setState(createState(text));
      }
      i.echoes = [];
      applyDiagnostics(view);
      return;
    }

    if (view.state.doc.toString() === text) return;
    if (i.echoes.includes(value)) return; // an older text we reported ourselves: not a reset
    if (documentId !== undefined) replaceText(view, text);
    else view.setState(createState(text)); // no identity: start a fresh history
    i.echoes = [];
    applyDiagnostics(view);
  }, [props.value, props.documentId]);

  // Compartments
  const hasDiagnostics = (props.diagnostics?.length ?? 0) > 0;
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) syncConfig(view);
  }, [props.readOnly, props.language, props.completions, props["aria-label"], hasDiagnostics]);

  // Diagnostics
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) applyDiagnostics(view);
  }, [props.diagnostics]);

  // revealLine
  const reveal = props.revealLine;
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const doc = view.state.doc;
    const lineNo = Number.isFinite(reveal.line) ? Math.min(doc.lines, Math.max(1, Math.trunc(reveal.line))) : 1;
    const line = doc.line(lineNo);
    const column =
      reveal.column !== undefined && Number.isFinite(reveal.column)
        ? Math.min(line.length + 1, Math.max(1, Math.trunc(reveal.column)))
        : (/^\s*/.exec(line.text)?.[0].length ?? 0) + 1;
    const pos = line.from + column - 1;
    view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(line.from)],
      userEvent: "select.reveal",
    });
    view.focus();
    const i = inst.current!;
    if (i.flashTimer) clearTimeout(i.flashTimer);
    i.flashTimer = setTimeout(() => {
      i.flashTimer = null;
      viewRef.current?.dispatch({ effects: flashEffect.of(null) });
    }, 1600);
  }, [reveal?.nonce, reveal?.line, reveal?.column]);

  // insert (only for nonces that change after mount, so a remounted editor never repeats one)
  const insertRequest = props.insert;
  useLayoutEffect(() => {
    const view = viewRef.current;
    const i = inst.current!;
    if (!view || !insertRequest || insertRequest.nonce === i.insertNonce) return;
    i.insertNonce = insertRequest.nonce;
    if (view.state.readOnly) return;
    const { text, entry } = insertRequest;
    const sel = view.state.selection.main;
    const imp = entry && !memberOf(entry) ? importChange(view.state, entry.name, entry.module) : null;
    const changes = view.state.changes(imp ? [{ from: sel.from, to: sel.to, insert: text }, imp] : { from: sel.from, to: sel.to, insert: text });
    const caret = text.endsWith("()") ? text.length - 1 : text.length;
    view.dispatch({ changes, selection: { anchor: changes.mapPos(sel.from, -1) + caret }, scrollIntoView: true, userEvent: "input.insert" });
    view.focus();
  }, [insertRequest?.nonce]);

  const language = props.language ?? "assemblyscript";
  return (
    <div
      ref={hostRef}
      className={"cb-code-editor" + (props.readOnly ? " cb-code-editor--readonly" : "") + (props.className ? " " + props.className : "")}
      data-language={language}
    />
  );
}
