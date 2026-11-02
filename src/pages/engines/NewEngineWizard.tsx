// New-engine wizard (docs/ARCHITECTURE.md §6, "#/engines?new=1"). Step 1 chooses how to build the
// engine, step 2 asks for the details; "Create engine" saves the record (records.ts) and hands it
// to the page, which opens it in the Workshop.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { getDefaultHashMb } from "@/app/preferences";
import { EnginePicker, Icon, Modal, kindColor } from "@/components";
import { enginesRepo, newId, useEngines, useNetworks } from "@/storage";
import type { EngineKind, EngineRecord } from "@/types";
import { errorMessage } from "./actions";
import { ColorSwatches } from "./ColorSwatches";
import { PageIcon, type PageIconName } from "./icons";
import { NetworkChoice } from "./NetworkChoice";
import {
  MAX_NAME_LENGTH,
  createEngineRecord,
  defaultNetworkId,
  isHexColor,
  pickDefaultColor,
  suggestName,
  type Approach,
  type ScratchVariant,
} from "./records";
import { cx } from "./ui";
import { checkWasmModule } from "./wasm-check";
import { WasmUpload, type WasmUploadState } from "./WasmUpload";

export interface ApproachInfo {
  id: Approach;
  title: string;
  description: string;
  icon: PageIconName | "copy";
  /** Kind of the engine it creates (null for a copy: the source's kind). */
  kind: EngineKind | null;
}

export const APPROACHES: readonly ApproachInfo[] = [
  {
    id: "blocks",
    title: "Blocks",
    description: "Drag and drop evaluation terms — material, piece-square tables, pawn structure, king safety — and change their numbers. No code needed.",
    icon: "puzzle",
    kind: "blocks",
  },
  {
    id: "eval",
    title: "Evaluation code",
    description: "Write evaluate() in AssemblyScript. The search, move generation and time management are provided.",
    icon: "code",
    kind: "eval",
  },
  {
    id: "full",
    title: "Full engine code",
    description: "Every file of the engine — search, move generation and evaluation — is yours to edit.",
    icon: "layers",
    kind: "full",
  },
  {
    id: "scratch",
    title: "From scratch",
    description: "Your own engine in a single file: an empty skeleton with only the ABI functions, or a minimal working engine.",
    icon: "pencil",
    kind: "scratch",
  },
  {
    id: "nnue",
    title: "NNUE",
    description: "The stock search with a neural-network evaluation. Choose a network from the NNUE Lab now or later.",
    icon: "network",
    kind: "nnue",
  },
  {
    id: "wasm",
    title: "Upload .wasm",
    description: "An engine compiled elsewhere (C, C++, Rust, Zig, AssemblyScript …) that implements the Engine ABI.",
    icon: "chip",
    kind: "wasm",
  },
  {
    id: "copy",
    title: "Copy an existing engine",
    description: "Start from one of your engines. Its code, blocks, network and settings are copied.",
    icon: "copy",
    kind: null,
  },
];

export function ApproachIcon({ info, size = 20 }: { info: ApproachInfo; size?: number }) {
  return info.icon === "copy" ? <Icon name="copy" size={size} /> : <PageIcon name={info.icon} size={size} />;
}

export const approachColor = (info: ApproachInfo): string => (info.kind ? kindColor(info.kind) : "var(--accent)");

/** Shown under the Name field (not in the footer) when the name is empty. */
const NAME_MISSING = "Give your engine a name.";

const SCRATCH_VARIANTS: ReadonlyArray<{ id: ScratchVariant; title: string; description: string }> = [
  {
    id: "minimal",
    title: "Minimal working engine",
    description: "A complete small engine in one file (0x88 board, alpha-beta search, material and piece-square tables). It plays straight away and is written to be read and extended.",
  },
  {
    id: "empty",
    title: "Empty skeleton",
    description: "Only the Engine ABI functions, with the text plumbing done. It plays no moves until you write them.",
  },
];

export interface NewEngineWizardProps {
  /** Approach preselected by "?kind=" (opens straight at the details step). */
  initialKind: EngineKind | null;
  /** Network preselected by "?networkId=" (NNUE engines). */
  initialNetworkId: string | null;
  onClose: () => void;
  /** Called after the engine was saved. */
  onCreated: (engine: EngineRecord) => void;
}

export function NewEngineWizard({ initialKind, initialNetworkId, onClose, onCreated }: NewEngineWizardProps) {
  const engines = useEngines();
  const networks = useNetworks();
  const uid = useId();
  const formId = `${uid}-form`;
  const nameId = `${uid}-name`;
  const sourceFieldId = `${uid}-source`;
  const wasmButtonId = `${uid}-wasm-choose`;
  const stepRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const [step, setStep] = useState<"approach" | "details">(initialKind ? "details" : "approach");
  const [approach, setApproach] = useState<Approach | null>(initialKind);
  // Name, description and colour follow a suggestion until the user edits them (null = untouched).
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [scratchVariant, setScratchVariant] = useState<ScratchVariant>("minimal");
  // undefined = not chosen yet: an NNUE engine then gets the default network (defaultNetworkId).
  const [chosenNetworkId, setNetworkId] = useState<string | null | undefined>(initialNetworkId ?? undefined);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [wasm, setWasm] = useState<WasmUploadState>({ status: "empty" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasmJob = useRef<{ token: number; abort: AbortController } | null>(null);

  // Abandon a running module check when the wizard closes.
  useEffect(() => () => wasmJob.current?.abort.abort(), []);

  // Moving between the steps: focus the first decision of the new step (on open, the Modal
  // focuses the first control itself, which is the same element).
  useEffect(() => {
    const opening = firstRender.current;
    firstRender.current = false;
    if (opening && step === "approach") return;
    const target =
      step === "approach"
        ? stepRef.current?.querySelector<HTMLElement>(".engines-approach.is-selected, .engines-approach")
        : document.getElementById(approach === "copy" ? sourceFieldId : approach === "wasm" ? wasmButtonId : nameId);
    target?.focus({ preventScroll: true });
  }, [step, approach, nameId, sourceFieldId, wasmButtonId]);

  const info = APPROACHES.find((a) => a.id === approach) ?? null;
  const takenNames = useMemo(() => (engines ?? []).map((e) => e.name), [engines]);
  const source = approach === "copy" && sourceId ? (engines?.find((e) => e.id === sourceId) ?? null) : null;
  // An NNUE engine without a network only plays its fallback evaluation, so until the user picks
  // one (or "None") it gets the newest trained network — the starter network on a fresh install.
  // An uploaded module keeps "None": it may well have an evaluation of its own.
  const networkId = chosenNetworkId !== undefined ? chosenNetworkId : approach === "nnue" ? defaultNetworkId(networks) : null;
  const network = networkId && networks ? (networks.find((n) => n.id === networkId) ?? null) : null;
  // A preselected network that no longer exists counts as "none".
  const effectiveNetworkId = networks && networkId && !network ? null : networkId;
  const check = wasm.status === "checked" ? wasm.check : null;

  const suggestedName = approach
    ? suggestName(approach, takenNames, {
        source,
        networkName: approach === "nnue" ? network?.name : null,
        moduleName: check?.reportedName,
        fileName: wasm.status === "empty" ? null : wasm.file.name,
      })
    : "";
  const shownName = name ?? suggestedName;
  const shownDescription = description ?? (approach === "copy" ? (source?.description ?? "") : "");
  const sourceColor = approach === "copy" && source && isHexColor(source.color) ? source.color : null;
  const shownColor = color ?? sourceColor ?? pickDefaultColor((engines ?? []).map((e) => e.color));

  const trimmedName = shownName.trim();
  const nameTaken = name !== null && trimmedName !== "" && takenNames.some((n) => n.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase());
  const missingRequirement =
    approach === "copy" && !source
      ? "Choose the engine to copy."
      : approach === "wasm" && !(wasm.status === "checked" && wasm.check.ok)
        ? wasm.status === "checking"
          ? "Checking the module…"
          : "Choose a working .wasm module."
        : trimmedName === ""
          ? NAME_MISSING
          : null;
  // (An NNUE engine waits for the network list, so its default network is known.)
  const canCreate =
    step === "details" && approach !== null && missingRequirement === null && engines !== undefined && (approach !== "nnue" || networks !== undefined) && !busy;

  const chooseApproach = (id: Approach) => {
    setApproach(id);
    setStep("details");
    setError(null);
  };

  const handleWasmFile = (file: File) => {
    wasmJob.current?.abort.abort();
    const abort = new AbortController();
    const token = (wasmJob.current?.token ?? 0) + 1;
    wasmJob.current = { token, abort };
    const fileInfo = { name: file.name, size: file.size };
    const current = () => wasmJob.current?.token === token && !abort.signal.aborted;
    setWasm({ status: "checking", file: fileInfo });
    setError(null);
    void (async () => {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch (err) {
        if (current()) setWasm({ status: "unreadable", file: fileInfo, message: errorMessage(err) });
        return;
      }
      const result = await checkWasmModule(bytes, abort.signal);
      if (current()) setWasm({ status: "checked", file: fileInfo, bytes, check: result });
    })();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canCreate || !approach) return;
    setBusy(true);
    setError(null);
    try {
      const hashMb = await getDefaultHashMb();
      const record = createEngineRecord(
        {
          approach,
          name: shownName,
          description: shownDescription,
          color: shownColor,
          scratchVariant,
          networkId: effectiveNetworkId,
          wasm: wasm.status === "checked" ? wasm.bytes : null,
          wasmSupportsNnue: check?.capabilities.nnue ?? false,
          source,
        },
        { id: newId(), now: Date.now(), hashMb },
      );
      await enginesRepo.put(record);
      onCreated(record);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (!busy) onClose();
  };

  const title = (
    <span className="engines-wizard-title">
      New engine <span className="engines-wizard-stepcount">Step {step === "approach" ? 1 : 2} of 2</span>
    </span>
  );

  const footer =
    step === "approach" ? (
      <button type="button" className="btn" onClick={requestClose}>
        Cancel
      </button>
    ) : (
      <>
        <button type="button" className="btn btn-ghost" onClick={() => setStep("approach")} disabled={busy}>
          <Icon name="prev" /> Back
        </button>
        <span className="spacer" />
        {missingRequirement && missingRequirement !== NAME_MISSING && !busy && <span className="small faint engines-wizard-hint">{missingRequirement}</span>}
        <button type="button" className="btn" onClick={requestClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!canCreate}>
          {busy && <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />}
          {busy ? "Creating…" : "Create engine"}
        </button>
      </>
    );

  return (
    <Modal open title={title} onClose={requestClose} footer={footer} width={720} closeOnBackdrop={step === "approach" && !busy} className="engines-wizard">
      {step === "approach" || !info ? (
        <div className="engines-wizard-step" ref={stepRef}>
          <h3 className="engines-wizard-heading">How do you want to build it?</h3>
          <div className="engines-approaches">
            {APPROACHES.map((a) => (
              <button
                key={a.id}
                type="button"
                className={cx("engines-approach", approach === a.id && "is-selected")}
                style={{ "--approach-color": approachColor(a) } as CSSProperties}
                onClick={() => chooseApproach(a.id)}
              >
                <span className="engines-approach-icon" aria-hidden="true">
                  <ApproachIcon info={a} />
                </span>
                <span className="engines-approach-text">
                  <span className="engines-approach-title">{a.title}</span>
                  <span className="engines-approach-desc">{a.description}</span>
                </span>
                <Icon name="next" className="engines-approach-chevron" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <form id={formId} className="engines-wizard-step engines-wizard-form" onSubmit={submit} noValidate>
          <div className="engines-wizard-chosen" style={{ "--approach-color": approachColor(info) } as CSSProperties}>
            <span className="engines-approach-icon" aria-hidden="true">
              <ApproachIcon info={info} />
            </span>
            <div className="grow">
              <div className="engines-approach-title">{info.title}</div>
              <div className="engines-approach-desc">{info.description}</div>
            </div>
          </div>

          {approach === "copy" && (
            <Field label="Engine to copy" id={sourceFieldId} hint="The original is not changed.">
              <EnginePicker id={sourceFieldId} value={sourceId} onChange={(id) => setSourceId(id)} placeholder="Choose an engine…" />
            </Field>
          )}

          {approach === "wasm" && (
            <Field label="WebAssembly module" labelId={`${uid}-wasm-label`}>
              <WasmUpload state={wasm} onFile={handleWasmFile} labelId={`${uid}-wasm-label`} buttonId={wasmButtonId} />
            </Field>
          )}

          <Field
            label="Name"
            id={nameId}
            hint="Shown on cards, in games and in arena standings."
            warning={nameTaken ? `You already have an engine called “${trimmedName}”. That works, but it can be confusing in matches.` : undefined}
            error={trimmedName === "" ? NAME_MISSING : undefined}
          >
            <input
              id={nameId}
              className="input"
              value={shownName}
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={trimmedName === "" ? true : undefined}
            />
          </Field>

          <Field label="Description" id={`${uid}-description`} optional>
            <textarea
              id={`${uid}-description`}
              className="textarea"
              rows={2}
              value={shownDescription}
              maxLength={500}
              placeholder="What makes this engine special?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          {approach === "scratch" && (
            <Field label="Starting point" labelId={`${uid}-variant-label`}>
              <div className="engines-options" role="radiogroup" aria-labelledby={`${uid}-variant-label`}>
                {SCRATCH_VARIANTS.map((v) => (
                  <label key={v.id} className={cx("engines-option", scratchVariant === v.id && "is-selected")}>
                    <input type="radio" name={`${uid}-variant`} checked={scratchVariant === v.id} onChange={() => setScratchVariant(v.id)} />
                    <span className="engines-option-text">
                      <span className="engines-option-title">{v.title}</span>
                      <span className="engines-option-desc">{v.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          )}

          {(approach === "nnue" || (approach === "wasm" && check?.ok && check.capabilities.nnue)) && (
            <Field label="Network" labelId={`${uid}-network-label`}>
              <NetworkChoice name={`${uid}-network`} value={networkId} onChange={setNetworkId} aria-labelledby={`${uid}-network-label`} />
            </Field>
          )}

          <Field label="Colour" labelId={`${uid}-color-label`} hint="Used for its card, charts and arena standings.">
            <ColorSwatches name={`${uid}-color`} value={shownColor} onChange={setColor} aria-labelledby={`${uid}-color-label`} />
          </Field>

          {error && (
            <div className="callout danger" role="alert">
              <strong>The engine could not be created.</strong> {error}
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

interface FieldProps {
  label: string;
  /** id of the control (for <label htmlFor>). */
  id?: string;
  /** id given to the label text when the control is a group (aria-labelledby). */
  labelId?: string;
  hint?: ReactNode;
  warning?: ReactNode;
  /** A problem that blocks "Create engine" (shown instead of the hint and the warning). */
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}

function Field({ label, id, labelId, hint, warning, error, optional, children }: FieldProps) {
  return (
    <div className="field engines-field">
      {id ? (
        <label htmlFor={id}>
          {label}
          {optional && <span className="faint engines-field-optional"> · optional</span>}
        </label>
      ) : (
        <span className="field-label" id={labelId}>
          {label}
        </span>
      )}
      {children}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : warning ? (
        <div className="field-hint text-warn">{warning}</div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
    </div>
  );
}
