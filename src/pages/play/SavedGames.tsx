// Saved games: every finished game (yours and arena matches), newest first, with filters, search,
// open-for-review, PGN download and delete; plus the PGN import dialog used by the analysis board.
import { memo, useMemo, useState } from "react";
import { parsePgn } from "@/chess";
import { EmptyState, Icon, Modal, Spinner, type ConfirmFn } from "@/components";
import { toast } from "@/app/toast";
import { Link } from "@/app/router";
import { gamesRepo, useGames } from "@/storage";
import type { GameRecord } from "@/types";
import { formatDateTime, formatRelativeTime } from "@/utils/format";
import { downloadText, pickFile } from "@/utils/misc";
import { fullMoves, gameTitle, pgnFileName } from "./format";
import { PlayIcon } from "./icons";
import { terminationLabel } from "./rules";

type Filter = "all" | "mine" | "match";

const PAGE = 40;

/** Win / loss / draw from the human's side when exactly one human played, else null. */
function personalResult(g: GameRecord): "win" | "loss" | "draw" | null {
  const wh = g.white.type === "human";
  const bh = g.black.type === "human";
  if (wh === bh || g.result === "*") return null;
  if (g.result === "1/2-1/2") return "draw";
  return (g.result === "1-0") === wh ? "win" : "loss";
}

const resultText = (r: GameRecord["result"]) => (r === "1/2-1/2" ? "½–½" : r === "*" ? "—" : r.replace("-", "–"));

export function downloadGamePgn(g: GameRecord): void {
  downloadText(g.pgn, pgnFileName(g), "application/x-chess-pgn");
}

const GameRow = memo(function GameRow({ g, active, onOpen, onDelete }: { g: GameRecord; active: boolean; onOpen(g: GameRecord): void; onDelete(g: GameRecord): void }) {
  const mine = personalResult(g);
  return (
    <li className={"play-gamerow" + (active ? " play-gamerow--active" : "")}>
      <button type="button" className="play-gamerow-main" onClick={() => onOpen(g)} title="Open this game">
        <span className={`play-gamerow-result${mine ? ` play-gamerow-result--${mine}` : ""}`} title={g.result}>
          {resultText(g.result)}
        </span>
        <span className="play-gamerow-text">
          <span className="play-gamerow-title truncate">{gameTitle(g)}</span>
          <span className="play-gamerow-meta truncate">
            {terminationLabel(g.termination)} · {fullMoves(g.moves.length)} {fullMoves(g.moves.length) === 1 ? "move" : "moves"} ·{" "}
            <time dateTime={new Date(g.createdAt).toISOString()} title={formatDateTime(g.createdAt)}>
              {formatRelativeTime(g.createdAt)}
            </time>
          </span>
        </span>
      </button>
      <span className="play-gamerow-actions">
        {g.matchId && (
          <Link to={`/arena/${g.matchId}`} className="badge badge-violet" title="Played in an arena match">
            Match
          </Link>
        )}
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Download PGN of ${gameTitle(g)}`} title="Download PGN" onClick={() => downloadGamePgn(g)}>
          <PlayIcon name="download" />
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete ${gameTitle(g)}`} title="Delete" onClick={() => onDelete(g)}>
          <Icon name="trash" />
        </button>
      </span>
    </li>
  );
});

export interface SavedGamesProps {
  activeGameId: string | null;
  onOpen(game: GameRecord): void;
  onImport(): void;
  onDeleted?(id: string): void;
  confirm: ConfirmFn;
}

export function SavedGames({ activeGameId, onOpen, onImport, onDeleted, confirm }: SavedGamesProps) {
  const games = useGames();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(() => {
    const all = games ?? [];
    const match = all.filter((g) => !!g.matchId).length;
    return { all: all.length, mine: all.length - match, match };
  }, [games]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (games ?? []).filter((g) => {
      if (filter === "mine" && g.matchId) return false;
      if (filter === "match" && !g.matchId) return false;
      return !q || gameTitle(g).toLowerCase().includes(q) || (g.opening ?? "").toLowerCase().includes(q);
    });
  }, [games, filter, query]);

  const remove = async (g: GameRecord) => {
    const ok = await confirm({
      title: "Delete this game?",
      message: `${gameTitle(g)}, ${fullMoves(g.moves.length)} moves (${formatDateTime(g.createdAt)}). This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await gamesRepo.remove(g.id);
      onDeleted?.(g.id);
      toast("Game deleted", { kind: "success" });
    } catch (err) {
      toast("Could not delete the game", { kind: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const tabs: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "All" },
    { id: "mine", label: "My games" },
    { id: "match", label: "Matches" },
  ];

  return (
    <div className="play-games">
      <div className="play-games-head">
        <div className="btn-group play-seg" role="radiogroup" aria-label="Show games">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={filter === t.id} className={"btn btn-sm" + (filter === t.id ? " active" : "")} onClick={() => setFilter(t.id)}>
              {t.label}
              <span className="play-seg-count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={onImport} title="Load a PGN into the analysis board">
          <PlayIcon name="upload" /> Import PGN
        </button>
      </div>
      {games !== undefined && games.length > 6 && (
        <div className="play-search">
          <Icon name="search" />
          <input className="input input-sm" placeholder="Search players or openings…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search games" />
        </div>
      )}
      {games === undefined ? (
        <div className="play-games-loading">
          <Spinner label="Loading your games…" />
        </div>
      ) : games.length === 0 ? (
        <EmptyState
          compact
          title="No saved games yet"
          description="Finished games are saved here automatically — play one, or import a PGN to study it on the analysis board."
          action={
            <button type="button" className="btn btn-sm" onClick={onImport}>
              <PlayIcon name="upload" /> Import PGN
            </button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState compact title="No games match" description={query ? `Nothing matches “${query}”.` : filter === "match" ? "Games played in arena matches appear here." : "No games in this list yet."} />
      ) : (
        <>
          <ul className="play-gamelist" aria-label="Saved games">
            {list.slice(0, shown).map((g) => (
              <GameRow key={g.id} g={g} active={g.id === activeGameId} onOpen={onOpen} onDelete={remove} />
            ))}
          </ul>
          {list.length > shown && (
            <button type="button" className="btn btn-sm btn-ghost play-games-more" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({list.length - shown} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Paste or open a PGN; the first game is loaded into the analysis board. */
export function PgnImportModal({ open, onClose, onLoad }: { open: boolean; onClose(): void; onLoad(pgn: { startFen: string; moves: string[]; headers: Record<string, string> }): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    const parsed = parsePgn(text);
    if (!parsed) {
      setError("Could not read this PGN. Check that the moves are legal and any FEN tag is valid.");
      return;
    }
    setError(null);
    setText("");
    onLoad(parsed);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import a PGN"
      width={620}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginRight: "auto" }}
            onClick={async () => {
              const file = await pickFile(".pgn,.txt,text/plain,application/x-chess-pgn");
              if (!file) return;
              try {
                setText(await file.text());
                setError(null);
              } catch {
                setError("Could not read that file.");
              }
            }}
          >
            <PlayIcon name="upload" /> Open file…
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={load}>
            Load into analysis
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="play-pgn-text">PGN</label>
        <textarea
          id="play-pgn-text"
          className={"textarea mono play-pgn-text" + (error ? " play-input-error" : "")}
          rows={10}
          spellCheck={false}
          placeholder={'[Event "Casual game"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {error ? <span className="field-error">{error}</span> : <span className="field-hint">Only the first game of the text is loaded; comments and variations are ignored.</span>}
      </div>
    </Modal>
  );
}
