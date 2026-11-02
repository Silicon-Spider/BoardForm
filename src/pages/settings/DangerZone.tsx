// Settings → Danger zone: delete all data, behind a dialog that asks for "DELETE" to be typed.
// Running background work is stopped first so it cannot write into the emptied database; the
// starter engines are created again afterwards.
import { useId, useState } from "react";
import { toast } from "@/app/toast";
import { Modal } from "@/components";
import { arena } from "@/arena";
import { errorMessage } from "@/pages/engines/actions";
import { PageIcon } from "@/pages/engines/icons";
import { clearAllData, datasetsRepo, ensureSeeded, matchesRepo } from "@/storage";
import { datasets, training } from "@/training";
import { SettingRow, SettingsSection } from "./controls";

const CONFIRM_WORD = "DELETE";
/** How long to wait for background services to wind down before deleting anyway. */
const STOP_TIMEOUT_MS = 15_000;

/** Pauses training runs and matches and stops dataset generation running in this tab. */
async function stopBackgroundWork(): Promise<void> {
  const jobs: Array<Promise<unknown>> = training.activeRunIds().map((id) => training.pause(id));
  const [allDatasets, allMatches] = await Promise.all([datasetsRepo.list(), matchesRepo.list()]);
  for (const d of allDatasets) if (datasets.isGenerating(d.id)) jobs.push(datasets.stop(d.id));
  for (const m of allMatches) if (arena.isRunning(m.id)) jobs.push(arena.pause(m.id));
  if (jobs.length === 0) return;
  // Failures do not matter (everything is deleted next), and a service that hangs must not block
  // the deletion forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(jobs), new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_TIMEOUT_MS)))]);
  clearTimeout(timer);
}

export function DangerZone({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection id="danger" title="Danger zone" icon={<PageIcon name="warning" size={18} />} danger>
      <SettingRow
        title="Delete all data"
        description="Permanently deletes every engine, network, dataset, saved game, match, training run and setting stored in this browser. Export a backup first if you might want any of it back."
      >
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          <PageIcon name="warning" size={14} /> Delete all data…
        </button>
      </SettingRow>
      {open && (
        <DeleteAllDialog
          onClose={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false);
            onDeleted();
          }}
        />
      )}
    </SettingsSection>
  );
}

function DeleteAllDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "stopping" | "deleting">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";
  const confirmed = text.trim() === CONFIRM_WORD;

  const run = async () => {
    if (!confirmed || busy) return;
    setError(null);
    try {
      setPhase("stopping");
      await stopBackgroundWork();
      setPhase("deleting");
      await clearAllData();
    } catch (err) {
      setError(errorMessage(err));
      setPhase("idle");
      return;
    }
    let reseeded = true;
    try {
      await ensureSeeded();
    } catch (err) {
      reseeded = false;
      console.error("Could not re-create the starter engines", err);
    }
    toast("All data deleted", {
      kind: "success",
      detail: reseeded ? "The starter engines Blocky, Classic and Sprout are back." : "The starter engines could not be re-created — use Restore starter engines.",
    });
    onDeleted();
  };

  return (
    <Modal
      open
      title="Delete all data?"
      width={480}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn cb-btn-danger-solid" onClick={run} disabled={!confirmed || busy}>
            {busy && <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />}
            {phase === "stopping" ? "Stopping background work…" : phase === "deleting" ? "Deleting…" : "Delete everything"}
          </button>
        </>
      }
    >
      <div className="stack settings-delete">
        <p className="settings-delete-text">
          This permanently deletes <strong>everything</strong> Chess Builder stored in this browser: engines, networks, datasets, saved
          games, matches, training runs and settings. Running training, dataset generation and matches are stopped first. This cannot be
          undone.
        </p>
        <p className="settings-delete-text muted">The starter engines are added again afterwards. Your colour theme is kept.</p>
        <div className="field">
          <label htmlFor={id}>
            Type <code>{CONFIRM_WORD}</code> to confirm
          </label>
          <input
            id={id}
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            data-autofocus
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </div>
        {error && (
          <div id={`${id}-error`} className="callout danger" role="alert">
            <strong>Nothing was deleted.</strong> {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
