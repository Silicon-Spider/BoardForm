// Engine Library (routes "#/" and "#/engines"): every engine as a card with search, kind filter
// and sort; actions to open, play, match, duplicate, export and delete; importing engine files;
// and the new-engine wizard ("?new=1", optionally "&kind=<EngineKind>&networkId=<id>").
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { navigate, setQuery, type PageProps } from "@/app/router";
import { toast } from "@/app/toast";
import { EmptyState, Icon, KIND_LABELS, useConfirm } from "@/components";
import { enginesRepo, importEngineFile, useEngines, useNetworks, useSetting } from "@/storage";
import type { EngineKind, EngineRecord } from "@/types";
import { plural } from "@/utils/format";
import { pickFile } from "@/utils/misc";
import { duplicateEngine, errorMessage, exportEngine, restoreStarterEngines } from "./actions";
import { EngineCard, SkeletonCard, type CardAction } from "./EngineCard";
import {
  ENGINE_KINDS,
  KIND_FILTER_SETTING,
  LIBRARY_SORTS,
  SORT_SETTING,
  countByKind,
  filterEngines,
  isEngineKind,
  isKindFilter,
  isLibrarySort,
  sortEngines,
  type KindFilter,
  type LibrarySort,
} from "./filters";
import { PageIcon } from "./icons";
import { APPROACHES, ApproachIcon, NewEngineWizard, approachColor } from "./NewEngineWizard";
import { isTypingTarget, useNow } from "./ui";
import "./engines.css";

/** Highlight for a card that was just created by "Duplicate". */
const HIGHLIGHT_MS = 2400;

export default function EnginesPage({ query }: PageProps) {
  const engines = useEngines();
  const networks = useNetworks();
  const confirm = useConfirm();
  const now = useNow(30_000);
  const searchRef = useRef<HTMLInputElement>(null);

  const [storedKind, setStoredKind] = useSetting<string>(KIND_FILTER_SETTING, "all");
  const [storedSort, setStoredSort] = useSetting<string>(SORT_SETTING, "updated");
  const kind: KindFilter = isKindFilter(storedKind) ? storedKind : "all";
  const sort: LibrarySort = isLibrarySort(storedSort) ? storedSort : "updated";
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // --- wizard (state lives in the URL so links can open it) ---
  const wizardOpen = query.get("new") === "1";
  const queryKind = query.get("kind");
  const initialKind: EngineKind | null = isEngineKind(queryKind) ? queryKind : null;
  const initialNetworkId = query.get("networkId") || null;
  const openWizard = useCallback((kindToOpen?: EngineKind) => setQuery({ new: "1", kind: kindToOpen ?? null, networkId: null }), []);
  const closeWizard = useCallback(() => setQuery({ new: null, kind: null, networkId: null }), []);
  const onCreated = useCallback((engine: EngineRecord) => {
    // Replace "?new=1" first, so Back from the Workshop returns to the plain library.
    setQuery({ new: null, kind: null, networkId: null });
    navigate(`/engines/${encodeURIComponent(engine.id)}`);
    toast(`Created “${engine.name}”`, { kind: "success" });
  }, []);

  // --- derived lists (memoized: ~200 engines re-filter only when something changes) ---
  const counts = useMemo(() => countByKind(engines ?? []), [engines]);
  const visible = useMemo(() => (engines ? sortEngines(filterEngines(engines, { query: deferredSearch, kind }), sort) : []), [engines, deferredSearch, kind, sort]);
  const networkNames = useMemo(() => (networks ? new Map(networks.map((n) => [n.id, n.name || "Untitled network"])) : null), [networks]);

  // --- card actions: one stable callback, so memoized cards do not re-render ---
  const latest = useRef({ engines, confirm });
  useLayoutEffect(() => {
    latest.current = { engines, confirm };
  });
  const onAction = useCallback(async (action: CardAction, engine: EngineRecord) => {
    const name = engine.name || "Untitled engine";
    if (action === "duplicate") {
      try {
        const copy = await duplicateEngine(engine, (latest.current.engines ?? []).map((e) => e.name));
        setHighlightId(copy.id);
        toast(`Created “${copy.name}”`, { kind: "success" });
      } catch (err) {
        toast(`Could not duplicate “${name}”`, { kind: "error", detail: errorMessage(err) });
      }
    } else if (action === "export") {
      try {
        const fileName = await exportEngine(engine);
        toast(`Exported “${name}”`, { kind: "success", detail: fileName });
      } catch (err) {
        toast(`Could not export “${name}”`, { kind: "error", detail: errorMessage(err) });
      }
    } else {
      const ok = await latest.current.confirm({
        title: `Delete “${name}”?`,
        message: (
          <>
            <p>
              {engine.kind === "wasm" ? "Its uploaded module is" : engine.kind === "blocks" ? "Its blocks, generated code and builds are" : "Its source files and builds are"}{" "}
              removed from this browser. Saved games and match results that include it are kept.
            </p>
            {engine.networkId && <p>Its NNUE network stays in the NNUE Lab.</p>}
            {engine.builtin && <p>Starter engines can be added back in Settings → Restore starter engines.</p>}
          </>
        ),
        confirmLabel: "Delete engine",
        danger: true,
      });
      if (!ok) return;
      try {
        await enginesRepo.remove(engine.id);
        toast(`Deleted “${name}”`, { kind: "success" });
      } catch (err) {
        toast(`Could not delete “${name}”`, { kind: "error", detail: errorMessage(err) });
      }
    }
  }, []);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // "/" focuses the search box (unless typing somewhere or a dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (!searchRef.current) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onImport = async () => {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    setImporting(true);
    try {
      const id = await importEngineFile(file);
      const imported = await enginesRepo.get(id);
      toast(`Imported “${imported?.name ?? file.name}”`, { kind: "success" });
      navigate(`/engines/${encodeURIComponent(id)}`);
    } catch (err) {
      toast("Could not import the engine", { kind: "error", detail: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  const onRestore = async () => {
    setRestoring(true);
    try {
      await restoreStarterEngines();
      toast("Starter engines restored", { kind: "success", detail: "Blocky, Classic and Sprout are back in your library." });
    } catch (err) {
      toast("Could not restore the starter engines", { kind: "error", detail: errorMessage(err) });
    } finally {
      setRestoring(false);
    }
  };

  const clearFilters = () => {
    setSearch("");
    if (kind !== "all") setStoredKind("all");
  };

  const total = engines?.length ?? 0;
  const filtered = search.trim() !== "" || kind !== "all";

  return (
    <div className="page engines-page">
      <header className="page-header engines-header">
        <div className="engines-header-text">
          <h1>Your engines</h1>
          <p className="page-subtitle">Build chess engines from blocks or code, compile them to WebAssembly right here, then play them or pit them against each other.</p>
        </div>
        <div className="engines-header-actions">
          <button type="button" className="btn" onClick={onImport} disabled={importing}>
            {importing ? <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> : <PageIcon name="upload" />}
            {importing ? "Importing…" : "Import engine"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => openWizard()}>
            <Icon name="plus" /> New engine
          </button>
        </div>
      </header>

      {engines === undefined ? (
        <div className="engines-grid" aria-busy="true" aria-label="Loading your engines">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : total === 0 ? (
        <LibraryEmpty onNew={openWizard} onRestore={onRestore} restoring={restoring} />
      ) : (
        <>
          <div className="engines-toolbar" role="search" aria-label="Find engines">
            <div className="engines-search">
              <Icon name="search" className="engines-search-icon" />
              <input
                ref={searchRef}
                type="search"
                className="input engines-search-input"
                placeholder="Search names, descriptions and tags"
                aria-label="Search engines"
                aria-keyshortcuts="/"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && search) {
                    e.preventDefault();
                    setSearch("");
                  }
                }}
              />
              <kbd className="engines-search-kbd" aria-hidden="true">
                /
              </kbd>
            </div>
            <label className="engines-select">
              <span className="engines-select-label">Kind</span>
              <select className="select" value={kind} onChange={(e) => setStoredKind(e.target.value)}>
                <option value="all">All kinds ({counts.all})</option>
                {ENGINE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]} ({counts[k]})
                  </option>
                ))}
              </select>
            </label>
            <label className="engines-select">
              <span className="engines-select-label">Sort</span>
              <select className="select" value={sort} onChange={(e) => setStoredSort(e.target.value)}>
                {LIBRARY_SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="engines-count small muted num" aria-live="polite">
              {filtered ? `${visible.length} of ${plural(total, "engine")}` : plural(total, "engine")}
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              compact
              className="engines-noresults"
              icon={<Icon name="search" size={22} />}
              title="No engines match"
              description={
                search.trim()
                  ? `Nothing ${kind === "all" ? "" : `of kind “${KIND_LABELS[kind as EngineKind]}” `}matches “${search.trim()}”.`
                  : `You have no ${KIND_LABELS[kind as EngineKind]} engines yet.`
              }
              action={
                <>
                  <button type="button" className="btn" onClick={clearFilters}>
                    Clear filters
                  </button>
                  {kind !== "all" && !search.trim() && (
                    <button type="button" className="btn btn-primary" onClick={() => openWizard(kind as EngineKind)}>
                      <Icon name="plus" /> New {KIND_LABELS[kind as EngineKind]} engine
                    </button>
                  )}
                </>
              }
            />
          ) : (
            <div className="engines-grid">
              {visible.map((e) => (
                <EngineCard
                  key={e.id}
                  engine={e}
                  networkName={e.networkId && networkNames ? (networkNames.get(e.networkId) ?? null) : null}
                  networkMissing={!!e.networkId && !!networkNames && !networkNames.has(e.networkId)}
                  now={now}
                  highlighted={highlightId === e.id}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
        </>
      )}

      {wizardOpen && <NewEngineWizard initialKind={initialKind} initialNetworkId={initialNetworkId} onClose={closeWizard} onCreated={onCreated} />}
    </div>
  );
}

/** First-run style empty state: the ways to build an engine, each opening the wizard. */
function LibraryEmpty({ onNew, onRestore, restoring }: { onNew: (kind?: EngineKind) => void; onRestore: () => void; restoring: boolean }) {
  return (
    <EmptyState
      className="engines-empty"
      icon={<img src="/pieces/chessnut/wN.svg" alt="" />}
      title="No engines yet"
      description="An engine is a small WebAssembly program that picks chess moves. Start one in any of these ways — you can change everything later."
      action={
        <>
          <button type="button" className="btn btn-primary" onClick={() => onNew()}>
            <Icon name="plus" /> New engine
          </button>
          <button type="button" className="btn" onClick={onRestore} disabled={restoring}>
            {restoring ? <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> : <PageIcon name="refresh" />}
            Restore starter engines
          </button>
        </>
      }
    >
      <div className="engines-empty-ways">
        {APPROACHES.flatMap((a) =>
          a.kind === null
            ? []
            : [
                <button
                  key={a.id}
                  type="button"
                  className="engines-empty-way"
                  style={{ "--approach-color": approachColor(a) } as CSSProperties}
                  onClick={() => onNew(a.kind ?? undefined)}
                >
                  <span className="engines-approach-icon" aria-hidden="true">
                    <ApproachIcon info={a} size={18} />
                  </span>
                  <span className="engines-approach-text">
                    <span className="engines-approach-title">{a.title}</span>
                    <span className="engines-approach-desc">{a.description}</span>
                  </span>
                </button>,
              ],
        )}
      </div>
      <p className="small faint engines-empty-note">“Restore starter engines” brings back Blocky (blocks), Classic (evaluation code) and Sprout (a small engine written from scratch).</p>
    </EmptyState>
  );
}
