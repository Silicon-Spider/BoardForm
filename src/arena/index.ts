// @/arena — engine matches and tournaments (docs/ARCHITECTURE.md §5).
//
//   initArenaService()   once at start-up (src/main.tsx): interrupted matches become "paused"
//   arena                createMatch / start / pause / abort / deleteMatch / isRunning
//   useLiveMatch(id)     live boards, clocks, infos and log of a match running in this tab
//   playEngineGame(opts) one engine-vs-engine game (also usable outside matches)
//
// Plus the pure helpers the Arena pages use: schedule, standings, config defaults & validation,
// PGN helpers and the arena's extra record fields.
export type * from "./types";

export { initArenaService, arena, playEngineGame, runningMatchIds } from "./service";
export { useLiveMatch, getLiveMatch, matchExtras, summaryDetail, matchElapsedMs } from "./live";
export { runEngineGame, whitePovScore } from "./game";
export {
  buildSchedule,
  buildSlots,
  countGames,
  gamesPerPairingOf,
  openingForSlot,
  pairingsOf,
  slotSeed,
  withOpening,
  DEFAULT_OPENING_SEED,
  type ScheduledGame,
  type ScheduledPairing,
  type ScheduledSlot,
  type SlotOpening,
} from "./schedule";
export {
  autoMatchName,
  colorStats,
  computeStandings,
  crosstable,
  formatPoints,
  participantLabels,
  resolveResults,
  scoreLine,
  whitePoints,
  type CrossCell,
  type ResolvedResult,
  type StandingRow,
} from "./standings";
export {
  defaultConcurrency,
  defaultMatchConfig,
  defaultParticipant,
  normalizeMatchConfig,
  randomSeed,
  validateMatchConfig,
  DEFAULT_RANDOM_PLIES,
  DEFAULT_TIME_CONTROL,
  QUICK_TIME_CONTROL,
  MAX_GAMES_PER_PAIRING,
  MAX_MATCH_GAMES,
  MAX_RANDOM_PLIES,
} from "./config";
export { Adjudicator, DEFAULT_ADJUDICATION, MATE_SCORE, type AdjudicationOutcome } from "./adjudication";
export { chargeMove, hasMatingMaterial, initialClockMs, type ClockCharge } from "./clock";
export { describeTermination, joinPgn, pgnTermination, pgnTimeControl, withFinalComment } from "./pgn";
