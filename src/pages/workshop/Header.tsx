// Workshop header: back link, colour dot + inline-editable name, kind badge, autosave and build
// indicators, Build / Play / Match buttons and the actions menu.
import { useEffect, useRef, useState } from "react";
import { Link } from "@/app/router";
import { Icon, KindBadge, Tooltip } from "@/components";
import type { EngineRecord } from "@/types";
import type { DraftSnapshot } from "./draft";
import { MOD_KEY, MenuButton, Pill, type MenuItem } from "./ui";

export interface BuildPillInfo {
  tone: "ok" | "warn" | "danger" | "accent" | "neutral";
  text: string;
  title?: string;
  spinner?: boolean;
}

export interface HeaderProps {
  view: EngineRecord;
  save: DraftSnapshot;
  buildPill: BuildPillInfo | null;
  building: boolean;
  menu: ReadonlyArray<MenuItem | "separator">;
  onRename(name: string): void;
  onBuild(): void;
  onRetrySave(): void;
  onShowBuildLog(): void;
}

function SaveIndicator({ save, onRetry }: { save: DraftSnapshot; onRetry(): void }) {
  if (save.state === "error") {
    return (
      <span className="workshop-save workshop-save--error" role="alert">
        <Tooltip content={save.error ?? "Your changes could not be saved."} maxWidth={360}>
          <span className="row" style={{ gap: 6 }}>
            <Icon name="alert" size={14} />
            <span>{save.gone ? "Not saved — engine deleted" : "Not saved"}</span>
          </span>
        </Tooltip>
        {!save.gone && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
            Retry
          </button>
        )}
      </span>
    );
  }
  if (save.state === "pending" || save.state === "saving") {
    return (
      <span className="workshop-save" role="status" aria-live="polite">
        <span className="spinner workshop-save-spinner" aria-hidden="true" /> Saving…
      </span>
    );
  }
  return (
    <span className="workshop-save workshop-save--ok" role="status" aria-live="polite" title="Every change is saved automatically">
      <Icon name="check" size={14} /> Saved
    </span>
  );
}

/** The engine name as an input that looks like a heading. Commits trimmed on blur / Enter. */
function NameField({ name, onRename }: { name: string; onRename(name: string): void }) {
  const [text, setText] = useState(name);
  const focused = useRef(false);
  const before = useRef(name);
  useEffect(() => {
    if (!focused.current) setText(name);
  }, [name]);
  const commit = () => {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t) {
      setText(before.current);
      onRename(before.current);
    } else {
      if (t !== text) setText(t);
      onRename(t);
    }
  };
  return (
    <input
      className="workshop-name"
      value={text}
      size={Math.max(6, Math.min(40, text.length + 1))}
      maxLength={80}
      aria-label="Engine name"
      spellCheck={false}
      onFocus={() => {
        focused.current = true;
        before.current = name;
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim()) onRename(e.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(before.current);
          onRename(before.current);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

export function WorkshopHeader({ view, save, buildPill, building, menu, onRename, onBuild, onRetrySave, onShowBuildLog }: HeaderProps) {
  const canBuild = view.kind !== "wasm";
  return (
    <header className="workshop-header">
      <div className="workshop-header-title">
        <Link to="/engines" className="btn btn-ghost btn-sm workshop-back" aria-label="Back to your engines" title="Back to your engines">
          <Icon name="prev" />
          <span className="workshop-back-label">Engines</span>
        </Link>
        <span className="workshop-dot" style={{ background: view.color }} aria-hidden="true" />
        <NameField name={view.name} onRename={onRename} />
        <KindBadge kind={view.kind} />
      </div>
      <div className="workshop-header-status">
        <SaveIndicator save={save} onRetry={onRetrySave} />
        {buildPill && (
          <Pill tone={buildPill.tone} spinner={buildPill.spinner} title={buildPill.title} onClick={canBuild ? onShowBuildLog : undefined}>
            {buildPill.text}
          </Pill>
        )}
      </div>
      <div className="workshop-header-actions">
        {canBuild && (
          <Tooltip content={`Compile to WebAssembly (${MOD_KEY}+B)`} placement="bottom">
            <button type="button" className="btn btn-primary" onClick={onBuild} disabled={building} aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+B" : "Control+B"}>
              {building ? <span className="spinner workshop-btn-spinner" aria-hidden="true" /> : <Icon name="play" size={14} />}
              {building ? "Building…" : "Build"}
            </button>
          </Tooltip>
        )}
        <Link to={`/play?engine=${encodeURIComponent(view.id)}`} className="btn" title="Play a game against this engine">
          Play
        </Link>
        <Link to={`/arena?new=1&engines=${encodeURIComponent(view.id)}`} className="btn" title="Start a match with this engine">
          Match
        </Link>
        <MenuButton label={<span aria-hidden="true">⋯</span>} aria-label="More actions" title="More actions" items={menu} />
      </div>
    </header>
  );
}
