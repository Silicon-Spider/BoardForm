// Library actions shared by the engine cards, the empty state and the Settings page.
// Each resolves with its result or rejects with an error whose message can be shown to the user
// (storage functions reject with StorageError, whose messages are written for end users).
import { SEED_FLAG_KEY, ensureSeeded, enginesRepo, exportEngineFile, newId, settingsRepo } from "@/storage";
import type { EngineRecord } from "@/types";
import { downloadBlob, slugify } from "@/utils/misc";
import { copyName, duplicateEngineRecord } from "./records";

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

/** File name of an exported engine: "my-engine.cbengine.json". */
export function engineFileName(name: string): string {
  return `${slugify(name)}.cbengine.json`;
}

/** Downloads the engine (sources / blocks / module and its network) as a .cbengine.json file. */
export async function exportEngine(engine: EngineRecord): Promise<string> {
  const blob = await exportEngineFile(engine.id);
  const fileName = engineFileName(engine.name);
  downloadBlob(blob, fileName);
  return fileName;
}

/** Adds fresh copies of the starter engines (Blocky, Classic, Sprout). */
export async function restoreStarterEngines(): Promise<void> {
  await settingsRepo.remove(SEED_FLAG_KEY);
  await ensureSeeded();
}
