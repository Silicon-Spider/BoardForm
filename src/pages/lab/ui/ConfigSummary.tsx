// Human-readable run configuration (wizard review step and run dashboard).
import type { ReactNode } from "react";
import type { TrainingRunConfig } from "@/types";
import { summarizeConfig, type SummaryContext, type SummarySection } from "../model/wizard";

export function ConfigSummary({
  config,
  ctx,
  renderAction,
}: {
  config: TrainingRunConfig;
  ctx: SummaryContext;
  /** Extra control in each section header, e.g. an "Edit" button in the wizard. */
  renderAction?: (section: SummarySection) => ReactNode;
}) {
  const sections = summarizeConfig(config, ctx);
  return (
    <div className="lab-summary">
      {sections.map((s) => (
        <section key={s.id} className="lab-summary-section">
          <div className="lab-summary-head">
            <h3>{s.title}</h3>
            {renderAction?.(s)}
          </div>
          <dl>
            {s.items.map((it) => (
              <div key={it.label} className="lab-summary-item">
                <dt>{it.label}</dt>
                <dd>{it.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
