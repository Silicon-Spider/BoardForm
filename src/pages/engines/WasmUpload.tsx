// The .wasm part of the new-engine wizard: a drop zone / file picker and the result of checking
// the module (validity, reported name, capabilities, notes).
import { useState, type DragEvent } from "react";
import { Link } from "@/app/router";
import { Icon, Spinner } from "@/components";
import { pickFile } from "@/utils/misc";
import { PageIcon } from "./icons";
import { cx, formatSize } from "./ui";
import { CAPABILITY_LABELS, type WasmCheck } from "./wasm-check";

export interface WasmFileInfo {
  name: string;
  size: number;
}

export type WasmUploadState =
  | { status: "empty" }
  | { status: "checking"; file: WasmFileInfo }
  | { status: "checked"; file: WasmFileInfo; bytes: ArrayBuffer; check: WasmCheck }
  | { status: "unreadable"; file: WasmFileInfo; message: string };

export interface WasmUploadProps {
  state: WasmUploadState;
  onFile: (file: File) => void;
  labelId: string;
  /** id of the file button (so the wizard can focus it). */
  buttonId?: string;
}

export function WasmUpload({ state, onFile, labelId, buttonId }: WasmUploadProps) {
  const [dragging, setDragging] = useState(false);

  const choose = async () => {
    const file = await pickFile(".wasm,application/wasm");
    if (file) onFile(file);
  };
  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  const dropHandlers = { onDragOver, onDragLeave: () => setDragging(false), onDrop };

  if (state.status === "empty") {
    return (
      <div className={cx("engines-dropzone", dragging && "is-dragging")} {...dropHandlers}>
        <PageIcon name="upload" size={22} className="engines-dropzone-icon" />
        <div>
          <strong>Drop a .wasm file here</strong> or{" "}
          <button id={buttonId} type="button" className="btn btn-sm" onClick={choose} aria-describedby={labelId}>
            Choose file…
          </button>
        </div>
        <div className="small muted">
          Compiled from C, C++, Rust, Zig, AssemblyScript … and implementing the <Link to="/help/abi">Engine ABI</Link>.
        </div>
      </div>
    );
  }

  const { file } = state;
  return (
    <div className={cx("engines-wasm", dragging && "is-dragging")} {...dropHandlers}>
      <div className="engines-wasm-file">
        <PageIcon name="file" size={18} />
        <span className="engines-wasm-file-name truncate" title={file.name}>
          {file.name}
        </span>
        <span className="faint small nowrap">{formatSize(file.size)}</span>
        <span className="spacer" />
        <button id={buttonId} type="button" className="btn btn-sm" onClick={choose} disabled={state.status === "checking"}>
          Choose another…
        </button>
      </div>

      {state.status === "checking" && <Spinner label="Checking the module…" />}

      {state.status === "unreadable" && (
        <div className="callout danger" role="alert">
          <strong>The file could not be read.</strong> {state.message}
        </div>
      )}

      {state.status === "checked" && (
        <>
          {state.check.ok ? (
            <div className="callout ok engines-wasm-verdict">
              <Icon name="check" className="text-ok" />
              <span>
                Ready to use
                {state.check.reportedName ? (
                  <>
                    {" "}
                    — it calls itself <strong>{state.check.reportedName}</strong>
                  </>
                ) : (
                  " — it implements the Engine ABI and started correctly."
                )}
              </span>
            </div>
          ) : (
            <div className="callout danger" role="alert">
              <strong>This module can't be used as an engine.</strong>
              <ul className="engines-wasm-list">
                {state.check.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              <div className="small muted">
                See the <Link to="/help/abi">Engine ABI</Link> for what an engine module has to export.
              </div>
            </div>
          )}

          <ul className="engines-caps" aria-label="Capabilities">
            {CAPABILITY_LABELS.map((c) => {
              const yes = state.check.capabilities[c.key];
              return (
                <li key={c.key} className={cx("engines-cap", yes ? "is-yes" : "is-no")} title={c.hint}>
                  <Icon name={yes ? "check" : "close"} size={13} />
                  {c.label}
                  <span className="engines-sr-only">{yes ? " — supported" : " — not supported"}</span>
                </li>
              );
            })}
          </ul>

          {state.check.warnings.length > 0 && (
            <details className="engines-wasm-notes">
              <summary>
                {state.check.warnings.length === 1 ? "1 note from the check" : `${state.check.warnings.length} notes from the check`}
              </summary>
              <ul className="engines-wasm-list">
                {state.check.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
