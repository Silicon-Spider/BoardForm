// The help topics: metadata (order, groups, one-line summaries) plus the Markdown sources in
// ./topics/<id>.md, and the docs/ specs that topics include by name. Rendering is cached per topic.
// Pure module (no React): the tests import it in Node.

import { renderArticle, type RenderedArticle } from "./markdown";

export type TopicGroupId = "start" | "build" | "networks" | "play" | "data";

export interface TopicGroup {
  id: TopicGroupId;
  label: string;
}

export interface TopicMeta {
  /** Route id: #/help/<id>. */
  id: string;
  /** Short name for the navigation. */
  nav: string;
  /** One line for cards and search results. */
  summary: string;
  group: TopicGroupId;
}

export const TOPIC_GROUPS: readonly TopicGroup[] = [
  { id: "start", label: "Start here" },
  { id: "build", label: "Build engines" },
  { id: "networks", label: "Neural networks" },
  { id: "play", label: "Play & compare" },
  { id: "data", label: "Your data" },
];

/** In reading order (previous / next follow it). Ids are the ones in docs/ARCHITECTURE.md §6. */
export const TOPICS: readonly TopicMeta[] = [
  {
    id: "getting-started",
    nav: "Getting started",
    summary: "What Chess Builder does, the three starter engines and where everything is.",
    group: "start",
  },
  {
    id: "blocks",
    nav: "Blocks editor",
    summary: "Build an evaluation from drag-and-drop blocks, with every block explained.",
    group: "build",
  },
  {
    id: "eval-api",
    nav: "Evaluation code",
    summary: "Write evaluate() in AssemblyScript with the engine's helper library.",
    group: "build",
  },
  {
    id: "full-engine",
    nav: "Full engine code",
    summary: "The template's files, how its search works, and how to measure changes.",
    group: "build",
  },
  {
    id: "scratch",
    nav: "From scratch",
    summary: "Write a whole engine yourself, step by step, and test it with perft.",
    group: "build",
  },
  {
    id: "abi",
    nav: "Engine ABI & .wasm",
    summary: "The interface every engine implements, and uploading engines written in C, Rust or Zig.",
    group: "build",
  },
  {
    id: "nnue",
    nav: "NNUE networks",
    summary: "Train neural-network evaluations with self-play in the NNUE Lab.",
    group: "networks",
  },
  {
    id: "play-and-arena",
    nav: "Play & Arena",
    summary: "Play and analyse with your engines, run matches, and read Elo and LOS.",
    group: "play",
  },
  {
    id: "limits",
    nav: "Limits & time controls",
    summary: "Depth, nodes, time per move and clocks — and how to pick fair settings.",
    group: "play",
  },
  {
    id: "storage",
    nav: "Saving & backups",
    summary: "Where your data lives, backups, import and export, and clearing data.",
    group: "data",
  },
];

/** Common tasks on the help home, each linking to the section that explains it. */
export const HELP_TASKS: ReadonlyArray<{ label: string; topic: string; section: string | null }> = [
  { label: "Change a bonus in Blocky, the blocks engine", topic: "blocks", section: "editing-blocks" },
  { label: "Reward a pawn on the 7th rank", topic: "blocks", section: "worked-example-a-pawn-on-the-7th-rank" },
  { label: "Write my own evaluate() function", topic: "eval-api", section: "your-first-evaluation" },
  { label: "Understand the engine's search", topic: "full-engine", section: "how-the-search-works" },
  { label: "Write an engine from scratch", topic: "scratch", section: "from-the-empty-skeleton-to-a-working-engine" },
  { label: "Upload an engine written in C, Rust or Zig", topic: "abi", section: "uploading-a-wasm-engine" },
  { label: "Train a neural network with self-play", topic: "nnue", section: "the-nnue-lab" },
  { label: "Find out whether a change made my engine stronger", topic: "play-and-arena", section: "elo-and-los" },
  { label: "Pick fair limits for a match", topic: "limits", section: "choosing-fair-limits-for-matches" },
  { label: "Back up my engines and networks", topic: "storage", section: "backups" },
];

const topicSources = import.meta.glob("./topics/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const specSources = import.meta.glob(["/docs/ENGINE_ABI.md", "/docs/ENGINE_TEMPLATE.md", "/docs/NNUE_FORMAT.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Topic Markdown keyed by topic id ("blocks" → contents of topics/blocks.md). */
export const TOPIC_SOURCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(topicSources).map(([path, text]) => [baseName(path).replace(/\.md$/, ""), text])),
);

/** The specs topics may include with `<!-- include: NAME -->`, keyed by file name. */
export const SPEC_SOURCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(specSources).map(([path, text]) => [baseName(path), text])),
);

/** Which topic explains each spec (links such as "ENGINE_ABI.md" in the specs point there). */
export const SPEC_TOPICS: Readonly<Record<string, string>> = {
  "ENGINE_ABI.md": "abi",
  "ENGINE_TEMPLATE.md": "eval-api",
  "NNUE_FORMAT.md": "nnue",
};

export function getTopic(id: string | null | undefined): TopicMeta | null {
  return TOPICS.find((t) => t.id === id) ?? null;
}

export function groupLabel(id: TopicGroupId): string {
  return TOPIC_GROUPS.find((g) => g.id === id)?.label ?? "";
}

/** The topics before and after `id` in reading order. */
export function neighbours(id: string): { previous: TopicMeta | null; next: TopicMeta | null } {
  const i = TOPICS.findIndex((t) => t.id === id);
  if (i < 0) return { previous: null, next: null };
  return { previous: TOPICS[i - 1] ?? null, next: TOPICS[i + 1] ?? null };
}

const cache = new Map<string, RenderedArticle>();

/** The rendered article of a topic (cached), or null for an unknown topic. */
export function getArticle(id: string): RenderedArticle | null {
  const cached = cache.get(id);
  if (cached) return cached;
  const source = TOPIC_SOURCES[id];
  if (source === undefined || !getTopic(id)) return null;
  const article = renderArticle(source, { topicId: id, includes: SPEC_SOURCES, docTopics: SPEC_TOPICS });
  cache.set(id, article);
  return article;
}

/** Display title of a topic: the Markdown's "# Title", falling back to its navigation name. */
export function topicTitle(topic: TopicMeta): string {
  return getArticle(topic.id)?.title || topic.nav;
}

/** Estimated reading time in minutes (200 words per minute, at least 1). */
export function readingMinutes(article: RenderedArticle): number {
  return Math.max(1, Math.round(article.words / 200));
}
