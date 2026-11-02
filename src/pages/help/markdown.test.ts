// Unit tests for the help page's Markdown renderer, syntax highlighter and search.
import { describe, expect, it } from "vitest";
import { highlight, languageLabel } from "./highlight";
import { renderArticle, slugify } from "./markdown";
import { highlightParts, makeSnippet, queryTerms, searchTopics, type SearchDocument } from "./search";
import { TOPICS, getArticle, neighbours, topicTitle } from "./topics";

const render = (md: string, includes: Record<string, string> = {}) =>
  renderArticle(md, { topicId: "demo", includes, docTopics: { "ENGINE_ABI.md": "abi" } });

describe("slugify", () => {
  it("makes readable anchors", () => {
    expect(slugify("Search limits (cb_go)")).toBe("search-limits-cb-go");
    expect(slugify("Us and them")).toBe("us-and-them");
    expect(slugify("Reference: the engine template")).toBe("reference-the-engine-template");
    expect(slugify("Élan & co.")).toBe("elan-co");
    expect(slugify("→ ×")).toBe("section");
  });
});

describe("renderArticle", () => {
  it("takes the title from the first h1 and builds the table of contents from h2 / h3", () => {
    const a = render("# My topic\n\nIntro text.\n\n## First\n\nA\n\n### Detail\n\nB\n\n#### Deep\n\nC\n\n## First\n\nD\n");
    expect(a.title).toBe("My topic");
    expect(a.html).not.toContain("<h1");
    expect(a.toc).toEqual([
      { id: "first", text: "First", depth: 2 },
      { id: "detail", text: "Detail", depth: 3 },
      { id: "first-2", text: "First", depth: 2 },
    ]);
    expect(a.anchors).toEqual(["first", "detail", "deep", "first-2"]);
    expect(a.html).toContain('data-anchor="first-2"');
    expect(a.html).toContain('href="#/help/demo?section=detail"');
    expect(a.sections.map((s) => [s.id, s.text])).toEqual([
      [null, "Intro text."],
      ["first", "A"],
      ["detail", "B"],
      ["deep", "C"],
      ["first-2", "D"],
    ]);
  });

  it("turns **Tip** / **Note** / **Warning** blockquotes into callouts", () => {
    const tip = render("> **Tip** Use blocks.\n").html;
    expect(tip).toContain("help-callout-tip");
    expect(tip).toContain("<p>Use blocks.</p>");
    const warning = render("> **Warning:** Careful.\n").html;
    expect(warning).toContain("help-callout-warning");
    expect(warning).toContain("<p>Careful.</p>");
    expect(render("> **Note** A *note*.\n").html).toContain("help-callout-note");
    const quote = render("> Just a quote.\n").html;
    expect(quote).toContain('<blockquote class="help-quote">');
    expect(quote).not.toContain("callout");
  });

  it("highlights code, escapes it, and marks complete eval.ts examples", () => {
    const a = render("```ts eval\nconst x: i32 = 1 << 2; // <b>\n```\n\n```text\na < b\n```\n");
    expect(a.codeBlocks).toEqual([
      { lang: "ts", flags: ["eval"], code: "const x: i32 = 1 << 2; // <b>" },
      { lang: "text", flags: [], code: "a < b" },
    ]);
    expect(a.html).toContain("Complete eval.ts");
    expect(a.html).toContain("help-code-complete");
    expect(a.html).toContain('<span class="hl-keyword">const</span>');
    expect(a.html).toContain('<span class="hl-type">i32</span>');
    expect(a.html).toContain('<span class="hl-comment">// &lt;b&gt;</span>');
    expect(a.html).toContain("a &lt; b");
    expect(a.html).not.toContain("<b>");
    expect(a.html.match(/data-copy/g)?.length).toBe(2);
  });

  it("rewrites links: in-topic anchors, specs and external sites", () => {
    const a = render("[here](#first) [abi](ENGINE_ABI.md) [web](https://example.org) [play](#/play) [t](#/help/abi?section=x)\n");
    expect(a.links).toEqual(["#first", "ENGINE_ABI.md", "https://example.org", "#/play", "#/help/abi?section=x"]);
    expect(a.html).toContain('href="#/help/demo?section=first" data-topic="demo" data-section="first"');
    expect(a.html).toContain('href="#/help/abi" data-topic="abi"');
    expect(a.html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(a.html).toContain('href="#/play"');
    expect(a.html).toContain('data-topic="abi" data-section="x"');
  });

  it("wraps tables so they can scroll", () => {
    const html = render("| A | B |\n| --- | ---: |\n| `x` | 2 |\n").html;
    expect(html).toContain('<div class="help-table-wrap"><table class="table help-table">');
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it("includes specs with demoted headings, an optional title, and without internal notes", () => {
    const spec = "# Spec title\n\nIntro (see the WP-NNUE-VERIFY report).\n\n## Part\n\nText\n";
    const a = render('# Topic\n\n## Before\n\n<!-- include: SPEC.md title="Reference" -->\n', { "SPEC.md": spec });
    expect(a.toc).toEqual([
      { id: "before", text: "Before", depth: 2 },
      { id: "reference", text: "Reference", depth: 2 },
      { id: "part", text: "Part", depth: 3 },
    ]);
    expect(a.html).toContain("<p>Intro.</p>");
    expect(render("<!-- include: NOPE.md -->\n").html).toContain("Missing reference: NOPE.md");
  });
});

describe("highlight", () => {
  it("colours AssemblyScript", () => {
    const html = highlight('@inline\nexport function f(pos: Position): i32 { return popcount(pos.pieces(WHITE, PAWN)) + 0x10 + "s".length; }', "ts");
    expect(html).toContain('<span class="hl-decorator">@inline</span>');
    expect(html).toContain('<span class="hl-keyword">export</span>');
    expect(html).toContain('<span class="hl-fn">f</span>');
    expect(html).toContain('<span class="hl-type">Position</span>');
    expect(html).toContain('<span class="hl-fn">popcount</span>');
    expect(html).toContain('<span class="hl-fn">pieces</span>');
    expect(html).toContain('<span class="hl-const">WHITE</span>');
    expect(html).toContain('<span class="hl-number">0x10</span>');
    expect(html).toContain('<span class="hl-string">&quot;s&quot;</span>');
  });

  it("treats generic calls, C attributes and unknown languages sensibly", () => {
    expect(highlight("min<i32>(a, b)", "ts")).toContain('<span class="hl-fn">min</span>');
    expect(highlight("#include <stdint.h>\nint32_t x;", "c")).toContain('<span class="hl-meta">#include &lt;stdint.h&gt;</span>');
    expect(highlight("int32_t x;", "c")).toContain('<span class="hl-type">int32_t</span>');
    expect(highlight("<b>if</b>", "brainfuck")).toBe("&lt;b&gt;if&lt;/b&gt;");
    expect(highlight("i32 a1 x2", "ts")).toBe('<span class="hl-type">i32</span> a1 x2');
    expect(languageLabel("ts")).toBe("AssemblyScript");
    expect(languageLabel("text")).toBe("");
  });

  it("never loses or reorders text", () => {
    const code = 'const s = `a${b}` + \'c\' /* x */ // y\nlet n = 1_000.5e3 + .5;\n#x';
    const text = highlight(code, "ts").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(text).toBe(code);
  });
});

describe("search", () => {
  const docs: SearchDocument[] = TOPICS.map((t) => ({ topicId: t.id, title: topicTitle(t), summary: t.summary, sections: getArticle(t.id)!.sections }));

  it("splits queries into terms", () => {
    expect(queryTerms("  Piece-square  TABLES, ")).toEqual(["piece-square", "tables"]);
    expect(queryTerms("eval.ts cb_go")).toEqual(["eval.ts", "cb_go"]);
    expect(queryTerms("   ")).toEqual([]);
  });

  it("finds topics and the sections that match", () => {
    const hits = searchTopics("pstSum", docs);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.topicId)).toContain("eval-api");
    const evalHit = hits.find((h) => h.topicId === "eval-api")!;
    expect(evalHit.sections.length).toBeGreaterThan(0);
    expect(evalHit.sections.some((s) => s.snippet?.toLowerCase().includes("pstsum"))).toBe(true);

    const perft = searchTopics("perft kiwipete", docs);
    expect(perft[0]?.topicId).toBe("scratch");
    expect(searchTopics("Blocks editor", docs)[0]?.topicId).toBe("blocks");
    expect(searchTopics("xyzzy-nothing", docs)).toEqual([]);
    expect(searchTopics("", docs)).toEqual([]);
  });

  it("ranks heading matches and builds snippets", () => {
    const hits = searchTopics("tapered evaluation", docs);
    const evalApi = hits.find((h) => h.topicId === "eval-api")!;
    expect(evalApi.sections[0]).toEqual({ id: "tapered-evaluation", heading: "Tapered evaluation", snippet: null });
    // The window (4 characters either side) starts at "two" and would end inside "four".
    expect(makeSnippet("one two three four five", ["three"], 4)).toBe("… two three …");
    expect(makeSnippet("one two three four five", ["three"], 6)).toBe("… two three four …");
    expect(makeSnippet("abc", ["zzz"])).toBeNull();
  });

  it("splits text for highlighting", () => {
    expect(highlightParts("Search the Search", ["search"])).toEqual([
      { text: "Search", match: true },
      { text: " the ", match: false },
      { text: "Search", match: true },
    ]);
    expect(highlightParts("a.b", ["."])).toEqual([
      { text: "a", match: false },
      { text: ".", match: true },
      { text: "b", match: false },
    ]);
  });
});

describe("topics", () => {
  it("are in reading order with previous / next links", () => {
    expect(TOPICS[0]!.id).toBe("getting-started");
    expect(neighbours("getting-started")).toEqual({ previous: null, next: TOPICS[1] });
    expect(neighbours(TOPICS[TOPICS.length - 1]!.id).next).toBeNull();
    expect(neighbours("nope")).toEqual({ previous: null, next: null });
  });
});
