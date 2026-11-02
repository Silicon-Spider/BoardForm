// File tree of an engine's sources: folders (paths with "/"), the active file, the entry file,
// unsaved-change dots and error counts; new / rename / delete / set-as-entry when editable.
//
// Keyboard (WAI-ARIA tree): ↑ ↓ move, → expands / enters a folder, ← collapses / goes to the
// parent, Home / End, Enter or Space opens, F2 renames, Delete deletes, Shift+F10 or the
// context-menu key opens the actions menu, typing a letter jumps to the next matching name.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "@/components/ConfirmDialog";
import { ancestorFolders, buildFileTree, normalizeFilePath, validateFilePath, type FileTreeNode } from "./filePaths";
import { TreeIcon } from "./icons";
import type { FileTreeProps } from "./types";
import "./FileTree.css";

interface Row {
  key: string;
  node: FileTreeNode;
  depth: number;
  parentKey: string | null;
}

type Editing = { mode: "create"; folder: string } | { mode: "rename"; path: string } | null;

const keyOf = (node: FileTreeNode) => (node.kind === "folder" ? "d:" : "f:") + node.path;

function flatten(nodes: FileTreeNode[], collapsed: ReadonlySet<string>, depth = 0, parentKey: string | null = null, out: Row[] = []): Row[] {
  for (const node of nodes) {
    const key = keyOf(node);
    out.push({ key, node, depth, parentKey });
    if (node.kind === "folder" && !collapsed.has(node.path)) flatten(node.children, collapsed, depth + 1, key, out);
  }
  return out;
}

/** "helpers" -> "helpers.ts" (only when the last segment has no extension at all). */
function withExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base !== "" && !base.includes(".") ? path + ".ts" : path;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// ------------------------------------------------------------------------- name editor

interface NameEditorProps {
  initial: string;
  depth: number;
  existing: readonly string[];
  /** The file being renamed. */
  current?: string;
  label: string;
  /** `byKeyboard`: Enter (move focus back into the tree), not leaving the field. */
  onCommit(path: string, byKeyboard: boolean): void;
  /** `byKeyboard`: Escape (move focus back into the tree), not leaving the field. */
  onCancel(byKeyboard: boolean): void;
}

function NameEditor({ initial, depth, existing, current, label, onCommit, onCancel }: NameEditorProps) {
  const [value, setValue] = useState(initial);
  const [tried, setTried] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const path = withExtension(normalizeFilePath(value));
  const error = validateFilePath(path, existing, { current });
  const showError = error && (tried || (value.trim() !== "" && value.trim() !== initial));

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the name without folder and extension, like file managers do.
    const start = initial.lastIndexOf("/") + 1;
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(start, dot > start ? dot : initial.length);
  }, [initial]);

  const finish = (commit: boolean, byKeyboard: boolean) => {
    if (done.current) return;
    if (commit && error) {
      if (byKeyboard) {
        setTried(true);
        return;
      }
      // Leaving the field keeps a valid name and drops anything else.
      commit = false;
    }
    done.current = true;
    if (commit && path !== current) onCommit(path, byKeyboard);
    else onCancel(byKeyboard);
  };

  return (
    <div className="cb-tree-edit" style={{ paddingLeft: 8 + depth * 14 + 18 }}>
      <div className="cb-tree-edit-row">
        <TreeIcon name="file" size={15} className="cb-tree-icon" />
        <input
          ref={inputRef}
          className={"input input-sm cb-tree-input" + (showError ? " is-invalid" : "")}
          value={value}
          aria-label={label}
          aria-invalid={showError ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true, true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false, true);
            }
          }}
          onBlur={() => finish(true, false)}
        />
      </div>
      {showError ? (
        <div className="cb-tree-edit-msg is-error" role="alert">
          {error}
        </div>
      ) : (
        value.trim() !== "" && path !== value.trim() && <div className="cb-tree-edit-msg">Creates {path}</div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- menu

interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is disabled (shown as its title). */
  hint?: string;
  run(): void;
}

interface MenuState {
  key: string;
  x: number;
  y: number;
  items: MenuItem[];
}

function Menu({ state, onClose }: { state: MenuState; onClose(focusRow: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(state.x, window.innerWidth - w - 8));
    const top = state.y + h + 8 > window.innerHeight ? Math.max(8, state.y - h - 4) : state.y;
    setPos({ left, top });
  }, [state]);

  // Focus the first item once the menu is placed: browsers ignore focus() on the hidden,
  // not-yet-measured menu.
  useLayoutEffect(() => {
    if (pos) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current(false);
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close.current(false);
    };
    const onResize = () => close.current(false);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === "Home") buttons[0]?.focus();
    else if (e.key === "End") buttons[buttons.length - 1]?.focus();
    else if (e.key === "Escape") onClose(true);
    else if (e.key === "Tab") onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      className="cb-tree-menu"
      role="menu"
      aria-label="File actions"
      style={pos ? { left: pos.left, top: pos.top } : { left: state.x, top: state.y, visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {state.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={"cb-tree-menu-item" + (item.danger ? " is-danger" : "")}
          disabled={item.disabled}
          title={item.disabled ? item.hint : undefined}
          onClick={() => {
            onClose(false);
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------- tree

/** File tree with folders, status badges and file actions. Keyboard accessible. */
export function FileTree(props: FileTreeProps): JSX.Element {
  const { files, active, entry, readOnly, onSelect, onCreate, onRename, onDelete, onSetEntry, dirty, errorCounts, className } = props;
  const confirm = useConfirm();
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /**
   * A row to focus as soon as it is rendered: a file the parent is about to add (create /
   * rename). It expires, so a file that never shows up cannot steal focus later.
   */
  const pendingFocus = useRef<{ key: string; until: number } | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  const editable = !readOnly;
  const canCreate = editable && !!onCreate;
  const canRename = editable && !!onRename;
  const canDelete = editable && !!onDelete;
  const canSetEntry = editable && !!onSetEntry;

  // Reveal the active file: expand the folders above it.
  useEffect(() => {
    if (!active) return;
    const up = ancestorFolders(active);
    setCollapsed((prev) => (up.some((f) => prev.has(f)) ? new Set([...prev].filter((f) => !up.includes(f))) : prev));
  }, [active]);

  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  // Aggregates for folders: errors and unsaved changes of everything inside.
  const folderStats = useMemo(() => {
    const stats = new Map<string, { errors: number; dirty: boolean }>();
    for (const f of files) {
      for (const folder of ancestorFolders(f)) {
        const s = stats.get(folder) ?? { errors: 0, dirty: false };
        s.errors += errorCounts?.[f] ?? 0;
        s.dirty ||= dirty?.has(f) ?? false;
        stats.set(folder, s);
      }
    }
    return stats;
  }, [files, errorCounts, dirty]);

  // The single tab stop of the tree.
  const tabKey = (focusKey && rowByKey.has(focusKey) ? focusKey : null) ?? (active && rowByKey.has("f:" + active) ? "f:" + active : rows[0]?.key ?? null);

  /** Focuses a row now when it is rendered, else as soon as it shows up. */
  const focusRow = (key: string | null) => {
    if (!key) return;
    setFocusKey(key);
    const el = rowRefs.current.get(key);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    } else pendingFocus.current = { key, until: Date.now() + 2000 };
  };
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    const el = rowRefs.current.get(pending.key);
    if (!el) return; // not rendered yet
    pendingFocus.current = null;
    if (document.activeElement !== el) el.focus();
  });

  const toggleFolder = (path: string, open?: boolean) =>
    setCollapsed((prev) => {
      const isOpen = !prev.has(path);
      const want = open ?? !isOpen;
      if (want === isOpen) return prev;
      const next = new Set(prev);
      if (want) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (folder: string) => {
    if (!canCreate) return;
    if (folder) toggleFolder(folder, true);
    setEditing({ mode: "create", folder });
  };

  const deleteFile = async (path: string) => {
    if (!canDelete || path === entry || files.length <= 1) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    // Where keyboard focus goes afterwards: the row below (or above) the deleted one.
    const index = rows.findIndex((r) => r.key === "f:" + path);
    const neighbour = rows[index + 1]?.key ?? rows[index - 1]?.key ?? null;
    const ok = await confirm({
      title: `Delete ${name}?`,
      message: `${path} will be removed from this engine. This can't be undone.`,
      confirmLabel: "Delete file",
      danger: true,
    });
    // Focus the neighbour before the parent removes the row, so focus never drops to <body>.
    focusRow(ok ? neighbour : "f:" + path);
    if (ok) onDelete?.(path);
  };

  const menuItems = (row: Row): MenuItem[] => {
    const items: MenuItem[] = [];
    if (row.node.kind === "folder") {
      const folder = row.node.path;
      if (canCreate) items.push({ label: `New file in ${row.node.name}`, run: () => startCreate(folder) });
      return items;
    }
    const path = row.node.path;
    if (canRename) items.push({ label: "Rename", shortcut: "F2", run: () => setEditing({ mode: "rename", path }) });
    if (canSetEntry)
      items.push({
        label: "Set as entry file",
        disabled: path === entry || !path.endsWith(".ts"),
        hint: path === entry ? "This is already the entry file" : "Only .ts files can be the entry",
        run: () => onSetEntry?.(path),
      });
    if (canCreate) items.push({ label: "New file here", run: () => startCreate(folderOf(path)) });
    if (canDelete)
      items.push({
        label: "Delete",
        shortcut: "Del",
        danger: true,
        disabled: path === entry || files.length <= 1,
        hint: path === entry ? "Choose another entry file before deleting this one" : "An engine needs at least one file",
        run: () => void deleteFile(path),
      });
    return items;
  };

  const openMenu = (row: Row, x: number, y: number) => {
    const items = menuItems(row);
    if (items.length === 0) return;
    pendingFocus.current = null; // the menu takes the focus
    setFocusKey(row.key);
    setMenu({ key: row.key, x, y, items });
  };

  const openMenuAtRow = (row: Row) => {
    const el = rowRefs.current.get(row.key);
    if (!el) return;
    const r = el.getBoundingClientRect();
    openMenu(row, r.right - 190, r.bottom + 2);
  };

  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, row: Row) => {
    const index = rows.indexOf(row);
    const node = row.node;
    const isFolder = node.kind === "folder";
    const open = isFolder && !collapsed.has(node.path);
    switch (e.key) {
      case "ArrowDown":
        focusRow(rows[Math.min(rows.length - 1, index + 1)]?.key ?? null);
        break;
      case "ArrowUp":
        focusRow(rows[Math.max(0, index - 1)]?.key ?? null);
        break;
      case "Home":
        focusRow(rows[0]?.key ?? null);
        break;
      case "End":
        focusRow(rows[rows.length - 1]?.key ?? null);
        break;
      case "ArrowRight":
        if (isFolder && !open) toggleFolder(node.path, true);
        else if (isFolder && node.children.length) focusRow(keyOf(node.children[0]));
        break;
      case "ArrowLeft":
        if (isFolder && open) toggleFolder(node.path, false);
        else if (row.parentKey) focusRow(row.parentKey);
        break;
      case "Enter":
      case " ":
        if (isFolder) toggleFolder(node.path);
        else onSelect(node.path);
        break;
      case "F2":
        if (!isFolder && canRename) setEditing({ mode: "rename", path: node.path });
        else return;
        break;
      case "Delete":
        if (!isFolder && canDelete) void deleteFile(node.path);
        else return;
        break;
      case "ContextMenu":
        openMenuAtRow(row);
        break;
      default:
        if (e.key === "F10" && e.shiftKey) {
          openMenuAtRow(row);
          break;
        }
        // Type-ahead: jump to the next row whose name starts with the typed letters.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          const now = Date.now();
          const t = typeahead.current;
          t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
          t.at = now;
          const ordered = [...rows.slice(index + (t.text.length === 1 ? 1 : 0)), ...rows.slice(0, index + (t.text.length === 1 ? 1 : 0))];
          const hit = ordered.find((r) => r.node.name.toLowerCase().startsWith(t.text));
          if (hit) focusRow(hit.key);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const closeMenu = (focus: boolean) => {
    const key = menu?.key ?? null;
    setMenu(null);
    if (focus) focusRow(key);
  };

  const renderEditor = (depth: number): ReactNode => {
    if (editing?.mode !== "create") return null;
    return (
      <NameEditor
        key={"create:" + editing.folder}
        initial={editing.folder ? editing.folder + "/" : ""}
        depth={depth}
        existing={files}
        label="New file name"
        onCommit={(path, byKeyboard) => {
          setEditing(null);
          onCreate?.(path);
          // Focus the new file once it shows up (the parent adds it to `files`), unless the
          // user left the field by clicking somewhere else.
          if (byKeyboard) focusRow("f:" + path);
        }}
        onCancel={(byKeyboard) => {
          setEditing(null);
          if (byKeyboard) focusRow(editing.folder ? "d:" + editing.folder : tabKey);
        }}
      />
    );
  };

  const errorsLabel = (n: number) => (n > 99 ? "99+" : String(n));

  return (
    <div className={"cb-tree" + (className ? " " + className : "")}>
      <div className="cb-tree-head">
        <span className="cb-tree-title">Files</span>
        <span className="cb-tree-total">{files.length}</span>
        {canCreate && (
          <button type="button" className="btn btn-ghost btn-sm btn-icon cb-tree-new" title="New file" aria-label="New file" onClick={() => startCreate("")}>
            <TreeIcon name="filePlus" size={16} />
          </button>
        )}
      </div>

      <div className="cb-tree-body">
        {editing?.mode === "create" && editing.folder === "" && renderEditor(0)}
        {files.length === 0 && editing?.mode !== "create" ? (
          <div className="cb-tree-empty">
            <p>No files yet.</p>
            {canCreate && (
              <button type="button" className="btn btn-sm" onClick={() => startCreate("")}>
                <TreeIcon name="plus" size={14} /> New file
              </button>
            )}
          </div>
        ) : (
          <div role="tree" aria-label="Files" className="cb-tree-list">
            {rows.map((row) => {
              const { node, depth, key } = row;
              const isFolder = node.kind === "folder";
              const open = isFolder && !collapsed.has(node.path);
              const isActive = !isFolder && node.path === active;
              const isEntry = !isFolder && node.path === entry;
              const stats = isFolder ? folderStats.get(node.path) : undefined;
              const errors = isFolder ? (open ? 0 : stats?.errors ?? 0) : errorCounts?.[node.path] ?? 0;
              const isDirty = isFolder ? !open && !!stats?.dirty : dirty?.has(node.path) ?? false;
              const renaming = !isFolder && editing?.mode === "rename" && editing.path === node.path;

              if (renaming) {
                return (
                  <NameEditor
                    key={"rename:" + node.path}
                    initial={node.path}
                    depth={depth}
                    existing={files}
                    current={node.path}
                    label={`Rename ${node.path}`}
                    onCommit={(to, byKeyboard) => {
                      setEditing(null);
                      onRename?.(node.path, to);
                      if (byKeyboard) focusRow("f:" + to);
                      else setFocusKey("f:" + to);
                    }}
                    onCancel={(byKeyboard) => {
                      setEditing(null);
                      if (byKeyboard) focusRow(key);
                    }}
                  />
                );
              }

              return (
                <div key={key} role="none">
                  <div
                    ref={(el) => {
                      if (el) rowRefs.current.set(key, el);
                      else rowRefs.current.delete(key);
                    }}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={isFolder ? open : undefined}
                    aria-selected={isFolder ? undefined : isActive}
                    tabIndex={key === tabKey ? 0 : -1}
                    className={"cb-tree-row" + (isActive ? " is-active" : "") + (isFolder ? " is-folder" : "") + (menu?.key === key ? " has-menu" : "")}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    title={node.path}
                    onClick={() => {
                      setFocusKey(key);
                      if (isFolder) toggleFolder(node.path);
                      else onSelect(node.path);
                    }}
                    onContextMenu={(e) => {
                      if (menuItems(row).length === 0) return;
                      e.preventDefault();
                      openMenu(row, e.clientX, e.clientY);
                    }}
                    onKeyDown={(e) => onRowKeyDown(e, row)}
                    onFocus={() => setFocusKey(key)}
                  >
                    {isFolder ? (
                      <TreeIcon name="chevron" size={14} className={"cb-tree-chevron" + (open ? " is-open" : "")} />
                    ) : (
                      <span className="cb-tree-chevron-space" />
                    )}
                    <TreeIcon name={isFolder ? (open ? "folderOpen" : "folder") : "file"} size={15} className="cb-tree-icon" />
                    <span className="cb-tree-name">{node.name}</span>
                    <span className="cb-tree-badges">
                      {isEntry && (
                        <span className="cb-tree-entry" title="Entry file: compilation starts here">
                          entry
                        </span>
                      )}
                      {isDirty && <span className="cb-tree-dirty" title={isFolder ? "Unsaved changes inside" : "Unsaved changes"} />}
                      {errors > 0 && (
                        <span className="cb-tree-errors" title={`${errors} error${errors === 1 ? "" : "s"}${isFolder ? " inside" : ""}`}>
                          {errorsLabel(errors)}
                        </span>
                      )}
                      <span className="cb-tree-sr">
                        {isEntry ? ", entry file" : ""}
                        {isDirty ? ", unsaved changes" : ""}
                        {errors > 0 ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}
                      </span>
                    </span>
                    {menuItems(row).length > 0 && (
                      <button
                        type="button"
                        tabIndex={-1}
                        className="cb-tree-more"
                        aria-label={`Actions for ${node.name}`}
                        title="Actions (Shift+F10)"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          openMenu(row, r.right - 190, r.bottom + 4);
                        }}
                      >
                        <TreeIcon name="more" size={16} />
                      </button>
                    )}
                  </div>
                  {isFolder && open && editing?.mode === "create" && editing.folder === node.path && renderEditor(depth + 1)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {menu && <Menu state={menu} onClose={closeMenu} />}
    </div>
  );
}
