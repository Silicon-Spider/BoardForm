// Dataset files (docs/NNUE_FORMAT.md "Dataset files"):
//
//   .cbds  "CBDS" | u32 version 1 | u32 count | u32 reserved | count × 32-byte PackedPosition
//   text   one position per line: "<FEN> | <score> | <result>" (score: cp, White POV;
//          result 1.0 / 0.5 / 0.0 = White won / draw / Black won); blank and "#" lines ignored
//
// Readers stream the file in slices so large files neither block the page for long nor need to
// fit in memory twice. Invalid positions / malformed lines are skipped and counted.
import { PACKED_SIZE, packPosition, validatePacked, type PackedResult } from "@/nnue/pack";
import { parseFenBoard } from "@/nnue/fen";

export const CBDS_MAGIC = "CBDS";
export const CBDS_VERSION = 1;
export const CBDS_HEADER_SIZE = 16;

/** Positions decoded per slice (one dataset chunk's worth). */
const SLICE_POSITIONS = 16384;
/** Problems quoted in import reports. */
const MAX_QUOTED_PROBLEMS = 3;

/** The file is not a dataset this app can read (message is shown to the user). */
export class DatasetFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetFileError";
  }
}

/** The 16-byte .cbds header for `count` positions. */
export function cbdsHeader(count: number): ArrayBuffer {
  const buf = new ArrayBuffer(CBDS_HEADER_SIZE);
  const dv = new DataView(buf);
  for (let i = 0; i < 4; i++) dv.setUint8(i, CBDS_MAGIC.charCodeAt(i));
  dv.setUint32(4, CBDS_VERSION, true);
  dv.setUint32(8, count >>> 0, true);
  dv.setUint32(12, 0, true);
  return buf;
}

/** True when the bytes start with the .cbds magic. */
export function hasCbdsMagic(head: Uint8Array): boolean {
  return head.length >= 4 && String.fromCharCode(head[0] as number, head[1] as number, head[2] as number, head[3] as number) === CBDS_MAGIC;
}

/** What a reader produced besides the positions. */
export interface ImportReport {
  format: "cbds" | "text";
  /** Valid positions delivered. */
  positions: number;
  /** Positions (binary) or lines (text) that were skipped. */
  skipped: number;
  /** A few examples of what was wrong ("line 12: invalid FEN …"). */
  problems: string[];
}

/** Receives decoded positions in batches (`count` × 32 bytes in `data`). */
export type PositionSink = (data: Uint8Array, count: number) => Promise<void> | void;

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/** Reads a .cbds file; throws DatasetFileError for a wrong magic, version or size. */
export async function readCbds(file: Blob, sink: PositionSink): Promise<ImportReport> {
  if (file.size < CBDS_HEADER_SIZE) throw new DatasetFileError(`The file is too small to be a .cbds dataset (${file.size} bytes).`);
  const header = new Uint8Array(await file.slice(0, CBDS_HEADER_SIZE).arrayBuffer());
  if (!hasCbdsMagic(header)) throw new DatasetFileError('Not a .cbds dataset (it does not start with "CBDS").');
  const dv = new DataView(header.buffer);
  const version = dv.getUint32(4, true);
  if (version !== CBDS_VERSION) throw new DatasetFileError(`Unsupported .cbds version ${version} (this app reads version ${CBDS_VERSION}).`);
  const count = dv.getUint32(8, true);
  const expected = CBDS_HEADER_SIZE + count * PACKED_SIZE;
  if (file.size !== expected) {
    throw new DatasetFileError(
      `The .cbds file is damaged: its header announces ${count.toLocaleString("en-US")} positions (${expected.toLocaleString("en-US")} bytes) but the file has ${file.size.toLocaleString("en-US")} bytes.`,
    );
  }
  const report: ImportReport = { format: "cbds", positions: 0, skipped: 0, problems: [] };
  const out = new Uint8Array(SLICE_POSITIONS * PACKED_SIZE);
  for (let first = 0; first < count; first += SLICE_POSITIONS) {
    const n = Math.min(SLICE_POSITIONS, count - first);
    const start = CBDS_HEADER_SIZE + first * PACKED_SIZE;
    const bytes = new Uint8Array(await file.slice(start, start + n * PACKED_SIZE).arrayBuffer());
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const err = validatePacked(bytes, i * PACKED_SIZE);
      if (err !== null) {
        report.skipped++;
        if (report.problems.length < MAX_QUOTED_PROBLEMS) report.problems.push(`position ${(first + i + 1).toLocaleString("en-US")}: ${err}`);
        continue;
      }
      out.set(bytes.subarray(i * PACKED_SIZE, (i + 1) * PACKED_SIZE), kept * PACKED_SIZE);
      kept++;
    }
    if (kept > 0) await sink(out.subarray(0, kept * PACKED_SIZE), kept);
    report.positions += kept;
  }
  return report;
}

/** Parses the result field of a text line (also accepts "1-0", "0-1", "1/2-1/2", "1/2"). */
function parseResult(text: string): PackedResult | null {
  const t = text.trim();
  if (t === "1-0") return 2;
  if (t === "0-1") return 0;
  if (t === "1/2-1/2" || t === "1/2" || t === "½") return 1;
  if (!/^[+-]?\d*\.?\d+$/.test(t)) return null;
  const v = Number(t);
  if (v === 1) return 2;
  if (v === 0.5) return 1;
  if (v === 0) return 0;
  return null;
}

/**
 * Parses one text line into `out` at `offset`. Returns null on success, or what is wrong.
 * Exported for tests.
 */
export function parseTextLine(line: string, out: Uint8Array, offset: number): string | null {
  const parts = line.split("|");
  if (parts.length !== 3) return `expected "FEN | score | result" (found ${parts.length} field${parts.length === 1 ? "" : "s"})`;
  const fen = (parts[0] as string).trim();
  const scoreText = (parts[1] as string).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(scoreText)) return `invalid score "${scoreText.slice(0, 20)}"`;
  const score = Number(scoreText);
  const result = parseResult(parts[2] as string);
  if (result === null) return `invalid result "${(parts[2] as string).trim().slice(0, 20)}" (use 1.0, 0.5 or 0.0)`;
  let pieces: number;
  try {
    pieces = parseFenBoard(fen).pieces.length;
  } catch (e) {
    return `invalid FEN (${e instanceof Error ? e.message : String(e)})`;
  }
  if (pieces > 32) return `the FEN has ${pieces} pieces (at most 32)`;
  try {
    packPosition(fen, score, result, out, offset);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

/** Reads the "FEN | score | result" text format (UTF-8), streaming it line by line. */
export async function readTextDataset(file: Blob, sink: PositionSink): Promise<ImportReport> {
  const report: ImportReport = { format: "text", positions: 0, skipped: 0, problems: [] };
  const out = new Uint8Array(SLICE_POSITIONS * PACKED_SIZE);
  let kept = 0;
  let lineNo = 0;
  let rest = "";
  let sinceYield = 0;

  const flushOut = async () => {
    if (kept === 0) return;
    await sink(out.subarray(0, kept * PACKED_SIZE), kept);
    report.positions += kept;
    kept = 0;
  };

  const handleLine = async (raw: string) => {
    lineNo++;
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const err = parseTextLine(line, out, kept * PACKED_SIZE);
    if (err !== null) {
      report.skipped++;
      if (report.problems.length < MAX_QUOTED_PROBLEMS) report.problems.push(`line ${lineNo.toLocaleString("en-US")}: ${err}`);
      return;
    }
    kept++;
    if (kept === SLICE_POSITIONS) await flushOut();
    if (++sinceYield >= 4000) {
      sinceYield = 0;
      await yieldNow(); // keep the page responsive while parsing large files
    }
  };

  const decoder = new TextDecoder("utf-8");
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = (rest + text).split("\n");
    rest = done ? "" : (lines.pop() ?? "");
    for (const l of lines) await handleLine(l);
    if (done) break;
  }
  await flushOut();
  return report;
}

/** Reads a dataset file in either format (detected from the first bytes). */
export async function readDatasetFile(file: Blob, sink: PositionSink): Promise<ImportReport> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return hasCbdsMagic(head) ? readCbds(file, sink) : readTextDataset(file, sink);
}

/** One-line summary of skipped input for toasts and descriptions. */
export function describeSkipped(report: ImportReport): string | null {
  if (report.skipped === 0) return null;
  const what = report.format === "text" ? (report.skipped === 1 ? "line" : "lines") : report.skipped === 1 ? "position" : "positions";
  return `Skipped ${report.skipped.toLocaleString("en-US")} invalid ${what}${report.problems.length ? ` (${report.problems.join("; ")})` : ""}.`;
}
