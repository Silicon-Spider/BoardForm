// Searchable reference of the engine API (ENGINE_API), grouped by template module. Keyboard:
// the search box drives the list like a combobox (↑ ↓ PageUp PageDown move, Enter inserts,
// Esc clears); the highlighted entry shows its full documentation.
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { ENGINE_API, ENGINE_API_MODULES, apiSnippet, compareModules, memberOf, moduleName } from "./api";
import { docParts } from "./docParts";
import type { ApiEntry } from "./types";
import "./ApiReference.css";

export interface ApiReferenceProps {
  /** Called with a call / reference snippet ("popcount()", "pos.phase()", "PAWN"). Shows Insert buttons. */
  onInsert?(snippet: string, entry: ApiEntry): void;
  /** Only these modules ("evalkit" or "evalkit.ts" both work). Default: all. */
  modules?: string[];
  className?: string;
}

const KIND_LETTER: Record<ApiEntry["kind"], string> = { function: "f", method: "m", constant: "c", variable: "v", class: "C", type: "T" };
const KIND_LABEL: Record<ApiEntry["kind"], string> = { function: "function", method: "method", constant: "constant", variable: "field", class: "class", type: "type" };
const SQUARE = /^[A-H][1-8]$/;

/** One row of the list: an entry, or the compact "A1 … H8" square-constants row. */
type Row =
  | { kind: "entry"; key: string; entry: ApiEntry }
  | { kind: "squares"; key: string; module: string; squares: ApiEntry[] };

interface Group {
  module: string;
  file: string;
  summary: string;
  rows: Row[];
  total: number;
}

function matchScore(entry: ApiEntry, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = entry.name.toLowerCase();
  const short = (memberOf(entry)?.member ?? entry.name).toLowerCase();
  const hay = `${name} ${entry.signature.toLowerCase()} ${entry.module} ${entry.doc.toLowerCase()}`;
  let score = 0;
  for (const t of terms) {
    if (!hay.includes(t)) return 0;
    if (short === t) score += 100;
    else if (short.startsWith(t)) score += 50;
    else if (name.includes(t)) score += 20;
    else if (entry.signature.toLowerCase().includes(t)) score += 5;
    else score += 1;
  }
  return score;
}

function buildGroups(query: string, modules: string[] | undefined): Group[] {
  const allowed = modules ? new Set(modules.map((m) => moduleName(m))) : null;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const byModule = new Map<string, Array<{ entry: ApiEntry; score: number; index: number }>>();
  ENGINE_API.forEach((entry, index) => {
    if (allowed && !allowed.has(entry.module)) return;
    const score = matchScore(entry, terms);
    if (score <= 0) return;
    let list = byModule.get(entry.module);
    if (!list) byModule.set(entry.module, (list = []));
    list.push({ entry, score, index });
  });
  const groups: Group[] = [];
  for (const [module, list] of [...byModule].sort((a, b) => compareModules(a[0], b[0]))) {
    if (terms.length) list.sort((a, b) => b.score - a.score || a.index - b.index);
    const squares = list.filter((x) => x.entry.kind === "constant" && SQUARE.test(x.entry.name));
    const rows: Row[] = [];
    let squaresAdded = false;
    for (const { entry } of list) {
      if (squares.length > 8 && entry.kind === "constant" && SQUARE.test(entry.name)) {
        if (!squaresAdded) rows.push({ kind: "squares", key: `${module}:squares`, module, squares: squares.map((s) => s.entry) });
        squaresAdded = true;
        continue;
      }
      rows.push({ kind: "entry", key: `${module}:${entry.name}`, entry });
    }
    const info = ENGINE_API_MODULES.find((m) => m.module === module);
    groups.push({ module, file: info?.file ?? `${module}.ts`, summary: info?.summary ?? "", rows, total: list.length });
  }
  return groups;
}

function DocText({ text }: { text: string }) {
  return (
    <>
      {docParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Signature with the symbol name emphasised; members get a faint "Owner." prefix. */
function Signature({ entry }: { entry: ApiEntry }) {
  const member = memberOf(entry);
  const isStatic = entry.signature.startsWith("static ");
  const sig = isStatic ? entry.signature.slice(7) : entry.signature;
  const name = member ? member.member : entry.name;
  let head: ReactNode = null;
  let rest = sig;
  let prefix = "";
  for (const kw of ["class ", "enum ", "type ", "interface ", "namespace "]) {
    if (rest.startsWith(kw)) {
      prefix = kw;
      rest = rest.slice(kw.length);
    }
  }
  if (rest.startsWith(name)) {
    head = <span className="cb-api-name">{name}</span>;
    rest = rest.slice(name.length);
  }
  return (
    <code className="cb-api-sig">
      {isStatic && <span className="cb-api-faint">static </span>}
      {prefix && <span className="cb-api-kw">{prefix}</span>}
      {member && <span className="cb-api-faint">{member.owner}.</span>}
      {head}
      {rest}
    </code>
  );
}

const SQUARE_ROWS = ["8", "7", "6", "5", "4", "3", "2", "1"];
const FILES = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** API reference panel. Fills its container (give it a height); compact enough for a side panel. */
export function ApiReference({ onInsert, modules, className }: ApiReferenceProps): JSX.Element {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modulesKey = modules?.join("|");

  // `modules` is compared by content (callers often pass a new array on every render).
  const groups = useMemo(() => buildGroups(deferred, modules), [deferred, modulesKey]);
  const searching = deferred.trim() !== "";
  const total = useMemo(() => buildGroups("", modules).reduce((n, g) => n + g.total, 0), [modulesKey]);
  const shown = groups.reduce((n, g) => n + g.total, 0);
  const visibleRows = useMemo(() => groups.flatMap((g) => (searching || !collapsed.has(g.module) ? g.rows : [])), [groups, collapsed, searching]);

  // Keep the highlighted row valid: the first match while searching, else the previous one.
  const active = visibleRows.find((r) => r.key === activeKey) ?? (searching ? visibleRows[0] : undefined);
  const activeIndex = active ? visibleRows.indexOf(active) : -1;
  const optionId = (key: string) => `${listId}-${key.replace(/[^\w-]/g, "_")}`;

  useEffect(() => {
    if (!active) return;
    const el = document.getElementById(optionId(active.key));
    el?.scrollIntoView({ block: "nearest" });
  }, [active?.key]);

  const insert = (row: Row, squareName?: string) => {
    if (!onInsert) return;
    if (row.kind === "squares") {
      // The compact row itself inserts nothing; its square buttons do.
      const entry = squareName ? row.squares.find((s) => s.name === squareName) : undefined;
      if (entry) onInsert(entry.name, entry);
    } else onInsert(apiSnippet(row.entry), row.entry);
  };

  const move = (delta: number) => {
    if (visibleRows.length === 0) return;
    const next = activeIndex < 0 ? (delta > 0 ? 0 : visibleRows.length - 1) : Math.min(visibleRows.length - 1, Math.max(0, activeIndex + delta));
    setActiveKey(visibleRows[next].key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(8);
    else if (e.key === "PageUp") move(-8);
    else if (e.key === "Enter") {
      if (active) insert(active);
      else return;
    } else if (e.key === "Escape") {
      if (query === "") return;
      setQuery("");
    } else return;
    e.preventDefault();
  };

  const toggleGroup = (module: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(module)) next.delete(module);
      else next.add(module);
      return next;
    });

  return (
    <div className={"cb-api" + (className ? " " + className : "")}>
      <div className="cb-api-search">
        <Icon name="search" size={14} className="cb-api-search-icon" />
        <input
          ref={inputRef}
          className="input input-sm cb-api-input"
          type="search"
          placeholder="Search the engine API…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Search the engine API"
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active.key) : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm cb-api-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <div className="cb-api-meta" aria-live="polite">
        {searching ? `${shown} of ${total} symbols` : `${total} symbols in ${groups.length} files`}
        {onInsert && <span className="cb-api-hint">↑↓ to browse · Enter inserts</span>}
      </div>

      <div ref={listRef} id={listId} className="cb-api-list" role="listbox" aria-label="Engine API">
        {groups.length === 0 && (
          <div className="cb-api-empty">
            <p>No symbols match “{deferred.trim()}”.</p>
            <button type="button" className="btn btn-sm" onClick={() => setQuery("")}>
              Clear search
            </button>
          </div>
        )}
        {groups.map((g) => {
          const open = searching || !collapsed.has(g.module);
          return (
            <div key={g.module} className="cb-api-group" role="group" aria-label={g.file}>
              <button type="button" className="cb-api-group-head" aria-expanded={open} onClick={() => toggleGroup(g.module)} title={g.summary || undefined}>
                <svg className={"cb-api-chevron" + (open ? " is-open" : "")} viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="cb-api-file">{g.file}</span>
                {g.summary && <span className="cb-api-summary">{g.summary}</span>}
                <span className="cb-api-count">{g.total}</span>
              </button>
              {open &&
                g.rows.map((row) => {
                  const isActive = active?.key === row.key;
                  if (row.kind === "squares") {
                    return (
                      <div
                        key={row.key}
                        id={optionId(row.key)}
                        role="option"
                        aria-selected={isActive}
                        className={"cb-api-item cb-api-item--squares" + (isActive ? " is-active" : "")}
                        onClick={() => setActiveKey(isActive ? null : row.key)}
                      >
                        <div className="cb-api-line">
                          <span className="cb-api-kind" data-kind="constant" aria-hidden="true">c</span>
                          <code className="cb-api-sig">
                            <span className="cb-api-name">A1</span> … <span className="cb-api-name">H8</span>: i32
                          </code>
                        </div>
                        <div className="cb-api-doc">
                          {row.squares.length} named squares: A1 = 0, B1 = 1 … H8 = 63.{isActive ? (onInsert ? " Click a square to insert it." : "") : " Select to show the board."}
                        </div>
                        {isActive && (
                        <div className="cb-api-squares" role="presentation">
                          {SQUARE_ROWS.map((rank) =>
                            FILES.map((file) => {
                              const name = file + rank;
                              const present = row.squares.some((s) => s.name === name);
                              return (
                                <button
                                  key={name}
                                  type="button"
                                  tabIndex={-1}
                                  className="cb-api-square"
                                  disabled={!present || !onInsert}
                                  title={onInsert ? `Insert ${name}` : name}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    insert(row, name);
                                  }}
                                >
                                  {name}
                                </button>
                              );
                            }),
                          )}
                        </div>
                        )}
                      </div>
                    );
                  }
                  const { entry } = row;
                  return (
                    <div
                      key={row.key}
                      id={optionId(row.key)}
                      role="option"
                      aria-selected={isActive}
                      className={"cb-api-item" + (isActive ? " is-active" : "")}
                      onClick={() => setActiveKey(isActive ? null : row.key)}
                      onDoubleClick={() => insert(row)}
                    >
                      <div className="cb-api-line">
                        <span className="cb-api-kind" data-kind={entry.kind} title={KIND_LABEL[entry.kind]} aria-label={KIND_LABEL[entry.kind]}>
                          {KIND_LETTER[entry.kind]}
                        </span>
                        <Signature entry={entry} />
                        {onInsert && (
                          <button
                            type="button"
                            tabIndex={-1}
                            className="btn btn-ghost btn-sm cb-api-insert"
                            title={`Insert ${apiSnippet(entry)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              insert(row);
                            }}
                          >
                            Insert
                          </button>
                        )}
                      </div>
                      {entry.doc ? (
                        <div className="cb-api-doc">
                          {isActive ? (
                            entry.doc.split("\n\n").map((p, i) => (
                              <p key={i}>
                                <DocText text={p} />
                              </p>
                            ))
                          ) : (
                            // The first paragraph, clamped to two lines by CSS.
                            <DocText text={entry.doc.split("\n\n")[0]} />
                          )}
                        </div>
                      ) : (
                        isActive && <div className="cb-api-doc cb-api-faint">No description.</div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
