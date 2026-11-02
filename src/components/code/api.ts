// ENGINE_API: every public symbol of the engine template, parsed at runtime from the template
// sources (engine/template/*.ts via @/engine-host/templates), so the reference and the
// autocompletion always match the code users actually compile.
//
// The parser is deliberately small: it is not a TypeScript parser, it only understands the
// top-level shape of a module. It first masks comments and string contents (same length,
// newlines kept) so that bracket matching never trips over a "}" inside a string or comment,
// then walks top-level statements and picks up
//   export function / const / let / var / class / enum / type / interface / namespace
// with their leading /** doc comments */ (decorators such as @inline may sit in between) and,
// for exported classes, the public methods and fields. Headless: no DOM, no CodeMirror.
import { templateFiles } from "@/engine-host/templates";
import type { ApiEntry } from "./types";

/** A template module as listed in the API reference. */
export interface ApiModuleInfo {
  /** "evalkit" */
  module: string;
  /** "evalkit.ts" */
  file: string;
  /** From the file's header line, e.g. "building blocks for evaluation functions". */
  summary: string;
  /** Number of entries (class members included). */
  count: number;
}

/**
 * Display order of the modules: the ones an evaluation author needs first, then the rest of
 * the engine. Modules not listed here follow alphabetically.
 */
export const MODULE_ORDER: readonly string[] = [
  "evalkit",
  "position",
  "bitboard",
  "types",
  "trace",
  "nnue",
  "eval",
  "movegen",
  "search",
  "tt",
  "io",
  "main",
];

export function moduleRank(module: string): number {
  const i = MODULE_ORDER.indexOf(module);
  return i >= 0 ? i : MODULE_ORDER.length;
}

export function compareModules(a: string, b: string): number {
  return moduleRank(a) - moduleRank(b) || a.localeCompare(b);
}

/** "evalkit.ts" / "./evalkit" / "lib/x.ts" -> "evalkit" / "evalkit" / "lib/x". */
export function moduleName(fileOrModule: string): string {
  return fileOrModule.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\.ts$/, "");
}

// ------------------------------------------------------------------------------- scanning

interface SourceComment {
  start: number;
  end: number;
  /** A /** doc comment *\/. */
  doc: boolean;
}

interface Scanned {
  src: string;
  /** `src` with comments and string contents replaced by spaces (newlines kept). */
  masked: string;
  /** Sorted by start. */
  comments: SourceComment[];
}

const SPACE = 32;
const NEWLINE = 10;

/** Masks comments and the contents of string / template literals. */
export function scanSource(src: string): Scanned {
  const n = src.length;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = src.charCodeAt(i);
  const comments: SourceComment[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== NEWLINE) out[k] = SPACE;
  };

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    const next = i + 1 < n ? src.charCodeAt(i + 1) : 0;
    if (c === 47 /* / */ && next === 47) {
      let end = src.indexOf("\n", i);
      if (end < 0) end = n;
      comments.push({ start: i, end, doc: false });
      blank(i, end);
      i = end;
    } else if (c === 47 && next === 42 /* * */) {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      // "/**/" is an empty block comment, not a doc comment.
      const doc = src.charCodeAt(i + 2) === 42 && src.charCodeAt(i + 3) !== 47;
      comments.push({ start: i, end, doc });
      blank(i, end);
      i = end;
    } else if (c === 34 /* " */ || c === 39 /* ' */) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92 /* \ */) j += 2;
        else if (d === c || d === NEWLINE) break;
        else j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
    } else if (c === 96 /* ` */) {
      let j = i + 1;
      let depth = 0; // inside ${ ... }
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92) {
          j += 2;
          continue;
        }
        if (depth === 0 && d === 96) break;
        if (d === 36 /* $ */ && src.charCodeAt(j + 1) === 123 /* { */) {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && d === 123) depth++;
        else if (depth > 0 && d === 125 /* } */) depth--;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
    } else {
      i++;
    }
  }

  // Build the masked string in chunks (String.fromCharCode has an argument limit).
  let masked = "";
  for (let k = 0; k < n; k += 8192) masked += String.fromCharCode(...out.subarray(k, Math.min(n, k + 8192)));
  return { src, masked, comments };
}

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdentChar = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);
const isSpaceChar = (c: number) => c === SPACE || c === NEWLINE || c === 9 || c === 13 || c === 12;

function skipSpaces(s: string, i: number, end = s.length): number {
  while (i < end && isSpaceChar(s.charCodeAt(i))) i++;
  return i;
}

function readIdent(s: string, i: number): string {
  if (!isIdentStart(s.charCodeAt(i))) return "";
  let j = i + 1;
  while (j < s.length && isIdentChar(s.charCodeAt(j))) j++;
  return s.slice(i, j);
}

/** True if the word `w` starts at i and is not part of a longer identifier. */
function wordAt(s: string, i: number, w: string): boolean {
  return s.startsWith(w, i) && !isIdentChar(s.charCodeAt(i + w.length)) && (i === 0 || !isIdentChar(s.charCodeAt(i - 1)));
}

const OPEN = "([{";
const CLOSE = ")]}";

/** Index just after the bracket matching the one at `i` ( "(" "[" or "{" ). */
function matchBracket(s: string, i: number, end = s.length): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const ch = s[j];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return end;
}

/** Index just after the ">" matching the "<" at `i` (type parameter / argument lists). */
function matchAngle(s: string, i: number, end = s.length): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const ch = s[j];
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === ";" || ch === "{" || ch === "}") return j; // not a generic list after all
  }
  return end;
}

/** Could a new statement / member start at `i`? (Used when a semicolon is missing.) */
function looksLikeStatementStart(s: string, i: number): boolean {
  if (i >= s.length) return true;
  const ch = s[i];
  if (ch === "@" || ch === "}") return true;
  for (const w of ["export", "import", "const", "let", "var", "function", "class", "enum", "type", "interface", "namespace", "declare", "abstract", "public", "private", "protected", "static", "readonly"]) {
    if (wordAt(s, i, w)) return true;
  }
  return false;
}

/**
 * End of the statement starting at `i`: the index of the terminating ";" (exclusive end of the
 * statement text), or the newline after which a new statement starts, or the "}" closing the
 * enclosing block. Brackets are balanced; nothing inside them ends the statement.
 */
function statementEnd(s: string, i: number, end = s.length): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const ch = s[j];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) {
      if (depth === 0) return j; // closing brace of the enclosing block
      depth--;
    } else if (depth === 0) {
      if (ch === ";") return j;
      if (ch === "\n") {
        const k = skipSpaces(s, j, end);
        const prev = s.slice(i, j).trimEnd();
        // A line that ends an expression, followed by something that starts a statement.
        if (prev.length > 0 && !/[=,:|&+\-*/%<>?(\[{.!~^]$/.test(prev) && looksLikeStatementStart(s, k)) return j;
      }
    }
  }
  return end;
}

/** Index after a statement we do not care about (non-exported declarations, imports, ...). */
function skipStatement(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) {
      depth--;
      if (depth < 0) return j + 1; // stray "}" — step over it
      // A block statement ends with its closing brace when nothing follows on that line.
      if (depth === 0 && ch === "}") {
        let k = j + 1;
        while (k < s.length && (s[k] === " " || s[k] === "\t" || s[k] === "\r")) k++;
        if (k >= s.length || s[k] === "\n") return j + 1;
      }
    } else if (depth === 0 && ch === ";") return j + 1;
  }
  return s.length;
}

/** Index after a decorator at `i` ("@inline", "@external("env", "x")", "@operator.binary(...)"). */
function skipDecorator(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length && (isIdentChar(s.charCodeAt(j)) || s[j] === ".")) j++;
  const k = skipSpaces(s, j);
  if (s[k] === "(") return matchBracket(s, k);
  return j;
}

// ------------------------------------------------------------------------- text helpers

/** Source text of [start, end) with comments removed and whitespace collapsed. */
function cleanText(sc: Scanned, start: number, end: number): string {
  let text = "";
  let pos = start;
  for (const c of sc.comments) {
    if (c.end <= start || c.start >= end) continue;
    if (c.start > pos) text += sc.src.slice(pos, c.start);
    text += " ";
    pos = Math.max(pos, c.end);
  }
  if (pos < end) text += sc.src.slice(pos, end);
  // (Angle brackets are left alone: "a < b" and "x << 2" must keep their spaces.)
  return text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]},])/g, "$1")
    .replace(/,\)/g, ")")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

/** Plain text of a /** doc comment *\/: paragraphs kept, lines of a paragraph joined. */
function docText(raw: string): string {
  const body = raw.replace(/^\/\*\*+/, "").replace(/\*+\/$/, "");
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const line of body.split("\n")) {
    const text = line.replace(/^\s*\*?[ \t]?/, "").trim();
    if (text === "") flush();
    else {
      if (text.startsWith("@")) flush(); // @param, @returns, ... each start a paragraph
      current.push(text);
    }
  }
  flush();
  return paragraphs.join("\n\n");
}

/** Index of the first comment starting at or after `pos` (comments are sorted and disjoint). */
function firstCommentFrom(comments: readonly SourceComment[], pos: number): number {
  let lo = 0;
  let hi = comments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comments[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The doc comment attached to a declaration starting at `at` (its first decorator, if any):
 * the last /** comment *\/ before it with nothing but whitespace (and other comments) between.
 */
function leadingDoc(sc: Scanned, at: number): string {
  for (let i = firstCommentFrom(sc.comments, at) - 1; i >= 0; i--) {
    const c = sc.comments[i];
    if (c.end > at) continue;
    if (!c.doc) {
      // A line comment between the doc comment and the declaration is fine; code is not.
      if (sc.masked.slice(c.end, at).trim() !== "") return "";
      continue;
    }
    if (sc.masked.slice(c.end, at).trim() !== "") return "";
    return docText(sc.src.slice(c.start, c.end));
  }
  return "";
}

/** A `// comment` on the same line right after position `at` (fallback documentation). */
function trailingComment(sc: Scanned, at: number): string {
  let lineEnd = sc.src.indexOf("\n", at);
  if (lineEnd < 0) lineEnd = sc.src.length;
  const c = sc.comments[firstCommentFrom(sc.comments, at)];
  if (!c || c.doc || c.start >= lineEnd || sc.masked.slice(at, c.start).replace(/[;,]/g, "").trim() !== "") return "";
  return sc.src.slice(c.start + 2, c.end).trim();
}

// -------------------------------------------------------------------------------- parsing

const MEMBER_MODIFIERS = new Set(["public", "private", "protected", "static", "readonly", "abstract", "declare", "override"]);

class ModuleParser {
  readonly entries: ApiEntry[] = [];
  private readonly s: string;

  constructor(private readonly sc: Scanned, private readonly module: string) {
    this.s = sc.masked;
  }

  private add(name: string, kind: ApiEntry["kind"], signature: string, doc: string): void {
    this.entries.push({ name, module: this.module, signature, doc, kind });
  }

  parse(): ApiEntry[] {
    const s = this.s;
    let i = 0;
    let decoratorStart = -1;
    while (i < s.length) {
      i = skipSpaces(s, i);
      if (i >= s.length) break;
      if (s[i] === "@") {
        if (decoratorStart < 0) decoratorStart = i;
        i = skipDecorator(s, i);
        continue;
      }
      if (wordAt(s, i, "export")) {
        const attach = decoratorStart >= 0 ? decoratorStart : i;
        decoratorStart = -1;
        i = this.parseExport(i + "export".length, attach);
        continue;
      }
      decoratorStart = -1;
      i = skipStatement(s, i);
    }
    return this.entries;
  }

  /** `i` is just after "export"; returns the index after the statement. */
  private parseExport(i: number, attach: number): number {
    const s = this.s;
    let j = skipSpaces(s, i);
    for (;;) {
      if (wordAt(s, j, "default")) return skipStatement(s, j);
      if (wordAt(s, j, "declare") || wordAt(s, j, "abstract")) j = skipSpaces(s, j + readIdent(s, j).length);
      else break;
    }
    const keyword = readIdent(s, j);
    const after = j + keyword.length;
    const doc = () => leadingDoc(this.sc, attach);
    switch (keyword) {
      case "function":
        return this.parseFunction(after, doc);
      case "const":
      case "let":
      case "var":
        return this.parseVariables(after, keyword === "const" ? "constant" : "variable", doc);
      case "class":
        return this.parseClass(j, after, doc);
      case "enum":
        return this.parseEnum(j, after, doc);
      case "interface":
      case "namespace": {
        const brace = s.indexOf("{", after);
        if (brace < 0) return s.length;
        const name = readIdent(s, skipSpaces(s, after));
        if (name) this.add(name, "type", cleanText(this.sc, j, brace), doc());
        return matchBracket(s, brace);
      }
      case "type": {
        const end = statementEnd(s, after);
        const name = readIdent(s, skipSpaces(s, after));
        if (name) this.add(name, "type", truncate(cleanText(this.sc, j, end), 120), doc());
        return end + 1;
      }
      default:
        // export { a, b }; export * from "./x"; ... (re-exports are not declarations)
        return skipStatement(s, j);
    }
  }

  private parseFunction(i: number, doc: () => string): number {
    const s = this.s;
    let j = skipSpaces(s, i);
    if (s[j] === "*") j = skipSpaces(s, j + 1);
    const name = readIdent(s, j);
    if (!name) return skipStatement(s, j);
    const nameStart = j;
    let k = skipSpaces(s, j + name.length);
    if (s[k] === "<") k = skipSpaces(s, matchAngle(s, k));
    if (s[k] !== "(") return skipStatement(s, k);
    k = matchBracket(s, k);
    // Return type: up to the body "{" (or ";" for declarations without a body).
    let depth = 0;
    let m = k;
    for (; m < s.length; m++) {
      const ch = s[m];
      if (ch === "(" || ch === "[" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === ">") depth--;
      else if (depth <= 0 && (ch === "{" || ch === ";")) break;
    }
    this.add(name, "function", cleanText(this.sc, nameStart, m), doc());
    return s[m] === "{" ? matchBracket(s, m) : m + 1;
  }

  /** Index ranges of the declarators of `const a: T = 1, b = 2` (between i and end). */
  private declarators(i: number, end: number): Array<[number, number]> {
    const s = this.s;
    const out: Array<[number, number]> = [];
    let start = i;
    let depth = 0;
    for (let j = i; j < end; j++) {
      const ch = s[j];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth--;
      else if (ch === "," && depth === 0) {
        // Only a new declarator if "name :" / "name =" / "name ," / "name<end>" follows
        // (a comma inside "Map<i32, u64>" is followed by a type, then ">").
        const k = skipSpaces(s, j + 1, end);
        const id = readIdent(s, k);
        const after = skipSpaces(s, k + id.length, end);
        if (id && (after >= end || s[after] === ":" || s[after] === "=" || s[after] === ",")) {
          out.push([start, j]);
          start = j + 1;
        }
      }
    }
    out.push([start, end]);
    return out;
  }

  private parseVariables(i: number, kind: "constant" | "variable", doc: () => string): number {
    const s = this.s;
    const end = statementEnd(s, i);
    const parts = this.declarators(i, end);
    const docText = doc() || (parts.length === 1 ? trailingComment(this.sc, end) : "");
    for (const [a, b] of parts) {
      const start = skipSpaces(s, a, b);
      const name = readIdent(s, start);
      if (!name) continue;
      // ":" type annotation and "=" initializer at depth 0.
      let colon = -1;
      let eq = -1;
      let depth = 0;
      for (let j = start + name.length; j < b; j++) {
        const ch = s[j];
        if (OPEN.includes(ch) || ch === "<") depth++;
        else if (CLOSE.includes(ch) || (ch === ">" && s[j - 1] !== "=")) depth--;
        else if (depth <= 0 && ch === ":" && colon < 0 && eq < 0) colon = j;
        else if (depth <= 0 && ch === "=" && s[j + 1] !== "=" && s[j + 1] !== ">" && eq < 0) {
          eq = j;
          break;
        }
      }
      const type = colon >= 0 ? cleanText(this.sc, colon + 1, eq >= 0 ? eq : b) : "";
      const init = eq >= 0 ? cleanText(this.sc, eq + 1, b) : "";
      let signature: string;
      if (kind === "constant") signature = type ? (init ? `${name}: ${type} = ${init}` : `${name}: ${type}`) : `${name} = ${init}`;
      else signature = type ? `${name}: ${type}` : init ? `${name} = ${init}` : name;
      this.add(name, kind, truncate(signature, 100), docText);
    }
    return end + 1;
  }

  /** `kw` = index of "class", `i` = just after it. */
  private parseClass(kw: number, i: number, doc: () => string): number {
    const s = this.s;
    const nameStart = skipSpaces(s, i);
    const name = readIdent(s, nameStart);
    // Header up to the body brace (generic parameters may contain anything but braces).
    let brace = nameStart + name.length;
    while (brace < s.length && s[brace] !== "{") {
      if (s[brace] === "<") brace = matchAngle(s, brace);
      else brace++;
    }
    if (brace >= s.length) return s.length;
    const bodyEnd = matchBracket(s, brace);
    if (!name) return bodyEnd;
    this.add(name, "class", cleanText(this.sc, kw, brace), doc());
    this.parseClassBody(name, brace + 1, bodyEnd - 1);
    return bodyEnd;
  }

  private parseClassBody(cls: string, start: number, end: number): void {
    const s = this.s;
    let i = start;
    let decoratorStart = -1;
    while (i < end) {
      i = skipSpaces(s, i, end);
      if (i >= end) break;
      const ch = s[i];
      if (ch === ";" || ch === ",") {
        i++;
        continue;
      }
      if (ch === "@") {
        if (decoratorStart < 0) decoratorStart = i;
        i = skipDecorator(s, i);
        continue;
      }
      const memberStart = decoratorStart >= 0 ? decoratorStart : i;
      decoratorStart = -1;

      // Modifiers (a word followed by another word; "static(" would be a method named static).
      const mods = new Set<string>();
      for (;;) {
        const w = readIdent(s, i);
        if (!MEMBER_MODIFIERS.has(w)) break;
        const k = skipSpaces(s, i + w.length, end);
        if (!isIdentStart(s.charCodeAt(k)) && s[k] !== "[" && s[k] !== "#") break;
        mods.add(w);
        i = k;
      }
      let accessor: "get" | "set" | null = null;
      for (const a of ["get", "set"] as const) {
        if (wordAt(s, i, a)) {
          const k = skipSpaces(s, i + a.length, end);
          if (isIdentStart(s.charCodeAt(k))) {
            accessor = a;
            i = k;
          }
        }
      }

      const nameStart = i;
      const name = readIdent(s, i);
      if (!name) {
        // Index signature, computed or #private name: skip the member.
        i = s[i] === "[" ? statementEnd(s, matchBracket(s, i, end), end) + 1 : statementEnd(s, i + 1, end) + 1;
        continue;
      }
      let k = skipSpaces(s, i + name.length, end);
      if (s[k] === "?" || s[k] === "!") k = skipSpaces(s, k + 1, end);
      const hidden = mods.has("private") || mods.has("protected");
      const qualified = `${cls}.${name}`;
      const isStatic = mods.has("static");

      if (s[k] === "(" || s[k] === "<") {
        // Method (or accessor / constructor).
        if (s[k] === "<") k = skipSpaces(s, matchAngle(s, k, end), end);
        const paramsEnd = s[k] === "(" ? matchBracket(s, k, end) : k;
        let m = paramsEnd;
        let depth = 0;
        for (; m < end; m++) {
          const c = s[m];
          if (c === "(" || c === "[" || c === "<") depth++;
          else if (c === ")" || c === "]" || c === ">") depth--;
          else if (depth <= 0 && (c === "{" || c === ";" || c === "\n")) {
            if (c !== "\n" || looksLikeStatementStart(s, skipSpaces(s, m, end))) break;
          }
        }
        const memberEnd = s[m] === "{" ? matchBracket(s, m, end) : m + 1;
        if (!hidden && name !== "constructor") {
          const sig = cleanText(this.sc, nameStart, m);
          const docText = leadingDoc(this.sc, memberStart);
          if (accessor === "get") {
            const ret = /\)\s*:\s*(.+)$/.exec(sig);
            this.add(qualified, "variable", `${isStatic ? "static " : ""}${name}${ret ? `: ${ret[1]}` : ""}`, docText);
          } else if (accessor === "set") {
            if (!this.entries.some((e) => e.name === qualified)) {
              const param = /\(\s*[\w$]+\s*:\s*([^)]+)\)/.exec(sig);
              this.add(qualified, "variable", `${isStatic ? "static " : ""}${name}${param ? `: ${param[1]}` : ""}`, docText);
            }
          } else {
            this.add(qualified, "method", `${isStatic ? "static " : ""}${sig}`, docText);
          }
        }
        i = memberEnd;
        continue;
      }

      // Field: "name: Type = init;" / "name = init;" / "name: Type;".
      const fieldEnd = statementEnd(s, k, end);
      if (!hidden) {
        let colon = -1;
        let eq = -1;
        let depth = 0;
        for (let j = k; j < fieldEnd; j++) {
          const c = s[j];
          if (OPEN.includes(c) || c === "<") depth++;
          else if (CLOSE.includes(c) || (c === ">" && s[j - 1] !== "=")) depth--;
          else if (depth <= 0 && c === ":" && colon < 0 && eq < 0) colon = j;
          else if (depth <= 0 && c === "=" && eq < 0) {
            eq = j;
            break;
          }
        }
        const type = colon >= 0 ? cleanText(this.sc, colon + 1, eq >= 0 ? eq : fieldEnd) : "";
        const init = eq >= 0 ? cleanText(this.sc, eq + 1, fieldEnd) : "";
        const prefix = `${isStatic ? "static " : ""}${mods.has("readonly") ? "readonly " : ""}`;
        const sig = type ? `${prefix}${name}: ${type}` : init ? `${prefix}${name} = ${truncate(init, 60)}` : `${prefix}${name}`;
        const docText = leadingDoc(this.sc, memberStart) || trailingComment(this.sc, fieldEnd);
        this.add(qualified, "variable", sig, docText);
      }
      i = fieldEnd + 1;
    }
  }

  /** `kw` = index of "enum", `i` = just after it. Members become constants "Name.MEMBER". */
  private parseEnum(kw: number, i: number, doc: () => string): number {
    const s = this.s;
    const name = readIdent(s, skipSpaces(s, i));
    const brace = s.indexOf("{", i);
    if (brace < 0) return s.length;
    const bodyEnd = matchBracket(s, brace);
    if (!name) return bodyEnd;
    this.add(name, "type", cleanText(this.sc, kw, brace), doc());
    let start = brace + 1;
    const close = bodyEnd - 1;
    let depth = 0;
    const flush = (a: number, b: number) => {
      const at = skipSpaces(s, a, b);
      const member = readIdent(s, at);
      if (!member) return;
      this.add(`${name}.${member}`, "constant", cleanText(this.sc, at, b).replace(/^/, `${name}.`), leadingDoc(this.sc, at) || trailingComment(this.sc, b));
    };
    for (let j = start; j < close; j++) {
      const ch = s[j];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth--;
      else if (ch === "," && depth === 0) {
        flush(start, j);
        start = j + 1;
      }
    }
    flush(start, close);
    return bodyEnd;
  }
}

/** Public symbols of one module's source, in source order. */
export function parseModuleApi(source: string, module: string): ApiEntry[] {
  return new ModuleParser(scanSource(source), module).parse();
}

/** "evalkit.ts — building blocks for evaluation functions" -> "building blocks for ...". */
export function moduleSummary(source: string): string {
  const head = source.split("\n", 8);
  for (const line of head) {
    const m = /^\/\/\s*[\w./-]+\.ts\s+[—–-]+\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return "";
}

/** Parses a set of template files into entries (grouped by module order) and module infos. */
export function buildEngineApi(files: Readonly<Record<string, string>>): { entries: ApiEntry[]; modules: ApiModuleInfo[] } {
  const modules: ApiModuleInfo[] = [];
  const byModule = new Map<string, ApiEntry[]>();
  for (const [file, source] of Object.entries(files)) {
    if (!file.endsWith(".ts")) continue;
    const module = moduleName(file);
    const list = parseModuleApi(source, module);
    byModule.set(module, list);
    modules.push({ module, file, summary: moduleSummary(source), count: list.length });
  }
  modules.sort((a, b) => compareModules(a.module, b.module));
  const entries = modules.flatMap((m) => byModule.get(m.module) ?? []);
  return { entries, modules };
}

/** Splits "Position.pieces" into owner and member; null for top-level symbols. */
export function memberOf(entry: Pick<ApiEntry, "name" | "kind">): { owner: string; member: string } | null {
  if (entry.kind !== "method" && entry.kind !== "variable" && entry.kind !== "constant") return null;
  const dot = entry.name.indexOf(".");
  return dot > 0 ? { owner: entry.name.slice(0, dot), member: entry.name.slice(dot + 1) } : null;
}

/** Variable name used in snippets for instances of a class ("Position" -> "pos"). */
export function instanceName(cls: string): string {
  return cls === "Position" ? "pos" : cls.charAt(0).toLowerCase() + cls.slice(1);
}

/** A simple call / reference snippet for an entry: "popcount()", "pos.phase()", "PAWN". */
export function apiSnippet(entry: ApiEntry): string {
  const member = memberOf(entry);
  if (member) {
    const isStatic = entry.signature.startsWith("static ");
    const target = isStatic || entry.kind === "constant" ? member.owner : instanceName(member.owner);
    return `${target}.${member.member}${entry.kind === "method" ? "()" : ""}`;
  }
  return entry.kind === "function" ? `${entry.name}()` : entry.name;
}

function freezeAll(list: ApiEntry[]): readonly ApiEntry[] {
  for (const e of list) Object.freeze(e);
  return Object.freeze(list);
}

const built = buildEngineApi(templateFiles);

/** Every public symbol of engine/template (docs/ENGINE_TEMPLATE.md), grouped by MODULE_ORDER. */
export const ENGINE_API: readonly ApiEntry[] = freezeAll(built.entries);

/** The template modules in display order, with their header summaries and entry counts. */
export const ENGINE_API_MODULES: readonly ApiModuleInfo[] = Object.freeze(built.modules.map((m) => Object.freeze(m)));
