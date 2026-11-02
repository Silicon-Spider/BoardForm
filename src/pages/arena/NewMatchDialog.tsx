// "New match" dialog: engines with their limits, format, openings, adjudication and how the match
// runs. Opened from the Arena page (also via #/arena?new=1&engines=<id>,<id> or &from=<matchId>
// for a rematch); creates and starts the match, then opens its page.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ADJUDICATION,
  DEFAULT_RANDOM_PLIES,
  DEFAULT_TIME_CONTROL,
  MAX_GAMES_PER_PAIRING,
  MAX_RANDOM_PLIES,
  arena,
  autoMatchName,
  countGames,
  defaultConcurrency,
  normalizeMatchConfig,
  pairingsOf,
  participantLabels,
  randomSeed,
  validateMatchConfig,
} from "@/arena";
import { OPENINGS } from "@/chess";
import { EnginePicker, Icon, LimitsEditor, Modal, Spinner, type LimitsValue } from "@/components";
import { useMaxWorkers } from "@/app/preferences";
import { toast } from "@/app/toast";
import { settingsRepo } from "@/storage";
import type { AdjudicationConfig, MatchConfig } from "@/types";
import { plural } from "@/utils/format";
import { IntField, useEngineMap } from "./shared";

interface Row {
  key: number;
  engineId: string | null;
  value: LimitsValue;
  hashMb: number;
}

type OpeningMode = MatchConfig["openings"]["mode"];

interface FormState {
  name: string;
  /** The user typed a name (otherwise the name follows the engines). */
  nameTouched: boolean;
  rows: Row[];
  same: boolean;
  shared: { value: LimitsValue; hashMb: number };
  format: MatchConfig["format"];
  gamesPerPairing: number;
  openingMode: OpeningMode;
  randomPlies: number;
  seed: number;
  concurrency: number;
  resignOn: boolean;
  resignScoreCp: number;
  resignMoves: number;
  drawOn: boolean;
  drawScoreCp: number;
  drawMoves: number;
  drawMinPly: number;
  maxPliesOn: boolean;
  maxPlies: number;
  saveGames: boolean;
}

let rowKey = 1;
const sameValue = (a: LimitsValue, b: LimitsValue) => JSON.stringify(a) === JSON.stringify(b);

/** Settings key: the last match's settings, used as the defaults of the next new match. */
export const REMEMBERED_SETTINGS_KEY = "arena.lastSettings";

/** What the form remembers between matches (not engines, name or seed). */
export interface RememberedSettings {
  value: LimitsValue;
  hashMb: number;
  gamesPerPairing: number;
  openingMode: OpeningMode;
  randomPlies: number;
  concurrency: number;
  adjudication: AdjudicationConfig;
  saveGames: boolean;
}

/** Defaults loaded before the dialog opens (so it never starts from not-yet-loaded settings). */
export interface FormDefaults {
  hashMb: number;
  maxWorkers: number;
  remembered: RememberedSettings | null;
}

/** A stored RememberedSettings, or null when it is missing or malformed. */
export function parseRemembered(v: unknown): RememberedSettings | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<RememberedSettings>;
  const okNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (!r.value || typeof r.value !== "object" || !okNum(r.hashMb) || !okNum(r.gamesPerPairing) || !okNum(r.concurrency) || !r.adjudication) return null;
  if (r.openingMode !== "book" && r.openingMode !== "random-plies" && r.openingMode !== "none") return null;
  return {
    value: { limits: { ...(r.value.limits ?? {}) }, timeControl: r.value.timeControl ? { ...r.value.timeControl } : null },
    hashMb: r.hashMb,
    gamesPerPairing: r.gamesPerPairing,
    openingMode: r.openingMode,
    randomPlies: okNum(r.randomPlies) ? r.randomPlies : DEFAULT_RANDOM_PLIES,
    concurrency: r.concurrency,
    adjudication: { ...DEFAULT_ADJUDICATION, ...r.adjudication },
    saveGames: r.saveGames !== false,
  };
}

function initialState(opts: { engineIds: string[]; config: MatchConfig | null; name: string | null; defaults: FormDefaults }): FormState {
  const d = DEFAULT_ADJUDICATION;
  const c = opts.config;
  const { hashMb, maxWorkers, remembered } = opts.defaults;
  const defaultValue: LimitsValue = remembered?.value ?? { limits: {}, timeControl: { ...DEFAULT_TIME_CONTROL } };
  if (c) {
    const rows: Row[] = c.participants.map((p) => ({ key: rowKey++, engineId: p.engineId, value: { limits: { ...p.limits }, timeControl: p.timeControl ? { ...p.timeControl } : null }, hashMb: p.hashMb ?? hashMb }));
    const same = rows.every((r) => sameValue(r.value, rows[0].value) && r.hashMb === rows[0].hashMb);
    const a = c.adjudication;
    return {
      name: opts.name ?? c.name,
      nameTouched: true,
      rows,
      same,
      shared: { value: rows[0]?.value ?? defaultValue, hashMb: rows[0]?.hashMb ?? hashMb },
      format: c.format,
      gamesPerPairing: c.gamesPerPairing,
      openingMode: c.openings.mode,
      randomPlies: c.openings.randomPlies ?? DEFAULT_RANDOM_PLIES,
      seed: c.openings.seed ?? randomSeed(),
      concurrency: Math.min(c.concurrency, Math.max(1, maxWorkers)),
      resignOn: a.resignScoreCp !== null,
      resignScoreCp: a.resignScoreCp ?? d.resignScoreCp!,
      resignMoves: a.resignMoves,
      drawOn: a.drawScoreCp !== null,
      drawScoreCp: a.drawScoreCp ?? d.drawScoreCp!,
      drawMoves: a.drawMoves,
      drawMinPly: a.drawMinPly,
      maxPliesOn: a.maxPlies !== null,
      maxPlies: a.maxPlies ?? d.maxPlies!,
      saveGames: c.saveGames,
    };
  }
  const ids = opts.engineIds.length > 0 ? opts.engineIds : [];
  const rowHash = remembered?.hashMb ?? hashMb;
  const rows: Row[] = (ids.length >= 2 ? ids : [...ids, ...Array<string | null>(2 - ids.length).fill(null)]).map((id) => ({
    key: rowKey++,
    engineId: id,
    value: defaultValue,
    hashMb: rowHash,
  }));
  const a = remembered?.adjudication ?? d;
  return {
    name: "",
    nameTouched: false,
    rows,
    same: true,
    shared: { value: defaultValue, hashMb: rowHash },
    format: "round-robin",
    gamesPerPairing: remembered?.gamesPerPairing ?? 10,
    openingMode: remembered?.openingMode ?? "book",
    randomPlies: remembered?.randomPlies ?? DEFAULT_RANDOM_PLIES,
    seed: randomSeed(),
    concurrency: Math.max(1, Math.min(remembered?.concurrency ?? defaultConcurrency(maxWorkers), maxWorkers)),
    resignOn: a.resignScoreCp !== null,
    resignScoreCp: a.resignScoreCp ?? d.resignScoreCp!,
    resignMoves: a.resignMoves,
    drawOn: a.drawScoreCp !== null,
    drawScoreCp: a.drawScoreCp ?? d.drawScoreCp!,
    drawMoves: a.drawMoves,
    drawMinPly: a.drawMinPly,
    maxPliesOn: a.maxPlies !== null,
    maxPlies: a.maxPlies ?? d.maxPlies!,
    saveGames: remembered?.saveGames ?? true,
  };
}

function toConfig(s: FormState, name: string): MatchConfig {
  return {
    name,
    participants: s.rows.map((r) => {
      const v = s.same ? s.shared.value : r.value;
      return { engineId: r.engineId ?? "", limits: { ...v.limits }, timeControl: v.timeControl ? { ...v.timeControl } : null, hashMb: s.same ? s.shared.hashMb : r.hashMb };
    }),
    format: s.format,
    gamesPerPairing: s.gamesPerPairing,
    openings: { mode: s.openingMode, seed: s.seed, ...(s.openingMode === "random-plies" ? { randomPlies: s.randomPlies } : {}) },
    concurrency: s.concurrency,
    adjudication: {
      resignScoreCp: s.resignOn ? s.resignScoreCp : null,
      resignMoves: s.resignMoves,
      drawScoreCp: s.drawOn ? s.drawScoreCp : null,
      drawMoves: s.drawMoves,
      drawMinPly: s.drawMinPly,
      maxPlies: s.maxPliesOn ? s.maxPlies : null,
    },
    saveGames: s.saveGames,
  };
}

export interface NewMatchDialogProps {
  /** Engines to start with (e.g. from ?engines=). */
  engineIds?: string[];
  /** A match config to copy (rematch). */
  config?: MatchConfig | null;
  /** Name for a copied config. */
  name?: string | null;
  defaults: FormDefaults;
  onClose(): void;
  onCreated(matchId: string): void;
}

export function NewMatchDialog({ engineIds = [], config = null, name = null, defaults, onClose, onCreated }: NewMatchDialogProps) {
  const engines = useEngineMap();
  const [maxWorkers] = useMaxWorkers();
  const [s, setS] = useState<FormState>(() => initialState({ engineIds, config, name, defaults }));
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const update = (patch: Partial<FormState>) => setS((prev) => ({ ...prev, ...patch }));

  // Without engines in the URL, start with the two most recently edited engines.
  const prefilled = useRef(engineIds.length > 0 || config !== null);
  useEffect(() => {
    if (prefilled.current || !engines) return;
    prefilled.current = true;
    const ids = [...engines.keys()].slice(0, 2);
    setS((prev) => (prev.rows.every((r) => !r.engineId) ? { ...prev, rows: prev.rows.map((r, i) => ({ ...r, engineId: ids[i] ?? null })) } : prev));
  }, [engines]);

  const labels = useMemo(
    () => participantLabels({ participants: s.rows.map((r) => ({ engineId: r.engineId ?? "", limits: {}, timeControl: null })) }, (id) => (id ? (engines?.get(id)?.name ?? null) : null)),
    [s.rows, engines],
  );
  const autoName = autoMatchName({ participants: s.rows.map(() => ({ engineId: "", limits: {}, timeControl: null })), format: s.format }, labels.map((l, i) => (s.rows[i].engineId ? l : `Engine ${i + 1}`)));
  const matchName = s.nameTouched ? s.name : autoName;
  const draft = toConfig(s, matchName.trim() || autoName);
  const total = s.rows.length >= 2 ? countGames(draft) : 0;
  const pairings = pairingsOf(draft).length;

  const problems = validateMatchConfig(normalizeMatchConfig(draft), { maxConcurrency: maxWorkers });
  if (engines && s.rows.some((r) => r.engineId && !engines.has(r.engineId))) problems.unshift("An engine in this list was deleted. Choose another one.");
  // The limits editor warns about this too ("would think forever"); don't let it through silently.
  if (draft.participants.some((p) => !p.timeControl && !p.limits.depth && !p.limits.nodes && !p.limits.movetimeMs)) {
    problems.push(s.same ? "Set a clock or at least one search limit." : "Give every engine a clock or at least one search limit.");
  }
  const ids = s.rows.map((r) => r.engineId).filter((id): id is string => !!id);
  const duplicates = ids.length !== new Set(ids).size;

  const setRow = (key: number, patch: Partial<Row>) => update({ rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const addRow = () => update({ rows: [...s.rows, { key: rowKey++, engineId: null, value: s.shared.value, hashMb: s.shared.hashMb }] });
  const removeRow = (key: number) => update({ rows: s.rows.filter((r) => r.key !== key) });
  const toggleSame = (same: boolean) => {
    if (same) update({ same, shared: { value: s.rows[0]?.value ?? s.shared.value, hashMb: s.rows[0]?.hashMb ?? s.shared.hashMb } });
    else update({ same, rows: s.rows.map((r) => ({ ...r, value: s.shared.value, hashMb: s.shared.hashMb })) });
  };

  const submit = async () => {
    setShowProblems(true);
    setSubmitError(null);
    if (problems.length > 0) return;
    setBusy(true);
    let id: string;
    try {
      id = await arena.createMatch(draft);
      const remember: RememberedSettings = {
        value: s.same ? s.shared.value : s.rows[0].value,
        hashMb: s.same ? s.shared.hashMb : s.rows[0].hashMb,
        gamesPerPairing: s.gamesPerPairing,
        openingMode: s.openingMode,
        randomPlies: s.randomPlies,
        concurrency: s.concurrency,
        adjudication: draft.adjudication,
        saveGames: s.saveGames,
      };
      settingsRepo.set(REMEMBERED_SETTINGS_KEY, remember).catch((err: unknown) => console.warn("[arena] could not remember the match settings", err));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    try {
      await arena.start(id);
    } catch (err) {
      toast("The match was created but could not start", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    }
    setBusy(false);
    onCreated(id);
  };

  const formatHelp =
    s.format === "round-robin"
      ? "Every engine plays every other engine."
      : `${labels[0] && s.rows[0]?.engineId ? labels[0] : "The first engine"} plays each of the others; the others don't play each other.`;

  return (
    <Modal
      open
      title={config ? "Rematch" : "New match"}
      onClose={() => !busy && onClose()}
      width={780}
      className="arena-dialog"
      footer={
        <div className="arena-dialog-footer">
          <span className="small muted arena-dialog-summary" data-testid="arena-form-summary">
            {total > 0 ? `${plural(total, "game")} · ${Math.min(s.concurrency, total)} at a time` : "Add at least two engines"}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy} data-testid="arena-form-start">
            {busy ? <Spinner size={14} /> : <Icon name="play" size={14} />} Start match
          </button>
        </div>
      }
    >
      <form
        className="arena-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="arena-name">Name</label>
          <input
            id="arena-name"
            className="input"
            value={matchName}
            placeholder={autoName}
            maxLength={120}
            onChange={(e) => update({ name: e.target.value, nameTouched: e.target.value.trim() !== "" })}
          />
        </div>

        <section className="arena-form-section" aria-labelledby="arena-engines-title">
          <div className="arena-form-section-head">
            <h3 className="section-title" id="arena-engines-title">
              Engines
            </h3>
            <label className="checkbox small">
              <input type="checkbox" checked={s.same} onChange={(e) => toggleSame(e.target.checked)} /> Same settings for every engine
            </label>
          </div>
          <ol className="arena-form-rows">
            {s.rows.map((r, i) => (
              <li key={r.key} className="arena-form-row" data-testid="arena-form-row">
                <div className="arena-form-row-main">
                  <span className="arena-form-row-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <EnginePicker
                    className="grow"
                    value={r.engineId}
                    onChange={(id) => setRow(r.key, { engineId: id })}
                    aria-label={`Engine ${i + 1}`}
                  />
                  {s.format === "gauntlet" && i === 0 && <span className="badge badge-accent arena-form-row-tag">Plays everyone</span>}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Remove engine ${i + 1}`}
                    title="Remove"
                    disabled={s.rows.length <= 2}
                    onClick={() => removeRow(r.key)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {!s.same && (
                  <div className="arena-form-row-settings">
                    <LimitsEditor compact value={r.value} onChange={(value) => setRow(r.key, { value })} />
                    <IntField label="Hash" suffix="MB" min={1} max={1024} value={r.hashMb} onChange={(hashMb) => setRow(r.key, { hashMb })} width={90} />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="row-wrap">
            <button type="button" className="btn btn-sm" onClick={addRow} disabled={s.rows.length >= 16}>
              <Icon name="plus" size={14} /> Add engine
            </button>
            {duplicates && (
              <span className="small text-warn arena-form-note">
                <Icon name="alert" size={13} /> The same engine appears more than once: fine for testing settings, it is listed separately in the standings.
              </span>
            )}
          </div>
          {s.same && (
            <div className="arena-form-shared">
              <LimitsEditor value={s.shared.value} onChange={(value) => update({ shared: { ...s.shared, value } })} />
              <IntField
                label="Hash table"
                suffix="MB"
                min={1}
                max={1024}
                value={s.shared.hashMb}
                onChange={(h) => update({ shared: { ...s.shared, hashMb: h } })}
                hint="Memory for each engine's transposition table."
                width={110}
              />
            </div>
          )}
        </section>

        <section className="arena-form-section" aria-labelledby="arena-format-title">
          <h3 className="section-title" id="arena-format-title">
            Format
          </h3>
          <div className="btn-group arena-seg" role="radiogroup" aria-label="Format">
            {(
              [
                ["round-robin", "Round robin"],
                ["gauntlet", "Gauntlet"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={s.format === id} className={"btn btn-sm" + (s.format === id ? " active" : "")} onClick={() => update({ format: id })}>
                {label}
              </button>
            ))}
          </div>
          <p className="small muted arena-form-help">{formatHelp}</p>
          <div className="arena-form-grid">
            <IntField
              label="Games per pairing"
              min={1}
              max={MAX_GAMES_PER_PAIRING}
              value={s.gamesPerPairing}
              onChange={(gamesPerPairing) => update({ gamesPerPairing })}
              hint={
                s.gamesPerPairing % 2 === 1 ? (
                  <span className="text-warn">An even number gives both engines each opening with both colours.</span>
                ) : (
                  "Colours alternate every game."
                )
              }
            />
            <div className="arena-form-total">
              <span className="field-label">Total</span>
              <span className="arena-form-total-value num" data-testid="arena-form-total">
                {s.rows.length >= 2 ? `${plural(pairings, "pairing")} × ${s.gamesPerPairing} = ${plural(total, "game")}` : "—"}
              </span>
            </div>
          </div>
        </section>

        <section className="arena-form-section" aria-labelledby="arena-openings-title">
          <h3 className="section-title" id="arena-openings-title">
            Openings
          </h3>
          <div className="btn-group arena-seg" role="radiogroup" aria-label="Openings">
            {(
              [
                ["book", "Opening book"],
                ["random-plies", "Random moves"],
                ["none", "Start position"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={s.openingMode === id} className={"btn btn-sm" + (s.openingMode === id ? " active" : "")} onClick={() => update({ openingMode: id })}>
                {label}
              </button>
            ))}
          </div>
          <p className="small muted arena-form-help">
            {s.openingMode === "book"
              ? `${OPENINGS.length} balanced main lines (Ruy Lopez, Sicilian, Queen's Gambit, …). Both games of a pair use the same opening with colours swapped.`
              : s.openingMode === "random-plies"
                ? "Each pair of games starts after the same few random legal moves, then colours swap."
                : "Every game starts from the initial position. Deterministic engines may repeat the same game."}
          </p>
          {s.openingMode !== "none" && (
            <div className="arena-form-grid">
              {s.openingMode === "random-plies" && (
                <IntField label="Random plies" min={1} max={MAX_RANDOM_PLIES} value={s.randomPlies} onChange={(randomPlies) => update({ randomPlies })} hint="Half-moves played at random." />
              )}
              <div className="arena-form-seed">
                <IntField label="Seed" min={0} max={2_147_483_647} value={s.seed} onChange={(seed) => update({ seed })} hint="Same seed, same openings." />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => update({ seed: randomSeed() })} title="Pick another seed">
                  <Icon name="reset" size={14} /> New seed
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="arena-form-section" aria-labelledby="arena-adj-title">
          <h3 className="section-title" id="arena-adj-title">
            Adjudication
          </h3>
          <p className="small muted arena-form-help">End clear-cut games early, using the engines' own scores.</p>
          <div className="arena-adj">
            <div className={"arena-adj-rule" + (s.resignOn ? "" : " arena-adj-rule--off")}>
              <label className="checkbox">
                <input type="checkbox" checked={s.resignOn} onChange={(e) => update({ resignOn: e.target.checked })} /> Resign when both engines see one side clearly winning
              </label>
              <div className="arena-adj-fields">
                <IntField label="Ahead by at least" suffix="cp" min={1} max={10_000} value={s.resignScoreCp} onChange={(resignScoreCp) => update({ resignScoreCp })} disabled={!s.resignOn} width={90} />
                <IntField label="For" suffix="moves each" min={1} max={100} value={s.resignMoves} onChange={(resignMoves) => update({ resignMoves })} disabled={!s.resignOn} width={70} />
              </div>
            </div>
            <div className={"arena-adj-rule" + (s.drawOn ? "" : " arena-adj-rule--off")}>
              <label className="checkbox">
                <input type="checkbox" checked={s.drawOn} onChange={(e) => update({ drawOn: e.target.checked })} /> Draw when both engines score the position as level
              </label>
              <div className="arena-adj-fields">
                <IntField label="Within ±" suffix="cp" min={0} max={1_000} value={s.drawScoreCp} onChange={(drawScoreCp) => update({ drawScoreCp })} disabled={!s.drawOn} width={80} />
                <IntField label="For" suffix="moves each" min={1} max={200} value={s.drawMoves} onChange={(drawMoves) => update({ drawMoves })} disabled={!s.drawOn} width={70} />
                <IntField label="After ply" min={0} max={2_000} value={s.drawMinPly} onChange={(drawMinPly) => update({ drawMinPly })} disabled={!s.drawOn} width={80} />
              </div>
            </div>
            <div className={"arena-adj-rule" + (s.maxPliesOn ? "" : " arena-adj-rule--off")}>
              <label className="checkbox">
                <input type="checkbox" checked={s.maxPliesOn} onChange={(e) => update({ maxPliesOn: e.target.checked })} /> Draw games that get too long
              </label>
              <div className="arena-adj-fields">
                <IntField label="After" suffix="plies" min={10} max={5_000} value={s.maxPlies} onChange={(maxPlies) => update({ maxPlies })} disabled={!s.maxPliesOn} width={90} />
              </div>
            </div>
          </div>
        </section>

        <section className="arena-form-section" aria-labelledby="arena-run-title">
          <h3 className="section-title" id="arena-run-title">
            Running
          </h3>
          <div className="arena-form-grid">
            <IntField
              label="Games at once"
              min={1}
              max={Math.max(1, maxWorkers)}
              value={s.concurrency}
              onChange={(concurrency) => update({ concurrency })}
              hint={`Each game runs two engines. Up to ${maxWorkers} (set in Settings).`}
            />
            <label className="checkbox arena-form-save">
              <input type="checkbox" checked={s.saveGames} onChange={(e) => update({ saveGames: e.target.checked })} />
              <span>
                Save every game
                <span className="field-hint arena-block">Needed for replays and PGN export.</span>
              </span>
            </label>
          </div>
        </section>

        {(submitError || (showProblems && problems.length > 0)) && (
          <div className="callout danger arena-form-problems" role="alert">
            {submitError ? (
              <span>{submitError}</span>
            ) : (
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {/* Enter in a field submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
