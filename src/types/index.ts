export * from "./engine";
export * from "./compile";
export * from "./game";
export * from "./nnue";

/** Key/value settings (store "settings"). */
export interface SettingRecord {
  key: string;
  value: unknown;
}
