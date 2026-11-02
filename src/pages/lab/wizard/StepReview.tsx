// Wizard step 5: name the run, check the summary and the service's validation, create it.
import type { TrainingRunConfig } from "@/types";
import { WIZARD_STEPS, type WizardStepId } from "../model/wizard";
import { ConfigSummary } from "../ui/ConfigSummary";
import { Field, ProblemList } from "../ui/common";
import { EstimateCard, StepSection, type EstimateState, type StepProps } from "./shared";

export function StepReview({
  state,
  update,
  ctx,
  config,
  defaultName,
  problems,
  checking,
  estimate,
  onEdit,
}: StepProps & {
  config: TrainingRunConfig;
  defaultName: string;
  problems: readonly string[];
  checking: boolean;
  estimate: EstimateState;
  onEdit: (step: WizardStepId) => void;
}) {
  return (
    <div className="lab-step">
      <StepSection title="Name">
        <Field label="Run name" htmlFor="lab-run-name" hint="Shown in the run list; the published engine and networks are named after it.">
          <input
            id="lab-run-name"
            className="input"
            value={state.name}
            placeholder={defaultName}
            maxLength={120}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
      </StepSection>

      <StepSection title="Summary">
        <ConfigSummary
          config={config}
          ctx={ctx}
          renderAction={(s) => (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(s.id)} aria-label={`Edit ${s.title}`}>
              Edit
            </button>
          )}
        />
        <div className="small muted">
          Auto-resume: {state.autoResume ? "on — the run continues when you reopen the app" : "off — you resume it yourself after closing the app"}.
        </div>
      </StepSection>

      <EstimateCard estimate={estimate} />

      {checking && problems.length === 0 ? (
        <div className="small muted row">
          <span className="spinner" style={{ width: 12, height: 12 }} /> Checking the settings…
        </div>
      ) : problems.length > 0 ? (
        <ProblemList items={problems} title={`Fix ${problems.length === 1 ? "this" : "these"} before creating the run:`} />
      ) : estimate.value && estimate.value.warnings.length > 0 ? (
        <div className="callout ok small">
          Ready to create. The advice above does not stop the run, but following it gives a better network. The run starts as soon as you create it and keeps
          going while you use the rest of the app.
        </div>
      ) : (
        <div className="callout ok small">Everything looks good. The run starts as soon as you create it and keeps going while you use the rest of the app.</div>
      )}
    </div>
  );
}

/** Label of a step for "Fix in …" links. */
export function stepLabel(id: WizardStepId): string {
  return WIZARD_STEPS.find((s) => s.id === id)?.label ?? id;
}
