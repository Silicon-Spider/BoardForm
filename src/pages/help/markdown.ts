// Markdown → HTML for the help topics, built on `marked` with a custom renderer:
//
//   * headings get stable anchors (slugs) and a "link to this section" button; the router uses the
//     URL hash for routes, so in-page links are written as "#/help/<topic>?section=<anchor>" and the
//     page scrolls with element.scrollIntoView instead of relying on "#anchor" navigation;
//   * fenced code is highlighted (./highlight.ts) and gets a header with the language and a copy
//     button; the info string "ts eval" marks a complete eval.ts (tested by examples.test.ts);
//   * blockquotes starting with **Tip** / **Note** / **Warning** become callouts;
//   * tables are wrapped so wide ones scroll on narrow screens;
//   * links: "#anchor" → this topic's section, "*.md" spec files → their topics, external links open
//     in a new tab;
//   * `<!-- include: FILE.md title="…" -->` inlines one of the docs/ specs, its headings demoted by one
//     level, so the reference parts of the help can never drift from the specs.
//
// Pure module (no React, no DOM): the tests run it in Node.

import { Lexer, Parser, Renderer, getDefaults, type MarkedOptions, type Token, type Tokens } from "marked";
import { escapeHtml, highlight, languageLabel } from "./highlight";

export interface TocEntry {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** A heading and the plain text below it, for the search index. `id` null = the topic intro. */
export interface ArticleSection {
  id: string | null;
  heading: string;
  depth: number;
  text: string;
}

export interface ArticleCodeBlock {
  /** First word of the fence info string ("ts", "c", "" …). */
  lang: string;
  /** Remaining words of the info string, e.g. ["eval"]. */
  flags: string[];
  code: string;
}

export interface RenderedArticle {
  /** Text of the leading "# Title" (empty if the source has none). */
  title: string;
  /** Article body without the title. */
  html: string;
  /** h2 / h3 headings, in order. */
  toc: TocEntry[];
  /** Every heading anchor in the article (all levels). */
  anchors: string[];
  sections: ArticleSection[];
  codeBlocks: ArticleCodeBlock[];
  /** Every link target as written in the Markdown (before rewriting). */
  links: string[];
  /** Approximate number of words (for the reading time). */
  words: number;
}

export interface RenderOptions {
  /** Topic being rendered: the target of "#anchor" links and of the heading links. */
  topicId: string;
  /** Spec files that `<!-- include: NAME -->` may reference, keyed by file name. */
  includes?: Readonly<Record<string, string>>;
  /** Spec file name → topic id, for links such as "ENGINE_ABI.md". */
  docTopics?: Readonly<Record<string, string>>;
}

type AnchoredHeading = Tokens.Heading & { anchor?: string };

/** Fresh options for every lexer / parser: marked stores its tokenizer and renderer on the object it is given. */
function markedOptions(extra: MarkedOptions = {}): MarkedOptions {
  return { ...getDefaults(), gfm: true, ...extra };
}

/** Anchor slug of a heading: "Search limits (cb_go)" → "search-limits-cb-go". */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** Plain text of inline tokens (code spans keep their text, markup is dropped). */
export function inlineText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    if (t.type === "br") out += " ";
    else if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) out += inlineText(t.tokens);
    else if (t.type === "html") out += t.text.replace(/<[^>]*>/g, "");
    else if ("text" in t && typeof t.text === "string") out += t.text;
  }
  return out.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Plain text of any block token, for searching. */
function blockText(t: Token): string {
  switch (t.type) {
    case "code":
      return (t as Tokens.Code).text;
    case "table": {
      const table = t as Tokens.Table;
      const cells = [...table.header, ...table.rows.flat()];
      return cells.map((c) => inlineText(c.tokens)).join(" ");
    }
    case "list":
      return (t as Tokens.List).items.map((item) => item.tokens.map(blockText).join(" ")).join(" ");
    case "html":
      return (t as Tokens.HTML).text.startsWith("<!--") ? "" : (t as Tokens.HTML).text.replace(/<[^>]*>/g, " ");
    case "space":
    case "hr":
      return "";
    default:
      if ("tokens" in t && Array.isArray(t.tokens)) {
        // Block containers (blockquote) hold block tokens; paragraphs hold inline tokens.
        return t.type === "blockquote" ? t.tokens.map(blockText).join(" ") : inlineText(t.tokens);
      }
      return "text" in t && typeof t.text === "string" ? t.text : "";
  }
}

/** Calls `visit` for every token, depth first, including list items, table cells and inline tokens. */
function walk(tokens: readonly Token[], visit: (t: Token) => void): void {
  for (const t of tokens) {
    visit(t);
    if (t.type === "list") for (const item of (t as Tokens.List).items) walk(item.tokens, visit);
    else if (t.type === "table") {
      const table = t as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) walk(cell.tokens, visit);
    } else if ("tokens" in t && Array.isArray(t.tokens)) walk(t.tokens, visit);
  }
}

// ───────────────────────────── includes ─────────────────────────────

const INCLUDE_RE = /^<!--\s*include:\s*([\w.-]+)(?:\s+title="([^"]*)")?\s*-->\s*$/;

/** Internal notes in the specs that mean nothing to users ("(see the WP-… report)"). */
function sanitizeSpec(text: string): string {
  return text.replace(/\s*\(see the WP-[A-Z0-9-]+ report\)/g, "");
}

function expandIncludes(tokens: Token[], includes: Readonly<Record<string, string>>): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const m = t.type === "html" ? INCLUDE_RE.exec((t as Tokens.HTML).text.trim()) : null;
    if (!m) {
      out.push(t);
      continue;
    }
    const [, name, title] = m;
    const source = includes[name!];
    if (source === undefined) {
      out.push({ type: "paragraph", raw: "", text: "", tokens: [{ type: "text", raw: "", text: `(Missing reference: ${name})` }] } as Tokens.Paragraph);
      continue;
    }
    const included = Lexer.lex(sanitizeSpec(source), markedOptions());
    let first = true;
    for (const inc of included) {
      if (inc.type === "heading") {
        const h = inc as Tokens.Heading;
        h.depth = Math.min(6, h.depth + 1);
        if (first && title) {
          h.text = title;
          h.raw = `${"#".repeat(h.depth)} ${title}\n`;
          h.tokens = Lexer.lexInline(title, markedOptions());
        }
        first = false;
      }
      out.push(inc);
    }
  }
  return out;
}

// ───────────────────────────── links ─────────────────────────────

interface ResolvedLink {
  href: string;
  external: boolean;
  /** Set when the link points into a help topic section. */
  topic?: string;
  section?: string;
}

function resolveLink(href: string, opts: RenderOptions): ResolvedLink {
  if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) return { href, external: true };
  if (href.startsWith("#/help/")) {
    const m = /^#\/help\/([^?#/]+)(?:\?(.*))?$/.exec(href);
    const section = m?.[2] ? new URLSearchParams(m[2]).get("section") ?? undefined : undefined;
    return { href, external: false, topic: m?.[1], section };
  }
  if (href.startsWith("#") && !href.startsWith("#/")) {
    const section = href.slice(1);
    return { href: `#/help/${opts.topicId}?section=${encodeURIComponent(section)}`, external: false, topic: opts.topicId, section };
  }
  const doc = /(?:^|\/)([A-Z_]+\.md)(?:#.*)?$/.exec(href);
  if (doc && opts.docTopics?.[doc[1]!]) {
    const topic = opts.docTopics[doc[1]!]!;
    return { href: `#/help/${topic}`, external: false, topic };
  }
  return { href, external: false };
}

// ───────────────────────────── renderer ─────────────────────────────

const ICONS = {
  tip: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z",
  note: "M12 11v6M12 7.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  warning: "M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  copy: "M9 9h10v11H9zM5 15V4h10",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
} as const;

function icon(name: keyof typeof ICONS, cls: string): string {
  return `<svg class="${cls}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
}

const CALLOUTS: Record<string, { cls: string; label: string; icon: keyof typeof ICONS }> = {
  tip: { cls: "tip", label: "Tip", icon: "tip" },
  note: { cls: "note", label: "Note", icon: "note" },
  warning: { cls: "warning", label: "Warning", icon: "warning" },
};

const attr = (s: string): string => escapeHtml(s);

class HelpRenderer extends Renderer {
  constructor(private readonly opts: RenderOptions) {
    super();
  }

  override heading(token: Tokens.Heading): string {
    const inner = this.parser.parseInline(token.tokens);
    const anchor = (token as AnchoredHeading).anchor ?? slugify(token.text);
    const d = token.depth;
    const link = `#/help/${this.opts.topicId}?section=${encodeURIComponent(anchor)}`;
    return (
      `<h${d} id="help-sec-${attr(anchor)}" class="help-heading" data-anchor="${attr(anchor)}">${inner}` +
      `<a class="help-anchor" href="${attr(link)}" data-section="${attr(anchor)}" aria-label="Link to this section" title="Link to this section">#</a></h${d}>\n`
    );
  }

  override code(token: Tokens.Code): string {
    const [lang = "", ...flags] = (token.lang ?? "").trim().split(/\s+/).filter(Boolean);
    const complete = flags.includes("eval");
    const label = languageLabel(lang);
    const badge = complete
      ? `<span class="help-code-badge" title="A complete file: replace the whole eval.ts with it">Complete eval.ts</span>`
      : "";
    return (
      `<div class="help-code${complete ? " help-code-complete" : ""}">` +
      `<div class="help-code-bar">${label ? `<span class="help-code-lang">${escapeHtml(label)}</span>` : ""}${badge}` +
      `<button type="button" class="help-copy" data-copy aria-label="Copy the code">${icon("copy", "help-copy-icon")}<span class="help-copy-label">Copy</span></button></div>` +
      `<pre class="help-pre"><code class="hl">${highlight(token.text.replace(/\n$/, ""), lang)}</code></pre></div>\n`
    );
  }

  override blockquote(token: Tokens.Blockquote): string {
    const first = token.tokens[0];
    if (first?.type === "paragraph") {
      const paragraph = first as Tokens.Paragraph;
      const lead = paragraph.tokens[0];
      const kind = lead?.type === "strong" ? CALLOUTS[(lead as Tokens.Strong).text.replace(/[:.]$/, "").trim().toLowerCase()] : undefined;
      if (kind) {
        const rest = paragraph.tokens.slice(1);
        const next = rest[0];
        if (next?.type === "text") {
          const t = next as Tokens.Text;
          rest[0] = { ...t, text: t.text.replace(/^[:.]?\s+/, ""), raw: t.raw.replace(/^[:.]?\s+/, "") };
        }
        const body = this.parser.parse([{ ...paragraph, tokens: rest } as Tokens.Paragraph, ...token.tokens.slice(1)]);
        return (
          `<aside class="callout help-callout help-callout-${kind.cls}" role="note">` +
          `<div class="help-callout-title">${icon(kind.icon, "help-callout-icon")}<span>${kind.label}</span></div>` +
          `<div class="help-callout-body">${body}</div></aside>\n`
        );
      }
    }
    return `<blockquote class="help-quote">${this.parser.parse(token.tokens)}</blockquote>\n`;
  }

  override table(token: Tokens.Table): string {
    const align = (a: Tokens.TableCell["align"]): string => (a ? ` style="text-align:${a}"` : "");
    const head = token.header.map((c) => `<th scope="col"${align(c.align)}>${this.parser.parseInline(c.tokens)}</th>`).join("");
    const body = token.rows
      .map((row) => `<tr>${row.map((c) => `<td${align(c.align)}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
      .join("\n");
    return `<div class="help-table-wrap"><table class="table help-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
  }

  override link(token: Tokens.Link): string {
    const text = this.parser.parseInline(token.tokens);
    const target = resolveLink(token.href, this.opts);
    const title = token.title ? ` title="${attr(token.title)}"` : "";
    if (target.external) {
      return `<a href="${attr(target.href)}"${title} target="_blank" rel="noopener noreferrer" class="help-external">${text}${icon("external", "help-external-icon")}<span class="help-sr-only"> (opens in a new tab)</span></a>`;
    }
    const data =
      (target.topic ? ` data-topic="${attr(target.topic)}"` : "") + (target.section ? ` data-section="${attr(target.section)}"` : "");
    return `<a href="${attr(target.href)}"${title}${data}>${text}</a>`;
  }
}

// ───────────────────────────── entry point ─────────────────────────────

/** Renders one help topic. Never throws for odd Markdown; missing includes render a short notice. */
export function renderArticle(source: string, opts: RenderOptions): RenderedArticle {
  const lexed = Lexer.lex(source, markedOptions());
  let tokens = expandIncludes([...lexed], opts.includes ?? {});

  // The leading "# Title" becomes the page title instead of part of the body.
  let title = "";
  const titleIndex = tokens.findIndex((t) => t.type !== "space");
  if (titleIndex >= 0 && tokens[titleIndex]!.type === "heading" && (tokens[titleIndex] as Tokens.Heading).depth === 1) {
    title = inlineText((tokens[titleIndex] as Tokens.Heading).tokens).trim();
    tokens = tokens.filter((_, i) => i !== titleIndex);
  }

  // Unique anchors for every heading, plus the table of contents and the search sections.
  const used = new Map<string, number>();
  const toc: TocEntry[] = [];
  const anchors: string[] = [];
  const sections: ArticleSection[] = [{ id: null, heading: title, depth: 1, text: "" }];
  for (const t of tokens) {
    if (t.type === "heading") {
      const h = t as AnchoredHeading;
      const text = inlineText(h.tokens).trim();
      const base = slugify(text);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      h.anchor = n === 1 ? base : `${base}-${n}`;
      anchors.push(h.anchor);
      if (h.depth === 2 || h.depth === 3) toc.push({ id: h.anchor, text, depth: h.depth });
      sections.push({ id: h.anchor, heading: text, depth: h.depth, text: "" });
    } else {
      const text = blockText(t).replace(/\s+/g, " ").trim();
      if (text) {
        const current = sections[sections.length - 1]!;
        current.text = current.text ? `${current.text} ${text}` : text;
      }
    }
  }

  const codeBlocks: ArticleCodeBlock[] = [];
  const links: string[] = [];
  walk(tokens, (t) => {
    if (t.type === "code") {
      const [lang = "", ...flags] = ((t as Tokens.Code).lang ?? "").trim().split(/\s+/).filter(Boolean);
      codeBlocks.push({ lang, flags, code: (t as Tokens.Code).text });
    } else if (t.type === "link") {
      links.push((t as Tokens.Link).href);
    }
  });

  const html = Parser.parse(tokens, markedOptions({ renderer: new HelpRenderer(opts) }));
  const words = sections.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  return { title, html, toc, anchors, sections: sections.filter((s) => s.id !== null || s.text), codeBlocks, links, words };
}
