// "On this page": the h2 / h3 headings of the article. Links scroll to the section (the router owns
// the URL hash, so they can't be plain #anchors).
import type { MouseEvent } from "react";
import { href } from "@/app/router";
import type { TocEntry } from "./markdown";
import { sectionHref } from "./HelpSidebar";

export interface TocListProps {
  topicId: string;
  entries: readonly TocEntry[];
  activeId: string | null;
  onSelect(id: string): void;
}

export function TocList({ topicId, entries, activeId, onSelect }: TocListProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab etc.
    e.preventDefault();
    onSelect(id);
  };
  return (
    <ul className="help-toc-list">
      {entries.map((e) => (
        <li key={e.id} className={`help-toc-item depth-${e.depth}`}>
          <a
            href={href(sectionHref(topicId, e.id))}
            className={`help-toc-link ${activeId === e.id ? "active" : ""}`}
            aria-current={activeId === e.id ? "location" : undefined}
            onClick={(ev) => onClick(ev, e.id)}
          >
            {e.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The sticky table of contents in the right-hand column (wide screens). */
export function HelpToc(props: TocListProps & { onTop(): void }) {
  if (props.entries.length === 0) return null;
  return (
    <nav className="help-toc" aria-label="On this page">
      <div className="help-toc-title">On this page</div>
      <TocList {...props} />
      <button type="button" className="help-toc-top" onClick={props.onTop}>
        Back to top
      </button>
    </nav>
  );
}

/** The collapsible table of contents at the top of the article (narrower screens). */
export function InlineToc(props: TocListProps) {
  if (props.entries.length === 0) return null;
  return (
    <details className="help-toc-inline">
      <summary>On this page</summary>
      <TocList {...props} />
    </details>
  );
}
