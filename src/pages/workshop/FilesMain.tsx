// Main area of full / scratch engines: the file tree (create, rename, delete, set entry), open
// file tabs and the code editor with per-file diagnostics.
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { EmptyState, Icon, Modal, type ConfirmFn } from "@/components";
import { FileTree, diagnosticsForFile, normalizeFilePath, validateFilePath } from "@/components/code";
import { TEMPLATE_VERSION, templateFiles } from "@/engine-host";
import { toast } from "@/app/toast";
import type { CompileDiagnostic, EngineRecord } from "@/types";
import { CodePane, type CodePaneHandle } from "./CodePane";
import type { EngineDraft } from "./draft";
import { closeTab, importSpecifier, importersOf, newFileContents, openTab, pruneTabs, renameTab, renameWithImports, sortPaths, withExtension, withoutFile } from "./files";
import { entryOf, filePatch } from "./records";
import type { RevealTarget } from "./types";
import { ShortcutsButton } from "./Shortcuts";
import { MenuButton } from "./ui";

interface FilesMainProps {
  view: EngineRecord;
  saved: EngineRecord;
  draft: EngineDraft;
  diagnostics: CompileDiagnostic[];
  reveal: RevealTarget | null;
  editorRef: Ref<CodePaneHandle>;
  /** File requested through ?file= (may not exist). */
  requestedFile: string | null;
  onOpenFile(path: string | null): void;
  confirm: ConfirmFn;
  narrow: boolean;
}

/** The file to show: the requested one if it exists, else the entry file, else the first file. */
export function resolveActiveFile(paths: readonly string[], requested: string | null, entry: string): string | null {
  if (requested && paths.includes(requested)) return requested;
  if (paths.includes(entry)) return entry;
  return paths[0] ?? null;
}

type Dialog = { kind: "create" } | { kind: "rename"; path: string } | null;

export function FilesMain({ view, saved, draft, diagnostics, reveal, editorRef, requestedFile, onOpenFile, confirm, narrow }: FilesMainProps) {
  const files = view.files ?? {};
  const entry = entryOf(view);
  // Only the set of names matters for the tree (the contents change on every keystroke).
  const names = Object.keys(files).sort().join("\u0000");
  const paths = useMemo(() => sortPaths(names ? names.split("\u0000") : [], entry), [names, entry]);
  const active = resolveActiveFile(paths, requestedFile, entry);
  const [tabs, setTabs] = useState<string[]>(() => (active ? [active] : []));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Keep the tabs in line with the files and the active file.
  useEffect(() => {
    setTabs((t) => {
      const next = pruneTabs(active ? openTab(t, active) : t, paths);
      return next.length === t.length && next.every((p, i) => p === t[i]) ? t : next;
    });
  }, [active, paths]);

  // The tab strip scrolls sideways when the tabs do not fit (always on a phone): keep the open
  // file's tab in sight, so it is clear which file the editor shows.
  const tabStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabStripRef.current;
    const tab = strip?.querySelector<HTMLElement>(".workshop-filetab.active");
    if (!strip || !tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < s.left) strip.scrollLeft -= s.left - t.left;
    else if (t.right > s.right) strip.scrollLeft += Math.min(t.right - s.right, t.left - s.left);
  }, [active, tabs, narrow]);

  const errorCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of diagnostics) if (d.severity === "error" && d.file && d.file in files) out[d.file] = (out[d.file] ?? 0) + 1;
    return out;
  }, [diagnostics, files]);

  const dirty = useMemo(() => {
    const set = new Set<string>();
    const before = saved.files ?? {};
    for (const p of paths) if (files[p] !== before[p]) set.add(p);
    return set;
  }, [files, saved.files, paths]);

  const open = (path: string) => {
    onOpenFile(path);
    if (narrow) setTreeOpen(false);
  };

  const create = (raw: string): string | null => {
    const path = withExtension(normalizeFilePath(raw));
    const problem = validateFilePath(path, paths);
    if (problem) return problem;
    const current = draft.view.files ?? {};
    draft.edit({ files: { ...current, [path]: newFileContents(path, Object.keys(current), entryOf(draft.view)) } });
    open(path);
    return null;
  };

  const rename = (from: string, raw: string): string | null => {
    const to = withExtension(normalizeFilePath(raw));
    if (to === from) return null;
    const problem = validateFilePath(to, paths, { current: from });
    if (problem) return problem;
    const current = draft.view;
    // Imports of the renamed file are rewritten to the new path, so the engine keeps building.
    const renamed = renameWithImports(current.files ?? {}, from, to);
    const patch: Partial<EngineRecord> = { files: renamed.files };
    if (entryOf(current) === from) patch.entry = to;
    draft.edit(patch);
    setTabs((t) => renameTab(t, from, to));
    if (active === from) onOpenFile(to);
    const updated = renamed.updated;
    toast(`Renamed to ${to}`, {
      kind: "success",
      detail: updated.length === 0 ? undefined : `Updated the import${updated.length === 1 ? "" : "s"} in ${updated.join(", ")}.`,
    });
    return null;
  };

  /** "main.ts imports it: …" for the delete confirmation, or "" when no file imports `path`. */
  const importWarning = (path: string): string => {
    const importers = importersOf(draft.view.files ?? {}, path);
    if (importers.length === 0) return "";
    const who = importers.length === 1 ? `${importers[0]} imports it` : `${importers.join(", ")} import it`;
    return ` ${who}: remove ${importers.length === 1 ? "that import" : "those imports"} too, or the engine won't build.`;
  };

  /** Deletes a file (`confirmed`: the file tree already asked). */
  const remove = async (path: string, confirmed = false) => {
    if (path === entryOf(draft.view)) {
      toast(`${path} is the entry file`, { kind: "warn", detail: "Choose another entry file first (Set as entry), then delete this one." });
      return;
    }
    if (!confirmed) {
      const ok = await confirm({
        title: `Delete ${path}?`,
        message: `${path} will be removed from this engine. This can't be undone.${importWarning(path)}`,
        confirmLabel: "Delete file",
        danger: true,
      });
      if (!ok) return;
    }
    draft.edit({ files: withoutFile(draft.view.files ?? {}, path) });
    const closed = closeTab(tabs, path, active);
    setTabs(closed.tabs);
    if (active === path) onOpenFile(closed.active);
  };

  const setEntry = (path: string) => {
    draft.edit({ entry: path });
    toast(`${path} is now the entry file`, { kind: "success", detail: "The compiler starts from this file." });
  };

  const resetToTemplate = async (path: string) => {
    const template = templateFiles[path];
    if (template === undefined) return;
    const ok = await confirm({ title: `Reset ${path} to the template?`, message: "Your changes to this file are replaced by the stock template's version.", confirmLabel: "Reset file", danger: true });
    if (ok) draft.edit(filePatch(draft.view, path, template));
  };

  const closeEditorTab = (path: string) => {
    const closed = closeTab(tabs, path, active);
    setTabs(closed.tabs);
    if (active === path) onOpenFile(closed.active);
  };

  const templateNewer = view.kind === "full" && (view.templateVersion ?? 0) < TEMPLATE_VERSION;
  const activeHasTemplate = view.kind === "full" && active !== null && active in templateFiles;
  const activeDiffersFromTemplate = activeHasTemplate && active !== null && files[active] !== templateFiles[active];

  if (paths.length === 0) {
    return (
      <div className="workshop-files workshop-files--empty">
        <EmptyState
          title="This engine has no files yet"
          description="Create main.ts with the ABI exports (see Help → Engine ABI) to get started."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                draft.edit({ files: { "main.ts": newFileContents("main.ts", [], "main.ts") }, entry: "main.ts" });
                onOpenFile("main.ts");
              }}
            >
              <Icon name="plus" size={14} /> Create main.ts
            </button>
          }
        />
      </div>
    );
  }

  // Narrow screens: the tree is a drawer over the editor. Escape (not taken by the tree itself,
  // e.g. by its menu or a name field) or a press on the editor closes it.
  const closeDrawer = (focusToggle: boolean) => {
    setTreeOpen(false);
    if (focusToggle) toggleRef.current?.focus();
  };

  const tree = (
    <div
      className={"workshop-tree" + (narrow ? " workshop-tree--drawer" : "")}
      hidden={narrow && !treeOpen}
      onKeyDown={(e) => {
        if (narrow && e.key === "Escape" && !e.defaultPrevented) closeDrawer(true);
      }}
    >
      <FileTree
        className="workshop-tree-list"
        files={paths}
        active={active}
        entry={entry}
        onSelect={open}
        onCreate={(p) => {
          const problem = create(p);
          if (problem) toast("Could not create the file", { kind: "error", detail: problem });
        }}
        onRename={(from, to) => {
          const problem = rename(from, to);
          if (problem) toast("Could not rename the file", { kind: "error", detail: problem });
        }}
        onDelete={(p) => void remove(p, true)}
        deleteWarning={(p) => importWarning(p).trim() || null}
        onSetEntry={setEntry}
        dirty={dirty}
        errorCounts={errorCounts}
      />
    </div>
  );

  return (
    <div className="workshop-files">
      {tree}
      <div
        className="workshop-files-editor"
        onPointerDown={(e) => {
          if (narrow && treeOpen && !(e.target as Element).closest(".workshop-tree-toggle")) closeDrawer(false);
        }}
      >
        <div className="workshop-filetabs">
          {narrow && (
            <button
              ref={toggleRef}
              type="button"
              className="btn btn-sm btn-ghost workshop-tree-toggle"
              onClick={() => setTreeOpen((o) => !o)}
              aria-expanded={treeOpen}
            >
              <Icon name="copy" size={14} /> Files
            </button>
          )}
          <div ref={tabStripRef} className="workshop-filetabs-scroll" role="tablist" aria-label="Open files">
            {tabs.map((t) => {
              const name = t.split("/").pop() ?? t;
              const errs = errorCounts[t] ?? 0;
              return (
                <div key={t} className={"workshop-filetab" + (t === active ? " active" : "")} title={t}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={t === active}
                    className="workshop-filetab-name"
                    onClick={() => onOpenFile(t)}
                    onAuxClick={(e) => {
                      if (e.button === 1) closeEditorTab(t);
                    }}
                  >
                    {name}
                    {t === entry && <span className="workshop-entry-mark" title="Entry file">entry</span>}
                    {dirty.has(t) && <span className="workshop-dirty-dot" aria-label="unsaved" />}
                    {errs > 0 && <span className="badge badge-danger">{errs}</span>}
                  </button>
                  <button type="button" className="workshop-filetab-close" aria-label={`Close ${name}`} onClick={() => closeEditorTab(t)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <ShortcutsButton />
          {active && (
            <MenuButton
              label={
                <>
                  <span className="workshop-hide-narrow">File</span> <Icon name="chevronDown" size={14} />
                </>
              }
              aria-label="File actions"
              items={[
                { id: "new", label: "New file…", onSelect: () => setDialog({ kind: "create" }) },
                { id: "rename", label: `Rename ${active}…`, onSelect: () => setDialog({ kind: "rename", path: active }) },
                { id: "entry", label: "Set as entry file", hint: active === entry ? "It already is" : "The compiler starts here", disabled: active === entry, onSelect: () => setEntry(active) },
                ...(view.kind === "full"
                  ? [
                      {
                        id: "reset",
                        label: "Reset file to template",
                        hint: activeHasTemplate ? (activeDiffersFromTemplate ? "Undo your changes to this file" : "Same as the template") : "Not a template file",
                        disabled: !activeDiffersFromTemplate,
                        onSelect: () => void resetToTemplate(active),
                      },
                    ]
                  : []),
                "separator" as const,
                { id: "delete", label: `Delete ${active}`, danger: true, disabled: active === entry, hint: active === entry ? "The entry file cannot be deleted" : undefined, onSelect: () => void remove(active) },
              ]}
            />
          )}
        </div>
        {templateNewer && (
          <div className="callout workshop-inline-callout small">
            The engine template was updated since this engine was created (version {view.templateVersion ?? "?"} → {TEMPLATE_VERSION}). Your files are unchanged; use
            “Reset file to template” on a file to take the new version.
          </div>
        )}
        {active ? (
          <CodePane
            ref={editorRef}
            documentId={active}
            completions={view.kind === "full"}
            importBase={view.kind === "full" ? importSpecifier(active, "x.ts").slice(0, -1) : undefined}
            value={files[active] ?? ""}
            onChange={(text) => draft.edit(filePatch(draft.view, active, text))}
            onSave={() => void draft.flush()}
            diagnostics={diagnosticsForFile(diagnostics, active)}
            revealLine={reveal && reveal.target === `main:${active}` ? reveal.reveal : undefined}
            aria-label={active}
          />
        ) : (
          <div className="workshop-files-none muted">Choose a file on the left.</div>
        )}
      </div>
      <PathDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onSubmit={(value) => (dialog?.kind === "rename" ? rename(dialog.path, value) : create(value))}
      />
    </div>
  );
}

function PathDialog({ dialog, onClose, onSubmit }: { dialog: Dialog; onClose(): void; onSubmit(value: string): string | null }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Reset the field while rendering (not in an effect) when another dialog opens, so its first
  // frame already shows the right name.
  const [shownFor, setShownFor] = useState<Dialog>(null);
  // The dialog whose name was pre-selected: only the first focus selects the base name (focusing
  // the field again later, e.g. after a validation error, must not throw away a corrected name).
  const selectedFor = useRef<Dialog>(null);
  if (dialog !== shownFor) {
    setShownFor(dialog);
    setValue(dialog?.kind === "rename" ? dialog.path : "");
    setError(null);
  }
  const submit = () => {
    const problem = onSubmit(value);
    if (problem) setError(problem);
    else onClose();
  };
  return (
    <Modal
      open={dialog !== null}
      onClose={onClose}
      title={dialog?.kind === "rename" ? `Rename ${dialog.path}` : "New file"}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {dialog?.kind === "rename" ? "Rename" : "Create"}
          </button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="workshop-path-input">File name</label>
        <input
          id="workshop-path-input"
          className="input mono"
          value={value}
          data-autofocus
          placeholder="pawns.ts or lib/pawns.ts"
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => {
            // Renaming: select the name without folder and extension, so typing replaces just that.
            if (dialog?.kind !== "rename" || selectedFor.current === dialog) return;
            selectedFor.current = dialog;
            const el = e.currentTarget;
            const start = el.value.lastIndexOf("/") + 1;
            const dot = el.value.lastIndexOf(".");
            el.setSelectionRange(start, dot > start ? dot : el.value.length);
          }}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error ? <span className="field-error">{error}</span> : <span className="field-hint">AssemblyScript files end in .ts (added if you leave it out). Use / for folders.</span>}
      </form>
    </Modal>
  );
}
