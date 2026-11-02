// Engine dropdown: lists engines from the storage hook (colour dot + name + kind badge),
// with search, keyboard navigation, loading / empty states and optional "none"/extra options.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useEngines } from "@/storage";
import type { EngineKind, EngineRecord } from "@/types";
import { Icon } from "./icons";
import { KindBadge } from "./KindBadge";
import "./EnginePicker.css";

export interface EnginePickerOption {
  value: string;
  label: string;
  description?: string;
  color?: string;
  kind?: EngineKind;
}

export interface EnginePickerProps {
  /** Selected engine id (or an extra option's value); null/undefined = nothing selected. */
  value: string | null | undefined;
  onChange: (id: string | null, engine: EngineRecord | null) => void;
  /** Only offer engines passing this test. */
  filter?: (engine: EngineRecord) => boolean;
  /** Offer a "None" entry (value null). */
  allowNone?: boolean;
  noneLabel?: string;
  /** Text when nothing is selected. Default "Choose an engine…". */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  /** Non-engine entries listed first (e.g. { value: "$network", label: "Current network" }). */
  extraOptions?: EnginePickerOption[];
  /** Use this list instead of the storage hook (tests, previews). */
  engines?: EngineRecord[];
  id?: string;
  "aria-label"?: string;
}

interface Opt {
  key: string;
  value: string | null;
  label: string;
  description?: string;
  color?: string;
  kind?: EngineKind;
  engine: EngineRecord | null;
}

function OptionContent({ opt, muted }: { opt: Opt; muted?: boolean }) {
  return (
    <>
      <span
        className={"cb-ep-dot" + (opt.color ? "" : " cb-ep-dot--empty")}
        style={opt.color ? ({ "--cb-ep-dot": opt.color } as CSSProperties) : undefined}
        aria-hidden="true"
      />
      <span className={"cb-ep-name truncate" + (muted ? " muted" : "")}>{opt.label}</span>
      {opt.kind && <KindBadge kind={opt.kind} small />}
    </>
  );
}

export function EnginePicker({
  value,
  onChange,
  filter,
  allowNone,
  noneLabel = "None",
  placeholder = "Choose an engine…",
  disabled,
  className,
  size = "md",
  extraOptions,
  engines: enginesProp,
  id,
  "aria-label": ariaLabel,
}: EnginePickerProps) {
  const stored = useEngines();
  const engines = enginesProp ?? stored;
  const loading = engines === undefined;
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});

  const options = useMemo<Opt[]>(() => {
    const list: Opt[] = [];
    if (allowNone) list.push({ key: "__none", value: null, label: noneLabel, engine: null });
    for (const o of extraOptions ?? []) list.push({ key: `x:${o.value}`, ...o, engine: null });
    const usable = (engines ?? []).filter((e) => !filter || filter(e));
    usable.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const e of usable) list.push({ key: e.id, value: e.id, label: e.name || "Untitled engine", description: e.description, color: e.color, kind: e.kind, engine: e });
    return list;
  }, [engines, filter, allowNone, noneLabel, extraOptions]);

  const engineCount = options.filter((o) => o.engine).length;
  const showSearch = options.length > 7;
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.kind ?? "").includes(q)) : options;
  const selected = options.find((o) => o.value === (value ?? null) && (o.value !== null || allowNone)) ?? null;

  const place = () => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.max(b.width, 260);
    const left = Math.min(b.left, window.innerWidth - width - 8);
    const below = window.innerHeight - b.bottom;
    if (below < 300 && b.top > below) setPos({ left, width, bottom: window.innerHeight - b.top + 4, maxHeight: Math.min(360, b.top - 12) });
    else setPos({ left, width, top: b.bottom + 4, maxHeight: Math.min(360, below - 12) });
  };

  const openList = () => {
    if (disabled || loading) return;
    place();
    setQuery("");
    const i = options.findIndex((o) => o.value === (value ?? null));
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  };
  const closeList = (focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const pick = (o: Opt) => {
    onChange(o.value, o.engine);
    closeList();
  };

  useLayoutEffect(() => {
    if (!open) return;
    (showSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      closeList(false);
    };
    const onMove = () => place();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  // Keep the active option visible.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[active];
      if (o) pick(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeList();
    } else if (e.key === "Tab") {
      closeList(false);
    }
  };

  const unknown = !loading && value && !selected;

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={["select", "cb-ep-button", size === "sm" && "select-sm", open && "cb-ep-button--open", className].filter(Boolean).join(" ")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled || loading}
        title={selected?.description || undefined}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openList();
          }
        }}
      >
        <span className="cb-ep-current">
          {loading ? (
            <>
              <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
              <span className="muted">Loading engines…</span>
            </>
          ) : selected ? (
            <OptionContent opt={selected} muted={selected.value === null} />
          ) : unknown ? (
            <span className="text-warn truncate">Missing engine (deleted?)</span>
          ) : (
            <span className="cb-ep-placeholder truncate">{engineCount === 0 && !extraOptions?.length ? "No engines yet" : placeholder}</span>
          )}
        </span>
        <Icon name="chevronDown" className="cb-ep-chevron" />
      </button>
      {open &&
        createPortal(
          <div ref={popRef} className="cb-ep-pop" style={pos}>
            {showSearch && (
              <div className="cb-ep-search">
                <Icon name="search" />
                <input
                  ref={searchRef}
                  className="cb-ep-search-input"
                  placeholder="Search engines…"
                  value={query}
                  aria-controls={listId}
                  aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onListKey}
                />
              </div>
            )}
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              className="cb-ep-list"
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              onKeyDown={onListKey}
            >
              {filtered.map((o, i) => {
                const isSelected = o.value === (value ?? null) && (o.value !== null || allowNone);
                return (
                  <li
                    key={o.key}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    className={["cb-ep-option", i === active && "active", isSelected && "selected"].filter(Boolean).join(" ")}
                    title={o.description || undefined}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    <OptionContent opt={o} muted={o.value === null} />
                    {isSelected && <Icon name="check" className="cb-ep-check" />}
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="cb-ep-empty" role="presentation">
                  {options.length === 0 ? "No engines yet — create one on the Engines page." : `No engine matches “${query}”.`}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
