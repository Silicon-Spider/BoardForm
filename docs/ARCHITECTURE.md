# Chess Builder — architecture & module contracts

Chess Builder is a browser app (React 19 + TypeScript + Vite) in which users create their own
WebAssembly chess engines, train NNUE networks, and play against / pit engines against each other.
Everything runs client-side; all user data is stored in IndexedDB, so it survives closing the tab.

Companion specs (normative): [`ENGINE_ABI.md`](ENGINE_ABI.md), [`ENGINE_TEMPLATE.md`](ENGINE_TEMPLATE.md),
[`NNUE_FORMAT.md`](NNUE_FORMAT.md). Shared types: `src/types/*.ts`.

## 1. Features → modules

| Feature | Where |
|---|---|
| Hand-crafted eval from drag-and-drop blocks with editable parameters | `src/blocks/` (Blockly blocks + AssemblyScript generator), Workshop page |
| Edit just the eval function, the whole engine, or start from scratch | `engine/template/`, `engine/variants/`, Workshop code editor (`src/components/code/`) |
| Compile to WebAssembly in the browser | `src/compiler/` (AssemblyScript compiler in a worker) |
| Run engines | `src/engine-host/` (ABI host, one worker per engine instance) |
| Train / continue / widen NNUE networks, watch training, self-play, background runs | `src/nnue/` (trainer core + worker), `src/training/` (orchestrator, self-play worker), Lab page |
| Persist everything | `src/storage/` (IndexedDB via `idb`) |
| Play vs engine, engine vs engine, analysis; depth / nodes / movetime / clock limits | `src/chess/`, `src/components/`, Play page |
| Engine matches & tournaments | `src/arena/`, Arena page |

## 2. Directory layout & ownership

```
engine/template/*.ts          AssemblyScript engine (WP-ENGINE)            — NOT part of the app tsconfig
engine/variants/...           eval-nnue.ts (WP-NNUE), scratch-* (WP-SCRATCH)
scripts/engine-test.mjs       Node: compile template with asc, perft & search tests (WP-ENGINE)
src/types/                    shared types (architect; additive changes only)
src/app/                      shell: router, layout, activity, toasts (architect)
src/styles/global.css         design tokens + base classes (architect)
src/utils/                    format/hash/download helpers (architect)
src/engine-host/              templates.ts (architect), instance/client/worker/build/limits/inspect (WP-HOST)
src/compiler/                 compiler worker + client + diagnostics (WP-HOST)
src/storage/                  IndexedDB, repos, hooks, backup, seed (WP-STORAGE)
src/chess/                    rules wrapper, openings, PGN (WP-UIKIT)
src/components/               board, move list, clock, charts, modal, tabs, limits editor... (WP-UIKIT)
src/blocks/                   Blockly blocks, generator, PST field, editor component (WP-BLOCKS)
src/nnue/                     format, reference inference, packing, trainer core + worker (WP-TRAINER)
src/components/code/          CodeMirror editor, API reference, file tree (WP-CODE-EDITOR)
src/pages/engines|settings/    library, new-engine wizard, settings (WP-LIBRARY)
src/pages/help/               documentation pages (WP-HELP)
src/pages/workshop/           engine editor (WP-WORKSHOP)
src/pages/play/               play & analysis (WP-PLAY)
src/arena/, src/pages/arena/  match runner + UI (WP-ARENA)
src/training/                 NNUE lab service: runs, self-play worker, datasets, networks (WP-LAB-SERVICE)
src/pages/lab/                NNUE lab UI: networks, datasets, run wizard, dashboards (WP-LAB-UI)
e2e/                          Playwright end-to-end tests
public/pieces/chessnut/       piece SVGs (Apache-2.0, Alexis Luengas, via lichess)
```

Path alias: `@/` → `src/` (vite + tsconfig). Import shared types from `@/types`.

## 3. Runtime architecture

```
Main thread (React UI + services)
 ├─ compiler client ──► compiler.worker  (loads assemblyscript/asc + binaryen once, compiles on demand)
 ├─ EngineClient ×N ──► engine.worker    (one EngineInstance per worker; stop via SharedArrayBuffer flag)
 ├─ arena service   ──► EngineClients (2 per running game)
 ├─ training service──► selfplay.worker ×K (EngineInstance in-worker, plays games, packs positions → IndexedDB)
 │                  └─► trainer.worker    (reads dataset chunks from IndexedDB, trains, posts progress/checkpoints)
 └─ storage (IndexedDB; BroadcastChannel "chess-builder-db" notifies other tabs)
```

* The page is cross-origin isolated (COOP/COEP headers in `vite.config.ts`), so `SharedArrayBuffer`
  is available. All code must still work (degraded) when `crossOriginIsolated` is false.
* Services (training, arena) are module-level singletons, not React state, so they keep running
  while the user navigates. React reads them through zustand stores / hooks.
* Work keeps running while the tab is open (also in the background). Browsers cannot run it while
  the tab is closed — instead every long task checkpoints to IndexedDB and runs flagged
  `autoResume` restart when the app is opened again. Web Locks (`navigator.locks`) ensure only one tab
  executes a given run.

## 4. Data model (IndexedDB database `chess-builder`, version 1)

| Store | Key | Value type (`src/types`) | Indexes |
|---|---|---|---|
| `engines` | `id` | `EngineRecord` | `updatedAt` |
| `networks` | `id` | `NetworkRecord` (metadata only) | `updatedAt` |
| `networkData` | `id` | `NetworkDataRecord` (CBNN bytes + float weights + optimizer) | — |
| `datasets` | `id` | `DatasetRecord` | `updatedAt` |
| `datasetChunks` | `id` | `DatasetChunkRecord` | `datasetId` |
| `games` | `id` | `GameRecord` | `createdAt`, `matchId` |
| `matches` | `id` | `MatchRecord` | `updatedAt` |
| `trainingRuns` | `id` | `TrainingRunRecord` | `updatedAt` |
| `settings` | `key` | `SettingRecord` | — |

Rules: blocks engines store the Blockly JSON in `blocks` **and** the generated code in
`files["eval.ts"]` (regenerated on every change), so building never needs Blockly.
`eval`/`nnue` engines store only overrides in `files` (normally `eval.ts`) and get every other
file from the current template. `full`/`scratch` engines store the complete tree.

## 5. Service APIs (implementations must match these signatures)

### `@/storage` (WP-STORAGE)

```ts
type StoreName = "engines"|"networks"|"networkData"|"datasets"|"datasetChunks"|"games"|"matches"|"trainingRuns"|"settings";
function newId(): string;                                    // crypto.randomUUID()
const enginesRepo:  { list(): Promise<EngineRecord[]>; get(id): Promise<EngineRecord|undefined>;
                      put(r): Promise<void>; update(id, patch: Partial<EngineRecord>): Promise<EngineRecord>; remove(id): Promise<void> };
const networksRepo: { list; get; put; update; remove /* + networkData */;
                      getData(id): Promise<NetworkDataRecord|undefined>; putData(r: NetworkDataRecord): Promise<void> };
const datasetsRepo: { list; get; put; update; remove /* + chunks */;
                      putChunk(r: DatasetChunkRecord): Promise<void>; getChunk(datasetId, index): Promise<DatasetChunkRecord|undefined>;
                      chunkCount(datasetId): Promise<number>; iterateChunks(datasetId): AsyncGenerator<DatasetChunkRecord> };
const gamesRepo:    { list(opts?: { matchId?: string; limit?: number }): Promise<GameRecord[]>; get; put; remove; removeByMatch(matchId) };
const matchesRepo:  { list; get; put; update; remove };
const runsRepo:     { list; get; put; update; remove };      // trainingRuns
const settingsRepo: { get<T>(key: string, fallback: T): Promise<T>; set(key: string, value: unknown): Promise<void> };
type ChangeEvent = { store: StoreName; id: string; op: "put" | "delete" };
function subscribe(store: StoreName | "*", cb: (e: ChangeEvent) => void): () => void;   // same tab + other tabs
// React hooks (undefined while loading; re-query on change events)
useEngines(), useEngine(id), useNetworks(), useNetwork(id), useDatasets(), useTrainingRuns(), useTrainingRun(id),
useMatches(), useMatch(id), useGames(opts?), useSetting<T>(key, fallback): [T, (v: T) => void]
// backup & quota
exportBackup(opts?: { includeDatasets?: boolean; includeGames?: boolean }): Promise<Blob>;
importBackup(file: Blob): Promise<Record<StoreName, number>>;
exportEngineFile(id): Promise<Blob>;   importEngineFile(file: Blob): Promise<string /* new id */>;
requestPersistentStorage(): Promise<boolean>;  storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }>;
ensureSeeded(): Promise<void>;         // first-run starter engines (idempotent, uses settings key "seeded.v1")
```

`@/storage` must be importable from workers (no React in `db.ts`/`repos.ts`; hooks live in `hooks.ts`
and are re-exported from `index.ts`; workers import `@/storage/repos`).

### `@/compiler` (WP-HOST)

```ts
const COMPILER_VERSION: string;                       // "assemblyscript 0.28.20"
function compile(req: CompileRequest, opts?: { onStatus?: (s: "loading-compiler"|"compiling") => void }): Promise<CompileResult>;
function preloadCompiler(): void;
```

### `@/engine-host` (WP-HOST; `templates.ts` by architect)

```ts
// templates.ts
const TEMPLATE_VERSION: number;
const templateFiles: Record<string, string>;          // engine/template/*.ts
const variantFiles: Record<string, string>;           // engine/variants/**, keys like "eval-nnue.ts", "scratch-empty/main.ts"
function defaultFilesFor(kind: EngineKind): Record<string, string>;   // what a new engine of that kind stores in `files`

// instance.ts — synchronous ABI wrapper; works in any worker and in Node
interface EngineInstanceOptions { stopFlag?: Int32Array|null; onInfo?: (i: SearchInfo) => void; onLog?: (s: string) => void;
                                  hashMb?: number; network?: ArrayBuffer|null }
class EngineInstance {
  static create(module: WebAssembly.Module | ArrayBuffer | Uint8Array, opts?: EngineInstanceOptions): Promise<EngineInstance>;
  readonly capabilities: EngineCapabilities;
  newGame(): void; position(startFen: string /* "startpos" | FEN */, moves: string[]): boolean;
  go(limits: SearchLimits): { bestMove: string|null; info: SearchInfo|null; elapsedMs: number };
  eval(): number|null; evalTrace(): TraceEntry[]|null; perft(depth: number): number|null;
  setOption(name: string, value: string): boolean; loadNetwork(bytes: ArrayBuffer): boolean;
}

// client.ts — main-thread async wrapper around an engine.worker
class EngineClient {
  static create(wasm: ArrayBuffer | WebAssembly.Module, opts?: { hashMb?: number; network?: ArrayBuffer|null;
                onLog?: (s: string) => void; label?: string }): Promise<EngineClient>;
  readonly capabilities: EngineCapabilities;  readonly busy: boolean;
  newGame(): Promise<void>; position(startFen: string, moves: string[]): Promise<boolean>;
  go(limits: SearchLimits, onInfo?: (i: SearchInfo) => void): Promise<SearchResult>;   // applies hard deadline
  stop(): void;                                // SAB flag, or terminate + respawn fallback
  eval(): Promise<number|null>; evalTrace(): Promise<TraceEntry[]|null>; perft(depth: number): Promise<number|null>;
  setOption(name: string, value: string): Promise<boolean>; loadNetwork(bytes: ArrayBuffer): Promise<boolean>;
  terminate(): void;
}

// build.ts
function assembleSources(engine: EngineRecord): { files: Record<string,string>; entry: string };  // throws for kind "wasm"
class BuildError extends Error { result: CompileResult }
function buildEngine(engine: EngineRecord, opts?: { force?: boolean; onStatus?: (s: string) => void }):
  Promise<{ ok: boolean; result: CompileResult|null; engine: EngineRecord; fromCache: boolean }>;  // persists build on success
function getEngineArtifacts(engineId: string, opts?: { onStatus? }): Promise<{ engine: EngineRecord; wasm: ArrayBuffer; network: ArrayBuffer|null }>;
function loadEngine(engineId: string, opts?: { hashMb?: number; onLog?; onStatus?; label?: string }): Promise<EngineClient>;
function getStockNnueWasm(): Promise<ArrayBuffer>;     // template + variants/eval-nnue.ts, compiled & cached

// limits.ts
function toSearchLimits(args: { limits: EngineLimits; whiteTc: TimeControl|null; blackTc: TimeControl|null;
  whiteMs: number|null; blackMs: number|null; sideToMove: "w"|"b"; movesPlayed: number }): SearchLimits;
// inspect.ts
function inspectWasm(bytes: ArrayBuffer): Promise<{ ok: boolean; errors: string[]; warnings: string[]; exports: string[]; imports: string[] }>;
```

### `@/chess` (WP-UIKIT) — wraps `chess.js`

```ts
const START_FEN: string; type Color = "w" | "b";
interface MoveInput { from: string; to: string; promotion?: "q"|"r"|"b"|"n" }
class ChessGame {
  constructor(startFen?: string);            // "startpos" (default) or FEN
  readonly startFen: string;
  fen(): string; turn(): Color; ply(): number; moveNumber(): number;
  legalMoves(): string[]; legalMovesMap(): Map<string, string[]>; isLegal(uci: string): boolean;
  play(move: string | MoveInput): { uci: string; san: string } | null;
  undo(): { uci: string; san: string } | null;
  history(): { uci: string[]; san: string[] };  lastMove(): { from: string; to: string } | null;
  inCheck(): boolean; checkSquare(): string | null;
  outcome(): { result: GameResult; termination: Termination } | null;   // mate, stalemate, threefold, fifty, insufficient
  isGameOver(): boolean; fenAt(ply: number): string; clone(): ChessGame;
  pgn(headers?: Record<string, string>, result?: GameResult): string;
}
uciToSan(fen, uci): string|null;  sanToUci(fen, san): string|null;  validateFen(fen): { ok: boolean; error?: string };
mirrorFen(fen): string;           // colour-flipped equivalent position
parsePgn(pgn): { headers: Record<string,string>; startFen: string; moves: string[] } | null;
interface Opening { name: string; eco: string; moves: string[] }
const OPENINGS: Opening[];        pickOpenings(count: number, seed: number): Opening[];
randomPlies(n: number, seed: number, startFen?: string): string[];
```

### `@/components` (WP-UIKIT)

```tsx
<Chessboard fen orientation? interactive?: "white"|"black"|"both"|"none" onMove?(m: MoveInput) lastMove? check?
            arrows?: {from,to,color?}[] squareHighlights?: Record<string,string> showCoordinates? animationMs? className? />
<BoardEditor fen onChange(fen) />          <MiniBoard fen orientation? lastMove? size? />
<MoveList san currentPly? onSelectPly?(ply) startPly? />     <Clock ms running side label? />
<EvalBar cp mate orientation? />           // White POV
<LineChart series={[{ name, color, points: {x,y}[] }]} xLabel? yLabel? height? logY? formatX? formatY? />
<Modal open title onClose footer? width?>   <Tabs tabs active onChange />   <ProgressBar value max label? />
<LimitsEditor value={{ limits, timeControl }} onChange allowClock? compact? />
<EnginePicker value onChange filter? allowNone? placeholder? />   <KindBadge kind />   <Spinner />  <EmptyState title action? />
```

### `@/blocks` (WP-BLOCKS)

```ts
const DEFAULT_WORKSPACE: object;                    // starter HCE workspace (Blockly JSON)
function generateEvalSource(workspace: object): { code: string; errors: string[]; warnings: string[] };  // headless
function BlocksEditor(props: { workspace: object; onChange(workspace: object, code: string): void; readOnly?: boolean }): JSX.Element;
```

### `@/nnue` (WP-TRAINER)

```ts
createNetwork(hidden: number, activation: Activation, seed: number): FloatNetworkData;
widenNetwork(net: FloatNetworkData, newHidden: number, seed: number): FloatNetworkData;
quantizeNetwork(net: FloatNetworkData): ArrayBuffer;            // CBNN v1 file
parseNetworkFile(buf: ArrayBuffer): QuantizedNetwork;           // throws on invalid
evaluateFloat(net: FloatNetworkData, fen: string): number;      // cp, side-to-move POV
evaluateQuantized(net: QuantizedNetwork, fen: string): number;  // exact reference semantics
PACKED_SIZE = 32; packPosition(fen, scoreWhiteCp, result: 0|1|2, out?: Uint8Array, offset?): Uint8Array; unpackPosition(buf, offset): {...}
class TrainerClient { start(job: TrainJob, handlers): Promise<TrainCheckpoint>; pause(); resume(); stop(); terminate() }
```

### `@/components/code` (WP-CODE-EDITOR) — CodeMirror 6

```ts
interface CodeEditorDiagnostic { line: number; column: number; endLine?: number; endColumn?: number;   // 1-based
                                 severity: "error" | "warning" | "info"; message: string }
interface CodeEditorProps {
  value: string; onChange?(value: string): void; readOnly?: boolean;
  language?: "assemblyscript" | "typescript" | "markdown" | "text";   // default "assemblyscript"
  diagnostics?: CodeEditorDiagnostic[];        // shown as underlines + gutter markers + hover text
  onSave?(): void;                             // Ctrl/Cmd+S (prevents the browser's save dialog)
  revealLine?: { line: number; column?: number; nonce: number };   // scroll to + select; bump nonce to repeat
  completions?: boolean;                       // engine-API autocompletion (default true for assemblyscript)
  className?: string; "aria-label"?: string;
}
CodeEditor(props): JSX.Element                 // fills its container (give the parent a height)
interface ApiEntry { name: string; module: string; signature: string; doc: string;
                     kind: "function" | "constant" | "class" | "method" | "type" | "variable" }
ENGINE_API: readonly ApiEntry[]                // every public symbol of engine/template (docs/ENGINE_TEMPLATE.md)
ApiReference(props: { onInsert?(snippet: string, entry: ApiEntry): void; modules?: string[]; className?: string }): JSX.Element
interface FileTreeProps { files: string[]; active: string | null; entry?: string; readOnly?: boolean;
  onSelect(path: string): void; onCreate?(path: string): void; onRename?(from: string, to: string): void;
  onDelete?(path: string): void; onSetEntry?(path: string): void;
  dirty?: ReadonlySet<string>; errorCounts?: Record<string, number>; className?: string }
FileTree(props: FileTreeProps): JSX.Element
diagnosticsForFile(diags: CompileDiagnostic[], file: string): CodeEditorDiagnostic[]   // helper
```

### `@/training` (WP-LAB-SERVICE) — NNUE runs, datasets, networks

```ts
initTrainingService(): void        // once at start-up (main.tsx); idempotent. After whenSeeded():
                                   // runs left in selfplay/training/evaluating/queued are resumed if
                                   // autoResume, otherwise marked "paused" (interrupted); same for
                                   // dataset generation jobs.
training: {
  createRun(config: TrainingRunConfig, opts?: { autoResume?: boolean; start?: boolean }): Promise<string>;
  start(runId: string): Promise<void>;        // start or continue (queued / paused / stopped / error)
  pause(runId: string): Promise<void>;        // checkpoint, stop workers → "paused"
  stop(runId: string): Promise<void>;         // end the run now → "stopped" (best network so far is kept)
  deleteRun(runId: string, opts?: { deleteNetworks?: boolean; deleteDatasets?: boolean }): Promise<void>;
  setAutoResume(runId: string, on: boolean): Promise<void>;
  isActive(runId: string): boolean;           // executing in THIS tab
  activeRunIds(): string[];
  validateConfig(config: TrainingRunConfig): Promise<string[]>;    // user-facing problems; [] = OK
  estimate(config: TrainingRunConfig): Promise<RunEstimate>;       // for the wizard
}
interface RunEstimate { positions: number; stepsPerEpoch: number; totalSteps: number; parameters: number; warnings: string[] }
useLiveRun(runId): LiveRunState | null       // null when not executing in this tab
useActiveRunIds(): string[]

datasets: {
  generate(opts: GenerateDatasetOptions): Promise<string>;   // resolves with the dataset id at once; runs in the background
  stop(datasetId: string): Promise<void>;
  isGenerating(datasetId: string): boolean;
  importFile(file: Blob, opts?: { name?: string }): Promise<string>;   // .cbds or text (docs/NNUE_FORMAT.md)
  exportFile(datasetId: string): Promise<Blob>;                         // .cbds
  merge(ids: string[], name: string): Promise<string>;
  samplePositions(datasetId: string, count: number): Promise<Array<{ fen: string; scoreWhite: number; result: 0 | 1 | 2 }>>;
  remove(datasetId: string): Promise<void>;    // refuses while generating or used by an active run
}
interface GenerateDatasetOptions { name: string; description?: string;
  selfPlay: SelfPlayConfig;                   // engineId "$network" = stock NNUE engine with networkId
  networkId?: string | null; appendTo?: string | null }
useDatasetJob(datasetId): DatasetJobState | null

networks: {
  importFile(file: Blob, opts?: { name?: string }): Promise<string>;   // CBNN; float weights = dequantized
  exportFile(networkId: string): Promise<Blob>;                         // CBNN bytes
  createRandom(opts: { name: string; hidden: number; activation: Activation; seed?: number }): Promise<string>;
  createEngine(networkId: string, opts?: { name?: string }): Promise<string>;   // new kind "nnue" engine using it
  rename(networkId: string, name: string, description?: string): Promise<void>;
  remove(networkId: string): Promise<void>;   // refuses while an active run uses it
  evaluate(networkId: string, fens: string[]): Promise<Array<number | null>>;   // White-POV cp (quantized reference)
}

interface LiveBoard { slot: number; fen: string; lastMove: string | null; ply: number; white: string; black: string }
interface SelfPlayProgress { gamesDone: number; gamesTotal: number | null; positions: number; posPerSec: number;
  workers: number; boards: LiveBoard[]; results: { white: number; draw: number; black: number }; avgPlies: number }
interface GatingProgress { played: number; total: number; wins: number; draws: number; losses: number; score: number; boards: LiveBoard[] }
interface LiveRunState { runId: string; status: TrainingRunStatus; cycle: number;
  phase: "idle" | "selfplay" | "training" | "evaluating";
  selfPlay: SelfPlayProgress | null; train: TrainProgress | null /* @/nnue */; gating: GatingProgress | null;
  lastLog: string | null; startedAt: number | null }
interface DatasetJobState { datasetId: string; status: "running" | "finished" | "stopped" | "error";
  progress: SelfPlayProgress; error?: string | null }
```

Types live in `src/training/types.ts` and are re-exported from `@/training`. Long work registers in
`@/app/activity` (ids `training:<runId>`, `dataset:<datasetId>`, hrefs to the Lab pages).

### `@/arena` (WP-ARENA) — matches

```ts
initArenaService(): void           // once at start-up; matches left "running" become "paused" (interrupted)
arena: {
  createMatch(config: MatchConfig, opts?: { start?: boolean }): Promise<string>;
  start(matchId: string): Promise<void>;      // start or resume (unfinished games are replayed)
  pause(matchId: string): Promise<void>;
  abort(matchId: string): Promise<void>;      // → "aborted"
  deleteMatch(matchId: string, opts?: { deleteGames?: boolean }): Promise<void>;
  isRunning(matchId: string): boolean;
}
useLiveMatch(matchId): LiveMatchState | null
interface LiveGameView { slot: number; index: number; white: { id: string; name: string }; black: { id: string; name: string };
  startFen: string; fen: string; moves: string[]; lastMove: string | null; sideToMove: "w" | "b";
  whiteMs: number | null; blackMs: number | null; whiteInfo: SearchInfo | null; blackInfo: SearchInfo | null; opening: string | null }
interface LiveMatchState { matchId: string; running: boolean; games: LiveGameView[]; lastError: string | null }
playEngineGame(opts: PlayEngineGameOptions): Promise<PlayedGame>   // one engine-vs-engine game (reusable)
```

### `@/app/preferences` (architect)

Theme (`getThemePreference`, `setThemePreference`, `applyTheme`), board appearance
(`useBoardPreferences`, `useBoardProps()` → spread into every `<Chessboard>`, `BOARD_THEMES`),
engine defaults (`useDefaultHashMb`, `getDefaultHashMb`) and the background-work budget
(`useMaxWorkers`, `getMaxWorkers`, `defaultMaxWorkers()`): the default and upper bound for self-play
workers, simultaneous arena games and trainer threads.

## 6. UI

Routes (hash router in `src/app/router.ts`):

| Route | Page |
|---|---|
| `#/` and `#/engines` | Engine library. `?new=1` opens the new-engine wizard (`&kind=<EngineKind>`, `&networkId=<id>` preselect) |
| `#/engines/:id` | Workshop. Optional `?tab=<id>` and `?file=<path>` |
| `#/play` | Play. `?engine=<id>` (you vs that engine, you play White), `?white=<engineId or human>&black=<engineId or human>`, `?fen=<FEN>`, `?analysis=<engineId>`, `?game=<gameId>` (open a saved game) |
| `#/arena`, `#/arena/:id` | Matches. `#/arena?new=1&engines=<id>,<id>` opens the new-match form prefilled |
| `#/lab` | NNUE Lab overview. Sections: `#/lab/runs`, `#/lab/runs/:id`, `#/lab/networks`, `#/lab/networks/:id`, `#/lab/datasets`, `#/lab/datasets/:id`, `#/lab/new` (run wizard; `?networkId=<id>&mode=continue` or `mode=widen`) |
| `#/settings` | Settings & data |
| `#/help`, `#/help/:topic` | Documentation (topics: `getting-started`, `blocks`, `eval-api`, `full-engine`, `scratch`, `abi`, `nnue`, `play-and-arena`, `limits`, `storage`) |

Every page is a default-exported component in `src/pages/<name>/index.tsx` and gets the full content
area (the layout supplies the nav bar). Use the design system classes in `src/styles/global.css`
(`.btn`, `.btn-primary`, `.input`, `.select`, `.card`, `.panel`, `.tabs`, `.badge`, `.table`, ...) and keep
page-specific CSS in a file next to the page with class names prefixed by the page name
(`.play-…`, `.arena-…`). Dark theme is the default; light theme via `[data-theme="light"]` on `<html>`.

UX rules: every long operation shows progress and can be cancelled; errors are shown in context,
never swallowed; destructive actions ask for confirmation; everything autosaves (no "unsaved work"
on refresh); empty states explain what to do next.

## 7. Conventions

* TypeScript `strict`. No `any` in public APIs. Small, focused modules.
* **Do not add npm dependencies** — the installed set is: react, react-dom, zustand, idb, chess.js,
  blockly, codemirror 6 packages, assemblyscript (+binaryen), marked; dev: vitest, jsdom, fake-indexeddb,
  @playwright/test, @types/*. Ask the architect if something else is truly needed.
* Unit tests: `src/**/*.test.ts` (vitest, node environment by default; add
  `// @vitest-environment jsdom` for DOM tests; `fake-indexeddb/auto` for storage tests).
* Engine tests: `npm run test:engine` (compiles `engine/template` with asc in Node).
* Workers: `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`.
* Raw imports: `import src from "/engine/template/eval.ts?raw"` or `import.meta.glob(..., { query: "?raw", import: "default", eager: true })`.
