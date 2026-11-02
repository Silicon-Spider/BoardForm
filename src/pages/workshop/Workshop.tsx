// The Workshop for one engine: header, the kind-specific main area (blocks / eval.ts / files /
// module), a resizable side panel with tabs (Test, Generated code, API reference, Engine source,
// Build log, Settings) that collapses into one tab strip on narrow screens.
//
// State: the EngineDraft (autosave) is the source of truth for everything the editors show; the
// build store keeps the last build result; the EngineSession runs the test engine.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { navigate, setQuery } from "@/app/router";
import { dismissToast, toast } from "@/app/toast";
import { DEFAULT_WORKSPACE, generateEvalSource, type BlocksEditorHandle } from "@/blocks";
import { Tabs, useConfirm, type TabItem } from "@/components";
import { ApiReference } from "@/components/code";
import { preloadCompiler } from "@/compiler";
import { BuildError, TEMPLATE_VERSION, assembleSources, sourceHashOf, templateFiles } from "@/engine-host";
import { StorageError, enginesRepo, exportEngineFile, newId, useSetting } from "@/storage";
import type { EngineKind, EngineRecord } from "@/types";
import { clamp, formatBytes, formatDuration } from "@/utils/format";
import { downloadBlob, slugify } from "@/utils/misc";
import { AreaBoundary } from "./AreaBoundary";
import { BlocksMain } from "./BlocksMain";
import { BuildLog } from "./BuildLog";
import { recordFailedBuild, runBuild, useEngineBuild } from "./build-store";
import type { CodePaneHandle } from "./CodePane";
import { EngineDraft } from "./draft";
import { EvalMain, templateEvalFor } from "./EvalMain";
import { FilesMain } from "./FilesMain";
import { WorkshopHeader } from "./Header";
import { blocksToCodeRecord, conversionFor, convertedEvalSource, duplicateRecord, entryOf, filePatch, unlockFullRecord } from "./records";
import { EngineSession } from "./session";
import { SettingsPanel } from "./SettingsPanel";
import { buildPillFor, errorsOf, type SourceHash } from "./status";
import { EngineSource, GeneratedCode } from "./SourcePanels";
import { TestBench } from "./bench/TestBench";
import type { RevealTarget, SideTabId, TabId } from "./types";
import { IS_MAC, type MenuItem, useMediaQuery } from "./ui";
import { WasmMain } from "./WasmMain";
import { clearBackup, editsToRestore, readBackup, writeBackup } from "./unsaved";

const SIDE_TABS: Record<EngineKind, SideTabId[]> = {
  blocks: ["test", "code", "build", "settings"],
  eval: ["test", "api", "source", "build", "settings"],
  nnue: ["test", "api", "source", "build", "settings"],
  full: ["test", "api", "build", "settings"],
  scratch: ["test", "build", "settings"],
  wasm: ["test", "settings"],
};

const TAB_LABELS: Record<SideTabId, string> = {
  test: "Test",
  code: "Generated code",
  api: "API reference",
  source: "Engine source",
  build: "Build log",
  settings: "Settings",
};

const EDITOR_LABELS: Record<EngineKind, string> = { blocks: "Blocks", eval: "eval.ts", nnue: "eval.ts", full: "Files", scratch: "Files", wasm: "Module" };

const SIDE_WIDTH_KEY = "workshop.sideWidth";
const DEFAULT_SIDE_WIDTH = 480;
const MIN_SIDE = 340;
const MIN_MAIN = 380;
const NARROW_QUERY = "(max-width: 900px)";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------
// Hooks

/** The autosave draft for this engine, fed with every stored version and flushed when leaving. */
function useDraft(stored: EngineRecord): EngineDraft {
  const [draft] = useState(
    () =>
      new EngineDraft(stored, (id, patch) => enginesRepo.update(id, patch), {
        delayMs: 500,
        isGoneError: (err) => err instanceof StorageError && err.code === "not-found",
      }),
  );
  useEffect(() => {
    draft.receive(stored);
  }, [draft, stored]);
  // While the page is going away, every change of the unsaved edits is also copied to
  // localStorage (synchronous, so it survives the unload); the copy goes once all is stored.
  const closing = useRef(false);
  const backedUp = useRef(false);
  // Edits that a reload or a closed tab interrupted before they reached IndexedDB (see unsaved.ts):
  // apply them again, once, when the engine opens (the copy goes once they are saved).
  const initial = useRef(stored);
  useEffect(() => {
    const backup = readBackup(initial.current.id);
    const edits = editsToRestore(backup, initial.current);
    if (edits) {
      backedUp.current = true;
      draft.edit(edits);
    } else if (backup) clearBackup(initial.current.id);
  }, [draft]);
  const backUp = useCallback(() => {
    const edits = draft.unsaved();
    if (edits && writeBackup(draft.id, edits, Date.now())) backedUp.current = true;
  }, [draft]);
  // A failed save is shown in the header; the first time a message appears it is also toasted so
  // it cannot go unnoticed. (A deleted engine is reported by the page itself.)
  useEffect(() => {
    let lastError: string | null = null;
    return draft.subscribe(() => {
      const s = draft.getSnapshot();
      if (s.error && s.error !== lastError && !s.gone) toast("Your changes could not be saved", { kind: "error", detail: `${s.error.replace(/\.?\s*$/, ".")} Your edits are kept and saved with your next change (or press Retry).` });
      lastError = s.error;
      if (closing.current) backUp();
      if (backedUp.current && (s.state === "saved" || s.gone)) {
        clearBackup(draft.id);
        backedUp.current = false;
      }
    });
  }, [draft, backUp]);
  useEffect(() => {
    draft.open();
    // Leaving / hiding the page: save now and save later edits at once instead of debounced (the
    // blocks editor delivers its last debounced change from its own listeners, which run after
    // these), with a localStorage copy of whatever is not stored yet. Back on screen: debounced again.
    const hide = () => {
      closing.current = true;
      draft.close();
      backUp();
    };
    const show = () => {
      closing.current = false;
      draft.open();
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? hide() : show());
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) show();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Save now, and save at once what arrives next: the blocks editor hands over its pending
      // change from its own beforeunload listener, which runs after this one. Writes started here
      // usually finish while the browser loads the next page (at pagehide it would be too late);
      // the localStorage copy covers the ones it cuts off.
      hide();
      // Only a failed save would lose work; routine autosaves finish on their own.
      if (draft.getSnapshot().state === "error" && !draft.getSnapshot().gone) e.preventDefault();
      // The page may stay (the user cancelled leaving): back to debounced saving after a moment.
      setTimeout(() => {
        if (document.visibilityState === "visible") show();
      }, 2000);
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      // Leaving the Workshop inside the app: the page stays alive, so the write finishes.
      closing.current = false;
      draft.close();
    };
  }, [draft, backUp]);
  return draft;
}

/**
 * Hash of the engine's current sources (debounced while typing), to tell whether the saved build
 * is current. When a build finishes (`buildSeq` changes) it is worked out at once: otherwise a
 * build started right after an edit could finish before the debounced hash catches up, and the
 * header would briefly call the failed build "Up to date" ("you changed the code since").
 */
function useSourceHash(view: EngineRecord, buildSeq: number): SourceHash {
  const [state, setState] = useState<SourceHash>({ hash: null, problem: null, seq: buildSeq });
  const first = useRef(true);
  const lastSeq = useRef(buildSeq);
  const { kind, files, blocks, entry, generatorVersion } = view;
  useEffect(() => {
    if (kind === "wasm") return;
    let cancelled = false;
    const afterBuild = lastSeq.current !== buildSeq;
    lastSeq.current = buildSeq;
    const delay = first.current || afterBuild ? 0 : 250;
    first.current = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hash = await sourceHashOf(assembleSources({ ...view, kind, files, blocks, entry, generatorVersion }));
          if (!cancelled) setState({ hash, problem: null, seq: buildSeq });
        } catch (err) {
          if (!cancelled) setState({ hash: null, problem: messageOf(err), seq: buildSeq });
        }
      })();
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `view` itself changes on every edit; only the fields that go into the build matter.
  }, [kind, files, blocks, entry, generatorVersion, buildSeq]);
  // Worked out before the latest build finished: unknown until it is recomputed (a moment).
  return state.seq === buildSeq ? state : { hash: null, problem: null, seq: buildSeq };
}

// ---------------------------------------------------------------------------------------------

export function Workshop({ stored, query }: { stored: EngineRecord; query: URLSearchParams }) {
  const draft = useDraft(stored);
  const snap = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const view = snap.view;
  const kind = view.kind;
  const build = useEngineBuild(view.id);
  const source = useSourceHash(view, build.last?.seq ?? 0);
  const confirm = useConfirm();
  const narrow = useMediaQuery(NARROW_QUERY);
  const editorRef = useRef<CodePaneHandle>(null);
  // The block editor hands over an edit ~300 ms after it happened (its debounce, see @/blocks).
  // Save, Build, the test engine, Convert and Export call flushBlocks() first, so Ctrl+S / Ctrl+B /
  // Build pressed right after editing a block include that edit (it reaches the draft synchronously).
  const blocksRef = useRef<BlocksEditorHandle>(null);
  const flushBlocks = useCallback(() => blocksRef.current?.flush(), []);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const revealNonce = useRef(0);
  const [sourceFile, setSourceFile] = useState("main.ts");

  // Warm up the compiler while the user reads the code (it takes a moment to load the first time).
  useEffect(() => {
    if (kind !== "wasm") preloadCompiler();
  }, [kind]);

  // --- the test engine --------------------------------------------------------------------
  const [session] = useState(
    () =>
      new EngineSession({
        engineId: stored.id,
        hashMb: () => draft.view.options?.hashMb ?? 16,
        label: () => draft.view.name,
        prepare: async (onStatus) => {
          onStatus("Saving your changes…");
          flushBlocks();
          if (!(await draft.flush())) throw new Error(`Your latest changes could not be saved: ${draft.getSnapshot().error ?? "unknown error"}`);
          const current = draft.view;
          if (current.kind === "wasm") {
            if (!current.wasm || current.wasm.byteLength === 0) throw new Error("There is no module yet: choose a .wasm file first.");
            return;
          }
          const { run } = await runBuild(current, { onStatus });
          if (!run.ok) {
            if (run.result) throw new BuildError(run.result, `“${current.name}”`);
            throw new Error(run.problem ?? "The engine could not be built.");
          }
        },
        // loadEngine compiled again and failed (the sources changed after our build): show it too.
        onBuildError: (err) => void recordFailedBuild(draft.view, err.result),
      }),
  );
  useEffect(() => {
    session.open();
    return () => session.close();
  }, [session]);

  const sessionState = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  // Restart the engine when what it is started with changes.
  const restartKey = `${view.networkId ?? ""}|${view.options?.hashMb ?? ""}`;
  const lastRestartKey = useRef(restartKey);
  useEffect(() => {
    if (lastRestartKey.current === restartKey) return;
    lastRestartKey.current = restartKey;
    session.restart("the network or hash size changed");
  }, [restartKey, session]);

  // --- tabs & query parameters --------------------------------------------------------------
  const sideTabs = SIDE_TABS[kind];
  const requested = query.get("tab") as TabId | null;
  const requestedSide = requested && (sideTabs as string[]).includes(requested) ? (requested as SideTabId) : null;
  const lastSide = useRef<SideTabId>(requestedSide ?? "test");
  if (requestedSide) lastSide.current = requestedSide;
  const active: TabId = narrow ? (requestedSide ?? "editor") : (requestedSide ?? "test");
  const activeSide: SideTabId = active === "editor" ? lastSide.current : active;
  const visited = useRef(new Set<SideTabId>());
  visited.current.add(activeSide);

  // On narrow screens the tab strip scrolls sideways: keep the active tab visible (e.g. "Build log"
  // opened by a failed build).
  useEffect(() => {
    if (!narrow) return;
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".workshop-stack-tabs .tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [narrow, active]);

  const setTab = useCallback((id: TabId) => setQuery({ tab: id }), []);
  const showBuildLog = useCallback(() => setQuery({ tab: "build" }), []);

  // --- building -----------------------------------------------------------------------------
  const diagnostics = useMemo(() => build.last?.result?.diagnostics ?? [], [build.last]);

  const failureToast = useRef<number | null>(null);
  // A build failure toast is about this engine: it goes when the Workshop closes (or switches to
  // another engine) instead of lingering over the next page. The build log keeps the details.
  useEffect(
    () => () => {
      if (failureToast.current !== null) dismissToast(failureToast.current);
    },
    [],
  );
  const doBuild = useCallback(async () => {
    if (draft.view.kind === "wasm") return;
    flushBlocks();
    if (!(await draft.flush())) {
      toast("Your changes could not be saved, so the engine was not built", { kind: "error", detail: draft.getSnapshot().error ?? undefined });
      return;
    }
    const { run } = await runBuild(draft.view, { force: true });
    if (failureToast.current !== null) {
      dismissToast(failureToast.current);
      failureToast.current = null;
    }
    if (run.ok && run.missingExports?.length) {
      session.restart("new build");
      failureToast.current = toast("Built, but it is not a working engine yet", {
        kind: "warn",
        detail: `The module does not export ${run.missingExports.join(", ")}. Check that the entry file (${entryOf(draft.view)}) exports the ABI functions.`,
      });
      setTab("build");
    } else if (run.ok) {
      session.restart("new build");
      const warnings = run.result ? run.result.diagnostics.filter((d) => d.severity === "warning").length : 0;
      toast(`Build succeeded${run.sizeBytes ? ` · ${formatBytes(run.sizeBytes)}` : ""}`, {
        kind: "success",
        detail: run.result ? `Compiled in ${formatDuration(run.result.timeMs)}${warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}` : undefined,
        timeoutMs: 2500,
      });
    } else {
      const errors = errorsOf(run.result);
      failureToast.current = toast(run.problem ? "The engine cannot be built" : `Build failed${errors.length ? ` — ${errors.length} error${errors.length === 1 ? "" : "s"}` : ""}`, {
        kind: "error",
        detail: run.problem ?? errors[0]?.message,
      });
      setTab("build");
    }
  }, [draft, session, setTab, flushBlocks]);

  const buildClick = useCallback(() => void doBuild(), [doBuild]);

  // --- locations (diagnostics → editor) -------------------------------------------------------
  const canOpen = useCallback(
    (file: string) => {
      const v = draft.view;
      if (v.kind === "full" || v.kind === "scratch") return !!v.files && file in v.files;
      if (v.kind === "eval" || v.kind === "nnue") return file === "eval.ts" || file in templateFiles;
      if (v.kind === "blocks") return file === "eval.ts";
      return false;
    },
    [draft],
  );

  const openLocation = useCallback(
    (file: string, line: number | null, column: number | null) => {
      const v = draft.view;
      const show = (target: string) => setReveal({ target, reveal: { line: line ?? 1, column: column ?? 1, nonce: ++revealNonce.current } });
      if (v.kind === "full" || v.kind === "scratch") {
        if (!v.files || !(file in v.files)) return;
        setQuery(narrow ? { file, tab: "editor" } : { file });
        show(`main:${file}`);
      } else if (v.kind === "eval" || v.kind === "nnue") {
        if (file === "eval.ts") {
          show("main:eval.ts");
          if (narrow) setTab("editor");
        } else if (file in templateFiles) {
          setSourceFile(file);
          setTab("source");
          show(`source:${file}`);
        }
      } else if (v.kind === "blocks" && file === "eval.ts") {
        setTab("code");
        show("generated");
      }
    },
    [draft, narrow, setTab],
  );

  // --- actions --------------------------------------------------------------------------------
  const existingNames = async () => (await enginesRepo.list()).map((e) => e.name);
  const deps = { newId, now: () => Date.now() };

  const createDerived = async (make: (names: string[]) => EngineRecord, done: (r: EngineRecord) => string) => {
    try {
      flushBlocks();
      if (!(await draft.flush())) throw new Error(draft.getSnapshot().error ?? "Your changes could not be saved.");
      const record = make(await existingNames());
      await enginesRepo.put(record);
      navigate(`/engines/${encodeURIComponent(record.id)}`);
      toast(done(record), { kind: "success", detail: `“${draft.view.name}” is unchanged.` });
    } catch (err) {
      toast("Could not create the engine", { kind: "error", detail: messageOf(err) });
    }
  };

  const duplicate = () => void createDerived((names) => duplicateRecord(draft.view, deps, names), (r) => `Created “${r.name}”`);

  const convertToCode = () =>
    void createDerived((names) => {
      const v = draft.view;
      const code = v.blocks ? generateEvalSource(v.blocks as object).code : (v.files?.["eval.ts"] ?? generateEvalSource(DEFAULT_WORKSPACE).code);
      return blocksToCodeRecord(v, convertedEvalSource(code, v.name), deps, TEMPLATE_VERSION, names);
    }, (r) => `Created “${r.name}” — edit its eval.ts by hand`);

  const unlockFull = () => void createDerived((names) => unlockFullRecord(draft.view, templateFiles, deps, TEMPLATE_VERSION, names), (r) => `Created “${r.name}” — every file is editable`);

  const exportFile = async () => {
    try {
      flushBlocks();
      if (!(await draft.flush())) throw new Error(draft.getSnapshot().error ?? "Your changes could not be saved.");
      const blob = await exportEngineFile(view.id);
      downloadBlob(blob, `${slugify(draft.view.name)}.engine.json`);
      toast("Engine exported", { kind: "success", detail: "Import the file on the Engines page (here or in another browser)." });
    } catch (err) {
      toast("Could not export the engine", { kind: "error", detail: messageOf(err) });
    }
  };

  const remove = async () => {
    const name = draft.view.name;
    const ok = await confirm({
      title: `Delete “${name}”?`,
      message: "The engine, its code and its build are deleted. Games it played and networks it uses are kept. This cannot be undone.",
      confirmLabel: "Delete engine",
      danger: true,
    });
    if (!ok) return;
    const id = draft.id;
    draft.discard();
    navigate("/engines");
    try {
      await enginesRepo.remove(id);
      toast(`Deleted “${name}”`, { kind: "success" });
    } catch (err) {
      toast("Could not delete the engine", { kind: "error", detail: messageOf(err) });
    }
  };

  const resetEval = async () => {
    const ok = await confirm({
      title: "Reset eval.ts to the template?",
      message: "Your eval.ts is replaced by the template's version. Copy anything you want to keep first.",
      confirmLabel: "Reset eval.ts",
      danger: true,
    });
    if (ok) draft.edit(filePatch(draft.view, "eval.ts", templateEvalFor(draft.view.kind)));
  };

  const conversion = conversionFor(kind);
  const menu: Array<MenuItem | "separator"> = [
    { id: "duplicate", label: "Duplicate", hint: "An independent copy of this engine", onSelect: duplicate },
    ...(conversion === "to-code" ? [{ id: "convert", label: "Convert to code", hint: "New engine with the generated eval.ts to edit by hand", onSelect: convertToCode }] : []),
    ...(conversion === "unlock-full" ? [{ id: "unlock", label: "Unlock the full engine source", hint: "New engine where every file is editable", onSelect: unlockFull }] : []),
    { id: "export", label: "Export…", hint: "Download as an engine file", onSelect: () => void exportFile() },
    "separator",
    { id: "delete", label: "Delete engine…", danger: true, onSelect: () => void remove() },
  ];

  // --- keyboard shortcuts, title --------------------------------------------------------------
  const buildRef = useRef(doBuild);
  buildRef.current = doBuild;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        flushBlocks();
        void draft.flush();
      } else if (key === "b") {
        e.preventDefault();
        if (draft.view.kind !== "wasm") void buildRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft, flushBlocks]);

  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    document.title = `${view.name} · Workshop · BoardForm`;
  }, [view.name]);

  // --- resizable split ----------------------------------------------------------------------
  const [storedWidth, setStoredWidth] = useSetting<number>(SIDE_WIDTH_KEY, DEFAULT_SIDE_WIDTH);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const clampWidth = useCallback((w: number) => {
    const total = bodyRef.current?.clientWidth ?? 1280;
    return Math.round(clamp(w, MIN_SIDE, Math.max(MIN_SIDE, total - MIN_MAIN)));
  }, []);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sideWidth = bodyWidth ? Math.round(clamp(dragWidth ?? storedWidth, MIN_SIDE, Math.max(MIN_SIDE, bodyWidth - MIN_MAIN))) : (dragWidth ?? storedWidth);

  const onSplitterDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = sideWidth;
    let latest = startW;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("workshop-resizing");
    const move = (ev: PointerEvent) => {
      latest = clampWidth(startW + (startX - ev.clientX));
      setDragWidth(latest);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("workshop-resizing");
      setDragWidth(null);
      setStoredWidth(latest);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onSplitterKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 32;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = sideWidth + step;
    else if (e.key === "ArrowRight") next = sideWidth - step;
    else if (e.key === "Home") next = MIN_SIDE;
    else if (e.key === "End") next = Number.MAX_SAFE_INTEGER;
    if (next === null) return;
    e.preventDefault();
    setStoredWidth(clampWidth(next));
  };

  // --- render ---------------------------------------------------------------------------------
  const buildPill = buildPillFor(view, build, source);
  const errorCount = build.last && !build.last.ok ? Math.max(1, errorsOf(build.last.result).length) : 0;
  const sideItems: TabItem[] = sideTabs.map((id) => ({
    id,
    label: TAB_LABELS[id],
    badge: id === "build" && errorCount > 0 ? String(errorCount) : undefined,
  }));
  const stackItems: TabItem[] = [{ id: "editor", label: EDITOR_LABELS[kind] }, ...sideItems];
  const requestedFile = query.get("file");

  let main: ReactNode;
  switch (kind) {
    case "blocks":
      main = <BlocksMain view={view} draft={draft} editorRef={blocksRef} />;
      break;
    case "eval":
    case "nnue":
      main = (
        <EvalMain
          view={view}
          draft={draft}
          diagnostics={diagnostics}
          reveal={reveal}
          editorRef={editorRef}
          onReset={() => void resetEval()}
          onShowSource={() => setTab("source")}
        />
      );
      break;
    case "full":
    case "scratch":
      main = (
        <FilesMain
          view={view}
          saved={snap.saved}
          draft={draft}
          diagnostics={diagnostics}
          reveal={reveal}
          editorRef={editorRef}
          requestedFile={requestedFile}
          onOpenFile={(path) => setQuery(narrow && path ? { file: path, tab: "editor" } : { file: path })}
          confirm={confirm}
          narrow={narrow}
        />
      );
      break;
    case "wasm":
      main = <WasmMain view={view} draft={draft} session={session} />;
      break;
  }

  const pane = (id: SideTabId, content: () => ReactNode) =>
    visited.current.has(id) ? (
      <div key={id} className={"workshop-pane workshop-pane--" + id} hidden={activeSide !== id}>
        <AreaBoundary label={`The ${TAB_LABELS[id]} tab`}>{content()}</AreaBoundary>
      </div>
    ) : null;

  const style = { "--workshop-side": `${sideWidth}px` } as CSSProperties;

  return (
    <div className="page-full workshop" data-kind={kind}>
      <WorkshopHeader
        view={view}
        save={snap}
        buildPill={buildPill}
        building={build.running > 0}
        menu={menu}
        onRename={(name) => draft.edit({ name })}
        onBuild={buildClick}
        onRetrySave={() => void draft.flush()}
        onShowBuildLog={() => setTab("build")}
      />
      {narrow && <Tabs tabs={stackItems} active={active} onChange={(id) => setTab(id as TabId)} className="workshop-stack-tabs" aria-label="Workshop sections" />}
      <div className={"workshop-body" + (narrow ? " narrow" : "")} ref={bodyRef} style={style}>
        <section className="workshop-main" hidden={narrow && active !== "editor"} aria-label={EDITOR_LABELS[kind]}>
          <AreaBoundary label={kind === "blocks" ? "The block editor" : kind === "wasm" ? "The module view" : "The code editor"}>{main}</AreaBoundary>
        </section>
        {!narrow && (
          <div
            className={"workshop-splitter" + (dragWidth !== null ? " dragging" : "")}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side panel"
            aria-valuenow={sideWidth}
            aria-valuemin={MIN_SIDE}
            tabIndex={0}
            onPointerDown={onSplitterDown}
            onKeyDown={onSplitterKey}
            onDoubleClick={() => setStoredWidth(clampWidth(DEFAULT_SIDE_WIDTH))}
            title="Drag to resize · double-click to reset"
          />
        )}
        <aside className="workshop-side" hidden={narrow && active === "editor"} aria-label="Workshop tools">
          {!narrow && <Tabs tabs={sideItems} active={activeSide} onChange={(id) => setTab(id as TabId)} size="sm" className="workshop-side-tabs" aria-label="Workshop tools" />}
          <div className="workshop-side-body">
            {pane("test", () => (
              <TestBench
                session={session}
                family={kind === "blocks" || kind === "eval" || kind === "nnue" || kind === "full" ? "template" : "custom"}
                visible={activeSide === "test" && !(narrow && active === "editor")}
                onShowBuildLog={showBuildLog}
              />
            ))}
            {pane("code", () => (
              <GeneratedCode code={view.files?.["eval.ts"] ?? ""} diagnostics={diagnostics} reveal={reveal} onConvert={convertToCode} />
            ))}
            {pane("api", () => (
              <div className="workshop-api">
                <p className="small muted workshop-api-hint">
                  Functions and constants of the engine template. <strong>Insert</strong> puts a snippet at the cursor in {kind === "full" ? "the open file" : "eval.ts"}.
                </p>
                <ApiReference
                  className="workshop-api-ref"
                  onInsert={(snippet, entry) => {
                    editorRef.current?.insert(snippet, entry);
                    if (narrow) setTab("editor");
                  }}
                />
              </div>
            ))}
            {pane("source", () => (
              <EngineSource file={sourceFile} onFile={setSourceFile} diagnostics={diagnostics} reveal={reveal} onUnlock={unlockFull} />
            ))}
            {pane("build", () => (
              <BuildLog
                view={view}
                build={build}
                sourceHash={source.hash}
                canOpen={canOpen}
                onOpen={openLocation}
                onBuild={buildClick}
              />
            ))}
            {pane("settings", () => (
              <SettingsPanel view={view} draft={draft} nnueCapable={sessionState.caps ? sessionState.caps.nnue : null} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
