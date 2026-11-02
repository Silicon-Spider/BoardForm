// Main area of an uploaded .wasm engine: what the module exports and imports, which optional
// ABI features it has, warnings from the inspection, "Replace module" and the network selector.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EmptyState, Icon, Spinner } from "@/components";
import { inspectWasm, type WasmInspection } from "@/engine-host";
import { HOST_IMPORTS, REQUIRED_FUNCTIONS } from "@/engine-host/abi";
import { toast } from "@/app/toast";
import type { EngineRecord } from "@/types";
import { formatBytes } from "@/utils/format";
import { downloadBlob, pickFile, slugify } from "@/utils/misc";
import type { EngineDraft } from "./draft";
import { NetworkDetails, NetworkSelect } from "./NetworkPicker";
import type { EngineSession } from "./session";

const FEATURES: Array<{ label: string; exports: string[]; what: string }> = [
  { label: "Evaluation", exports: ["cb_eval"], what: "static eval in the test bench" },
  { label: "Breakdown", exports: ["cb_eval_trace"], what: "evaluation terms" },
  { label: "Perft", exports: ["cb_perft"], what: "move-generation tests" },
  { label: "Options", exports: ["cb_set_option"], what: "hash size" },
  { label: "NNUE", exports: ["cb_nnue_alloc", "cb_nnue_load"], what: "loads networks" },
  { label: "Name", exports: ["cb_name"], what: "self-reported name" },
];

const WASI = new Set(["wasi_snapshot_preview1", "wasi_unstable"]);
const REQUIRED = new Set<string>(REQUIRED_FUNCTIONS);

function importKind(imp: string): "host" | "wasi" | "stub" {
  const dot = imp.indexOf(".");
  const module = imp.slice(0, dot);
  const name = imp.slice(dot + 1);
  if (module === "env" && name in HOST_IMPORTS) return "host";
  if (WASI.has(module)) return "wasi";
  return "stub";
}

export function useInspection(bytes: ArrayBuffer | undefined): WasmInspection | null | undefined {
  const [result, setResult] = useState<{ bytes: ArrayBuffer; info: WasmInspection } | null>(null);
  useEffect(() => {
    if (!bytes || bytes.byteLength === 0) return;
    let cancelled = false;
    inspectWasm(bytes).then(
      (info) => !cancelled && setResult({ bytes, info }),
      (err: unknown) =>
        !cancelled &&
        setResult({ bytes, info: { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], exports: [], imports: [] } }),
    );
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  if (!bytes || bytes.byteLength === 0) return null;
  return result && result.bytes === bytes ? result.info : undefined;
}

export function WasmMain({ view, draft, session }: { view: EngineRecord; draft: EngineDraft; session: EngineSession }) {
  const inspection = useInspection(view.wasm);
  const sessionState = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [replacing, setReplacing] = useState(false);

  // Start the engine once to read its self-reported name (there is nothing to build).
  useEffect(() => {
    if (inspection?.ok) void session.getClient().catch(() => {});
  }, [inspection, session]);

  const exportSet = useMemo(() => new Set(inspection?.exports ?? []), [inspection]);
  const nnueCapable = exportSet.has("cb_nnue_alloc") && exportSet.has("cb_nnue_load");
  const hasModule = !!view.wasm && view.wasm.byteLength > 0;

  const replace = async () => {
    const file = await pickFile(".wasm,application/wasm");
    if (!file) return;
    setReplacing(true);
    try {
      const bytes = await file.arrayBuffer();
      const info = await inspectWasm(bytes);
      if (!info.ok) {
        toast("This module cannot be used as an engine", { kind: "error", detail: info.errors.join("\n") });
        return;
      }
      draft.edit({ wasm: bytes });
      if (!(await draft.flush())) return;
      session.restart("the module was replaced");
      toast(`${hasModule ? "Module replaced" : "Module added"} (${formatBytes(bytes.byteLength)})`, { kind: "success", detail: info.warnings.length ? `${info.warnings.length} warning(s) — see the inspection.` : undefined });
    } catch (err) {
      toast("Could not read the file", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setReplacing(false);
    }
  };

  const actions = (
    <div className="row-wrap">
      <button type="button" className="btn btn-primary" onClick={() => void replace()} disabled={replacing}>
        {replacing ? <span className="spinner workshop-btn-spinner" /> : <Icon name={hasModule ? "reset" : "plus"} size={14} />} {hasModule ? "Replace module…" : "Choose a .wasm file…"}
      </button>
      {view.wasm && view.wasm.byteLength > 0 && (
        <button type="button" className="btn" onClick={() => downloadBlob(new Blob([view.wasm!], { type: "application/wasm" }), `${slugify(view.name)}.wasm`)}>
          Download .wasm
        </button>
      )}
    </div>
  );

  if (!view.wasm || view.wasm.byteLength === 0) {
    return (
      <div className="workshop-wasm">
        <EmptyState title="No WebAssembly module" description="Upload a .wasm file that implements the BoardForm Engine ABI (see Help → Engine ABI)." action={actions} />
      </div>
    );
  }

  return (
    <div className="workshop-wasm">
      <div className="workshop-wasm-grid">
        <section className="card workshop-wasm-card">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Module</h3>
            {inspection === undefined ? <Spinner label="Inspecting…" /> : inspection?.ok ? <span className="badge badge-ok">ABI v1 OK</span> : <span className="badge badge-danger">Not usable</span>}
          </div>
          <dl className="workshop-dl">
            <dt>Name</dt>
            <dd>
              {sessionState.caps?.name ? (
                <span>{sessionState.caps.name}</span>
              ) : sessionState.phase === "starting" ? (
                <span className="faint">Reading…</span>
              ) : (
                <span className="faint">{exportSet.has("cb_name") ? "—" : "Not reported (no cb_name)"}</span>
              )}
            </dd>
            <dt>Size</dt>
            <dd className="num">{formatBytes(view.wasm.byteLength)}</dd>
            <dt>Exports</dt>
            <dd className="num">{inspection ? inspection.exports.length : "…"}</dd>
            <dt>Imports</dt>
            <dd className="num">{inspection ? inspection.imports.length : "…"}</dd>
          </dl>
          {actions}
        </section>

        <section className="card workshop-wasm-card">
          <h3>Optional features</h3>
          <ul className="workshop-features">
            {FEATURES.map((f) => {
              const has = f.exports.every((e) => exportSet.has(e));
              return (
                <li key={f.label} className={has ? "on" : "off"}>
                  <Icon name={has ? "check" : "close"} size={14} />
                  <span className="workshop-feature-label">{f.label}</span>
                  <span className="small faint">
                    {f.exports.join(" + ")} — {f.what}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {inspection && inspection.errors.length > 0 && (
          <section className="callout danger workshop-wasm-wide">
            <strong>Problems</strong>
            <ul className="workshop-plain-list">
              {inspection.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </section>
        )}
        {inspection && inspection.warnings.length > 0 && (
          <section className="callout warn workshop-wasm-wide">
            <strong>Warnings</strong>
            <ul className="workshop-plain-list">
              {inspection.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        {nnueCapable && (
          <section className="card workshop-wasm-wide">
            <h3>NNUE network</h3>
            <p className="small muted">This module can load NNUE networks. The selected network is loaded right after the engine starts.</p>
            <div className="row-wrap">
              <NetworkSelect view={view} draft={draft} />
            </div>
            <div style={{ marginTop: 8 }}>
              <NetworkDetails view={view} />
            </div>
          </section>
        )}

        {inspection && (
          <>
            <section className="card workshop-wasm-card">
              <h3>Exports</h3>
              <ul className="workshop-chips">
                {inspection.exports.map((e) => (
                  <li key={e} className={"workshop-chip" + (REQUIRED.has(e) ? " required" : e.startsWith("cb_") ? " abi" : "")} title={REQUIRED.has(e) ? "Required by the ABI" : e.startsWith("cb_") ? "Optional ABI export" : "Not part of the ABI"}>
                    {e}
                  </li>
                ))}
              </ul>
            </section>
            <section className="card workshop-wasm-card">
              <h3>Imports</h3>
              {inspection.imports.length === 0 ? (
                <p className="small muted">None.</p>
              ) : (
                <ul className="workshop-chips">
                  {inspection.imports.map((imp) => {
                    const k = importKind(imp);
                    return (
                      <li key={imp} className={`workshop-chip ${k}`} title={k === "host" ? "Provided by the host" : k === "wasi" ? "WASI (partly emulated)" : "Stubbed: returns 0"}>
                        {imp}
                        {k === "stub" && <span className="workshop-chip-tag">stub</span>}
                        {k === "wasi" && <span className="workshop-chip-tag">WASI</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
