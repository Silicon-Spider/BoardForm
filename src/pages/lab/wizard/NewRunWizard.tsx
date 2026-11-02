// New training run wizard (#/lab/new; ?networkId=<id>&mode=continue|widen, ?datasetIds=<id>,<id>).
// Five steps with a progress header; the draft autosaves to the settings store, so a refresh or a
// detour (e.g. generating a dataset) loses nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, navigate } from "@/app/router";
import { getMaxWorkers, useMaxWorkers } from "@/app/preferences";
import { toast } from "@/app/toast";
import { Icon, useConfirm } from "@/components";
import { enginesRepo, networksRepo, settingsRepo, useDatasets, useEngines, useNetworks, whenSeeded } from "@/storage";
import { training } from "@/training";
import { threadSupport } from "@/nnue/parallel";
import { countOf, errorMessage, formatInt } from "../model/format";
import {
  DRAFT_SETTING_KEY,
  MIN_RECOMMENDED_STEPS,
  WIZARD_STEPS,
  applyQueryPreset,
  buildRunConfig,
  defaultRunName,
  defaultWizardState,
  isPristine,
  restoreDraft,
  stepProblems,
  suggestHyper,
  stepsFor,
  type WizardContext,
  type WizardDraft,
  type WizardState,
  type WizardStepId,
} from "../model/wizard";
import { defaultSelfPlayEngine } from "../datasets/GenerateDatasetDialog";
import { Breadcrumbs, LoadingBlock, ProblemList, TimeAgo } from "../ui/common";
import { EstimateCard, type EstimateState, type WizardUpdate } from "./shared";
import { StepData } from "./StepData";
import { StepLoop } from "./StepLoop";
import { StepNetwork } from "./StepNetwork";
import { StepReview } from "./StepReview";
import { StepTraining } from "./StepTraining";

interface InitResult {
  state: WizardState;
  defaults: WizardState;
  step: WizardStepId;
  restoredAt: number | null;
  /** presetKey() of the URL preselection applied at start ("" = none). */
  preset: string;
}

type QueryPreset = { networkId: string | null; mode: string | null; datasetIds: string | null };

function presetOf(query: URLSearchParams): QueryPreset {
  return { networkId: query.get("networkId"), mode: query.get("mode"), datasetIds: query.get("datasetIds") };
}

/** Identity of a URL preselection; "" when the URL has none. */
function presetKey(p: QueryPreset): string {
  return p.networkId || p.datasetIds ? [p.networkId ?? "", p.mode ?? "", p.datasetIds ?? ""].join("|") : "";
}

async function initialise(query: URLSearchParams): Promise<InitResult> {
  await whenSeeded();
  const [maxWorkers, engines, networks, raw] = await Promise.all([
    getMaxWorkers(),
    enginesRepo.list(),
    networksRepo.list(),
    settingsRepo.get<unknown>(DRAFT_SETTING_KEY, null),
  ]);
  const defaults = defaultWizardState({
    maxWorkers,
    engineId: defaultSelfPlayEngine(engines)?.id ?? null,
    threads: threadSupport().ok ? Math.min(4, maxWorkers) : 1,
  });
  const preset = presetOf(query);
  const key = presetKey(preset);
  if (key) return { state: applyQueryPreset(defaults, preset, networks), defaults, step: "network", restoredAt: null, preset: key };
  const draft = restoreDraft(raw, defaults);
  if (draft && !isPristine(draft.state, defaults)) return { state: draft.state, defaults, step: draft.step, restoredAt: draft.savedAt || null, preset: "" };
  return { state: defaults, defaults, step: "network", restoredAt: null, preset: "" };
}

export function NewRunWizard({ query }: { query: URLSearchParams }) {
  const [init, setInit] = useState<InitResult | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // The start-up preselection comes from the URL at mount; later changes are handled by Wizard.
  const queryRef = useRef(query);
  useEffect(() => {
    let cancelled = false;
    initialise(queryRef.current).then(
      (r) => !cancelled && setInit(r),
      (e: unknown) => !cancelled && setInitError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (initError) {
    return (
      <div className="callout danger" role="alert">
        <strong>The wizard could not load.</strong> {initError}
      </div>
    );
  }
  if (!init) return <LoadingBlock label="Preparing the wizard…" />;
  return <Wizard init={init} query={query} />;
}

function Wizard({ init, query }: { init: InitResult; query: URLSearchParams }) {
  const networks = useNetworks();
  const datasets = useDatasets();
  const engines = useEngines();
  const [maxWorkers] = useMaxWorkers();
  const confirm = useConfirm();
  const [state, setState] = useState<WizardState>(init.state);
  const [step, setStep] = useState<WizardStepId>(init.step);
  const [restoredAt, setRestoredAt] = useState<number | null>(init.restoredAt);
  const [shownProblems, setShownProblems] = useState<WizardStepId | null>(null);
  const [createdAt] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const created = useRef(false);
  const problemsRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const ctx: WizardContext = useMemo(() => ({ networks, datasets, engines, maxWorkers }), [networks, datasets, engines, maxWorkers]);
  const update: WizardUpdate = useCallback((patch) => {
    setState((s) => (typeof patch === "function" ? patch(s) : { ...s, ...patch }));
  }, []);

  const defaultName = useMemo(() => defaultRunName(state, { networks }, createdAt), [state, networks, createdAt]);
  const config = useMemo(() => buildRunConfig(state, defaultName), [state, defaultName]);
  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);
  const problemsByStep = useMemo(() => {
    const out = {} as Record<WizardStepId, string[]>;
    for (const s of WIZARD_STEPS) out[s.id] = s.id === "review" ? [] : stepProblems(s.id, state, ctx);
    return out;
  }, [state, ctx]);

  // --- URL preselection (?networkId=&mode=, ?datasetIds=) ----------------------------------------
  // Applied once (at start-up by initialise(), later here when the URL brings a new one), then
  // removed from the URL so that a reload restores the autosaved draft instead of re-applying it.
  const appliedPreset = useRef(init.preset);
  useEffect(() => {
    const preset = presetOf(query);
    const key = presetKey(preset);
    if (!key) return;
    if (key !== appliedPreset.current) {
      setState((s) => applyQueryPreset(s, preset, networks));
      setStep("network");
      setRestoredAt(null);
    }
    appliedPreset.current = "";
    navigate("/lab/new", { replace: true });
    // `networks` only refines the widen default; the preselection itself must apply once.
  }, [query]);

  // --- autosave the draft -------------------------------------------------------------------
  useEffect(() => {
    if (created.current) return;
    const t = setTimeout(() => {
      if (created.current) return;
      const draft: WizardDraft = { v: 1, savedAt: Date.now(), step, state };
      const write = isPristine(state, init.defaults) && step === "network" ? settingsRepo.remove(DRAFT_SETTING_KEY) : settingsRepo.set(DRAFT_SETTING_KEY, draft);
      write.catch((e: unknown) => console.warn("[lab] could not save the wizard draft", e));
    }, 400);
    return () => clearTimeout(t);
  }, [state, step, init.defaults]);

  // --- estimate (debounced) -----------------------------------------------------------------
  const [estimate, setEstimate] = useState<EstimateState>({ status: "loading", value: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setEstimate((e) => ({ ...e, status: "loading" }));
    const t = setTimeout(() => {
      training.estimate(config).then(
        (value) => !cancelled && setEstimate({ status: "ready", value, error: null }),
        (e: unknown) => !cancelled && setEstimate((prev) => ({ status: "error", value: prev.value, error: errorMessage(e) })),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [config]);

  // --- service validation on the review step ------------------------------------------------
  const [serviceProblems, setServiceProblems] = useState<{ list: string[]; checking: boolean }>({ list: [], checking: false });
  useEffect(() => {
    if (step !== "review") return;
    let cancelled = false;
    setServiceProblems((p) => ({ ...p, checking: true }));
    const t = setTimeout(() => {
      training.validateConfig(config).then(
        (list) => !cancelled && setServiceProblems({ list, checking: false }),
        (e: unknown) => !cancelled && setServiceProblems({ list: [errorMessage(e)], checking: false }),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [step, config]);

  // --- suggestion for too few optimizer steps -------------------------------------------------
  const positions = estimate.value?.positions ?? 0;
  const suggestion = useMemo(() => {
    const e = estimate.value;
    if (!e || e.totalSteps <= 0 || e.totalSteps >= MIN_RECOMMENDED_STEPS) return null;
    return suggestHyper(state.hyper, positions);
  }, [estimate.value, state.hyper, positions]);
  const suggestionText = suggestion
    ? `Batch ${formatInt(suggestion.batchSize)} and ${suggestion.epochs} epochs give about ${formatInt(stepsFor(positions, suggestion).totalSteps)} steps.`
    : null;
  const applySuggestion = suggestion
    ? () => {
        update((s) => ({ ...s, hyper: suggestion }));
        toast("Training settings updated", { kind: "success", detail: suggestionText ?? undefined });
      }
    : null;

  // --- navigation -------------------------------------------------------------------------------
  const goTo = (id: WizardStepId) => {
    setStep(id);
    setShownProblems(null);
    topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const next = () => {
    if (problemsByStep[step].length > 0) {
      setShownProblems(step);
      requestAnimationFrame(() => problemsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return;
    }
    const n = WIZARD_STEPS[stepIndex + 1];
    if (n) goTo(n.id);
  };
  const back = () => {
    const p = WIZARD_STEPS[stepIndex - 1];
    if (p) goTo(p.id);
  };

  const localProblems = stepProblems("review", state, ctx);
  const allProblems = [...new Set([...localProblems, ...serviceProblems.list])];

  const create = async () => {
    if (allProblems.length > 0 || creating) return;
    setCreating(true);
    try {
      const id = await training.createRun(config, { autoResume: state.autoResume, start: true });
      created.current = true;
      await settingsRepo.remove(DRAFT_SETTING_KEY).catch(() => undefined);
      toast(`Started “${config.name}”`, { kind: "success", detail: "It keeps running while you use the rest of the app." });
      navigate(`/lab/runs/${id}`);
    } catch (e) {
      toast("Could not create the run", { kind: "error", detail: errorMessage(e) });
      setCreating(false);
    }
  };

  const startOver = async () => {
    if (!isPristine(state, init.defaults)) {
      const ok = await confirm({ title: "Start over?", message: "Your choices in this wizard are reset to the defaults.", confirmLabel: "Start over", danger: true });
      if (!ok) return;
    }
    setState(init.defaults);
    setRestoredAt(null);
    goTo("network");
  };

  const stepBody = (() => {
    const props = { state, update, ctx };
    switch (step) {
      case "network":
        return <StepNetwork {...props} />;
      case "data":
        return <StepData {...props} />;
      case "training":
        return <StepTraining {...props} estimate={estimate} onUseSuggestion={applySuggestion} suggestionText={suggestionText} />;
      case "loop":
        return <StepLoop {...props} />;
      case "review":
        return (
          <StepReview
            {...props}
            config={config}
            defaultName={defaultName}
            problems={allProblems}
            checking={serviceProblems.checking}
            estimate={estimate}
            onEdit={goTo}
          />
        );
    }
  })();

  return (
    <div className="lab-wizard" ref={topRef}>
      <Breadcrumbs items={[{ label: "NNUE Lab", to: "/lab" }, { label: "Runs", to: "/lab/runs" }, { label: "New training run" }]} />
      <header className="page-header lab-header">
        <div>
          <h1>New training run</h1>
          <p className="page-subtitle">Pick a network, the games to learn from and how long to train. You can watch everything live once it starts.</p>
        </div>
        <div className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => void startOver()}>
          <Icon name="reset" size={14} /> Start over
        </button>
      </header>

      {restoredAt !== null && (
        <div className="callout lab-notice small">
          <span className="grow">
            Picked up where you left off (<TimeAgo ts={restoredAt} />
            ).
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRestoredAt(null)}>
            Dismiss
          </button>
        </div>
      )}

      <ol className="lab-wizard-steps" aria-label="Steps">
        {WIZARD_STEPS.map((s, i) => {
          const state_ = s.id === step ? "current" : i < stepIndex ? "done" : "upcoming";
          const bad = s.id !== "review" && i < stepIndex && problemsByStep[s.id].length > 0;
          return (
            <li key={s.id} className={`lab-wstep ${state_}${bad ? " bad" : ""}`}>
              <button type="button" onClick={() => goTo(s.id)} aria-current={s.id === step ? "step" : undefined}>
                <span className="lab-wstep-num" aria-hidden="true">
                  {state_ === "done" && !bad ? <Icon name="check" size={13} /> : bad ? "!" : i + 1}
                </span>
                <span className="lab-wstep-label">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="lab-wizard-layout">
        <section className="panel lab-wizard-main" aria-label={WIZARD_STEPS[stepIndex].label}>
          <div className="panel-body lab-wizard-body">
            {stepBody}
            {shownProblems === step && (
              <div ref={problemsRef} className="lab-wizard-problems">
                <ProblemList items={problemsByStep[step]} title="Before you continue:" />
              </div>
            )}
          </div>
          <footer className="panel-footer lab-wizard-footer">
            <button type="button" className="btn" onClick={back} disabled={stepIndex === 0}>
              <Icon name="prev" size={14} /> Back
            </button>
            <span className="spacer" />
            <span className="small faint lab-wizard-count">
              Step {stepIndex + 1} of {WIZARD_STEPS.length}
            </span>
            {step === "review" ? (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => void create()}
                disabled={creating || allProblems.length > 0 || serviceProblems.checking}
              >
                {creating ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="play" size={14} />}
                Create and start
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={next}>
                Next <Icon name="next" size={14} />
              </button>
            )}
          </footer>
        </section>

        <aside className="lab-wizard-aside" aria-label="This run">
          <div className="card lab-aside-card">
            <div className="section-title">This run</div>
            <dl className="lab-aside-list">
              <div>
                <dt>Network</dt>
                <dd>
                  {state.networkMode === "new"
                    ? `New · HL${state.hidden} ${state.activation === 1 ? "SCReLU" : "CReLU"}`
                    : state.networkMode === "continue"
                      ? `Continue · ${networks?.find((n) => n.id === state.sourceNetworkId)?.name ?? "not chosen"}`
                      : `Widen · ${networks?.find((n) => n.id === state.sourceNetworkId)?.name ?? "not chosen"}${state.widenTo ? ` → HL${state.widenTo}` : ""}`}
                </dd>
              </div>
              <div>
                <dt>Data</dt>
                <dd>
                  {[
                    state.datasetIds.length ? `${state.datasetIds.length} dataset${state.datasetIds.length === 1 ? "" : "s"}` : null,
                    state.selfPlayEnabled ? `${formatInt(state.selfPlay.games)} games${state.loopEnabled ? " per cycle" : ""}` : null,
                  ]
                    .filter(Boolean)
                    .join(" + ") || "none yet"}
                </dd>
              </div>
              <div>
                <dt>Training</dt>
                <dd>
                  {countOf(state.hyper.epochs, "epoch")} · batch {formatInt(state.hyper.batchSize)}
                </dd>
              </div>
              <div>
                <dt>Loop</dt>
                <dd>{state.loopEnabled ? (state.cyclesUnlimited ? "until stopped" : `${state.cycles} cycles`) : "one cycle"}</dd>
              </div>
            </dl>
          </div>
          {step !== "training" && step !== "review" && <EstimateCard estimate={estimate} compact onUseSuggestion={applySuggestion} suggestionText={suggestionText} />}
          <p className="small faint lab-aside-help">
            New to NNUE? <Link to="/help/nnue">Read how training works</Link>.
          </p>
        </aside>
      </div>
    </div>
  );
}
