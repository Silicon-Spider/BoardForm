// @vitest-environment jsdom
// Render tests of the code components in jsdom: the controlled-value / history rules of
// CodeEditor, diagnostics, revealLine, insert and Ctrl+S; FileTree actions and keyboard;
// ApiReference search and insert. (Visual checks run in Chromium via the #/dev/code gallery.)
import { redo, undo } from "@codemirror/commands";
import { diagnosticCount } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiReference } from "./ApiReference";
import { ENGINE_API } from "./api";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
import type { CodeEditorProps, FileTreeProps } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has no layout. CodeMirror measures text ranges and ApiReference scrolls the active
  // option into view: give them harmless stand-ins.
  const rect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
  const emptyList = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= emptyList;
  Range.prototype.getBoundingClientRect ??= rect;
  Element.prototype.scrollIntoView ??= () => {};
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

// ------------------------------------------------------------------------- CodeEditor

function view(): EditorView {
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  const v = dom && EditorView.findFromDOM(dom);
  if (!v) throw new Error("editor not rendered");
  return v;
}

const text = () => view().state.doc.toString();

/** A user edit (as typing would produce): inserts `insert` at `at` (default: the end). */
function type(insert: string, at?: number) {
  const v = view();
  const pos = at ?? v.state.doc.length;
  act(() => v.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: "input.type" }));
}

function editor(props: Partial<CodeEditorProps> & { value: string }) {
  render(<CodeEditor {...props} />);
}

describe("CodeEditor", () => {
  it("reports edits and ignores the echo of its own value", () => {
    const onChange = vi.fn();
    editor({ value: "let a = 1;", onChange });
    type(" // x");
    expect(onChange).toHaveBeenLastCalledWith("let a = 1; // x");
    const sel = view().state.selection.main.head;
    // The parent echoes the value back: nothing changes, the cursor stays.
    editor({ value: "let a = 1; // x", onChange });
    expect(text()).toBe("let a = 1; // x");
    expect(view().state.selection.main.head).toBe(sel);
    // A late echo of an older text (two quick keystrokes) is not taken as a reset either.
    type("y");
    editor({ value: "let a = 1; // x", onChange });
    expect(text()).toBe("let a = 1; // xy");
    // A different value from outside replaces the document.
    editor({ value: "fresh", onChange });
    expect(text()).toBe("fresh");
    expect(onChange).toHaveBeenCalledTimes(2); // outside changes are not reported
  });

  it("starts a fresh history for outside values without documentId", () => {
    editor({ value: "one" });
    type("1");
    editor({ value: "two" });
    expect(undo(view())).toBe(false);
    expect(text()).toBe("two");
  });

  it("keeps one history per documentId", () => {
    const v0 = (editor({ value: "alpha", documentId: "a.ts" }), view());
    type("1");
    editor({ value: "beta", documentId: "b.ts" });
    expect(view()).toBe(v0); // same EditorView, switched state
    expect(text()).toBe("beta");
    expect(undo(view())).toBe(false); // nothing of a.ts leaks into b.ts
    type("2");
    editor({ value: "alpha1", documentId: "a.ts" });
    expect(text()).toBe("alpha1");
    expect(undo(view())).toBe(true);
    expect(text()).toBe("alpha");
    expect(redo(view())).toBe(true);
    expect(text()).toBe("alpha1");
    // b.ts kept its own history while hidden.
    editor({ value: "beta2", documentId: "b.ts" });
    undo(view());
    expect(text()).toBe("beta");
  });

  it("makes an outside change of the same document undoable", () => {
    editor({ value: "edited", documentId: "eval.ts" });
    editor({ value: "template", documentId: "eval.ts" });
    expect(text()).toBe("template");
    undo(view());
    expect(text()).toBe("edited");
  });

  it("normalises Windows line endings", () => {
    editor({ value: "a\r\nb\r\n" });
    expect(view().state.doc.lines).toBe(3);
  });

  it("toggles read-only in place", () => {
    editor({ value: "x", readOnly: true });
    const v = view();
    expect(v.state.readOnly).toBe(true);
    expect(container.querySelector(".cb-code-editor--readonly")).not.toBeNull();
    editor({ value: "x", readOnly: false });
    expect(view()).toBe(v);
    expect(v.state.readOnly).toBe(false);
  });

  it("shows diagnostics, clamping positions outside the document", () => {
    const value = "export function f(): i32 {\n  return x;\n}\n";
    editor({
      value,
      diagnostics: [
        { line: 2, column: 10, severity: "error", message: "Cannot find name 'x'." },
        { line: 99, column: 99, severity: "warning", message: "Out of range" },
        { line: 1, column: 8, endLine: 1, endColumn: 16, severity: "info", message: "Info" },
      ],
    });
    expect(diagnosticCount(view().state)).toBe(3);
    editor({ value, diagnostics: [] });
    expect(diagnosticCount(view().state)).toBe(0);
  });

  it("reveals a line and repeats when the nonce changes", () => {
    const value = "line one\nline two\n    indented three\nfour";
    editor({ value, revealLine: { line: 3, nonce: 1 } });
    const v = view();
    // First non-blank character of line 3.
    expect(v.state.selection.main.head).toBe(v.state.doc.line(3).from + 4);
    act(() => v.dispatch({ selection: { anchor: 0 } }));
    editor({ value, revealLine: { line: 3, nonce: 2 } });
    expect(v.state.selection.main.head).toBe(v.state.doc.line(3).from + 4);
    // Explicit column, clamped line.
    editor({ value, revealLine: { line: 50, column: 3, nonce: 3 } });
    expect(v.state.selection.main.head).toBe(v.state.doc.line(4).from + 2);
  });

  it("inserts snippets with their import, only for new nonces", () => {
    const popcount = ENGINE_API.find((e) => e.name === "popcount" && e.module === "bitboard")!;
    const value = 'import { WHITE } from "./types";\n\nconst n = ';
    const onChange = vi.fn();
    editor({ value, onChange, insert: { text: "popcount()", entry: popcount, nonce: 1 } });
    expect(text()).toBe(value); // the request present at mount is not applied
    act(() => view().dispatch({ selection: { anchor: value.length } }));
    editor({ value, onChange, insert: { text: "popcount()", entry: popcount, nonce: 2 } });
    expect(text()).toBe('import { WHITE } from "./types";\nimport { popcount } from "./bitboard";\n\nconst n = popcount()');
    // The cursor sits between the parentheses.
    expect(text().slice(view().state.selection.main.head)).toBe(")");
    expect(onChange).toHaveBeenCalledTimes(1);
    // Ignored while read-only.
    editor({ value: text(), readOnly: true, insert: { text: "zzz", nonce: 3 } });
    expect(text()).not.toContain("zzz");
  });

  it("adds the first import to a file without imports only when it knows where the template is", () => {
    const popcount = ENGINE_API.find((e) => e.name === "popcount" && e.module === "bitboard")!;
    const value = "// pawns.ts\n//\n// Helpers for my evaluation.\n\n";
    editor({ value, documentId: "lib/pawns.ts" });
    act(() => view().dispatch({ selection: { anchor: value.length } }));
    // Without importBase it does not guess (scratch engines have no template modules).
    editor({ value, documentId: "lib/pawns.ts", insert: { text: "popcount()", entry: popcount, nonce: 1 } });
    expect(text()).toBe(value + "popcount()");
    act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: value }, selection: { anchor: value.length } }));
    editor({ value, documentId: "lib/pawns.ts", importBase: "../", insert: { text: "popcount()", entry: popcount, nonce: 2 } });
    expect(text()).toBe('// pawns.ts\n//\n// Helpers for my evaluation.\n\nimport { popcount } from "../bitboard";\n\npopcount()');
  });

  it("tells the parent when someone tries to type into a read-only document", () => {
    const onReadOnlyEdit = vi.fn();
    editor({ value: "fixed", readOnly: true, onReadOnlyEdit });
    const content = container.querySelector<HTMLElement>(".cm-content")!;
    act(() => {
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    });
    expect(onReadOnlyEdit).toHaveBeenCalledTimes(1);
    // Navigation keys are fine.
    act(() => {
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(onReadOnlyEdit).toHaveBeenCalledTimes(1);
    expect(text()).toBe("fixed");
  });

  it("calls onSave on Ctrl+S and suppresses the browser's save dialog", () => {
    const onSave = vi.fn();
    editor({ value: "x", onSave });
    const event = new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      view().contentDOM.dispatchEvent(event);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("labels the editor and switches languages", () => {
    editor({ value: "# notes", language: "markdown", "aria-label": "Notes" });
    expect(container.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Notes");
    expect(container.querySelector(".cb-code-editor")?.getAttribute("data-language")).toBe("markdown");
    editor({ value: "# notes", language: "assemblyscript", "aria-label": "Notes" });
    expect(container.querySelector(".cb-code-editor")?.getAttribute("data-language")).toBe("assemblyscript");
  });
});

// --------------------------------------------------------------------------- FileTree

function tree(props: Partial<FileTreeProps> = {}) {
  const all: FileTreeProps = {
    files: ["main.ts", "eval.ts", "lib/pst.ts", "lib/deep/x.ts"],
    active: "eval.ts",
    entry: "main.ts",
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onSetEntry: vi.fn(),
    ...props,
  };
  render(<FileTree {...all} />);
  return all;
}

const rowNames = () => [...container.querySelectorAll(".cb-tree-row .cb-tree-name")].map((n) => n.textContent);
const row = (name: string) => {
  const r = [...container.querySelectorAll<HTMLElement>(".cb-tree-row")].find((el) => el.querySelector(".cb-tree-name")?.textContent === name);
  if (!r) throw new Error(`row ${name} not found`);
  return r;
};
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });

/** Sets a React-controlled input's value the way typing does. */
function fill(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FileTree", () => {
  it("shows folders first with the entry marker, dirty dot and error badge", () => {
    tree({ dirty: new Set(["eval.ts"]), errorCounts: { "eval.ts": 3 } });
    expect(rowNames()).toEqual(["lib", "deep", "x.ts", "pst.ts", "eval.ts", "main.ts"]);
    expect(row("main.ts").querySelector(".cb-tree-entry")).not.toBeNull();
    expect(row("eval.ts").querySelector(".cb-tree-dirty")).not.toBeNull();
    expect(row("eval.ts").querySelector(".cb-tree-errors")?.textContent).toBe("3");
    expect(row("eval.ts").getAttribute("aria-selected")).toBe("true");
    // A single tab stop: the active file.
    expect([...container.querySelectorAll('[role="treeitem"][tabindex="0"]')]).toEqual([row("eval.ts")]);
  });

  it("collapses folders and summarises what is inside", () => {
    tree({ errorCounts: { "lib/pst.ts": 2 } });
    act(() => row("lib").click());
    expect(rowNames()).toEqual(["lib", "eval.ts", "main.ts"]);
    expect(row("lib").getAttribute("aria-expanded")).toBe("false");
    expect(row("lib").querySelector(".cb-tree-errors")?.textContent).toBe("2");
    key(row("lib"), "ArrowRight");
    expect(rowNames()).toContain("pst.ts");
  });

  it("navigates with the keyboard and opens files", () => {
    const props = tree();
    const eval_ = row("eval.ts");
    act(() => eval_.focus());
    key(eval_, "ArrowDown");
    expect(document.activeElement).toBe(row("main.ts"));
    key(row("main.ts"), "Home");
    expect(document.activeElement).toBe(row("lib"));
    key(row("lib"), "End");
    key(row("main.ts"), "Enter");
    expect(props.onSelect).toHaveBeenCalledWith("main.ts");
    key(row("main.ts"), "p"); // type-ahead
    expect(document.activeElement).toBe(row("pst.ts"));
  });

  it("creates files with validation", () => {
    const props = tree();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="New file"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New file name"]')!;
    expect(input).not.toBeNull();
    fill(input, "main");
    key(input, "Enter");
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/already a file called main\.ts/);
    expect(props.onCreate).not.toHaveBeenCalled();
    fill(input, "lib/helpers");
    expect(container.textContent).toContain("Creates lib/helpers.ts");
    key(input, "Enter");
    expect(props.onCreate).toHaveBeenCalledWith("lib/helpers.ts");
    expect(container.querySelector('input[aria-label="New file name"]')).toBeNull();
  });

  it("renames with F2 and keeps the entry file from being deleted", () => {
    const props = tree();
    key(row("eval.ts"), "F2");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename eval.ts"]')!;
    fill(input, "evaluation.ts");
    key(input, "Enter");
    expect(props.onRename).toHaveBeenCalledWith("eval.ts", "evaluation.ts");
    key(row("main.ts"), "Delete"); // the entry file
    expect(document.querySelector(".modal, [role=dialog]")).toBeNull();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("asks before deleting", async () => {
    const props = tree();
    key(row("eval.ts"), "Delete");
    const confirmButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Delete file"));
    await vi.waitFor(() => expect(confirmButton()).toBeDefined());
    expect(document.body.textContent).toContain("Delete eval.ts?");
    await act(async () => confirmButton()!.click());
    await vi.waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("eval.ts"));
  });

  it("hands focus to the actions menu, even after a cancelled delete", async () => {
    tree();
    act(() => row("eval.ts").focus());
    key(row("eval.ts"), "Delete");
    const cancel =() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel");
    await vi.waitFor(() => expect(cancel()).toBeDefined());
    await act(async () => cancel()!.click());
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
    expect(document.activeElement).toBe(row("eval.ts"));
    // Focusing another row and opening its menu: the menu keeps the focus.
    act(() => row("lib").focus());
    expect(document.activeElement).toBe(row("lib")); // no stale focus request pulls it back
    key(row("lib"), "F10", { shiftKey: true });
    const item = document.querySelector<HTMLButtonElement>(".cb-tree-menu [role=menuitem]");
    expect(item?.textContent).toBe("New file in lib");
    expect(document.activeElement).toBe(item);
    act(() => item!.click());
    expect(document.activeElement).toBe(container.querySelector('input[aria-label="New file name"]'));
  });

  it("commits a valid name on blur without pulling focus back", () => {
    const props = tree();
    key(row("eval.ts"), "F2");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename eval.ts"]')!;
    fill(input, "score.ts");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus()); // blurs the field
    expect(props.onRename).toHaveBeenCalledWith("eval.ts", "score.ts");
    expect(document.activeElement).toBe(outside);
    // An invalid name is dropped on blur.
    key(row("main.ts"), "F2");
    fill(container.querySelector<HTMLInputElement>('input[aria-label="Rename main.ts"]')!, "bad name");
    act(() => outside.focus());
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("hides every action when read-only", () => {
    tree({ readOnly: true });
    expect(container.querySelector('button[aria-label="New file"]')).toBeNull();
    expect(container.querySelector(".cb-tree-more")).toBeNull();
    key(row("eval.ts"), "F2");
    expect(container.querySelector("input")).toBeNull();
  });

  it("offers a first file when there are none", () => {
    tree({ files: [], active: null, entry: undefined });
    expect(container.textContent).toContain("No files yet.");
  });
});

// ----------------------------------------------------------------------- ApiReference

describe("ApiReference", () => {
  const search = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;

  it("groups modules with evalkit first", () => {
    render(<ApiReference />);
    const files = [...container.querySelectorAll(".cb-api-file")].map((f) => f.textContent);
    expect(files.slice(0, 6)).toEqual(["evalkit.ts", "position.ts", "bitboard.ts", "types.ts", "trace.ts", "nnue.ts"]);
    expect(container.querySelector(".cb-api-insert")).toBeNull(); // no Insert buttons without onInsert
  });

  it("searches and inserts the highlighted entry with Enter", () => {
    const onInsert = vi.fn();
    render(<ApiReference onInsert={onInsert} />);
    fill(search(), "popcount");
    const first = container.querySelector('[role="option"][aria-selected="true"]');
    expect(first?.textContent).toContain("popcount");
    key(search(), "Enter");
    expect(onInsert).toHaveBeenCalledTimes(1);
    const [snippet, entry] = onInsert.mock.calls[0];
    expect(snippet).toBe("popcount()");
    expect(entry).toMatchObject({ name: "popcount", module: "bitboard" });
    // Arrow keys move the highlight through the matches.
    fill(search(), "passed");
    const before = container.querySelector('[role="option"][aria-selected="true"]')?.id;
    key(search(), "ArrowDown");
    const after = container.querySelector('[role="option"][aria-selected="true"]')?.id;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(search().getAttribute("aria-activedescendant")).toBe(after);
  });

  it("shows an empty state and restricts modules", () => {
    render(<ApiReference modules={["trace.ts"]} />);
    expect([...container.querySelectorAll(".cb-api-file")].map((f) => f.textContent)).toEqual(["trace.ts"]);
    fill(search(), "no-such-symbol");
    expect(container.textContent).toContain("No symbols match");
  });
});
