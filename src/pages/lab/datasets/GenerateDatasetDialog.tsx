// "Generate dataset" dialog: an engine (or an NNUE network) plays self-play games in the
// background and every position becomes a training example. Remembers the last settings used.
import { useEffect, useMemo, useState } from "react";
import { navigate } from "@/app/router";
import { useMaxWorkers } from "@/app/preferences";
import { toast } from "@/app/toast";
import { EnginePicker, LimitsEditor, Modal, type EnginePickerOption } from "@/components";
import { useDatasets, useEngines, useNetworks, useSetting } from "@/storage";
import { datasets } from "@/training";
import type { EngineLimits, EngineRecord } from "@/types";
import { ACTIVATION_NAMES } from "@/nnue/format";
import { NETWORK_ENGINE_ID, describeEngineLimits, errorMessage, hasAnyLimit } from "../model/format";
import { DEFAULT_SELFPLAY_LIMITS } from "../model/wizard";
import { Field, NumberInput, ProblemList } from "../ui/common";

interface GenerateForm {
  name: string;
  engineId: string;
  networkId: string | null;
  limits: EngineLimits;
  games: number;
  concurrency: number;
  randomPlies: number;
  maxPlies: number;
  skipPlies: number;
  appendTo: string | null;
}

const SETTINGS_KEY = "lab.generateDefaults.v1";

type Remembered = Omit<GenerateForm, "name" | "appendTo">;

export const NETWORK_OPTION: EnginePickerOption = {
  value: NETWORK_ENGINE_ID,
  label: "An NNUE network…",
  description: "The stock NNUE engine playing with one of your networks",
  kind: "nnue",
  color: "var(--kind-nnue)",
};

/** The engine to suggest for self-play: the Classic starter if it exists. */
export function defaultSelfPlayEngine(engines: readonly EngineRecord[] | undefined): EngineRecord | null {
  if (!engines?.length) return null;
  return (
    engines.find((e) => e.builtin && e.name === "Classic") ??
    engines.find((e) => e.name === "Classic") ??
    engines.find((e) => e.kind === "eval" || e.kind === "blocks") ??
    engines[0]
  );
}

function validate(f: GenerateForm, ctx: { engines?: readonly EngineRecord[]; networkIds?: ReadonlySet<string>; maxWorkers: number }): string[] {
  const out: string[] = [];
  if (!f.appendTo && !f.name.trim()) out.push("Give the dataset a name.");
  if (!f.engineId) out.push("Choose the engine that plays the games.");
  else if (f.engineId === NETWORK_ENGINE_ID) {
    if (!f.networkId) out.push("Choose the network that plays the games.");
    else if (ctx.networkIds && !ctx.networkIds.has(f.networkId)) out.push("That network no longer exists — choose another one.");
  } else if (ctx.engines && !ctx.engines.some((e) => e.id === f.engineId)) out.push("That engine no longer exists — choose another one.");
  if (!hasAnyLimit(f.limits)) out.push("Set at least one search limit, for example 5,000 nodes.");
  if (f.skipPlies >= f.maxPlies) out.push("Skip fewer plies than the maximum game length.");
  if (f.concurrency > ctx.maxWorkers) out.push(`Use at most ${ctx.maxWorkers} workers (your limit in Settings).`);
  return out;
}

export function GenerateDatasetDialog({
  open,
  onClose,
  onStarted,
  appendTo,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the new dataset's id; default: open the dataset's page. */
  onStarted?: (datasetId: string) => void;
  /** Preselect "add to this dataset". */
  appendTo?: string | null;
}) {
  const engines = useEngines();
  const networks = useNetworks();
  const allDatasets = useDatasets();
  const [maxWorkers] = useMaxWorkers();
  const [remembered, setRemembered] = useSetting<Remembered | null>(SETTINGS_KEY, null);
  const [form, setForm] = useState<GenerateForm | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState(false);

  // (Re)initialise each time the dialog opens.
  useEffect(() => {
    if (!open) {
      setForm(null);
      return;
    }
    const fallbackEngine = defaultSelfPlayEngine(engines);
    const r = remembered;
    const engineOk = r && (r.engineId === NETWORK_ENGINE_ID || engines?.some((e) => e.id === r.engineId));
    setForm({
      name: "",
      engineId: engineOk ? r.engineId : (fallbackEngine?.id ?? ""),
      networkId: r?.networkId && networks?.some((n) => n.id === r.networkId) ? r.networkId : (networks?.[0]?.id ?? null),
      limits: r?.limits && hasAnyLimit(r.limits) ? { ...r.limits } : { ...DEFAULT_SELFPLAY_LIMITS },
      games: r?.games ?? 100,
      concurrency: Math.min(maxWorkers, r?.concurrency ?? maxWorkers),
      randomPlies: r?.randomPlies ?? 8,
      maxPlies: r?.maxPlies ?? 300,
      skipPlies: r?.skipPlies ?? 8,
      appendTo: appendTo ?? null,
    });
    setNameTouched(false);
    setShowProblems(false);
    // Only when opening: later list updates must not reset what the user typed.
  }, [open]);

  const networkIds = useMemo(() => (networks ? new Set(networks.map((n) => n.id)) : undefined), [networks]);
  if (!open || !form) return null;

  const engine = engines?.find((e) => e.id === form.engineId) ?? null;
  const net = form.networkId ? networks?.find((n) => n.id === form.networkId) : undefined;
  const who = form.engineId === NETWORK_ENGINE_ID ? (net ? net.name : "Network") : (engine?.name ?? "Engine");
  const suggestedName = `${who} self-play · ${describeEngineLimits(form.limits)}`;
  const name = nameTouched ? form.name : form.name || suggestedName;
  const problems = validate({ ...form, name }, { engines, networkIds, maxWorkers });
  const set = (patch: Partial<GenerateForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const submit = async () => {
    if (problems.length) {
      setShowProblems(true);
      return;
    }
    setBusy(true);
    try {
      const id = await datasets.generate({
        name: name.trim(),
        selfPlay: {
          engineId: form.engineId,
          limits: { ...form.limits },
          randomPlies: form.randomPlies,
          games: form.games,
          concurrency: form.concurrency,
          maxPlies: form.maxPlies,
          skipPlies: form.skipPlies,
        },
        networkId: form.engineId === NETWORK_ENGINE_ID ? form.networkId : null,
        appendTo: form.appendTo,
      });
      const { name: _n, appendTo: _a, ...keep } = form;
      setRemembered(keep);
      toast(form.appendTo ? "Adding games to the dataset…" : `Generating “${name.trim()}”…`, { kind: "success", detail: "It keeps running while you use the rest of the app." });
      onClose();
      if (onStarted) onStarted(id);
      else navigate(`/lab/datasets/${id}`);
    } catch (e) {
      toast("Could not start generating", { kind: "error", detail: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Generate a dataset"
      width={640}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            Start generating
          </button>
        </>
      }
    >
      <form
        className="stack lab-generate"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          The engine plays games against itself in the background. Every position it searches (minus checks, captures and the opening) is saved with
          its score and the game's result.
        </p>
        <div className="form-grid lab-form-2">
          <Field label="Who plays">
            <EnginePicker
              value={form.engineId || null}
              onChange={(id) => set({ engineId: id ?? "" })}
              extraOptions={[NETWORK_OPTION]}
              aria-label="Engine that plays the games"
            />
          </Field>
          {form.engineId === NETWORK_ENGINE_ID && (
            <Field label="Network" htmlFor="lab-gen-net">
              <select id="lab-gen-net" className="select" value={form.networkId ?? ""} onChange={(e) => set({ networkId: e.target.value || null })}>
                {(networks ?? []).length === 0 && <option value="">No networks yet</option>}
                {(networks ?? []).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} (HL{n.hidden} {ACTIVATION_NAMES[n.activation]})
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="form-grid lab-form-2">
          <Field label="Save to" htmlFor="lab-gen-target">
            <select id="lab-gen-target" className="select" value={form.appendTo ?? ""} onChange={(e) => set({ appendTo: e.target.value || null })}>
              <option value="">A new dataset</option>
              {(allDatasets ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  Add to “{d.name}”
                </option>
              ))}
            </select>
          </Field>
          {!form.appendTo && (
            <Field label="Name" htmlFor="lab-gen-name">
              <input
                id="lab-gen-name"
                className="input"
                value={name}
                placeholder={suggestedName}
                onChange={(e) => {
                  setNameTouched(true);
                  set({ name: e.target.value });
                }}
              />
            </Field>
          )}
        </div>
        <div className="form-grid lab-form-2">
          <Field label="Games" htmlFor="lab-gen-games" hint="About 100 positions per game">
            <NumberInput id="lab-gen-games" value={form.games} onChange={(v) => set({ games: v })} integer min={1} max={1_000_000} step={10} />
          </Field>
          <Field label="Workers" htmlFor="lab-gen-workers" hint={`Games at once, up to ${maxWorkers}`}>
            <NumberInput id="lab-gen-workers" value={form.concurrency} onChange={(v) => set({ concurrency: v })} integer min={1} max={maxWorkers} step={1} />
          </Field>
        </div>
        <div className="form-grid lab-form-3">
          <Field label="Random opening plies" htmlFor="lab-gen-random">
            <NumberInput id="lab-gen-random" value={form.randomPlies} onChange={(v) => set({ randomPlies: v })} integer min={0} max={40} step={1} />
          </Field>
          <Field label="Max plies per game" htmlFor="lab-gen-max">
            <NumberInput id="lab-gen-max" value={form.maxPlies} onChange={(v) => set({ maxPlies: v })} integer min={10} max={2000} step={10} />
          </Field>
          <Field label="Skip first plies" htmlFor="lab-gen-skip">
            <NumberInput id="lab-gen-skip" value={form.skipPlies} onChange={(v) => set({ skipPlies: v })} integer min={0} max={200} step={1} />
          </Field>
        </div>
        <LimitsEditor value={{ limits: form.limits, timeControl: null }} onChange={(v) => set({ limits: v.limits })} allowClock={false} />
        {showProblems && <ProblemList items={problems} />}
      </form>
    </Modal>
  );
}
