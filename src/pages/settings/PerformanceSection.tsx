// Settings → Engines & performance: default hash size, background-worker budget and whether
// engines can be stopped instantly (cross-origin isolation).
import { useEffect, useId, useMemo, useState } from "react";
import { DEFAULT_HASH_MB, defaultMaxWorkers, useDefaultHashMb, useMaxWorkers } from "@/app/preferences";
import { PageIcon } from "@/pages/engines/icons";
import { cx } from "@/pages/engines/ui";
import { debounce } from "@/utils/misc";
import { SettingRow, SettingsSection } from "./controls";
import { MAX_HASH_MB, MIN_HASH_MB, parseHashMb } from "./settings-logic";

const logicalCores = () => (typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4);
const isIsolated = () => typeof SharedArrayBuffer === "function" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

export function PerformanceSection() {
  return (
    <SettingsSection
      id="engines"
      title="Engines & performance"
      icon={<PageIcon name="sliders" size={18} />}
      description="Defaults for how much memory and how many CPU cores your engines may use."
    >
      <HashRow />
      <WorkersRow />
      <StopRow />
    </SettingsSection>
  );
}

function HashRow() {
  const id = useId();
  const [hashMb, setHashMb] = useDefaultHashMb();
  // Text being typed; null shows the saved value. A valid value is saved once typing pauses (or on
  // blur), so the steps on the way ("2", "20", "200" while typing "2000") are never saved, and an
  // invalid final value leaves the saved one unchanged.
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMemo(() => debounce((mb: number) => setHashMb(mb), 600), [setHashMb]);
  useEffect(() => {
    // Leaving the page (or closing the tab) right after typing still saves the value.
    const onHide = () => save.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      save.flush();
    };
  }, [save]);
  const text = draft ?? String(hashMb);
  const invalid = draft !== null && parseHashMb(draft) === null;

  return (
    <SettingRow
      title="Default hash size"
      htmlFor={id}
      description={
        <>
          The transposition table new engines get, also used by engines without a size of their own. Bigger tables help long
          searches; every running engine reserves this much memory. Default {DEFAULT_HASH_MB} MB.
        </>
      }
    >
      <div className="stack-sm settings-hash">
        <div className="settings-input-unit">
          <input
            id={id}
            className={cx("input settings-number", invalid && "is-invalid")}
            type="number"
            inputMode="numeric"
            min={MIN_HASH_MB}
            max={MAX_HASH_MB}
            step={1}
            value={text}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-error` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              const v = parseHashMb(e.target.value);
              if (v !== null && v !== hashMb) save(v);
              else save.cancel(); // invalid, or back to the saved value
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save.flush();
            }}
            onBlur={() => {
              save.flush();
              setDraft(null);
            }}
          />
          <span className="settings-unit">MB</span>
        </div>
        {invalid && (
          <span id={`${id}-error`} className="field-error">
            A whole number from {MIN_HASH_MB} to {MAX_HASH_MB}.
          </span>
        )}
      </div>
    </SettingRow>
  );
}

function WorkersRow() {
  const id = useId();
  const cores = logicalCores();
  const fallback = defaultMaxWorkers();
  const [workers, setWorkers] = useMaxWorkers();
  const [draft, setDraft] = useState<number | null>(null);
  // Dragging the slider saves at most every 250 ms (each save is a database write).
  const save = useMemo(() => debounce((n: number) => setWorkers(n), 250), [setWorkers]);
  useEffect(() => () => save.flush(), [save]);
  useEffect(() => {
    if (draft !== null && workers === draft) setDraft(null);
  }, [workers, draft]);

  const value = Math.min(cores, Math.max(1, Math.round(draft ?? workers)));

  return (
    <SettingRow
      title="Background workers"
      htmlFor={id}
      description={
        <>
          The default and the maximum number of workers for self-play games, arena games played at the same time and NNUE trainer
          threads. Leave a core or two free to keep the page responsive.
        </>
      }
    >
      <div className="settings-workers">
        <input
          id={id}
          type="range"
          className="settings-range"
          min={1}
          max={cores}
          step={1}
          value={value}
          aria-valuetext={`${value} of ${cores} cores`}
          onChange={(e) => {
            const n = Number(e.target.value);
            setDraft(n);
            save(n);
          }}
          onPointerUp={() => save.flush()}
          onKeyUp={() => save.flush()}
        />
        <output htmlFor={id} className="settings-workers-value num">
          {value}
        </output>
        <div className="settings-workers-meta small muted">
          of {cores} logical cores
          {value !== fallback && (
            <>
              {" · "}
              <button
                type="button"
                className="settings-link-button"
                onClick={() => {
                  save.cancel();
                  setDraft(null);
                  setWorkers(fallback);
                }}
              >
                Reset to {fallback}
              </button>
            </>
          )}
        </div>
      </div>
    </SettingRow>
  );
}

function StopRow() {
  const isolated = isIsolated();
  return (
    <SettingRow
      title="Instant engine stop"
      description={
        isolated
          ? "The page is cross-origin isolated, so the app can tell a searching engine to stop through shared memory."
          : "This page is not cross-origin isolated (SharedArrayBuffer is unavailable). Everything still works, but stopping a search restarts the engine's worker."
      }
    >
      <span className={cx("badge", isolated ? "badge-ok" : "badge-warn", "settings-status")}>
        <span className="settings-status-dot" aria-hidden="true" />
        {isolated ? "Available" : "Unavailable"}
      </span>
      <span className="small muted settings-status-detail">{isolated ? "(cross-origin isolated)" : "— engines are stopped by restarting their worker"}</span>
    </SettingRow>
  );
}
