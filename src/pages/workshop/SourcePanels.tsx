// Read-only code panels: the template files an eval / nnue engine builds with ("Engine source")
// and the eval.ts generated from a blocks engine ("Generated code").
import { useId } from "react";
import { Icon } from "@/components";
import { diagnosticsForFile } from "@/components/code";
import { templateFiles } from "@/engine-host";
import type { CompileDiagnostic } from "@/types";
import { CodePane } from "./CodePane";
import type { RevealTarget } from "./types";

/** What each template file is for (docs/ENGINE_TEMPLATE.md). */
export const TEMPLATE_FILE_INFO: Record<string, string> = {
  "main.ts": "ABI exports (cb_*): the entry point the app talks to",
  "io.ts": "Input / output buffers and the host imports",
  "types.ts": "Colours, pieces, squares, move encoding, score constants",
  "bitboard.ts": "Bitboard helpers and attack tables",
  "position.ts": "The Position class: board state, FEN, make / unmake",
  "movegen.ts": "Legal move generation and perft",
  "tt.ts": "Transposition table",
  "search.ts": "Iterative deepening alpha-beta search and time management",
  "evalkit.ts": "Evaluation helpers (pawn structure, mobility, king safety…)",
  "trace.ts": "Evaluation breakdown support (traceTerm)",
  "eval.ts": "The evaluation function",
  "nnue.ts": "NNUE network loading and inference",
};

const ORDER = ["main.ts", "search.ts", "position.ts", "movegen.ts", "evalkit.ts", "bitboard.ts", "tt.ts", "types.ts", "trace.ts", "io.ts", "nnue.ts"];

export function sourceFileList(): string[] {
  const all = Object.keys(templateFiles).filter((f) => f !== "eval.ts");
  return [...ORDER.filter((f) => all.includes(f)), ...all.filter((f) => !ORDER.includes(f)).sort()];
}

export function EngineSource({
  file,
  onFile,
  diagnostics,
  reveal,
  onUnlock,
}: {
  file: string;
  onFile(file: string): void;
  diagnostics: CompileDiagnostic[];
  reveal: RevealTarget | null;
  onUnlock(): void;
}) {
  const id = useId();
  const files = sourceFileList();
  const current = files.includes(file) ? file : files[0];
  return (
    <div className="workshop-source">
      <div className="workshop-source-head">
        <label htmlFor={id} className="sr-only-workshop">
          Template file
        </label>
        <select id={id} className="select select-sm mono" value={current} onChange={(e) => onFile(e.target.value)}>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className="small muted truncate">{TEMPLATE_FILE_INFO[current] ?? ""}</span>
      </div>
      <div className="workshop-source-note small">
        <Icon name="info" size={14} />
        <span>
          Read-only: your engine uses these files from the stock template, with your own eval.ts.{" "}
          <button type="button" className="workshop-linkbtn" onClick={onUnlock}>
            Unlock the full engine source
          </button>{" "}
          to edit them (makes a copy).
        </span>
      </div>
      <CodePane
        key={current}
        value={templateFiles[current] ?? ""}
        readOnly
        diagnostics={diagnosticsForFile(diagnostics, current)}
        revealLine={reveal && reveal.target === `source:${current}` ? reveal.reveal : undefined}
        aria-label={`${current} (read-only)`}
      />
    </div>
  );
}

export function GeneratedCode({ code, diagnostics, reveal, onConvert }: { code: string; diagnostics: CompileDiagnostic[]; reveal: RevealTarget | null; onConvert(): void }) {
  return (
    <div className="workshop-source">
      <div className="workshop-source-note small">
        <Icon name="info" size={14} />
        <span>
          eval.ts generated from your blocks — read-only, updates as you edit.{" "}
          <button type="button" className="workshop-linkbtn" onClick={onConvert}>
            Convert to code
          </button>{" "}
          to edit it by hand (makes a copy).
        </span>
      </div>
      <CodePane
        value={code}
        readOnly
        diagnostics={diagnosticsForFile(diagnostics, "eval.ts")}
        revealLine={reveal && reveal.target === "generated" ? reveal.reveal : undefined}
        aria-label="Generated eval.ts (read-only)"
      />
    </div>
  );
}
