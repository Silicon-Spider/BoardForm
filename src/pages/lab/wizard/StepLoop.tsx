// Wizard step 4: the reinforcement loop, gating, publishing an engine and auto-resume.
import { LimitsEditor } from "@/components";
import { GATING_MAX_SCORE, GATING_MIN_SCORE, stepWarnings } from "../model/wizard";
import { Field, NumberInput, ProblemList, Switch } from "../ui/common";
import { StepSection, type StepProps } from "./shared";

export function StepLoop({ state, update, ctx }: StepProps) {
  const warnings = stepWarnings("loop", state, ctx);
  const g = state.gating;
  const setG = (patch: Partial<typeof g>) => update((s) => ({ ...s, gating: { ...s.gating, ...patch } }));
  return (
    <div className="lab-step">
      <StepSection title="Reinforcement loop">
        <Switch
          checked={state.loopEnabled}
          onChange={(on) => update({ loopEnabled: on })}
          label="Repeat self-play and training"
          description="Each cycle plays new games, trains on them and starts over — so every network learns from games of the one before."
        />
        {state.loopEnabled && (
          <div className="lab-subform">
            <div className="lab-radio-rows" role="radiogroup" aria-label="Number of cycles">
              <label className="lab-radio-row">
                <input type="radio" name="lab-cycles" checked={!state.cyclesUnlimited} onChange={() => update({ cyclesUnlimited: false })} />
                <span>Run</span>
                <NumberInput
                  value={state.cycles}
                  onChange={(v) => update({ cycles: v, cyclesUnlimited: false })}
                  integer
                  min={1}
                  max={10_000}
                  step={1}
                  aria-label="Number of cycles"
                  className="lab-inline-num"
                />
                <span>cycles</span>
              </label>
              <label className="lab-radio-row">
                <input type="radio" name="lab-cycles" checked={state.cyclesUnlimited} onChange={() => update({ cyclesUnlimited: true })} />
                <span>Until I stop it</span>
              </label>
            </div>
            <Switch
              checked={state.selfPlayWithLatest && state.selfPlayEnabled}
              disabled={!state.selfPlayEnabled}
              onChange={(on) => update({ selfPlayWithLatest: on })}
              label="Self-play with the newest network after the first cycle"
              description="The first cycle uses the engine from the Data step; later cycles let the network play itself. This is how it can grow past its teacher."
            />
            <div className="lab-radio-rows" role="radiogroup" aria-label="Data kept for training">
              <label className="lab-radio-row">
                <input type="radio" name="lab-keep" checked={state.keepAllCycles} onChange={() => update({ keepAllCycles: true })} />
                <span>Train on the games of all cycles</span>
              </label>
              <label className="lab-radio-row">
                <input type="radio" name="lab-keep" checked={!state.keepAllCycles} onChange={() => update({ keepAllCycles: false })} />
                <span>Only the newest</span>
                <NumberInput
                  value={state.keepCycles}
                  onChange={(v) => update({ keepCycles: v, keepAllCycles: false })}
                  integer
                  min={1}
                  max={10_000}
                  step={1}
                  aria-label="Cycles of data to keep"
                  className="lab-inline-num"
                />
                <span>cycles — older games fade out as the network improves</span>
              </label>
            </div>
          </div>
        )}
      </StepSection>

      <StepSection title="Gating">
        <Switch
          checked={state.gatingEnabled && state.loopEnabled}
          disabled={!state.loopEnabled}
          onChange={(on) => update({ gatingEnabled: on })}
          label="Only keep networks that play at least as well"
          description={
            state.loopEnabled
              ? "After training, the new network plays a short match against the previous one and replaces it only if it scores enough."
              : "Needs the reinforcement loop: it compares each cycle's network with the one before."
          }
        />
        {state.gatingEnabled && state.loopEnabled && (
          <div className="lab-subform">
            <div className="form-grid lab-form-2">
              <Field label="Games" htmlFor="lab-g-games" hint="More games = a surer verdict, but slower">
                <NumberInput id="lab-g-games" value={g.games} onChange={(v) => setG({ games: v })} integer min={2} max={10_000} step={2} />
              </Field>
              <div className="field">
                <div className="row-between">
                  <label htmlFor="lab-g-score" className="field-label">
                    Minimum score
                  </label>
                  <span className="lab-strong num">{Math.round(g.minScore * 100)}%</span>
                </div>
                <input
                  id="lab-g-score"
                  type="range"
                  min={GATING_MIN_SCORE}
                  max={GATING_MAX_SCORE}
                  step={0.01}
                  value={g.minScore}
                  onChange={(e) => setG({ minScore: Number(e.target.value) })}
                  aria-valuetext={`${Math.round(g.minScore * 100)} percent`}
                />
                <span className="field-hint">50% = not worse. Higher is stricter: fewer, but surer, improvements.</span>
              </div>
            </div>
            <LimitsEditor value={{ limits: g.limits, timeControl: null }} onChange={(v) => setG({ limits: v.limits })} allowClock={false} />
          </div>
        )}
        <ProblemList items={warnings} tone="warn" />
      </StepSection>

      <StepSection title="When a network is ready">
        <Switch
          checked={state.publishEngine}
          onChange={(on) => update({ publishEngine: on })}
          label="Publish an engine"
          description="Adds an NNUE engine to your library that always uses this run's newest accepted network — ready to play or to enter in the Arena."
        />
        <Switch
          checked={state.autoResume}
          onChange={(on) => update({ autoResume: on })}
          label="Keep training when I reopen the app"
          description="Browsers can't train while the tab is closed. With this on, the run continues by itself the next time you open BoardForm."
        />
      </StepSection>
    </div>
  );
}
