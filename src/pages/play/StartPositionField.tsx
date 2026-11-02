// Start position chooser for the game setup: standard, a book opening (searchable list with a
// preview), a random opening, or a custom position (FEN, or set up on a board editor).
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChessGame, OPENINGS, START_FEN, uciLineToSan, validateFen, type Opening } from "@/chess";
import { BoardEditor, Icon, MiniBoard, Modal } from "@/components";
import { NumberInput } from "./NumberInput";
import { PlayIcon } from "./icons";
import { RANDOM_PLIES_DEFAULT, RANDOM_PLIES_MAX, RANDOM_PLIES_MIN, checkStart } from "./setup";
import type { StartPosition } from "./types";

type Kind = StartPosition["kind"];

const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: "standard", label: "Standard" },
  { kind: "opening", label: "Opening" },
  { kind: "random", label: "Random" },
  { kind: "fen", label: "Custom" },
];

function openingLine(o: Opening, plies = 6): string {
  const san = uciLineToSan(START_FEN, o.moves.slice(0, plies));
  const out: string[] = [];
  san.forEach((m, i) => out.push(i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m));
  return out.join(" ") + (o.moves.length > plies ? " …" : "");
}

/** Searchable opening list with a board preview. */
export function OpeningPicker({ open, current, onClose, onPick }: { open: boolean; current: string | null; onClose(): void; onPick(o: Opening): void }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [active, setActive] = useState<string | null>(current);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(current ?? OPENINGS[0]?.name ?? null);
    }
  }, [open, current]);
  const filtered = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (!q) return OPENINGS;
    return OPENINGS.filter((o) => o.name.toLowerCase().includes(q) || o.eco.toLowerCase().startsWith(q));
  }, [deferred]);
  const selected = OPENINGS.find((o) => o.name === active) ?? null;
  const previewFen = selected ? (ChessGame.fromMoves("startpos", selected.moves)?.fen() ?? START_FEN) : START_FEN;

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    const i = Math.max(0, filtered.findIndex((o) => o.name === active));
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, i + delta))];
    setActive(next.name);
    listRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(next.name)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose an opening"
      width={760}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
            Use this opening
          </button>
        </>
      }
    >
      <div className="play-openings">
        <div className="play-openings-list">
          <div className="play-search">
            <Icon name="search" />
            <input
              className="input"
              placeholder={`Search ${OPENINGS.length} openings by name or ECO code…`}
              value={query}
              autoFocus
              aria-label="Search openings"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(e.key === "ArrowDown" ? 1 : -1);
                } else if (e.key === "Enter" && selected) {
                  e.preventDefault();
                  onPick(selected);
                }
              }}
            />
          </div>
          <ul ref={listRef} className="play-openings-items" role="listbox" aria-label="Openings">
            {filtered.map((o) => (
              <li
                key={o.name}
                data-name={o.name}
                role="option"
                aria-selected={o.name === active}
                className={"play-openings-item" + (o.name === active ? " active" : "")}
                onClick={() => setActive(o.name)}
                onDoubleClick={() => onPick(o)}
              >
                <div className="row-between">
                  <span className="play-openings-name">{o.name}</span>
                  <span className="badge">{o.eco}</span>
                </div>
                <div className="play-openings-line">{openingLine(o)}</div>
              </li>
            ))}
            {filtered.length === 0 && <li className="play-openings-empty">No opening matches “{query}”.</li>}
          </ul>
        </div>
        <div className="play-openings-preview" aria-hidden="true">
          <MiniBoard fen={previewFen} />
          {selected && <div className="small muted">{openingLine(selected, 24)}</div>}
        </div>
      </div>
    </Modal>
  );
}

/** BoardEditor in a dialog; returns a valid FEN. */
export function PositionEditorModal({ open, fen, title = "Set up a position", confirmLabel = "Use position", onClose, onUse }: { open: boolean; fen: string; title?: string; confirmLabel?: string; onClose(): void; onUse(fen: string): void }) {
  const [draft, setDraft] = useState(fen);
  useEffect(() => {
    if (open) setDraft(fen);
  }, [open, fen]);
  const problem = useMemo(() => {
    const v = validateFen(draft);
    if (!v.ok) return v.error ?? "Invalid position";
    const outcome = new ChessGame(draft).outcome();
    return outcome ? `The game is already over in this position (${outcome.termination.replace(/-/g, " ")}).` : null;
  }, [draft]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={820}
      footer={
        <>
          {problem && <span className="field-error play-modal-problem">{problem}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!!problem} onClick={() => onUse(draft)}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <BoardEditor fen={draft} onChange={setDraft} />
    </Modal>
  );
}

export function StartPositionField({ value, onChange, disabled }: { value: StartPosition; onChange(next: StartPosition): void; disabled?: boolean }) {
  const fenId = useId();
  const [openingsOpen, setOpeningsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Remember the custom FEN while the user looks at other kinds.
  const [fenText, setFenText] = useState(value.kind === "fen" ? value.fen : "");
  useEffect(() => {
    if (value.kind === "fen") setFenText(value.fen);
  }, [value]);
  const problem = checkStart(value);

  const choose = (kind: Kind) => {
    if (kind === value.kind) return;
    if (kind === "standard") onChange({ kind: "standard" });
    else if (kind === "random") onChange({ kind: "random", plies: RANDOM_PLIES_DEFAULT });
    else if (kind === "fen") onChange({ kind: "fen", fen: fenText });
    // The opening is set when one is picked, so cancelling the picker keeps the previous start.
    else if (kind === "opening") setOpeningsOpen(true);
  };

  return (
    <div className="play-start">
      <div className="btn-group play-seg play-seg--full" role="radiogroup" aria-label="Start position">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={value.kind === k.kind}
            disabled={disabled}
            className={"btn btn-sm" + (value.kind === k.kind ? " active" : "")}
            onClick={() => choose(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {value.kind === "standard" && <p className="field-hint">The normal starting position.</p>}

      {value.kind === "opening" && (
        <div className="play-start-opening">
          <div className="grow">
            <div className="play-start-opening-name">{value.name}</div>
            <div className="small muted">
              {value.eco && <span className="badge">{value.eco}</span>} {value.moves.length} book plies are played before the game starts.
            </div>
          </div>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setOpeningsOpen(true)}>
            Change…
          </button>
        </div>
      )}

      {value.kind === "random" && (
        <div className="play-start-random">
          <NumberInput
            label="Random plies"
            value={value.plies}
            min={RANDOM_PLIES_MIN}
            max={RANDOM_PLIES_MAX}
            integer
            disabled={disabled}
            onCommit={(v) => v !== null && onChange({ kind: "random", plies: v })}
          />
          <p className="field-hint">Random legal moves, different every game — good for variety between engines.</p>
        </div>
      )}

      {value.kind === "fen" && (
        <div className="play-start-fen">
          <label htmlFor={fenId} className="field-label">
            FEN
          </label>
          <textarea
            id={fenId}
            className={"textarea mono play-fen-input" + (problem ? " play-input-error" : "")}
            rows={2}
            spellCheck={false}
            placeholder="e.g. 8/8/4k3/8/8/4K3/4P3/8 w - - 0 1"
            value={fenText}
            disabled={disabled}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => {
              setFenText(e.target.value);
              onChange({ kind: "fen", fen: e.target.value.trim() });
            }}
          />
          {problem && <span className="field-error">{problem}</span>}
          <div className="row-wrap">
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setEditorOpen(true)}>
              <PlayIcon name="board" /> Set up on a board…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={async () => {
                try {
                  const text = (await navigator.clipboard.readText()).trim();
                  if (text) {
                    setFenText(text);
                    onChange({ kind: "fen", fen: text });
                  }
                } catch {
                  /* clipboard read not allowed: the user can paste into the field */
                }
              }}
            >
              Paste
            </button>
          </div>
        </div>
      )}

      <OpeningPicker
        open={openingsOpen}
        current={value.kind === "opening" ? value.name : null}
        onClose={() => setOpeningsOpen(false)}
        onPick={(o) => {
          setOpeningsOpen(false);
          onChange({ kind: "opening", name: o.name, eco: o.eco, moves: [...o.moves] });
        }}
      />
      <PositionEditorModal
        open={editorOpen}
        fen={value.kind === "fen" && validateFen(value.fen).ok ? value.fen : START_FEN}
        onClose={() => setEditorOpen(false)}
        onUse={(fen) => {
          setEditorOpen(false);
          setFenText(fen);
          onChange({ kind: "fen", fen });
        }}
      />
    </div>
  );
}
