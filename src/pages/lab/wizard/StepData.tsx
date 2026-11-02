// Wizard step 2: existing datasets and/or self-play games generated every cycle.
import { useState } from "react";
import { EmptyState, EnginePicker, LimitsEditor, type EnginePickerOption } from "@/components";
import { useMaxWorkers } from "@/app/preferences";
import { useDatasetJob } from "@/training";
import type { DatasetRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { countOf, NETWORK_ENGINE_ID } from "../model/format";
import { stepWarnings } from "../model/wizard";
import { GenerateDatasetDialog } from "../datasets/GenerateDatasetDialog";
import { Field, NumberInput, ProblemList, Switch, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { StepSection, type StepProps } from "./shared";

const LATEST_OPTION: EnginePickerOption = {
  value: NETWORK_ENGINE_ID,
  label: "This run's newest network",
  description: "The stock NNUE engine playing with the network this run is training",
  kind: "nnue",
  color: "var(--kind-nnue)",
};

export function StepData({ state, update, ctx }: StepProps) {
  const [generateOpen, setGenerateOpen] = useState(false);
  const [maxWorkers] = useMaxWorkers();
  const sp = state.selfPlay;
  const setSp = (patch: Partial<typeof sp>) => update((s) => ({ ...s, selfPlay: { ...s.selfPlay, ...patch } }));
  const selected = new Set(state.datasetIds);
  const all = ctx.datasets;
  const chosen = (all ?? []).filter((d) => selected.has(d.id));
  const missing = all ? state.datasetIds.filter((id) => !all.some((d) => d.id === id)) : [];
  const warnings = stepWarnings("data", state, ctx);

  const toggle = (id: string, on: boolean) =>
    update((s) => ({ ...s, datasetIds: on ? [...new Set([...s.datasetIds, id])] : s.datasetIds.filter((x) => x !== id) }));

  return (
    <div className="lab-step">
      <StepSection
        title="Existing datasets"
        description="Positions you already have. Every selected dataset is part of the training set in every cycle."
        aside={
          <button type="button" className="btn btn-sm" onClick={() => setGenerateOpen(true)}>
            <LabIcon name="database" /> Generate a dataset
          </button>
        }
      >
        {all === undefined ? (
          <div className="muted small">Loading datasets…</div>
        ) : all.length === 0 ? (
          <EmptyState compact title="No datasets yet" description="Turn on self-play below, or generate a dataset first — it is added here automatically." />
        ) : (
          <>
            <div className="lab-pick-list" role="group" aria-label="Datasets">
              {[...all]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((d) => (
                  <DatasetCheckRow key={d.id} dataset={d} checked={selected.has(d.id)} onChange={(on) => toggle(d.id, on)} />
                ))}
            </div>
            <div className="small muted">
              {chosen.length === 0
                ? "None selected."
                : `${countOf(chosen.length, "dataset")} selected · ${formatCount(chosen.reduce((a, d) => a + d.positions, 0))} positions`}
              {missing.length > 0 && (
                <>
                  {" · "}
                  <button type="button" className="lab-link-btn" onClick={() => update((s) => ({ ...s, datasetIds: s.datasetIds.filter((id) => !missing.includes(id)) }))}>
                    remove {countOf(missing.length, "deleted dataset")}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </StepSection>

      <StepSection title="Self-play games">
        <Switch
          checked={state.selfPlayEnabled}
          onChange={(on) => update({ selfPlayEnabled: on })}
          label={state.loopEnabled ? "Generate self-play games every cycle" : "Generate self-play games before training"}
          description="An engine plays itself; the positions it searches become training examples, labelled with its score and the game's result."
        />
        {state.selfPlayEnabled && (
          <div className="lab-subform">
            <div className="form-grid lab-form-2">
              <Field label="Who plays">
                <EnginePicker
                  value={sp.engineId || null}
                  onChange={(id) => setSp({ engineId: id ?? "" })}
                  extraOptions={[LATEST_OPTION]}
                  aria-label="Engine that plays the self-play games"
                />
              </Field>
              <Field label={state.loopEnabled ? "Games per cycle" : "Games"} htmlFor="lab-sp-games" hint="About 100 training positions per game.">
                <NumberInput id="lab-sp-games" value={sp.games} onChange={(v) => setSp({ games: v })} integer min={1} max={1_000_000} step={50} />
              </Field>
            </div>
            <div className="form-grid lab-form-4">
              <Field label="Workers" htmlFor="lab-sp-workers" hint={`Games at once, up to ${maxWorkers}`}>
                <NumberInput id="lab-sp-workers" value={sp.concurrency} onChange={(v) => setSp({ concurrency: v })} integer min={1} max={maxWorkers} step={1} />
              </Field>
              <Field label="Random opening plies" htmlFor="lab-sp-random" hint="Variety between games">
                <NumberInput id="lab-sp-random" value={sp.randomPlies} onChange={(v) => setSp({ randomPlies: v })} integer min={0} max={40} step={1} />
              </Field>
              <Field label="Max plies per game" htmlFor="lab-sp-max" hint="Longer games count as draws">
                <NumberInput id="lab-sp-max" value={sp.maxPlies} onChange={(v) => setSp({ maxPlies: v })} integer min={10} max={2000} step={10} />
              </Field>
              <Field label="Skip first plies" htmlFor="lab-sp-skip" hint="Not recorded (random openings)">
                <NumberInput id="lab-sp-skip" value={sp.skipPlies} onChange={(v) => setSp({ skipPlies: v })} integer min={0} max={200} step={1} />
              </Field>
            </div>
            <LimitsEditor value={{ limits: sp.limits, timeControl: null }} onChange={(v) => setSp({ limits: v.limits })} allowClock={false} />
            <ProblemList items={warnings} tone="warn" />
          </div>
        )}
      </StepSection>

      <GenerateDatasetDialog open={generateOpen} onClose={() => setGenerateOpen(false)} onStarted={(id) => toggle(id, true)} />
    </div>
  );
}

function DatasetCheckRow({ dataset: d, checked, onChange }: { dataset: DatasetRecord; checked: boolean; onChange: (on: boolean) => void }) {
  const job = useDatasetJob(d.id);
  const generating = job?.status === "running";
  return (
    <label className={"lab-pick" + (checked ? " checked" : "")}>
      <input type="checkbox" className="lab-pick-check" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="lab-pick-main">
        <span className="lab-pick-title">
          <span className="truncate">{d.name}</span>
          {generating && <span className="badge badge-accent">Generating</span>}
        </span>
        <span className="lab-pick-meta">
          {formatCount(generating ? job.progress.positions : d.positions)} positions · {formatCount(generating ? job.progress.gamesDone : d.games)} games
        </span>
      </span>
      <span className="lab-pick-side small faint">
        <TimeAgo ts={d.createdAt} />
      </span>
    </label>
  );
}
