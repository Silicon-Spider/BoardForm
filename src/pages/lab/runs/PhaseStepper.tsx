// Phase stepper of a run: Self-play → Training → Evaluating → next cycle. Phases the run's config
// skips (no self-play, no gating, no loop) are shown as skipped.
import { Icon } from "@/components";
import type { TrainingRunRecord } from "@/types";
import { cycleText, type RunPhase } from "../model/format";
import { LabIcon } from "../ui/icons";

type StepState = "done" | "current" | "upcoming" | "skipped";

interface Step {
  id: "selfplay" | "training" | "evaluating" | "next";
  label: string;
  state: StepState;
  caption?: string;
}

const ORDER: Array<Step["id"]> = ["selfplay", "training", "evaluating", "next"];

export function buildSteps(run: Pick<TrainingRunRecord, "config" | "status">, phase: RunPhase, captions: Partial<Record<Step["id"], string>>): Step[] {
  const cfg = run.config;
  const enabled: Record<Step["id"], boolean> = {
    selfplay: cfg.data.selfPlay !== null,
    training: true,
    evaluating: cfg.loop.gating !== null,
    next: cfg.loop.enabled,
  };
  const labels: Record<Step["id"], string> = { selfplay: "Self-play", training: "Training", evaluating: "Evaluating", next: "Next cycle" };
  const finished = run.status === "finished";
  const currentIndex = phase === "idle" ? -1 : ORDER.indexOf(phase);
  // Gating and "next cycle" only exist with the reinforcement loop; a single-cycle run hides them.
  const shown = cfg.loop.enabled ? ORDER : ORDER.filter((id) => id !== "evaluating" && id !== "next");
  return shown.map((id) => {
    const i = ORDER.indexOf(id);
    let state: StepState;
    if (!enabled[id]) state = "skipped";
    else if (finished) state = id === "next" ? "skipped" : "done";
    else if (currentIndex < 0) state = "upcoming";
    else state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
    const caption = !enabled[id] ? "Off" : finished && id === "next" ? undefined : captions[id];
    return { id, label: labels[id], state, caption };
  });
}

export function PhaseStepper({
  run,
  phase,
  running,
  captions = {},
}: {
  run: Pick<TrainingRunRecord, "config" | "status" | "cycle">;
  phase: RunPhase;
  /** Animate the current step (the run executes in this tab). */
  running: boolean;
  captions?: Partial<Record<Step["id"], string>>;
}) {
  const steps = buildSteps(run, phase, captions);
  return (
    <div className="lab-phases">
      <ol className="lab-phase-list" aria-label="Run phases">
        {steps.map((s, i) => (
          <li key={s.id} className={`lab-phase ${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
            <span className={"lab-phase-dot" + (s.state === "current" && running ? " running" : "")} aria-hidden="true">
              {s.state === "done" ? <Icon name="check" size={13} /> : s.id === "next" ? <LabIcon name="loop" size={13} /> : i + 1}
            </span>
            <span className="lab-phase-text">
              <span className="lab-phase-label">{s.label}</span>
              {s.caption && <span className="lab-phase-caption">{s.caption}</span>}
            </span>
            <span className="lab-sr">{s.state === "current" ? " (current)" : s.state === "done" ? " (done)" : s.state === "skipped" ? " (skipped)" : ""}</span>
          </li>
        ))}
      </ol>
      <span className="lab-phase-cycle">{cycleText(run.cycle, run.config)}</span>
    </div>
  );
}
