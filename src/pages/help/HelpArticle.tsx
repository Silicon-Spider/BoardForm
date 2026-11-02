// One help topic: header, the rendered Markdown and links to the previous / next topic.
// The article HTML comes from ./markdown.ts; clicks inside it are handled here by delegation:
// copy buttons, and links to sections of this topic (scrolled to instead of navigating).
import { forwardRef, type MouseEvent } from "react";
import { Link } from "@/app/router";
import { toast } from "@/app/toast";
import type { RenderedArticle } from "./markdown";
import { copyText } from "./dom";
import { InlineToc } from "./HelpToc";
import { groupLabel, neighbours, readingMinutes, topicTitle, type TopicMeta } from "./topics";

export interface HelpArticleProps {
  topic: TopicMeta;
  article: RenderedArticle;
  activeSection: string | null;
  /** A link to a section of this topic was clicked. */
  onSection(id: string): void;
}

const COPIED_MS = 1600;

async function onCopyClick(button: HTMLButtonElement): Promise<void> {
  const code = button.closest(".help-code")?.querySelector("code")?.textContent ?? "";
  const ok = await copyText(code);
  if (!ok) {
    toast("Couldn't copy to the clipboard", { kind: "error", detail: "Select the code and copy it with Ctrl+C instead." });
    return;
  }
  const label = button.querySelector(".help-copy-label");
  button.dataset.state = "copied";
  if (label) label.textContent = "Copied";
  window.setTimeout(() => {
    delete button.dataset.state;
    if (label) label.textContent = "Copy";
  }, COPIED_MS);
}

export const HelpArticle = forwardRef<HTMLDivElement, HelpArticleProps>(function HelpArticle(
  { topic, article, activeSection, onSection },
  proseRef,
) {
  const { previous, next } = neighbours(topic.id);
  const minutes = readingMinutes(article);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>("button[data-copy]");
    if (copy) {
      e.preventDefault();
      void onCopyClick(copy);
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a[data-section]");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const linkTopic = link.dataset.topic ?? topic.id;
    if (linkTopic === topic.id && link.dataset.section) {
      e.preventDefault();
      onSection(link.dataset.section);
    }
  };

  return (
    <article className="help-article" aria-labelledby="help-article-title">
      <header className="help-article-header">
        <nav className="help-breadcrumb" aria-label="Breadcrumb">
          <Link to="/help">Help</Link>
          <span aria-hidden="true">/</span>
          <span>{groupLabel(topic.group)}</span>
        </nav>
        <h1 id="help-article-title">{article.title || topic.nav}</h1>
        <p className="help-article-summary">{topic.summary}</p>
        <div className="help-article-meta">{minutes} min read</div>
      </header>

      <InlineToc topicId={topic.id} entries={article.toc} activeId={activeSection} onSelect={onSection} />

      <div ref={proseRef} className="help-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: article.html }} />

      <nav className="help-pager" aria-label="Previous and next topic">
        {previous ? (
          <Link to={`/help/${previous.id}`} className="help-pager-link prev">
            <span className="help-pager-dir">← Previous</span>
            <span className="help-pager-title">{topicTitle(previous)}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link to={`/help/${next.id}`} className="help-pager-link next">
            <span className="help-pager-dir">Next →</span>
            <span className="help-pager-title">{topicTitle(next)}</span>
          </Link>
        ) : (
          <Link to="/help" className="help-pager-link next">
            <span className="help-pager-dir">Done reading?</span>
            <span className="help-pager-title">Back to the help home</span>
          </Link>
        )}
      </nav>
    </article>
  );
});
