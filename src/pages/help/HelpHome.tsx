// The help landing page (#/help) and the friendly page for unknown topics.
import type { CSSProperties } from "react";
import { Link } from "@/app/router";
import { sectionHref } from "./HelpSidebar";
import { HELP_TASKS, TOPICS, TOPIC_GROUPS, getArticle, readingMinutes, topicTitle, type TopicGroupId } from "./topics";

/** Accent colour of each group's cards. */
const GROUP_ACCENT: Record<TopicGroupId, string> = {
  start: "var(--accent)",
  build: "var(--kind-blocks)",
  networks: "var(--kind-nnue)",
  play: "var(--violet)",
  data: "var(--kind-wasm)",
};

export function TopicCards({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="help-groups">
      {TOPIC_GROUPS.map((g) => (
        <section key={g.id} className="help-group" style={{ "--help-accent": GROUP_ACCENT[g.id] } as CSSProperties}>
          <Heading className="help-group-title">{g.label}</Heading>
          <div className="help-cards">
            {TOPICS.filter((t) => t.group === g.id).map((t) => {
              const article = getArticle(t.id);
              return (
                <Link key={t.id} to={`/help/${t.id}`} className="card card-hover help-card">
                  <span className="help-card-title">{topicTitle(t)}</span>
                  <span className="help-card-summary">{t.summary}</span>
                  {article && <span className="help-card-meta">{readingMinutes(article)} min read</span>}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function HelpHome() {
  return (
    <div className="help-home">
      <header className="help-hero">
        <p className="help-eyebrow">Help &amp; documentation</p>
        <h1>Learn BoardForm</h1>
        <p className="help-lead">
          Build chess engines with blocks or code, train neural networks with self-play, and find out which ideas really make
          an engine stronger. Start with the basics, or jump straight to a topic.
        </p>
        <div className="row-wrap">
          <Link to="/help/getting-started" className="btn btn-primary">
            Start with the basics
          </Link>
          <Link to="/help/blocks" className="btn">
            Build an engine with blocks
          </Link>
        </div>
      </header>

      <section className="help-tasks" aria-labelledby="help-tasks-title">
        <h2 id="help-tasks-title" className="help-group-title">
          I want to …
        </h2>
        <ul className="help-task-list">
          {HELP_TASKS.map((t) => (
            <li key={t.label}>
              <Link to={sectionHref(t.topic, t.section)} className="help-task">
                <span>{t.label}</span>
                <span className="help-task-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <TopicCards />
    </div>
  );
}

export function HelpNotFound({ topicId }: { topicId: string }) {
  return (
    <div className="help-notfound">
      <div className="help-notfound-head">
        <p className="help-eyebrow">Help</p>
        <h1>We couldn't find that help page</h1>
        <p className="help-lead">
          There is no help topic called <code>{topicId}</code>. It may have been renamed — pick one of the topics below, or
          search the help.
        </p>
        <Link to="/help" className="btn">
          Go to the help home
        </Link>
      </div>
      <TopicCards headingLevel={2} />
    </div>
  );
}
