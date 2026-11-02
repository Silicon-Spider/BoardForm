// The help sidebar: a search box that filters the topics (showing matching sections), and the topic
// list grouped by theme. Also used, in a panel, by the compact top bar on narrow screens.
import { forwardRef, useMemo, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Link, navigate } from "@/app/router";
import { Icon } from "@/components";
import { highlightParts, queryTerms, searchTopics, type SearchDocument, type SearchHit } from "./search";
import { TOPICS, TOPIC_GROUPS, getArticle, topicTitle } from "./topics";

let documents: SearchDocument[] | null = null;

/** The search index (built on first use: it renders every topic once). */
function searchDocuments(): SearchDocument[] {
  documents ??= TOPICS.map((t) => ({
    topicId: t.id,
    title: topicTitle(t),
    summary: t.summary,
    sections: getArticle(t.id)?.sections ?? [],
  }));
  return documents;
}

export function sectionHref(topicId: string, section: string | null): string {
  return section ? `/help/${topicId}?section=${encodeURIComponent(section)}` : `/help/${topicId}`;
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  return highlightParts(text, terms).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
}

export interface SearchBoxProps {
  value: string;
  onChange(value: string): void;
  /** Enter: open the first result. */
  onSubmit(): void;
  /** ArrowDown: move focus into the results. */
  onFocusResults(): void;
  autoFocus?: boolean;
}

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox(
  { value, onChange, onSubmit, onFocusResults, autoFocus },
  ref,
) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (value) {
        e.preventDefault();
        e.stopPropagation();
        onChange("");
      } else {
        e.currentTarget.blur();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onFocusResults();
    }
  };
  return (
    <div className="help-search" role="search">
      <Icon name="search" className="help-search-icon" />
      <input
        ref={ref}
        type="search"
        className="input help-search-input"
        placeholder="Search the help"
        aria-label="Search the help"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button type="button" className="help-search-clear" aria-label="Clear the search" onClick={() => onChange("")}>
          <Icon name="close" size={14} />
        </button>
      ) : (
        <kbd className="help-search-kbd" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
});

/** Search hits for a query (empty for an empty query). */
export function useSearch(query: string): { terms: string[]; hits: SearchHit[] } {
  return useMemo(() => {
    const terms = queryTerms(query);
    return { terms, hits: terms.length ? searchTopics(query, searchDocuments()) : [] };
  }, [query]);
}

/** Where Enter in the search box goes: the first section of the best hit, or the topic. */
export function firstResultHref(hits: readonly SearchHit[]): string | null {
  const hit = hits[0];
  if (!hit) return null;
  return sectionHref(hit.topicId, hit.sections[0]?.id ?? null);
}

export interface SearchResultsProps {
  query: string;
  terms: readonly string[];
  hits: readonly SearchHit[];
  /** Called after a result was chosen (e.g. to close the mobile panel). */
  onNavigate?(): void;
}

export const SearchResults = forwardRef<HTMLDivElement, SearchResultsProps>(function SearchResults(
  { query, terms, hits, onNavigate },
  ref,
) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>("a"));
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    const next = links[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
    else if (e.key === "ArrowUp") (e.currentTarget.closest(".help-search-area")?.querySelector("input") as HTMLInputElement | null)?.focus();
  };
  return (
    <div className="help-results" ref={ref} onKeyDown={onKeyDown}>
      <div className="help-results-count" role="status">
        {hits.length === 0 ? "No matches" : `${hits.length} ${hits.length === 1 ? "topic matches" : "topics match"}`}
      </div>
      {hits.length === 0 && (
        <div className="help-results-empty">
          <p>
            Nothing in the help matches <strong>“{query.trim()}”</strong>.
          </p>
          <p className="muted small">Try a shorter or different word — for example a block name, a function such as pstSum, or a page such as Arena.</p>
        </div>
      )}
      {hits.map((hit) => (
        <div key={hit.topicId} className="help-result">
          <Link to={sectionHref(hit.topicId, null)} className="help-result-topic" onClick={onNavigate}>
            <Highlighted text={hit.title} terms={terms} />
          </Link>
          {hit.sections.length > 0 && (
            <ul className="help-result-sections">
              {hit.sections.map((s) => (
                <li key={s.id ?? "intro"}>
                  <Link to={sectionHref(hit.topicId, s.id)} className="help-result-section" onClick={onNavigate}>
                    <span className="help-result-heading">
                      <Highlighted text={s.heading} terms={terms} />
                    </span>
                    {s.snippet && (
                      <span className="help-result-snippet">
                        <Highlighted text={s.snippet} terms={terms} />
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
});

export function TopicNav({ activeId, onNavigate }: { activeId: string | null; onNavigate?(): void }) {
  return (
    <nav className="help-nav" aria-label="Help topics">
      <Link to="/help" className={`help-nav-home ${activeId === null ? "active" : ""}`} aria-current={activeId === null ? "page" : undefined} onClick={onNavigate}>
        Help home
      </Link>
      {TOPIC_GROUPS.map((g) => (
        <div key={g.id} className="help-nav-group">
          <div className="help-nav-group-title">{g.label}</div>
          <ul>
            {TOPICS.filter((t) => t.group === g.id).map((t) => (
              <li key={t.id}>
                <Link
                  to={`/help/${t.id}`}
                  className={`help-nav-link ${activeId === t.id ? "active" : ""}`}
                  aria-current={activeId === t.id ? "page" : undefined}
                  onClick={onNavigate}
                >
                  {t.nav}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export interface SearchAreaProps {
  query: string;
  onQueryChange(q: string): void;
  activeId: string | null;
  /** Called after any navigation from inside (the mobile panel closes itself). */
  onNavigate?(): void;
  autoFocus?: boolean;
  /** Lets the page focus the box for the "/" shortcut. */
  inputRef?: Ref<HTMLInputElement>;
  /** Show the topic list when there is no query (the sidebar does, the mobile panel doesn't). */
  showTopics: boolean;
}

/** Search box + results (while searching) or the topic list. */
export function SearchArea({ query, onQueryChange, activeId, onNavigate, autoFocus, inputRef, showTopics }: SearchAreaProps) {
  const { terms, hits } = useSearch(query);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searching = terms.length > 0;
  return (
    <div className="help-search-area">
      <SearchBox
        ref={inputRef}
        value={query}
        onChange={onQueryChange}
        autoFocus={autoFocus}
        onSubmit={() => {
          const to = firstResultHref(hits);
          if (to) {
            navigate(to);
            onNavigate?.();
          }
        }}
        onFocusResults={() => resultsRef.current?.querySelector<HTMLAnchorElement>("a")?.focus()}
      />
      {searching ? (
        <SearchResults ref={resultsRef} query={query} terms={terms} hits={hits} onNavigate={onNavigate} />
      ) : (
        showTopics && <TopicNav activeId={activeId} onNavigate={onNavigate} />
      )}
    </div>
  );
}
