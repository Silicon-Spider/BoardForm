// Delete-a-match confirmation with the option to delete the match's saved games too.
import { arena } from "@/arena";
import type { ConfirmFn } from "@/components";
import { toast } from "@/app/toast";
import type { MatchRecord } from "@/types";
import { plural } from "@/utils/format";

/** Asks, then deletes. Resolves true when the match was deleted. */
export async function confirmDeleteMatch(confirm: ConfirmFn, record: MatchRecord): Promise<boolean> {
  const saved = record.results.filter((r) => r.gameId).length;
  // The dialog renders this node once; the checkbox writes its state here.
  const choice = { deleteGames: true };
  const running = record.status === "running";
  const ok = await confirm({
    title: `Delete “${record.config.name}”?`,
    message: (
      <div className="stack-sm">
        <p style={{ margin: 0 }}>
          The match and its standings are removed{running ? "; it is stopped first" : ""}. This cannot be undone.
        </p>
        {saved > 0 && (
          <label className="checkbox">
            <input type="checkbox" defaultChecked onChange={(e) => (choice.deleteGames = e.target.checked)} data-testid="arena-delete-games" />
            Also delete its {plural(saved, "saved game")}
          </label>
        )}
      </div>
    ),
    confirmLabel: "Delete match",
    danger: true,
  });
  if (!ok) return false;
  await arena.deleteMatch(record.id, { deleteGames: saved > 0 && choice.deleteGames });
  toast(`Deleted “${record.config.name}”`, { kind: "success" });
  return true;
}
