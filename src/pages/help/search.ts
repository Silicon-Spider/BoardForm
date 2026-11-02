// Full-text search over the help topics for the sidebar: every word of the query must appear in a
// topic (title, summary or text). Results list the matching topics, best first, each with the
// sections whose heading or text matches. Pure module (no React).

import type { ArticleSection } from "./markdown";

export interface SearchDocument {
  topicId: string;
  title: string;
  summary: string;
  sections: readonly ArticleSection[];
}

export interface SearchSectionHit {
  /** Heading anchor, or null for the topic's introduction. */
  id: string | null;
  heading: string;
  /** Text around the first match when the match is in the body rather than the heading. */
  snippet: string | null;
}

export interface SearchHit {
  topicId: string;
  title: string;
  summary: string;
  score: number;
  sections: SearchSectionHit[];
}

/** Lower-case words of a query (punctuation inside words such as "eval.ts" or "cb_go" is kept). */
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}_#@]+|[^\p{L}\p{N}_]+$/gu, ""))
        .filter((w) => w.length > 0),
    ),
  ];
}

const containsAll = (text: string, terms: readonly string[]): boolean => terms.every((t) => text.includes(t));

/** About `radius` characters of context around the first occurrence of any term. */
export function makeSnippet(text: string, terms: readonly string[], radius = 70): string | null {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + radius + (terms[0]?.length ?? 0));
  // Don't cut words in half: move a cut that falls inside a word to the nearest space within the window.
  if (start > 0 && text[start - 1] !== " ") {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < text.length && text[end] !== " ") {
    const space = text.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  return `${start > 0 ? "… " : ""}${text.slice(start, end).trim()}${end < text.length ? " …" : ""}`;
}

/**
 * Searches the topics. `maxSections` limits the sections listed per topic. An empty query returns
 * no hits (the caller shows the normal topic list instead).
 */
export function searchTopics(query: string, docs: readonly SearchDocument[], maxSections = 4): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  docs.forEach((doc, order) => {
    const titleText = `${doc.title} ${doc.summary}`.toLowerCase();
    const whole = [titleText, ...doc.sections.map((s) => `${s.heading} ${s.text}`.toLowerCase())].join(" ");
    if (!containsAll(whole, terms)) return;

    const headingHits: SearchSectionHit[] = [];
    const textHits: SearchSectionHit[] = [];
    for (const s of doc.sections) {
      if (s.id === null && !s.text) continue;
      const heading = s.heading.toLowerCase();
      if (s.id !== null && containsAll(heading, terms)) headingHits.push({ id: s.id, heading: s.heading, snippet: null });
      else if (containsAll(`${heading} ${s.text.toLowerCase()}`, terms)) {
        textHits.push({ id: s.id, heading: s.id === null ? "Introduction" : s.heading, snippet: makeSnippet(s.text, terms) });
      }
    }
    let score = 0;
    if (containsAll(doc.title.toLowerCase(), terms)) score += 100;
    else if (containsAll(titleText, terms)) score += 40;
    score += Math.min(headingHits.length, 5) * 20 + Math.min(textHits.length, 10) * 3;
    // Keep the reading order as the tie-breaker.
    score -= order * 0.01;
    hits.push({
      topicId: doc.topicId,
      title: doc.title,
      summary: doc.summary,
      score,
      sections: [...headingHits, ...textHits].slice(0, maxSections),
    });
  });
  return hits.sort((a, b) => b.score - a.score);
}

/** Splits `text` into parts that do / don't match any of the terms (case-insensitive), for <mark>. */
export function highlightParts(text: string, terms: readonly string[]): Array<{ text: string; match: boolean }> {
  const usable = terms.filter((t) => t.length > 0);
  if (usable.length === 0) return [{ text, match: false }];
  const escaped = usable.sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts: Array<{ text: string; match: boolean }> = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}
