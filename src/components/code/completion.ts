// Autocompletion for AssemblyScript engine code.
//
// One completion source merges, in priority order:
//   * names defined in this file (scope-aware, from @codemirror/lang-javascript),
//   * the engine API (ENGINE_API: template functions / constants / classes with signature and
//     doc in the info panel; picking one adds the import from its template module when the
//     file already imports from sibling modules),
//   * AssemblyScript types, builtins, keywords and snippets,
//   * other words of the document.
// After `pos.` (or any variable declared as a Position) it offers the Position members, after
// "@" the decorators, and inside `import { … } from "./module"` that module's exports.
import { insertCompletionText, pickedCompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { localCompletionSource } from "@codemirror/lang-javascript";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { ENGINE_API, memberOf, moduleName, moduleRank, scanSource } from "./api";
import { AS_BUILTINS, AS_DECORATORS, AS_KEYWORDS, AS_SNIPPETS, AS_TYPES } from "./assemblyscript";
import { docParts } from "./docParts";
import type { ApiEntry } from "./types";

const IDENT = /^[\w$]*$/;
/** Never complete inside these nodes (unless explicitly asked, and not even then for strings). */
const SILENT_NODES = new Set(["LineComment", "BlockComment", "String", "TemplateString", "RegExp", "Number", "Escape"]);
/** The user is naming something new here: suggestions would only get in the way. */
const DEFINITION_NODES = new Set(["VariableDefinition", "TypeDefinition", "PropertyDefinition", "Label"]);

// ------------------------------------------------------------------------- info panels

function signatureLine(entry: ApiEntry): string {
  const member = memberOf(entry);
  if (!member) return entry.signature;
  const isStatic = entry.signature.startsWith("static ");
  const sig = isStatic ? entry.signature.slice("static ".length) : entry.signature;
  return `${isStatic ? "static " : ""}${member.owner}.${sig}`;
}

function appendDoc(parent: HTMLElement, doc: string): void {
  for (const paragraph of doc.split("\n\n")) {
    const p = document.createElement("p");
    for (const part of docParts(paragraph)) {
      if (part.code) {
        const code = document.createElement("code");
        code.textContent = part.text;
        p.append(code);
      } else p.append(part.text);
    }
    parent.append(p);
  }
}

function infoPanel(signature: string, doc: string, footer: string | null): () => Node {
  return () => {
    const dom = document.createElement("div");
    dom.className = "cb-code-info";
    const sig = document.createElement("code");
    sig.className = "cb-code-info-sig";
    sig.textContent = signature;
    dom.append(sig);
    if (doc) appendDoc(dom, doc);
    else {
      const p = document.createElement("p");
      p.className = "cb-code-info-empty";
      p.textContent = "No description.";
      dom.append(p);
    }
    if (footer) {
      const f = document.createElement("div");
      f.className = "cb-code-info-footer";
      f.textContent = footer;
      dom.append(f);
    }
    return dom;
  };
}

// ------------------------------------------------------------------------ static lists

const API_TYPE: Record<ApiEntry["kind"], string> = {
  function: "function",
  method: "method",
  constant: "constant",
  variable: "variable",
  class: "class",
  type: "type",
};

/** Higher for the modules an evaluation author uses most. */
function moduleBoost(module: string): number {
  const rank = moduleRank(module);
  return rank === 0 ? 5 : rank <= 3 ? 4 : rank <= 5 ? 3 : 1;
}

let topLevelOptions: Completion[] | null = null;
const memberOptionsCache = new Map<string, Completion[]>();
let vocabularyOptions: Completion[] | null = null;
let decoratorOptions: Completion[] | null = null;

function apiOption(entry: ApiEntry): Completion {
  return {
    label: entry.name,
    type: API_TYPE[entry.kind],
    detail: entry.module,
    boost: moduleBoost(entry.module),
    info: infoPanel(signatureLine(entry), entry.doc, `${entry.module}.ts`),
    apply: applyWithImport(entry),
  };
}

function apiTopLevelOptions(): Completion[] {
  topLevelOptions ??= ENGINE_API.filter((e) => !memberOf(e)).map(apiOption);
  return topLevelOptions;
}

/** Members of a template class; `statics` picks `Class.x` members instead of instance ones. */
function apiMemberOptions(owner: string, statics: boolean): Completion[] {
  const key = `${owner}:${statics}`;
  let list = memberOptionsCache.get(key);
  if (!list) {
    list = [];
    for (const e of ENGINE_API) {
      const m = memberOf(e);
      if (!m || m.owner !== owner) continue;
      const isStatic = e.signature.startsWith("static ") || e.kind === "constant";
      if (isStatic !== statics) continue;
      const sig = e.signature.replace(/^static /, "");
      list.push({
        label: m.member,
        type: e.kind === "method" ? "method" : e.kind === "constant" ? "constant" : "property",
        // The part after the name: "(color: i32, type: i32): u64" / ": i32".
        detail: sig.startsWith(m.member) ? sig.slice(m.member.length) : sig,
        info: infoPanel(signatureLine(e), e.doc, `${e.module}.ts`),
      });
    }
    memberOptionsCache.set(key, list);
  }
  return list;
}

function asVocabularyOptions(): Completion[] {
  if (!vocabularyOptions) {
    vocabularyOptions = [
      ...AS_TYPES.map((t): Completion => ({ label: t.name, type: "type", detail: "type", info: t.info, boost: /^[a-z]/.test(t.name) ? 3 : 1 })),
      ...AS_BUILTINS.map((b): Completion => ({ label: b.name, type: "function", detail: "builtin", info: infoPanel(b.signature ?? b.name, b.info, "AssemblyScript builtin"), boost: 2 })),
      ...AS_KEYWORDS.map((k): Completion => ({ label: k, type: "keyword", boost: 2 })),
      ...AS_SNIPPETS.map((s) => snippetCompletion(s.template, { label: s.label, detail: s.detail, type: "snippet", info: s.info, boost: 1 })),
    ];
  }
  return vocabularyOptions;
}

function asDecoratorOptions(): Completion[] {
  decoratorOptions ??= AS_DECORATORS.map((d): Completion => ({ label: d.name, type: "decorator", detail: "decorator", info: d.info }));
  return decoratorOptions;
}

// ----------------------------------------------------------------- document analysis

export interface ImportInfo {
  /** Statement range. */
  from: number;
  to: number;
  specifier: string;
  /** Local names bound by the import. */
  names: string[];
  /** Offset just after the last name inside the braces (where ", x" goes), null without braces. */
  insertAt: number | null;
  typeOnly: boolean;
}

/** Top-level `import ... from "x"` statements (a light regex scan; good enough for imports). */
export function parseImports(text: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /(^|\n)([ \t]*)import\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m.index + m[1].length + m[2].length;
    const quote = /["']/.exec(text.slice(from, from + 2000));
    if (!quote) continue;
    const q = from + quote.index;
    const close = text.indexOf(quote[0], q + 1);
    if (close < 0) continue;
    let to = close + 1;
    while (to < text.length && (text[to] === " " || text[to] === "\t")) to++;
    if (text[to] === ";") to++;
    const clause = text.slice(from + "import".length, q);
    const typeOnly = /^\s*type\s/.test(clause);
    const names: string[] = [];
    let insertAt: number | null = null;
    const open = clause.indexOf("{");
    const shut = clause.indexOf("}");
    if (open >= 0 && shut > open) {
      const inner = clause.slice(open + 1, shut);
      for (const part of inner.split(",")) {
        const p = part.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").trim();
        if (!p) continue;
        const alias = /\bas\s+([\w$]+)$/.exec(p);
        names.push(alias ? alias[1] : p.replace(/^type\s+/, ""));
      }
      // After the last non-space, non-comma character before "}".
      const base = from + "import".length;
      let k = base + shut - 1;
      while (k > base + open && /[\s,]/.test(text[k])) k--;
      insertAt = k > base + open ? k + 1 : null;
    }
    const def = /^\s*([\w$]+)\s*(,|from\b)/.exec(clause.replace(/^\s*type\s+/, ""));
    if (def && def[1] !== "from") names.push(def[1]);
    const star = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (star) names.push(star[1]);
    out.push({ from, to, specifier: text.slice(q + 1, close), names, insertAt, typeOnly });
    re.lastIndex = to;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[$]/g, "\\$");

/** True if the file declares `name` at the top level itself (function, class, const, ...). */
export function declaresName(text: string, name: string): boolean {
  return new RegExp(`(^|\\n)[ \\t]*(export\\s+)?(declare\\s+)?(abstract\\s+)?(function|class|enum|type|interface|namespace|const|let|var)\\s+${escapeRe(name)}(?![\\w$])`).test(text);
}

/**
 * The change that imports `name` from template module `module`, or null when nothing should
 * be added: already imported or declared here, this file *is* that module, or the file has no
 * relative imports at all (then it is not a template-based engine file and we never guess).
 */
export function importChange(state: EditorState, name: string, module: string): { from: number; insert: string } | null {
  const text = state.doc.toString();
  const imports = parseImports(text);
  if (imports.some((i) => i.names.includes(name)) || declaresName(text, name)) return null;
  // Editing the module itself (it declares other symbols of the same module)?
  if (ENGINE_API.some((e) => e.module === module && !memberOf(e) && e.name !== name && declaresName(text, e.name))) return null;
  const relative = imports.filter((i) => /^\.\.?\//.test(i.specifier));
  if (relative.length === 0) return null;
  const target = relative.find((i) => !i.typeOnly && i.insertAt !== null && moduleName(i.specifier.replace(/^(\.\.\/)+/, "")) === module);
  if (target && target.insertAt !== null) return { from: target.insertAt, insert: `, ${name}` };
  // New statement after the last import, with the same directory prefix ("./" or "../").
  const prefix = /^((?:\.\.\/)+|\.\/)/.exec(relative[0].specifier)?.[1] ?? "./";
  const last = imports[imports.length - 1];
  return { from: last.to, insert: `\nimport { ${name} } from "${prefix}${module}";` };
}

/** Completion `apply` that inserts the name and, when needed, its import. */
function applyWithImport(entry: ApiEntry): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, completion, from, to) => {
    const insert = insertCompletionText(view.state, entry.name, from, to);
    const imp = importChange(view.state, entry.name, entry.module);
    view.dispatch(insert, { changes: imp ?? [], annotations: pickedCompletion.of(completion) });
  };
}

const classNames = (): string[] => ENGINE_API.filter((e) => e.kind === "class").map((e) => e.name);

const ownerCache = new WeakMap<Text, Map<string, string | null>>();

/** The template class a variable holds ("pos" -> "Position"), from its declarations in the file. */
export function variableClass(doc: Text, variable: string): string | null {
  let cache = ownerCache.get(doc);
  if (!cache) ownerCache.set(doc, (cache = new Map()));
  const hit = cache.get(variable);
  if (hit !== undefined) return hit;
  let result: string | null = null;
  const text = doc.toString();
  const v = escapeRe(variable);
  for (const cls of classNames()) {
    if (new RegExp(`(^|[^\\w$.])${v}\\s*\\??:\\s*${cls}\\b|(^|[^\\w$.])${v}\\s*=\\s*new\\s+${cls}\\b`).test(text)) {
      result = cls;
      break;
    }
  }
  // The template calls its position "pos" everywhere; offer the members even before it is declared.
  if (!result && variable === "pos" && classNames().includes("Position")) result = "Position";
  cache.set(variable, result);
  return result;
}

const wordsCache = new WeakMap<Text, string[]>();

/** Identifiers used in the code of the document (comments and strings left out). */
function documentWords(doc: Text): string[] {
  let words = wordsCache.get(doc);
  if (!words) {
    const set = new Set<string>();
    for (const m of scanSource(doc.toString()).masked.matchAll(/(?<![\w$])[A-Za-z_$][\w$]{2,}/g)) {
      set.add(m[0]);
      if (set.size >= 4000) break;
    }
    words = [...set];
    wordsCache.set(doc, words);
  }
  return words;
}

function insideNode(state: EditorState, pos: number, names: ReadonlySet<string>): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.has(node.name)) return node.name;
  }
  return null;
}

/** `import { pa| } from "./evalkit"` -> "evalkit". */
function importClauseModule(ctx: CompletionContext): string | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  // Look back a few lines for "import {" without its closing brace yet.
  const startLine = Math.max(1, line.number - 20);
  const before = ctx.state.sliceDoc(ctx.state.doc.line(startLine).from, ctx.pos);
  const at = before.lastIndexOf("import");
  if (at < 0 || !/^import\s*(type\s+)?\{[^}]*$/.test(before.slice(at))) return null;
  const after = ctx.state.sliceDoc(ctx.pos, Math.min(ctx.state.doc.length, ctx.pos + 2000));
  const spec = /^[^}]*\}\s*from\s*["']([^"']+)["']/.exec(after);
  return spec ? moduleName(spec[1].replace(/^(\.\.\/)+/, "")) : null;
}

// --------------------------------------------------------------------------- the source

export interface CompletionSourceOptions {
  /** Offer ENGINE_API symbols, Position members and auto-imports. */
  api: boolean;
}

/** The completion source used by the code editor. */
export function assemblyScriptCompletions(opts: CompletionSourceOptions): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (insideNode(ctx.state, ctx.pos, SILENT_NODES)) return null;

    const decorator = ctx.matchBefore(/@[\w$]*$/);
    if (decorator) return { from: decorator.from + 1, options: asDecoratorOptions(), validFor: IDENT };

    const member = ctx.matchBefore(/[A-Za-z_$][\w$]*\s*\.\s*[\w$]*$/);
    if (member) {
      if (!opts.api) return null;
      const [, object, partial] = /([A-Za-z_$][\w$]*)\s*\.\s*([\w$]*)$/.exec(member.text) ?? [];
      if (object === undefined || partial === undefined) return null;
      const isClass = classNames().includes(object);
      const owner = isClass ? object : variableClass(ctx.state.doc, object);
      if (!owner) return null;
      const options = apiMemberOptions(owner, isClass);
      return options.length ? { from: ctx.pos - partial.length, options, validFor: IDENT } : null;
    }

    const word = ctx.matchBefore(/[A-Za-z_$][\w$]*$/);
    if (!word && !ctx.explicit) return null;
    if (word && insideNode(ctx.state, ctx.pos, DEFINITION_NODES) && !importClauseModule(ctx)) return null;
    const from = word ? word.from : ctx.pos;

    if (opts.api) {
      const module = importClauseModule(ctx);
      if (module) {
        const options = ENGINE_API.filter((e) => e.module === module && !memberOf(e)).map((e) => ({ ...apiOption(e), apply: e.name }));
        return options.length ? { from, options, validFor: IDENT } : null;
      }
    }

    const typed = word?.text ?? "";
    const seen = new Set<string>();
    const options: Completion[] = [];
    const push = (c: Completion, key = c.label) => {
      if (seen.has(key)) return;
      seen.add(key);
      options.push(c);
    };

    // Names defined in this file. Imported names are left to the API entry (it has docs).
    const local = localCompletionSource(ctx);
    const text = ctx.state.doc.toString();
    const imported = new Set(parseImports(text).flatMap((i) => i.names));
    const apiNames = opts.api ? new Set(apiTopLevelOptions().map((o) => o.label)) : new Set<string>();
    if (local) {
      for (const o of local.options) {
        if (o.label === typed) continue;
        if (imported.has(o.label) && apiNames.has(o.label)) continue;
        push({ ...o, boost: 6 });
      }
    }
    if (opts.api) for (const o of apiTopLevelOptions()) push(o);
    for (const o of asVocabularyOptions()) push(o, o.type === "snippet" ? `snippet:${o.label}:${o.detail}` : o.label);
    for (const w of documentWords(ctx.state.doc)) {
      if (w !== typed) push({ label: w, type: "text", boost: -5 });
    }
    return { from, options, validFor: IDENT };
  };
}
