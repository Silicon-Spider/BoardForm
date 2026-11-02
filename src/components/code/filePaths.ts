// File names of an engine's source tree: validation for new / renamed files and the folder
// tree shown by <FileTree>. Headless.

/** Longest accepted path, folders included. */
export const MAX_PATH_LENGTH = 120;

/** Trims, turns "\" into "/", and drops leading "./" and "/" (what users type by habit). */
export function normalizeFilePath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

/**
 * Checks a (normalised) path for a new or renamed source file. Returns a short message for the
 * user, or null when the path is fine. Rules: ends with ".ts"; letters, digits, "-", "_" and "."
 * only, "/" separating folders; no empty, "." or ".." segments; nothing starting with a dot; no
 * clash with an existing file or folder (case-insensitive). `current` is the file being renamed.
 */
export function validateFilePath(path: string, existing: readonly string[], opts: { current?: string } = {}): string | null {
  if (path === "") return "Enter a file name, e.g. helpers.ts.";
  if (path.length > MAX_PATH_LENGTH) return `That name is too long (at most ${MAX_PATH_LENGTH} characters).`;
  if (/\s/.test(path)) return "File names can't contain spaces. Use - or _ instead.";
  if (!/^[A-Za-z0-9_\-./]+$/.test(path)) return "Use only letters, digits, - and _ (and / for folders).";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "Folder names can't be empty (check for // or a trailing /).";
  if (segments.some((s) => s === "." || s === "..")) return '"." and ".." are not allowed in paths.';
  if (segments.some((s) => s.startsWith("."))) return "Names can't start with a dot.";
  if (segments.some((s) => s.includes(".."))) return "Use a single dot before the extension.";
  const base = segments[segments.length - 1];
  if (!base.endsWith(".ts")) return "Source files must end with .ts (AssemblyScript).";
  if (base.endsWith(".d.ts")) return "Declaration files (.d.ts) are not supported.";
  if (segments.slice(0, -1).some((s) => s.endsWith(".ts"))) return "Folder names can't end with .ts.";

  const key = path.toLowerCase();
  const current = opts.current?.toLowerCase();
  for (const file of existing) {
    const other = file.toLowerCase();
    if (other === current) continue;
    if (other === key) return `There is already a file called ${file}.`;
    // "lib.ts" vs "lib.ts/x.ts" and the other way round.
    if (other.startsWith(key + "/")) return `${path} is already a folder.`;
    if (key.startsWith(other + "/")) return `${file} is a file, not a folder.`;
  }
  return null;
}

/** Natural, case-insensitive order: "file2.ts" before "file10.ts". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface FileTreeFolder {
  kind: "folder";
  name: string;
  /** Folder path without trailing slash, e.g. "lib/util". */
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  kind: "file";
  name: string;
  path: string;
}

export type FileTreeNode = FileTreeFolder | FileTreeFile;

/** Builds the folder tree: folders first, then files, each sorted naturally. */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeFolder = { kind: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, FileTreeFolder>([["", root]]);
  const folderFor = (path: string): FileTreeFolder => {
    let f = folders.get(path);
    if (!f) {
      const slash = path.lastIndexOf("/");
      const parent = folderFor(slash < 0 ? "" : path.slice(0, slash));
      f = { kind: "folder", name: path.slice(slash + 1), path, children: [] };
      parent.children.push(f);
      folders.set(path, f);
    }
    return f;
  };
  for (const p of [...new Set(paths)]) {
    const slash = p.lastIndexOf("/");
    folderFor(slash < 0 ? "" : p.slice(0, slash)).children.push({ kind: "file", name: p.slice(slash + 1), path: p });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "folder" ? -1 : 1));
    for (const n of nodes) if (n.kind === "folder") sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** Folder paths containing `path`, outermost first: "a/b/c.ts" -> ["a", "a/b"]. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
