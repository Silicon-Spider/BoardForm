// Library actions shared by the engine cards, the empty state and the Settings page.
// Each resolves with its result or rejects with an error whose message can be shown to the user
// (storage functions reject with StorageError, whose messages are written for end users).
import { SEED_FLAG_KEY, ensureSeeded, enginesRepo, exportEngineFile, newId, settingsRepo } from "@/storage";
import type { EngineRecord } from "@/types";
import { downloadBlob, slugify } from "@/utils/misc";
import { copyName, duplicateEngineRecord, redundantRestoredStarters } from "./records";

/** A user-facing message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === "string" && err ? err : "Something went wrong.";
}

/** Saves a copy of the engine ("<name> (copy)") and resolves with it. */
export async function duplicateEngine(engine: EngineRecord, takenNames: readonly string[]): Promise<EngineRecord> {
  const copy = duplicateEngineRecord(engine, { id: newId(), now: Date.now(), name: copyName(engine.name, takenNames) });
  await enginesRepo.put(copy);
  return copy;
}

/** File name of an exported engine: "my-engine.engine.json" (the same name the Workshop's Export uses). */
export function engineFileName(name: string): string {
  return `${slugify(name)}.engine.json`;
}

/** Downloads the engine (sources / blocks / module and its network) as a .engine.json file. */
export async function exportEngine(engine: EngineRecord): Promise<string> {
  const blob = await exportEngineFile(engine.id);
  const fileName = engineFileName(engine.name);
  downloadBlob(blob, fileName);
  return fileName;
}

/**
 * Brings back the starter engines (Blocky, Classic, Sprout) that were deleted or changed, as fresh
 * copies. Starters that are still in the library unchanged are not doubled: seeding creates all
 * three, and the copies that already have an identical twin are removed again. Resolves with the
 * names of the engines that were added (empty when every starter was already there).
 */
export async function restoreStarterEngines(): Promise<string[]> {
  const before = await enginesRepo.list();
  const known = new Set(before.map((e) => e.id));
  await settingsRepo.remove(SEED_FLAG_KEY);
  await ensureSeeded();
  const fresh = (await enginesRepo.list()).filter((e) => e.builtin && !known.has(e.id));
  const redundant = new Set(redundantRestoredStarters(before, fresh));
  for (const id of redundant) await enginesRepo.remove(id);
  return fresh.filter((e) => !redundant.has(e.id)).map((e) => e.name);
}

/** The toast for a finished restore: what came back, or that nothing was missing. */
export function restoredStartersMessage(added: readonly string[]): { message: string; detail: string } {
  if (added.length === 0) {
    return { message: "Your starter engines are all here", detail: "Blocky, Classic and Sprout are already in your library, unchanged." };
  }
  const names = added.length === 1 ? added[0] : `${added.slice(0, -1).join(", ")} and ${added[added.length - 1]}`;
  return { message: "Starter engines restored", detail: `${names} ${added.length === 1 ? "is" : "are"} back in your library.` };
}
