// Wizard step 3: training presets and hyperparameters, with the trainer's estimate.
import { useMaxWorkers } from "@/app/preferences";
import { threadSupport } from "@/nnue/parallel";
import type { LrSchedule, TrainingHyperParams } from "@/types";
import { formatPercent } from "@/utils/format";
import { TRAINING_PRESETS, applyPreset, detectPreset } from "../model/wizard";
import { Field, NumberInput } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { ChoiceCard, EstimateCard, StepSection, type EstimateState, type StepProps } from "./shared";

export function StepTraining({
  state,
  update,
  estimate,
  onUseSuggestion,
  suggestionText,
}: StepProps & { estimate: EstimateState; onUseSuggestion: (() => void) | null; suggestionText: string | null }) {
  const [maxWorkers] = useMaxWorkers();
  const h = state.hyper;
  const preset = detectPreset(h);
  const threads = threadSupport();
  const setH = (patch: Partial<TrainingHyperParams>) => update((s) => ({ ...s, hyper: { ...s.hyper, ...patch } }));

  return (
    <div className="lab-step">
      <StepSection
        title="Preset"
        description="Fills in all the numbers below. Change any of them afterwards."
        aside={preset === "custom" ? <span className="badge badge-violet">Custom settings</span> : undefined}
      >
        <div className="lab-choice-grid three" role="radiogroup" aria-label="Training preset">
          {TRAINING_PRESETS.map((p) => (
            <ChoiceCard
              key={p.id}
              name="lab-preset"
              value={p.id}
              checked={preset === p.id}
              onChange={() => update((s) => ({ ...s, hyper: applyPreset(s.hyper, p.id) }))}
              title={p.label}
              description={p.description}
            >
              <span className="lab-choice-meta">
                {p.hyper.epochs} epochs · batch {p.hyper.batchSize} · LR {p.hyper.learningRate}
              </span>
            </ChoiceCard>
          ))}
        </div>
      </StepSection>

      <StepSection title="Optimizer">
        <div className="form-grid lab-form-4">
          <Field label="Epochs" htmlFor="lab-h-epochs" hint="Passes over the data">
            <NumberInput id="lab-h-epochs" value={h.epochs} onChange={(v) => setH({ epochs: v })} integer min={1} max={1000} step={1} />
          </Field>
          <Field label="Batch size" htmlFor="lab-h-batch" hint="Positions per optimizer step">
            <NumberInput id="lab-h-batch" value={h.batchSize} onChange={(v) => setH({ batchSize: v })} integer min={1} max={1_048_576} step={256} />
          </Field>
          <Field label="Learning rate" htmlFor="lab-h-lr">
            <NumberInput id="lab-h-lr" value={h.learningRate} onChange={(v) => setH({ learningRate: v })} min={0.000001} max={1} step={0.0005} />
          </Field>
          <Field label="Schedule" htmlFor="lab-h-sched">
            <select id="lab-h-sched" className="select" value={h.lrSchedule} onChange={(e) => setH({ lrSchedule: e.target.value as LrSchedule })}>
              <option value="constant">Constant</option>
              <option value="step">Step — lower it every few epochs</option>
              <option value="cosine">Cosine — glide down smoothly</option>
            </select>
          </Field>
          {h.lrSchedule === "step" && (
            <>
              <Field label="Multiply by (γ)" htmlFor="lab-h-gamma" hint="e.g. 0.3 = to 30%">
                <NumberInput id="lab-h-gamma" value={h.lrGamma ?? 0.1} onChange={(v) => setH({ lrGamma: v })} min={0.001} max={1} step={0.05} />
              </Field>
              <Field label="Every" htmlFor="lab-h-every">
                <NumberInput
                  id="lab-h-every"
                  value={h.lrStepEpochs ?? Math.max(1, Math.round(h.epochs / 3))}
                  onChange={(v) => setH({ lrStepEpochs: v })}
                  integer
                  min={1}
                  max={1000}
                  step={1}
                  suffix="epochs"
                />
              </Field>
            </>
          )}
          {h.lrSchedule === "cosine" && (
            <Field label="Final learning rate" htmlFor="lab-h-final" hint="Reached at the last step">
              <NumberInput
                id="lab-h-final"
                value={h.finalLearningRate ?? h.learningRate * 0.01}
                onChange={(v) => setH({ finalLearningRate: v })}
                min={0}
                max={1}
                step={0.00001}
              />
            </Field>
          )}
        </div>
      </StepSection>

      <StepSection title="What the network learns">
        <div className="lab-lambda">
          <div className="row-between">
            <label htmlFor="lab-h-lambda" className="field-label">
              Eval weight (λ)
            </label>
            <span className="lab-strong num">{h.evalWeight.toFixed(2)}</span>
          </div>
          <input
            id="lab-h-lambda"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={h.evalWeight}
            onChange={(e) => setH({ evalWeight: Number(e.target.value) })}
            aria-valuetext={`${Math.round(h.evalWeight * 100)}% search score`}
          />
          <div className="lab-lambda-scale small faint">
            <span>Game results only</span>
            <span>Search scores only</span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Each position's target blends the engine's search score ({Math.round(h.evalWeight * 100)}%) with how the game actually ended (
            {Math.round((1 - h.evalWeight) * 100)}%). Scores are less noisy; results are the ground truth. 0.75 is a good start.
          </p>
        </div>
        <div className="form-grid lab-form-4">
          <Field label="Weight decay" htmlFor="lab-h-wd" hint="Keeps weights small">
            <NumberInput id="lab-h-wd" value={h.weightDecay} onChange={(v) => setH({ weightDecay: v })} min={0} max={1} step={0.005} />
          </Field>
          <Field label="Validation split" htmlFor="lab-h-val" hint={`${formatPercent(h.validationSplit, 0)} held out to measure overfitting`}>
            <NumberInput
              id="lab-h-val"
              value={Math.round(h.validationSplit * 1000) / 10}
              onChange={(v) => setH({ validationSplit: v / 100 })}
              min={0}
              max={50}
              step={1}
              suffix="%"
            />
          </Field>
          <Field
            label="Threads"
            htmlFor="lab-h-threads"
            hint={threads.ok ? `Up to ${maxWorkers}` : `1 here: ${threads.reason}`}
          >
            <NumberInput
              id="lab-h-threads"
              value={h.threads}
              onChange={(v) => setH({ threads: v })}
              integer
              min={1}
              max={Math.max(1, maxWorkers)}
              step={1}
              disabled={!threads.ok && h.threads === 1}
            />
          </Field>
          <Field label="Seed" htmlFor="lab-h-seed" hint="Same seed, same result">
            <div className="row">
              <NumberInput id="lab-h-seed" value={h.seed} onChange={(v) => setH({ seed: v })} integer min={0} max={2_147_483_647} step={1} className="grow" />
              <button
                type="button"
                className="btn btn-icon"
                title="Pick a random seed"
                aria-label="Pick a random seed"
                onClick={() => setH({ seed: Math.floor(Math.random() * 1_000_000) })}
              >
                <LabIcon name="dice" />
              </button>
            </div>
          </Field>
        </div>
      </StepSection>

      <EstimateCard estimate={estimate} onUseSuggestion={onUseSuggestion} suggestionText={suggestionText} />
    </div>
  );
}
