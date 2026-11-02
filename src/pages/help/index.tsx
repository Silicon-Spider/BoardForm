// Help & documentation (routes #/help and #/help/:topic).
//
// Layout: a sticky sidebar (search + topics), the article, and a sticky "On this page" column; on
// narrower screens the table of contents moves into the article and the sidebar becomes a top bar
// with a topic picker and a search panel. Topics are Markdown files in ./topics, rendered by
// ./markdown.ts. Sections are addressed as #/help/<topic>?section=<anchor> because the router owns
// the URL hash; the page scrolls to them itself.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { navigate, setQuery, type PageProps } from "@/app/router";
import { Icon } from "@/components";
import { HelpArticle } from "./HelpArticle";
import { HelpHome, HelpNotFound } from "./HelpHome";
import { SearchArea } from "./HelpSidebar";
import { HelpToc } from "./HelpToc";
import { isEditableTarget, prefersReducedMotion, scrollParentOf, scrollToSection } from "./dom";
import { TOPICS, TOPIC_GROUPS, getArticle, getTopic, topicTitle } from "./topics";
import "./help.css";

/** Distance from the top of the scroll area at which a heading counts as "current". */
const SPY_OFFSET = 96;

/** The id of the last heading that has scrolled past the top of the scroll area. */
function currentSection(prose: HTMLElement, root: HTMLElement): string | null {
  const headings = prose.querySelectorAll<HTMLElement>("h2[data-anchor], h3[data-anchor]");
  if (headings.length === 0) return null;
  const top = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top;
  let current: string | null = null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top - top <= SPY_OFFSET) current = h.dataset.anchor ?? null;
    else break;
  }
  // At the very bottom the last sections can't reach the top: count them as reached.
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = headings[headings.length - 1]!.dataset.anchor ?? current;
  return current;
}

function MobileBar({
  topicId,
  searchOpen,
  onToggleSearch,
}: {
  topicId: string | null;
  searchOpen: boolean;
  onToggleSearch(): void;
}) {
  return (
    <div className="help-mobilebar">
      <label className="help-sr-only" htmlFor="help-topic-select">
        Help topic
      </label>
      <select
        id="help-topic-select"
        className="select help-mobile-select"
        value={topicId && getTopic(topicId) ? topicId : ""}
        onChange={(e) => navigate(e.target.value ? `/help/${e.target.value}` : "/help")}
      >
        <option value="">Help home</option>
        {TOPIC_GROUPS.map((g) => (
          <optgroup key={g.id} label={g.label}>
            {TOPICS.filter((t) => t.group === g.id).map((t) => (
              <option key={t.id} value={t.id}>
                {t.nav}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        className={`btn btn-icon help-mobile-search-btn ${searchOpen ? "active" : ""}`}
        aria-label={searchOpen ? "Close the search" : "Search the help"}
        aria-expanded={searchOpen}
        aria-controls="help-mobile-search"
        onClick={onToggleSearch}
      >
        <Icon name={searchOpen ? "close" : "search"} />
      </button>
    </div>
  );
}

export default function HelpPage({ params, query }: PageProps) {
  const topicId = params.topic ?? null;
  const topic = getTopic(topicId);
  const article = topic ? getArticle(topic.id) : null;
  const section = query.get("section");

  const [search, setSearch] = useState("");
  const [mobileSearch, setMobileSearch] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const pageRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastTopic = useRef<string | null | undefined>(undefined);
  const lastSection = useRef<string | null>(null);

  const scrollRoot = useCallback((): HTMLElement => scrollParentOf(pageRef.current), []);

  // Scroll to the section named in the URL (or to the top when the topic changes).
  useLayoutEffect(() => {
    const topicChanged = lastTopic.current !== topicId;
    lastTopic.current = topicId;
    if (section && article) {
      if (topicChanged || section !== lastSection.current) scrollToSection(proseRef.current, section, !topicChanged);
    } else if (topicChanged) {
      scrollRoot().scrollTo({ top: 0 });
    }
    lastSection.current = section;
    if (topicChanged) setActiveSection(section && article ? section : (article?.toc[0]?.id ?? null));
  }, [topicId, section, article, scrollRoot]);

  // Scroll spy: highlight the section being read in the table of contents.
  useEffect(() => {
    const prose = proseRef.current;
    if (!article || !prose) return;
    const root = scrollRoot();
    const target: EventTarget = root === document.scrollingElement ? window : root;
    let frame = 0;
    const update = () => {
      frame = 0;
      setActiveSection(currentSection(prose, root) ?? article.toc[0]?.id ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [article, scrollRoot]);

  // "/" focuses the search (or opens it on narrow screens); Esc closes the narrow-screen search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        const input = searchInputRef.current;
        e.preventDefault();
        if (input && input.offsetParent !== null) input.focus();
        else setMobileSearch(true);
      } else if (e.key === "Escape" && mobileSearch) {
        setMobileSearch(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileSearch]);

  // The window title follows the topic.
  useEffect(() => {
    const previous = document.title;
    document.title = topic ? `${topicTitle(topic)} · Help · BoardForm` : "Help · BoardForm";
    return () => {
      document.title = previous;
    };
  }, [topic]);

  /** A section link inside this topic: scroll there and remember it in the URL (no new history entry). */
  const goToSection = useCallback(
    (id: string) => {
      if (!topic) return;
      scrollToSection(proseRef.current, id, true);
      setActiveSection(id);
      lastSection.current = id;
      setQuery({ section: id });
    },
    [topic],
  );

  const backToTop = useCallback(() => {
    scrollRoot().scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    lastSection.current = null;
    setQuery({ section: null });
  }, [scrollRoot]);

  const closeMobileSearch = useCallback(() => setMobileSearch(false), []);

  return (
    <div className={`help-page ${article ? "has-toc" : ""}`} ref={pageRef}>
      <MobileBar topicId={topicId} searchOpen={mobileSearch} onToggleSearch={() => setMobileSearch((o) => !o)} />
      {mobileSearch && (
        <div className="help-mobile-search" id="help-mobile-search">
          <SearchArea query={search} onQueryChange={setSearch} activeId={topicId} onNavigate={closeMobileSearch} autoFocus showTopics={false} />
        </div>
      )}

      <aside className="help-sidebar">
        <SearchArea query={search} onQueryChange={setSearch} activeId={topicId === null ? null : (topic?.id ?? "")} inputRef={searchInputRef} showTopics />
      </aside>

      <div className="help-main">
        {topicId === null ? (
          <HelpHome />
        ) : topic && article ? (
          <HelpArticle ref={proseRef} topic={topic} article={article} activeSection={activeSection} onSection={goToSection} />
        ) : (
          <HelpNotFound topicId={topicId} />
        )}
      </div>

      {topic && article && (
        <aside className="help-toc-column">
          <HelpToc topicId={topic.id} entries={article.toc} activeId={activeSection} onSelect={goToSection} onTop={backToTop} />
        </aside>
      )}
    </div>
  );
}
