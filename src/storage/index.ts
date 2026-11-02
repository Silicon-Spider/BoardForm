// Public API of the storage layer (docs/ARCHITECTURE.md §5).
// Main-thread entry point (it includes the React hooks). Workers import "@/storage/repos" (plus
// "@/storage/events" / "@/storage/db" if needed), which have no React or DOM dependencies.

export { STORE_NAMES, isStoreName, type StoreName } from "./stores";
export { newId } from "./id";
export {
  DB_NAME,
  DB_VERSION,
  StorageError,
  isQuotaError,
  onDatabaseEvent,
  getDatabaseStatus,
  type BoardFormDB,
  type DatabaseEvent,
  type DatabaseEventType,
  type StorageErrorCode,
} from "./db";
export { subscribe, ALL_RECORDS, type ChangeEvent, type ChangeOp, type ChangeListener } from "./events";
export {
  enginesRepo,
  networksRepo,
  datasetsRepo,
  gamesRepo,
  matchesRepo,
  runsRepo,
  settingsRepo,
  chunkId,
  clearAllData,
  type Repo,
  type NetworksRepo,
  type DatasetsRepo,
  type GamesRepo,
  type GamesListOptions,
  type SettingsRepo,
} from "./repos";
export {
  useEngines,
  useEngine,
  useNetworks,
  useNetwork,
  useDatasets,
  useDataset,
  useTrainingRuns,
  useTrainingRun,
  useMatches,
  useMatch,
  useGames,
  useSetting,
  useDatabaseStatus,
} from "./hooks";
export {
  exportBackup,
  importBackup,
  exportEngineFile,
  importEngineFile,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  ENGINE_FILE_FORMAT,
  ENGINE_FILE_VERSION,
  type BackupOptions,
  type StoreCounts,
} from "./backup";
export { requestPersistentStorage, storageEstimate, type StorageEstimateInfo } from "./persist";
export {
  ensureSeeded,
  whenSeeded,
  SEED_FLAG_KEY,
  NETWORK_SEED_FLAG_KEY,
  STARTER_NETWORK_ID,
  STARTER_NNUE_ENGINE_ID,
  STARTER_NETWORK_PATH,
} from "./seed";
