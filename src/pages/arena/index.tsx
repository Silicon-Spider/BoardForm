// Arena pages: #/arena (all matches) and #/arena/:id (one match).
// ?new=1 opens the new-match dialog on either page; &engines=<id>,<id> preselects engines and
// &from=<matchId> copies a match's settings (rematch).
import { useEffect, useState } from "react";
import { DEFAULT_HASH_MB, defaultMaxWorkers, getDefaultHashMb, getMaxWorkers } from "@/app/preferences";
import type { PageProps } from "@/app/router";
import { navigate, setQuery } from "@/app/router";
import { settingsRepo, useMatch, useMatches } from "@/storage";
import { MatchDetail } from "./MatchDetail";
import { MatchList } from "./MatchList";
import { NewMatchDialog, REMEMBERED_SETTINGS_KEY, parseRemembered, type FormDefaults } from "./NewMatchDialog";
import "./arena.css";

export default function ArenaPage({ params, query }: PageProps) {
  const id = params.id;
  const showNew = query.get("new") === "1";
  const engineIds = (query.get("engines") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromId = query.get("from");
  const closeNew = () => setQuery({ new: null, engines: null, from: null });

  return (
    <>
      {id ? <MatchDetail id={id} /> : <MatchList onNew={() => setQuery({ new: "1" })} />}
      {showNew && <NewMatchHost engineIds={engineIds} fromId={fromId} onClose={closeNew} />}
    </>
  );
}

/** "Classic vs Blocky" → "Classic vs Blocky (2)", "… (2)" → "… (3)", skipping names in use. */
function nextName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/\s\(\d+\)$/, "");
  for (let k = 2; ; k++) {
    const candidate = `${base} (${k})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function NewMatchHost({ engineIds, fromId, onClose }: { engineIds: string[]; fromId: string | null; onClose: () => void }) {
  const source = useMatch(fromId);
  const matches = useMatches();
  const [defaults, setDefaults] = useState<FormDefaults | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<FormDefaults> => {
      const [hashMb, maxWorkers, stored] = await Promise.all([getDefaultHashMb(), getMaxWorkers(), settingsRepo.get<unknown>(REMEMBERED_SETTINGS_KEY, null)]);
      return { hashMb, maxWorkers, remembered: parseRemembered(stored) };
    };
    load()
      .catch((): FormDefaults => ({ hashMb: DEFAULT_HASH_MB, maxWorkers: defaultMaxWorkers(), remembered: null }))
      .then((d) => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  // Wait for the defaults and the match to copy (and the names in use) before showing the form.
  if (!defaults || (fromId && (source === undefined || matches === undefined))) return null;
  const taken = new Set((matches ?? []).map((m) => m.config.name));
  return (
    <NewMatchDialog
      engineIds={engineIds}
      config={source ? source.config : null}
      name={source ? nextName(source.config.name, taken) : null}
      defaults={defaults}
      onClose={onClose}
      onCreated={(matchId) => navigate(`/arena/${matchId}`)}
    />
  );
}
