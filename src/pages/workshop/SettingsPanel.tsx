// Settings tab: name, description, colour, hash size, tags, network (where it applies) and
// information about the engine (kind, template, entry file, dates, origin).
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@/app/router";
import { KIND_DESCRIPTIONS, KindBadge } from "@/components";
import { TEMPLATE_VERSION } from "@/engine-host";
import { useEngine } from "@/storage";
import type { EngineRecord } from "@/types";
import { formatDateTime } from "@/utils/format";
import type { EngineDraft } from "./draft";
import { NetworkDetails, NetworkSelect } from "./NetworkPicker";
import { entryOf, parseTags } from "./records";

const COLORS = ["#5b9cf5", "#38bdf8", "#4cc38a", "#34d399", "#f59e0b", "#e7b14a", "#ef6363", "#f472b6", "#a78bfa", "#94a3b8"];
const HASH_SIZES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** A text field that edits through the draft but keeps its own text while focused. */
function TextField({ value, onChange, onCommit, multiline, id, maxLength, placeholder }: { value: string; onChange?(v: string): void; onCommit?(v: string): void; multiline?: boolean; id: string; maxLength?: number; placeholder?: string }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const props = {
    id,
    value: text,
    maxLength,
    placeholder,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      onCommit?.(text);
    },
    onChange: (e: { target: { value: string } }) => {
      setText(e.target.value);
      onChange?.(e.target.value);
    },
  };
  return multiline ? <textarea className="textarea" rows={3} {...props} /> : <input className="input" {...props} />;
}

export function SettingsPanel({ view, draft, nnueCapable }: { view: EngineRecord; draft: EngineDraft; nnueCapable: boolean | null }) {
  const ids = useId();
  const parent = useEngine(view.parentId ?? null);
  const tags = view.tags ?? [];
  const showNetwork = view.kind === "nnue" || view.kind === "full" || !!view.networkId || nnueCapable === true;
  const hash = view.options?.hashMb ?? 16;
  const hashOptions = HASH_SIZES.includes(hash) ? HASH_SIZES : [...HASH_SIZES, hash].sort((a, b) => a - b);

  return (
    <div className="workshop-settings">
      <div className="field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <TextField
          id={`${ids}-name`}
          value={view.name}
          maxLength={80}
          onChange={(v) => v.trim() && draft.edit({ name: v })}
          onCommit={(v) => {
            const t = v.trim().replace(/\s+/g, " ");
            draft.edit({ name: t || draft.getSnapshot().saved.name || "Untitled engine" });
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-desc`}>Description</label>
        <TextField id={`${ids}-desc`} multiline value={view.description ?? ""} maxLength={600} placeholder="What makes this engine special?" onChange={(v) => draft.edit({ description: v })} />
      </div>
      <div className="field">
        <span className="field-label">Colour</span>
        <div className="row-wrap workshop-swatches" role="radiogroup" aria-label="Engine colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={view.color.toLowerCase() === c}
              aria-label={c}
              className={"workshop-swatch" + (view.color.toLowerCase() === c ? " active" : "")}
              style={{ background: c }}
              onClick={() => draft.edit({ color: c })}
            />
          ))}
          <label className="workshop-swatch workshop-swatch-custom" title="Custom colour">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(view.color) ? view.color : "#5b9cf5"} onChange={(e) => draft.edit({ color: e.target.value })} aria-label="Custom colour" />
          </label>
        </div>
        <span className="field-hint">Used for this engine's cards, charts and arena standings.</span>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-hash`}>Hash table</label>
        <select
          id={`${ids}-hash`}
          className="select"
          value={hash}
          onChange={(e) => {
            draft.edit({ options: { ...draft.view.options, hashMb: Number(e.target.value) } });
            void draft.flush();
          }}
        >
          {hashOptions.map((mb) => (
            <option key={mb} value={mb}>
              {mb} MiB
            </option>
          ))}
        </select>
        <span className="field-hint">Transposition table size, passed as Hash=N (engines without cb_set_option ignore it). The test engine restarts with the new size.</span>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-tags`}>Tags</label>
        <TextField id={`${ids}-tags`} value={tags.join(", ")} placeholder="e.g. aggressive, experiment" onCommit={(v) => draft.edit({ tags: parseTags(v) })} />
        {tags.length > 0 && (
          <div className="row-wrap">
            {tags.map((t) => (
              <span key={t} className="badge">
                {t}
              </span>
            ))}
          </div>
        )}
        <span className="field-hint">Separate tags with commas.</span>
      </div>

      {showNetwork && (
        <div className="field">
          <label htmlFor={`${ids}-net`}>NNUE network</label>
          <NetworkSelect view={view} draft={draft} id={`${ids}-net`} />
          <NetworkDetails view={view} compact />
          {view.kind !== "nnue" && <span className="field-hint">Loaded at start-up when the engine exports cb_nnue_alloc and cb_nnue_load.</span>}
        </div>
      )}

      <section className="workshop-info-card">
        <div className="section-title">About this engine</div>
        <dl className="workshop-dl">
          <dt>Kind</dt>
          <dd>
            <KindBadge kind={view.kind} /> <span className="small muted">{KIND_DESCRIPTIONS[view.kind]}</span>
          </dd>
          {view.kind !== "wasm" && (
            <>
              <dt>Entry file</dt>
              <dd className="mono small">{entryOf(view)}</dd>
              <dt>Template</dt>
              <dd className="small">
                {view.kind === "full" || view.kind === "scratch"
                  ? view.kind === "full"
                    ? `Copied from template version ${view.templateVersion ?? "?"} (current: ${TEMPLATE_VERSION})`
                    : "Not used — every file is your own"
                  : `Stock template, always the current version (${TEMPLATE_VERSION})`}
              </dd>
            </>
          )}
          {view.build && (
            <>
              <dt>Compiler</dt>
              <dd className="small">{view.build.compiler}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd className="small">{formatDateTime(view.createdAt)}</dd>
          <dt>Updated</dt>
          <dd className="small">{formatDateTime(view.updatedAt)}</dd>
          {view.parentId && (
            <>
              <dt>Made from</dt>
              <dd className="small">{parent ? <Link to={`/engines/${encodeURIComponent(parent.id)}`}>{parent.name}</Link> : parent === null ? <span className="faint">a deleted engine</span> : "…"}</dd>
            </>
          )}
        </dl>
        {view.builtin && <p className="small muted">This is a starter engine. Your changes are saved to it; use Duplicate (⋯ menu) to keep an untouched copy first.</p>}
      </section>
    </div>
  );
}
