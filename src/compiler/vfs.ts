// In-memory file system handed to the AssemblyScript compiler.

/**
 * Normalizes a virtual path: forward slashes, no "./" segments, no leading "/", ".." resolved.
 * `"./eval.ts"`, `"/eval.ts"` and `"eval.ts"` all become `"eval.ts"`.
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** Resolves `name` against `baseDir` the way asc does (absolute names ignore the base). */
export function resolvePath(name: string, baseDir: string): string {
  if (name.startsWith("/") || !baseDir || baseDir === ".") return normalizePath(name);
  return normalizePath(`${baseDir}/${name}`);
}

/** Returns a copy of `files` with normalized keys (later duplicates win). */
export function normalizeFileMap(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) {
    const key = normalizePath(name);
    if (key) out[key] = text;
  }
  return out;
}

export class VirtualFs {
  private readonly files = new Map<string, string>();
  /** Files written by the compiler (normalized path → contents). */
  readonly outputs = new Map<string, Uint8Array | string>();

  constructor(files: Record<string, string>) {
    for (const [name, text] of Object.entries(normalizeFileMap(files))) this.files.set(name, text);
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** Source text of a file by (normalized) path, or null. */
  get(path: string): string | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  /** asc `readFile`: names arrive relative to `baseDir` (normally "."). Null means "not found". */
  readFile(name: string, baseDir: string): string | null {
    return this.files.get(resolvePath(name, baseDir)) ?? null;
  }

  writeFile(name: string, contents: Uint8Array | string, baseDir: string): void {
    this.outputs.set(resolvePath(name, baseDir), contents);
  }

  /** asc `listFiles`: direct children of a directory that are `.ts` but not `.d.ts` files. */
  listFiles(dirname: string, baseDir: string): string[] {
    const dir = resolvePath(dirname, baseDir);
    const prefix = dir ? `${dir}/` : "";
    const out: string[] = [];
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/") || !rest.endsWith(".ts") || rest.endsWith(".d.ts")) continue;
      out.push(rest);
    }
    return out;
  }
}
