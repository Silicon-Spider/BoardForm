# BoardForm

Browser app (React 19 + TypeScript + Vite) where users build their own WebAssembly chess engines
(drag-and-drop blocks, eval-only code, full engine code, or from scratch — AssemblyScript compiled
in the browser), train NNUE networks with self-play, and play / match engines. All data lives in
IndexedDB.

Read `docs/ARCHITECTURE.md` first. Normative specs: `docs/ENGINE_ABI.md`, `docs/ENGINE_TEMPLATE.md`,
`docs/NNUE_FORMAT.md`. Shared types: `src/types/`. Path alias `@/` = `src/`.

## Commands

- `npm run dev` (port 5173, COOP/COEP headers → `crossOriginIsolated`), `npm run build`, `npm run typecheck`
- `npm test` — vitest (`src/**/*.test.ts`), `npm run test:engine` — AssemblyScript engine tests in Node
- Playwright + headless Chromium are installed: `import { chromium } from "@playwright/test"` in a
  throwaway `.mjs` script works for screenshots / smoke checks (view PNGs with the Read tool).

## Environment

- Windows 11. Bash (Git Bash) and PowerShell tools both work. The project path contains a space
  (`C:\Users\jayll_8zfkvgp\Chess builder`) — always quote it.
- Never leave servers or background processes running when you finish — stop what you started.
  If you need a dev server use the port assigned in your task with `--strictPort`.
- Throwaway scripts, screenshots and logs go in `.scratch/<your-task>/` (gitignored), never in `src/`.

## Rules

- Stay inside the files/directories your task assigns you. Architect-owned shared files: `src/types/`,
  `src/app/`, `src/styles/global.css`, `src/utils/`, `src/engine-host/templates.ts`, `docs/`,
  `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `CLAUDE.md`. Don't edit them; if
  you truly need a change, make the smallest additive edit and call it out in your final report.
- No new npm dependencies (see the installed list in `docs/ARCHITECTURE.md` §7).
- TypeScript strict, no `any` in public APIs, focused modules, comments for non-obvious logic.
- UI must look finished: use the design-system classes from `global.css`, page-prefixed CSS for the
  rest, and real loading / empty / error states. Long operations show progress and can be cancelled.
- The AssemblyScript engine sources are teaching material users will read and edit: keep them
  clear and well commented.
- Report honestly: say what you verified (commands run, results) and what you could not.
