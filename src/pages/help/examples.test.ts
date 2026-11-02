// Checks that the help topics are complete and correct:
//
//   * every topic id listed in docs/ARCHITECTURE.md §6 has a topic and a Markdown file;
//   * every link points somewhere real: #/help/<topic> links to existing topics, ?section= and #anchor
//     links to existing headings, other #/... links to routes of the app, spec links to their topics;
//   * every fenced block marked as a complete eval.ts ("ts eval") compiles into the engine template
//     (engine/template, as bundled by the app) with the app's compiler flags and no errors, and the
//     resulting engine evaluates, traces and searches correctly: the breakdown adds up to the
//     evaluation, colour-flipped positions get the opposite score, and a search plays a legal move.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { block, num, rankZone, term, workspace } from "@/blocks/builder";
import { generateEvalSource } from "@/blocks/generator";
import { mirrorFen } from "@/chess";
import type { AscDiagnosticMessage } from "@/compiler/asc-types";
import { loadAsc } from "@/compiler/load-asc.js";
import { templateFiles, variantFiles } from "@/engine-host/templates";
import { HELP_TASKS, SPEC_SOURCES, SPEC_TOPICS, TOPICS, TOPIC_SOURCES, getArticle } from "./topics";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The topic ids in the "#/help" row of the routes table in docs/ARCHITECTURE.md §6. */
function architectureTopicIds(): string[] {
  const doc = readFileSync(`${ROOT}docs/ARCHITECTURE.md`, "utf8");
  const row = doc.split("\n").find((line) => line.includes("`#/help/:topic`"));
  if (!row) throw new Error("docs/ARCHITECTURE.md has no #/help/:topic route row");
  const list = /\(topics: ([^)]*)\)/.exec(row)?.[1] ?? "";
  return [...list.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!);
}

/** Route patterns of the app (docs/ARCHITECTURE.md §6, src/app/App.tsx). */
const ROUTE_PATTERNS = [
  "/",
  "/engines",
  "/engines/:id",
  "/play",
  "/arena",
  "/arena/:id",
  "/lab",
  "/lab/:section",
  "/lab/:section/:id",
  "/settings",
  "/help",
  "/help/:topic",
];
const LAB_SECTIONS = ["runs", "networks", "datasets", "new"];

function isAppRoute(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "lab" && segments.length >= 2 && !LAB_SECTIONS.includes(segments[1]!)) return false;
  return ROUTE_PATTERNS.some((pattern) => {
    const p = pattern.split("/").filter(Boolean);
    return p.length === segments.length && p.every((part, i) => part.startsWith(":") || part === segments[i]);
  });
}

describe("help topics", () => {
  it("cover every topic id of docs/ARCHITECTURE.md §6, each with a Markdown file", () => {
    const ids = architectureTopicIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) {
      expect(TOPICS.map((t) => t.id), `topic "${id}" is missing from TOPICS`).toContain(id);
      expect(TOPIC_SOURCES[id], `src/pages/help/topics/${id}.md is missing`).toBeTypeOf("string");
    }
    // No orphans either way.
    expect(Object.keys(TOPIC_SOURCES).sort()).toEqual(TOPICS.map((t) => t.id).sort());
    expect(TOPICS.map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  it("render with a title, sections and a table of contents", () => {
    for (const t of TOPICS) {
      const a = getArticle(t.id)!;
      expect(a, t.id).not.toBeNull();
      expect(a.title.length, `${t.id} needs a "# Title"`).toBeGreaterThan(3);
      expect(a.toc.length, `${t.id} has no h2 sections`).toBeGreaterThan(2);
      expect(new Set(a.anchors).size, `${t.id} has duplicate anchors`).toBe(a.anchors.length);
      expect(a.html).not.toContain("Missing reference");
    }
  });

  it("render tables without broken code spans", () => {
    // A "|" inside `code` in a table row ends the cell unless it is written as "\|".
    const problems: string[] = [];
    for (const t of TOPICS) {
      for (const m of getArticle(t.id)!.html.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
        if (m[1]!.includes("`") || m[1]!.includes("\\|")) problems.push(`${t.id}: ${m[1]!.slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("include the specs they reference", () => {
    expect(getArticle("abi")!.toc.map((e) => e.text)).toContain("Required exports");
    expect(getArticle("nnue")!.toc.map((e) => e.text)).toContain("Training-run guidance (Lab defaults)");
    expect(getArticle("eval-api")!.toc.map((e) => e.text)).toContain("evalkit.ts (stable API used by the Blocks generator — do not rename)");
    // Internal report references in the specs are not shown to users.
    expect(getArticle("nnue")!.html).not.toMatch(/WP-[A-Z]/);
  });

  it("only use code fence languages the highlighter knows", () => {
    const known = new Set(["", "ts", "text", "c", "rust", "zig", "json", "sh"]);
    for (const t of TOPICS) {
      for (const block of getArticle(t.id)!.codeBlocks) {
        expect(known.has(block.lang), `${t.id}: unknown fence language "${block.lang}"`).toBe(true);
        if (block.flags.includes("eval")) expect(block.lang, `${t.id}: "eval" examples must be "ts eval"`).toBe("ts");
      }
    }
  });
});

describe("help links", () => {
  const all: Array<{ from: string; href: string }> = [];
  for (const t of TOPICS) for (const href of getArticle(t.id)!.links) all.push({ from: t.id, href });
  for (const task of HELP_TASKS) {
    all.push({ from: "home", href: task.section ? `#/help/${task.topic}?section=${task.section}` : `#/help/${task.topic}` });
  }

  it("are plentiful", () => {
    expect(all.filter((l) => l.href.startsWith("#/help/")).length).toBeGreaterThan(40);
  });

  it("to #/help/<topic> point to existing topics and sections", () => {
    const problems: string[] = [];
    for (const { from, href } of all) {
      if (!href.startsWith("#/help/")) continue;
      const m = /^#\/help\/([^?#/]+)(?:\?(.*))?$/.exec(href);
      if (!m) {
        problems.push(`${from}: malformed help link ${href}`);
        continue;
      }
      const target = getArticle(m[1]!);
      if (!target) {
        problems.push(`${from}: ${href} → unknown topic "${m[1]}"`);
        continue;
      }
      const params = new URLSearchParams(m[2] ?? "");
      for (const key of params.keys()) if (key !== "section") problems.push(`${from}: ${href} has an unknown parameter "${key}"`);
      const section = params.get("section");
      if (section !== null && !target.anchors.includes(section)) problems.push(`${from}: ${href} → no section "${section}" in ${m[1]}`);
    }
    expect(problems).toEqual([]);
  });

  it("to #anchors point to headings of the same topic", () => {
    const problems: string[] = [];
    for (const { from, href } of all) {
      if (!href.startsWith("#") || href.startsWith("#/")) continue;
      if (!getArticle(from)!.anchors.includes(href.slice(1))) problems.push(`${from}: ${href} → no such section`);
    }
    expect(problems).toEqual([]);
  });

  it("to other pages point to routes of the app", () => {
    const problems: string[] = [];
    for (const { from, href } of all) {
      if (!href.startsWith("#/") || href.startsWith("#/help/")) continue;
      const path = href.slice(1).split("?")[0]!;
      if (!isAppRoute(path)) problems.push(`${from}: ${href} is not a route of the app`);
    }
    expect(problems).toEqual([]);
  });

  it("have no relative or plain-http targets", () => {
    const problems: string[] = [];
    for (const { from, href } of all) {
      if (href.startsWith("#") || href.startsWith("https://")) continue;
      if (/(^|\/)[A-Z_]+\.md$/.test(href) && SPEC_TOPICS[href.slice(href.lastIndexOf("/") + 1)]) continue;
      problems.push(`${from}: ${href}`);
    }
    expect(problems).toEqual([]);
  });
});

// ───────────────────────────── names of the engine API ─────────────────────────────

/** Inline `code` spans of a topic's Markdown (fenced blocks removed). */
function inlineCode(markdown: string): string[] {
  const withoutFences = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  return [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim());
}

/** Everything a topic may legitimately name: the engine sources and the specs. */
const ENGINE_CORPUS = [...Object.values(templateFiles), ...Object.values(variantFiles), ...Object.values(SPEC_SOURCES)].join("\n");

/**
 * Calls in inline code that are not engine API on purpose: the reader's own helpers in the
 * scratch walkthrough, AssemblyScript built-ins, math in formulas and C syntax in the ABI tips.
 */
const NOT_ENGINE_API = new Set([
  "__attribute__",
  "sigmoid", "log", "erf", "min", "max", "abs", "popcnt", "ctz", "clz", "bswap", "unchecked", "assert", "ceil",
  "makeMove", "unmakeMove", "generateLegalMoves", "firstMove", "moveToUci", "moveAt", "inCheck", "quiescence",
]);

describe("names of the engine API in the topics", () => {
  it("exist in the engine sources or the specs", () => {
    const problems: string[] = [];
    for (const t of TOPICS) {
      for (const span of inlineCode(TOPIC_SOURCES[t.id]!)) {
        // `name(...)`, `pos.name(...)` and SCREAMING_CASE constants such as `MATE_BOUND`.
        const call = /^(?:pos\.)?([A-Za-z_]\w*)\s*\(/.exec(span)?.[1];
        const constant = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(span) ? span : undefined;
        const name = call ?? constant;
        if (!name || (call && NOT_ENGINE_API.has(name))) continue;
        if (!new RegExp(`\\b${name}\\b`).test(ENGINE_CORPUS)) problems.push(`${t.id}: \`${span}\` — "${name}" is not in the engine sources`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("include the exact tuning constants of search.ts", () => {
    const search = templateFiles["search.ts"]!;
    const table = TOPIC_SOURCES["full-engine"]!.split("## Tuning knobs")[1]!.split("\n## ")[0]!;
    const rows = [...table.matchAll(/^\| `([A-Z_]+)`(?: \/ `([A-Z_]+)`)? \| ([\d ]+)(?: \/ (\d+))? \|/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const [, a, b, va, vb] of rows) {
      for (const [name, value] of [[a, va], [b, vb]] as const) {
        if (!name) continue;
        const declared = new RegExp(`const ${name}: (?:i32|f64) = (\\d+);`).exec(search)?.[1];
        expect(declared, `${name} in search.ts`).toBe(value!.replace(/ /g, ""));
      }
    }
  });
});

// ───────────────────────────── the blocks example ─────────────────────────────

describe("the blocks topic's generated eval.ts", () => {
  it("is exactly what the generator writes for the worked example", () => {
    const example = term("Pawn on our 7th rank", [
      block("controls_if", {
        inputs: {
          IF0: block("cb_any_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: rankZone(7) } }),
          DO0: block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(1) } }),
        },
      }),
    ]);
    const generated = generateEvalSource(workspace([block("cb_evaluation", { inputs: { TERMS: example } })]));
    expect(generated.errors).toEqual([]);
    const shown = getArticle("blocks")!.codeBlocks.find((b) => b.flags.includes("eval"))!.code;
    expect(shown.trimEnd()).toBe(generated.code.trimEnd());
  });
});

// ───────────────────────────── complete eval.ts examples ─────────────────────────────

interface Example {
  name: string;
  code: string;
}

const EXAMPLES: Example[] = TOPICS.flatMap((t) =>
  getArticle(t.id)!
    .codeBlocks.filter((b) => b.lang === "ts" && b.flags.includes("eval"))
    .map((b, i) => ({ name: `${t.id} #${i + 1}`, code: b.code })),
);

/** The app's compiler flags (src/engine-host/build.ts BUILD_OPTIONS, docs/ENGINE_TEMPLATE.md). */
const ASC_FLAGS = ["--optimizeLevel", "3", "--shrinkLevel", "0", "--runtime", "incremental", "--enable", "simd", "--noColors"];

interface Diagnostic {
  severity: "error" | "warning" | "info";
  file: string | null;
  text: string;
}

async function compileWithTemplate(evalSource: string): Promise<{ wasm: Uint8Array | null; diagnostics: Diagnostic[]; log: string }> {
  const asc = await loadAsc();
  const sources: Record<string, string> = { ...templateFiles, "eval.ts": evalSource };
  const outputs = new Map<string, Uint8Array | string>();
  const diagnostics: Diagnostic[] = [];
  let log = "";
  const decoder = new TextDecoder();
  const stream = {
    write(chunk: Uint8Array | string) {
      log += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    },
    toString: () => log,
  };
  const { error } = await asc.main(["main.ts", "--outFile", "engine.wasm", ...ASC_FLAGS], {
    stdout: stream,
    stderr: stream,
    readFile: (name) => {
      const key = name.replace(/^\.\//, "");
      return Object.prototype.hasOwnProperty.call(sources, key) ? sources[key]! : null;
    },
    writeFile: (name, contents) => void outputs.set(name, contents),
    listFiles: () => [],
    reportDiagnostic: (d: AscDiagnosticMessage) => {
      const severity = d.category === 3 ? "error" : d.category === 2 ? "warning" : "info";
      const file = d.range?.source?.normalizedPath ?? null;
      diagnostics.push({ severity, file, text: `${severity} AS${d.code}: ${d.message}${file ? ` (${file})` : ""}` });
    },
  });
  if (error && !diagnostics.some((d) => d.severity === "error")) diagnostics.push({ severity: "error", file: null, text: error.message });
  const out = outputs.get("engine.wasm");
  return { wasm: !error && out instanceof Uint8Array ? new Uint8Array(out) : null, diagnostics, log };
}

interface EngineExports {
  memory: WebAssembly.Memory;
  cb_abi_version(): number;
  cb_init(): void;
  cb_in(): number;
  cb_out(): number;
  cb_new_game(): void;
  cb_position(len: number): number;
  cb_go(depth: number, nodes: number, movetime: number, wtime: number, btime: number, winc: number, binc: number, movestogo: number): number;
  cb_eval(): number;
  cb_eval_trace(): number;
}

/** A minimal ABI host (docs/ENGINE_ABI.md) around one compiled engine. */
async function startEngine(wasm: Uint8Array) {
  let ex: EngineExports | null = null;
  const utf8 = new TextDecoder();
  const utf16 = new TextDecoder("utf-16le");
  const out = (len: number) => (len > 0 ? utf8.decode(new Uint8Array(ex!.memory.buffer, ex!.cb_out(), len)) : "");
  const asString = (ptr: number) =>
    ptr ? utf16.decode(new Uint8Array(ex!.memory.buffer, ptr, new Uint32Array(ex!.memory.buffer, ptr - 4, 1)[0]!)) : "";
  const env: Record<string, (...args: number[]) => number | void> = {
    abort: (msg, file, line, col) => {
      throw new Error(`engine abort: ${asString(msg!)} at ${asString(file!)}:${line}:${col}`);
    },
    cb_now: () => performance.now(),
    cb_should_stop: () => 0,
    cb_info: () => {},
    cb_log: () => {},
    seed: () => 1,
    trace: () => {},
  };
  // .slice(): a Uint8Array over a plain ArrayBuffer, which is what the WebAssembly API accepts.
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm.slice()), { env });
  ex = instance.exports as unknown as EngineExports;
  ex.cb_init();
  ex.cb_new_game();
  const engine = ex;
  const write = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(engine.memory.buffer, engine.cb_in(), bytes.length).set(bytes);
    return bytes.length;
  };
  return {
    abi: () => engine.cb_abi_version(),
    position: (fen: string) => engine.cb_position(write(`fen ${fen}`)) === 1,
    eval: () => engine.cb_eval(),
    trace: () => {
      const lines = out(engine.cb_eval_trace()).split("\n").filter(Boolean).map((l) => l.split("\t"));
      const terms = lines.filter((l) => l[0] !== "total").map(([label, w, b]) => ({ label: label!, white: Number(w), black: Number(b) }));
      const total = lines.find((l) => l[0] === "total");
      return { terms, total: total ? Number(total[1]) : null };
    },
    bestMove: (depth: number) => {
      const n = engine.cb_go(depth, 0, 0, -1, -1, 0, 0, 0);
      return n > 0 ? out(n) : null;
    },
  };
}

const POSITIONS = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "r1b2rk1/pp3ppp/2n5/3qN3/3P4/2PB4/P4PPP/R2QK2R w KQ - 0 14",
  "8/P1P2k2/8/8/8/8/3p1p1p/K7 w - - 0 1",
  "8/5k2/1p6/1P1p4/3P4/2P3p1/2P3P1/6K1 w - - 0 40",
  "4k3/8/8/8/8/4B3/8/2B1K3 w - - 0 1",
];

describe("complete eval.ts examples", () => {
  it("exist in the topics that teach code", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(5);
    const topics = new Set(EXAMPLES.map((e) => e.name.split(" ")[0]));
    for (const t of ["blocks", "eval-api", "nnue"]) expect(topics, `no complete example in ${t}`).toContain(t);
  });

  for (const example of EXAMPLES) {
    it(`${example.name} compiles into the engine template and evaluates correctly`, async () => {
      const { wasm, diagnostics, log } = await compileWithTemplate(example.code);
      const problems = diagnostics.filter((d) => d.severity === "error" || (d.severity === "warning" && d.file === "eval.ts"));
      expect(problems.map((d) => d.text), log).toEqual([]);
      expect(wasm, log).not.toBeNull();

      const engine = await startEngine(wasm!);
      expect(engine.abi()).toBe(1);
      for (const fen of POSITIONS) {
        expect(engine.position(fen), fen).toBe(true);
        const score = engine.eval();
        const trace = engine.trace();
        expect(Number.isInteger(score), fen).toBe(true);
        expect(Math.abs(score), fen).toBeLessThan(31000);
        expect(trace.terms.length, `${fen}: no breakdown terms`).toBeGreaterThan(0);
        expect(trace.total, fen).toBe(score);
        expect(trace.terms.reduce((sum, t) => sum + t.white - t.black, 0), `${fen}: the breakdown doesn't add up`).toBe(score);

        // A colour-flipped position gets exactly the opposite score.
        const mirrored = mirrorFen(fen);
        expect(engine.position(mirrored), mirrored).toBe(true);
        expect(engine.eval(), `${fen} vs ${mirrored}`).toBe(0 - score);
      }

      // The engine plays a legal move with this evaluation.
      for (const fen of [POSITIONS[0]!, POSITIONS[2]!]) {
        expect(engine.position(fen)).toBe(true);
        const move = engine.bestMove(3);
        const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
        expect(legal, `${fen}: illegal best move ${move}`).toContain(move);
      }
    });
  }
});
