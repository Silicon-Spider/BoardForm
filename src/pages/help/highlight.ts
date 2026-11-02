// A small syntax highlighter for the code blocks in the help topics (no dependencies).
//
// It is a single-pass tokenizer for C-family syntax: comments, strings, numbers, decorators /
// attributes, identifiers and everything else. Identifiers are classified per language (keyword,
// type, constant, function call). The output is HTML with <span class="hl-…"> wrappers; the text
// itself is always escaped, so the result is safe to insert with innerHTML.

export type HighlightLanguage = "ts" | "c" | "rust" | "zig" | "json" | "shell" | "plain";

/** Fence info strings → highlighter language. Unknown names are shown as plain text. */
const ALIASES: Record<string, HighlightLanguage> = {
  ts: "ts",
  typescript: "ts",
  as: "ts",
  assemblyscript: "ts",
  js: "ts",
  javascript: "ts",
  c: "c",
  h: "c",
  cpp: "c",
  "c++": "c",
  rust: "rust",
  rs: "rust",
  zig: "zig",
  json: "json",
  sh: "shell",
  bash: "shell",
  shell: "shell",
  console: "shell",
};

/** Human-readable language names for the code block header ("" = no label). */
const LABELS: Record<string, string> = {
  ts: "AssemblyScript",
  as: "AssemblyScript",
  assemblyscript: "AssemblyScript",
  typescript: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  c: "C",
  h: "C",
  cpp: "C++",
  "c++": "C++",
  rust: "Rust",
  rs: "Rust",
  zig: "Zig",
  json: "JSON",
  sh: "Shell",
  bash: "Shell",
  shell: "Shell",
  console: "Shell",
};

export function resolveLanguage(name: string): HighlightLanguage {
  return ALIASES[name.toLowerCase()] ?? "plain";
}

export function languageLabel(name: string): string {
  return LABELS[name.toLowerCase()] ?? "";
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const TS_KEYWORDS = words(`
  abstract as async await break case catch class const continue declare default delete do else enum export
  extends false finally for from function if implements import in instanceof interface let namespace new
  null of private protected public readonly return static super switch this throw true try type typeof
  undefined var void while yield`);
const TS_TYPES = words(`
  i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 isize usize bool v128 string number boolean void never unknown
  object StaticArray Array Map Set String Math`);
const C_KEYWORDS = words(`
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  true false NULL __attribute__`);
const C_TYPES = words(`int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t size_t bool`);
const RUST_KEYWORDS = words(`
  as break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub
  ref return self Self static struct super trait true type unsafe use where while`);
const RUST_TYPES = words(`i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Some None`);
const ZIG_KEYWORDS = words(`
  and break catch comptime const continue defer else enum errdefer export extern false fn for if inline null
  or orelse packed pub return struct switch test true try undefined union unreachable usingnamespace var while`);
const ZIG_TYPES = words(`i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize bool void anyopaque`);
const JSON_KEYWORDS = words(`true false null`);

interface LanguageSpec {
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
  /** `@name` (TS decorators, Zig builtins). */
  atNames: boolean;
  /** `#…` to the end of the line is a preprocessor line / attribute (C, Rust) or a comment (shell). */
  hash: "none" | "meta" | "comment";
  /** Function names are coloured where an identifier is followed by "(". */
  calls: boolean;
}

const SPECS: Record<Exclude<HighlightLanguage, "plain">, LanguageSpec> = {
  ts: { keywords: TS_KEYWORDS, types: TS_TYPES, atNames: true, hash: "none", calls: true },
  c: { keywords: C_KEYWORDS, types: C_TYPES, atNames: false, hash: "meta", calls: true },
  rust: { keywords: RUST_KEYWORDS, types: RUST_TYPES, atNames: false, hash: "meta", calls: true },
  zig: { keywords: ZIG_KEYWORDS, types: ZIG_TYPES, atNames: true, hash: "none", calls: true },
  json: { keywords: JSON_KEYWORDS, types: new Set(), atNames: false, hash: "none", calls: false },
  shell: { keywords: new Set(), types: new Set(), atNames: false, hash: "comment", calls: false },
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

const span = (cls: string, text: string): string => `<span class="hl-${cls}">${escapeHtml(text)}</span>`;

// Token patterns, tried in order at the current position (sticky regular expressions).
const LINE_COMMENT = /\/\/[^\n]*/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const STRING = /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/y;
const AT_NAME = /@[A-Za-z_]\w*/y;
const HASH_LINE = /#[^\n]*/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
/** After an identifier: optional generic arguments, then "(" → a call. */
const CALL_AFTER = /\s*(?:<[\w\s,<>[\]]*>)?\s*\(/y;

function matchAt(re: RegExp, text: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(text);
  return m && m[0].length > 0 ? m[0] : null;
}

function classifyIdent(word: string, spec: LanguageSpec, text: string, end: number, previous: string): string | null {
  if (spec.keywords.has(word)) return "keyword";
  if (spec.types.has(word)) return "type";
  // Property access such as `pos.pieces(...)`: a method call, never a keyword or constant.
  if (spec.calls && matchAt(CALL_AFTER, text, end) !== null) return "fn";
  if (/^[A-Z][A-Z0-9_]+$/.test(word) || /^[A-Z]\d$/.test(word)) return "const";
  if (/^[A-Z]/.test(word) && previous !== ".") return "type";
  return null;
}

/** Highlights `code` for `language` (a fence info word such as "ts"). Returns HTML. */
export function highlight(code: string, language: string): string {
  const lang = resolveLanguage(language);
  if (lang === "plain") return escapeHtml(code);
  const spec = SPECS[lang];
  let out = "";
  let i = 0;
  let plain = "";
  let previous = ""; // last non-space character emitted, for "." detection
  const flush = () => {
    if (plain) out += escapeHtml(plain);
    plain = "";
  };
  while (i < code.length) {
    const ch = code[i]!;
    let token: string | null = null;
    let cls: string | null = null;
    if (ch === "/" && lang !== "shell" && (token = matchAt(LINE_COMMENT, code, i) ?? matchAt(BLOCK_COMMENT, code, i))) cls = "comment";
    else if (ch === "#" && spec.hash !== "none" && (lang !== "shell" || i === 0 || /\s/.test(code[i - 1]!)) && (token = matchAt(HASH_LINE, code, i)))
      cls = spec.hash === "comment" ? "comment" : "meta";
    else if ((ch === '"' || ch === "'" || ch === "`") && (token = matchAt(STRING, code, i))) {
      // Rust lifetimes / C chars are rare in the docs; any quoted run is a string.
      cls = "string";
    } else if (/[\d.]/.test(ch) && !/[\w$]/.test(code[i - 1] ?? "") && (token = matchAt(NUMBER, code, i)) && /\d/.test(token)) cls = "number";
    else if (ch === "@" && spec.atNames && (token = matchAt(AT_NAME, code, i))) cls = "decorator";
    else if (/[A-Za-z_$]/.test(ch) && (token = matchAt(IDENT, code, i))) cls = classifyIdent(token, spec, code, i + token.length, previous);
    else token = null;

    if (token === null) {
      plain += ch;
      if (!/\s/.test(ch)) previous = ch;
      i++;
      continue;
    }
    if (cls) {
      flush();
      out += span(cls, token);
    } else {
      plain += token;
    }
    previous = token[token.length - 1]!;
    i += token.length;
  }
  flush();
  return out;
}
