// Wizard step 1: train a new network, continue one, or widen one.
import { useEffect, useState } from "react";
import { EmptyState } from "@/components";
import { networksRepo } from "@/storage";
import { ACTIVATION_NAMES, HIDDEN_SIZE_PRESETS, MAX_HIDDEN } from "@/nnue/format";
import type { NetworkRecord } from "@/types";
import { formatCount } from "@/utils/format";
import { importNetworkFromFile } from "../actions";
import { formatLoss } from "../model/format";
import { defaultWidenTarget } from "../model/wizard";
import { Field, NumberInput, TimeAgo } from "../ui/common";
import { LabIcon } from "../ui/icons";
import { ChoiceCard, HiddenSizeChips, StepSection, type StepProps } from "./shared";

export function StepNetwork({ state, update, ctx }: StepProps) {
  const nets = ctx.networks;
  const hasNetworks = !!nets && nets.length > 0;
  const src = state.sourceNetworkId && nets ? (nets.find((n) => n.id === state.sourceNetworkId) ?? null) : null;

  const chooseSource = (n: NetworkRecord) =>
    update((s) => ({ ...s, sourceNetworkId: n.id, widenTo: s.networkMode === "widen" ? (s.widenTo && s.widenTo > n.hidden ? s.widenTo : defaultWidenTarget(n.hidden)) : s.widenTo }));

  return (
    <div className="lab-step">
      <StepSection title="Which network should this run train?">
        <div className="lab-choice-grid" role="radiogroup" aria-label="Network">
          <ChoiceCard
            name="lab-net-mode"
            value="new"
            checked={state.networkMode === "new"}
            onChange={() => update({ networkMode: "new" })}
            icon={<LabIcon name="spark" size={20} />}
            title="Train a new network"
            description="Start from random weights."
          />
          <ChoiceCard
            name="lab-net-mode"
            value="continue"
            checked={state.networkMode === "continue"}
            disabled={!hasNetworks}
            onChange={() => update({ networkMode: "continue" })}
            icon={<LabIcon name="loop" size={20} />}
            title="Continue training a network"
            description={hasNetworks ? "Keep improving one you already have — same size, same activation." : "You don't have a network yet."}
          />
          <ChoiceCard
            name="lab-net-mode"
            value="widen"
            checked={state.networkMode === "widen"}
            disabled={!hasNetworks}
            onChange={() =>
              update((s) => {
                const cur = s.sourceNetworkId ? nets?.find((n) => n.id === s.sourceNetworkId) : undefined;
                return { ...s, networkMode: "widen", widenTo: cur ? (s.widenTo && s.widenTo > cur.hidden ? s.widenTo : defaultWidenTarget(cur.hidden)) : s.widenTo };
              })
            }
            icon={<LabIcon name="widen" size={20} />}
            title="Widen a network"
            description={hasNetworks ? "Give a network more hidden neurons, then train it further." : "You don't have a network yet."}
          />
        </div>
      </StepSection>

      {state.networkMode === "new" ? (
        <NewNetworkOptions state={state} update={update} />
      ) : (
        <StepSection
          title={state.networkMode === "continue" ? "Network to continue" : "Network to widen"}
          aside={
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const id = await importNetworkFromFile();
                if (id) update((s) => ({ ...s, sourceNetworkId: id }));
              }}
            >
              <LabIcon name="upload" /> Import .nnue
            </button>
          }
        >
          {state.sourceNetworkId && nets && !src && (
            <div className="callout warn small" role="status">
              The network you picked no longer exists (it may have been deleted). Choose another one.
            </div>
          )}
          <NetworkChoiceList networks={nets} value={state.sourceNetworkId} onChange={chooseSource} />
          {src && state.networkMode === "continue" && <ContinueNote network={src} />}
        </StepSection>
      )}

      {state.networkMode === "widen" && src && (
        <StepSection title="New hidden size" description={`Currently ${src.hidden} neurons. Pick a larger size.`}>
          <HiddenSizeChips
            name="lab-widen"
            label="New hidden size"
            sizes={[...HIDDEN_SIZE_PRESETS, 1024, MAX_HIDDEN].filter((h, i, all) => h > src.hidden && all.indexOf(h) === i)}
            value={state.widenTo}
            onChange={(h) => update({ widenTo: h })}
          />
          <Field label="Or any multiple of 8" hint={`Up to ${MAX_HIDDEN}.`} className="lab-field-narrow">
            <NumberInput value={state.widenTo ?? src.hidden} onChange={(v) => update({ widenTo: v })} integer min={8} max={MAX_HIDDEN} step={8} suffix="neurons" aria-label="New hidden size" />
          </Field>
          <div className="callout lab-explain">
            <strong>The network plays exactly the same until it is trained.</strong> The new neurons start with zero output weights, so they add
            nothing at first; training then puts them to work. A wider network can learn more, but needs more data and searches a little slower.
          </div>
        </StepSection>
      )}
    </div>
  );
}

function NewNetworkOptions({ state, update }: Pick<StepProps, "state" | "update">) {
  const custom = !HIDDEN_SIZE_PRESETS.includes(state.hidden);
  return (
    <>
      <StepSection
        title="Hidden size"
        description="Neurons in the hidden layer. Bigger networks can learn more but need more data, train slower and make the engine search slower. 128 is a good start."
      >
        <HiddenSizeChips name="lab-hidden" label="Hidden size" sizes={HIDDEN_SIZE_PRESETS} value={custom ? null : state.hidden} onChange={(h) => update({ hidden: h })} />
        <Field label="Or any multiple of 8" hint={`From 8 to ${MAX_HIDDEN}.`} className="lab-field-narrow">
          <NumberInput value={state.hidden} onChange={(v) => update({ hidden: v })} integer min={8} max={MAX_HIDDEN} step={8} suffix="neurons" aria-label="Hidden size" />
        </Field>
      </StepSection>
      <StepSection title="Activation" description="How each hidden neuron squashes its input.">
        <div className="lab-choice-grid two" role="radiogroup" aria-label="Activation">
          <ChoiceCard
            name="lab-act"
            value={1}
            checked={state.activation === 1}
            onChange={() => update({ activation: 1 })}
            title={ACTIVATION_NAMES[1]}
            badge={<span className="badge badge-accent">Recommended</span>}
            description="Clamps to 0–1, then squares. Usually a little stronger for the same size."
          />
          <ChoiceCard
            name="lab-act"
            value={0}
            checked={state.activation === 0}
            onChange={() => update({ activation: 0 })}
            title={ACTIVATION_NAMES[0]}
            description="Clamps each neuron to 0–1. The simplest choice, slightly faster."
          />
        </div>
      </StepSection>
    </>
  );
}

function NetworkChoiceList({ networks, value, onChange }: { networks: readonly NetworkRecord[] | undefined; value: string | null; onChange: (n: NetworkRecord) => void }) {
  if (networks === undefined) return <div className="muted small">Loading networks…</div>;
  if (networks.length === 0) {
    return <EmptyState compact title="No networks yet" description="Train a new network first, or import a .nnue file." />;
  }
  const sorted = [...networks].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="lab-pick-list" role="radiogroup" aria-label="Network">
      {sorted.map((n) => (
        <label key={n.id} className={"lab-pick" + (value === n.id ? " checked" : "")}>
          <input type="radio" className="lab-sr-input" name="lab-src-net" checked={value === n.id} onChange={() => onChange(n)} />
          <span className="lab-pick-main">
            <span className="lab-pick-title">
              <span className="truncate">{n.name}</span>
              {n.builtin && <span className="badge">Starter</span>}
            </span>
            <span className="lab-pick-meta">
              HL{n.hidden} {ACTIVATION_NAMES[n.activation]} · val loss {formatLoss(n.stats.valLoss)} · {formatCount(n.stats.positionsSeen)} positions seen
            </span>
          </span>
          <span className="lab-pick-side small faint">
            <TimeAgo ts={n.createdAt} />
          </span>
        </label>
      ))}
    </div>
  );
}

/** Whether the chosen network has float weights / optimizer state (decides what "continue" keeps). */
function ContinueNote({ network }: { network: NetworkRecord }) {
  const [info, setInfo] = useState<{ float: boolean; optimizer: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    networksRepo
      .getData(network.id)
      .then((d) => {
        if (!cancelled) setInfo({ float: !!d?.float, optimizer: !!d?.optimizer });
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [network.id]);
  return (
    <div className="callout lab-explain small">
      Training continues from its weights with the same size (HL{network.hidden}) and activation ({ACTIVATION_NAMES[network.activation]}).{" "}
      {info === null
        ? ""
        : info.optimizer
          ? "Its optimizer state is kept too, so training picks up smoothly."
          : info.float
            ? "It has no saved optimizer state, so the optimizer starts fresh."
            : "It was imported from a file, so training starts from its quantized weights with a fresh optimizer."}
    </div>
  );
}
