// End-to-end check of the Blocks generator against the real engine. Generated eval.ts files are
// compiled together with engine/template (read from disk) by the AssemblyScript compiler with the
// app's flags (-O3 --runtime incremental --enable simd), instantiated with a minimal ABI host, and
// checked on 100 positions:
//
//   * the code compiles, with no errors and no compiler warnings in the generated eval.ts;
//   * colour symmetry: eval(mirror(p)) == −eval(p), and every term's White and Black values swap;
//   * sane values: |eval| ≤ 30000 everywhere, and the starter evaluation stays close to the
//     template's own eval.ts and to the material balance;
//   * cb_eval_trace has one line per term, labelled with the term's name, adding up to cb_eval;
//   * every term equals an independent JavaScript interpretation of the blocks
//     (testing/reference.ts), which also catches mistakes that are symmetric but wrong;
//   * a depth-4 search returns a legal move with a legal principal variation (chess.js).
//
// Workspaces: the starter evaluation, a kitchen sink with every block type and every dropdown
// option, awkward term names, light/dark squares, and seeded random workspaces (testing/fuzz.ts).

import { Chess } from "chess.js";
import { beforeAll, describe, expect, it } from "vitest";
import { block, num, stack, term, workspace } from "./builder";
import { BLOCK_DEFINITIONS, BLOCK_INFO, BUILTIN_BLOCK_TYPES } from "./definitions";
import { DEFAULT_WORKSPACE } from "./default-workspace";
import { generateEval, type EvalGeneration } from "./generator";
import { PESTO_MATERIAL } from "./pst";
import { compileEngine, legalUciMoves, mirrorFen, randomFens, TestEngine, type Trace } from "./testing/engine-harness";
import { blockTypesIn, dropdownChoicesIn, everythingWorkspace } from "./testing/fixtures";
import { randomWorkspace } from "./testing/fuzz";
import { interpretWorkspace, RefPosition, taper, traceLabel } from "./testing/reference";

/** The generated evaluate() clamps its score to this (below the search's MATE_BOUND of 31000). */
const EVAL_LIMIT = 30000;

/** Hand-picked positions: castling rights, en passant, checks, promotions, pawn structures, many queens … */
const CURATED = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", // e.p. capture possible
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "r3k2r/8/8/8/8/8/8/R3K2R b Kq - 5 20", // one castling right each
  "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R4RK1 b kq - 7 9",
  "r1b2rk1/pp3ppp/2n5/3qN3/3P4/2PB4/P4PPP/R2QK2R w KQ - 0 14",
  "4k3/8/8/8/8/8/4q3/4K3 w - - 0 1", // in check
  "8/P1P2k2/8/8/8/8/3p1p1p/K7 w - - 0 1", // pawns on both 7th ranks
  "8/5k2/1p6/1P1p4/3P4/2P3p1/2P3P1/6K1 w - - 0 40", // doubled, isolated, passed, backward pawns
  "3r2k1/1R3ppp/8/8/8/8/5PPP/3R2K1 b - - 0 30", // rooks on open files and the 7th
  "2n1kn2/pppppppp/8/8/8/8/PPPPPPPP/2B1KB2 w - - 0 1", // bishop pair against knights
  "4k3/8/8/8/8/4B3/8/2B1K3 w - - 0 1", // two bishops on the same colour
  "QQQQQQQQ/8/8/8/8/8/8/2K4k b - - 0 1", // eight queens
  "QQQQQQQQ/Q7/8/8/8/8/8/2K4k b - - 0 1", // nine queens: the most material possible
  "8/8/4k3/8/8/3K4/8/8 w - - 0 1", // bare kings
  "8/8/4k3/8/8/3K4/8/7R w - - 99 120", // fifty-move counter at 99
];

/** 100 positions: the curated ones plus seeded random playouts (deterministic). */
const POSITIONS = [...CURATED, ...randomFens(82, 2024)];
/** A spread of the positions for the depth-4 searches. */
const SEARCH_POSITIONS = POSITIONS.filter((_, i) => i % 5 === 0);
/** The imports the minimal host provides (docs/ENGINE_ABI.md). */
const HOST_IMPORTS = ["abort", "cb_now", "cb_should_stop", "cb_info", "cb_log", "seed", "trace"].map((n) => `env.${n}`);

interface Built {
  gen: EvalGeneration;
  engine: TestEngine;
}

/** Generates, compiles with the template and instantiates; fails on generator or compiler errors. */
async function build(ws: object): Promise<Built> {
  const gen = generateEval(ws);
  expect(gen.errors).toEqual([]);
  const out = await compileEngine(gen.code);
  const problems = out.diagnostics.filter((d) => d.severity === "error" || (d.severity === "warning" && d.file === "eval.ts"));
  expect(problems.map((d) => d.text), out.log).toEqual([]);
  expect(out.wasm, out.log).not.toBeNull();
  const engine = await TestEngine.create(out.wasm!, { hashMb: 1 });
  expect(engine.exports.cb_abi_version()).toBe(1);
  expect(typeof engine.exports.cb_eval).toBe("function");
  expect(typeof engine.exports.cb_eval_trace).toBe("function");
  for (const name of engine.importNames) expect(HOST_IMPORTS, name).toContain(name);
  return { gen, engine };
}

function setFen(e: TestEngine, fen: string): void {
  if (!e.setFen(fen)) throw new Error(`the engine rejected ${fen}`);
}

/** What evaluate() returns for a trace: the wrapping i32 sum of white − black, then the clamp. */
function evalFromTrace(trace: Trace): number {
  let sum = 0;
  for (const t of trace.terms) sum = (sum + ((t.white - t.black) | 0)) | 0;
  return Math.max(-EVAL_LIMIT, Math.min(EVAL_LIMIT, sum));
}

/**
 * Engine vs the JS reference on every position, plus the trace contract: labels are the term
 * names, the "total" line is cb_eval, and the terms add up to it. Returns readable mismatches.
 */
function compareWithReference(ws: object, { gen, engine }: Built, fens: readonly string[]): string[] {
  const bad: string[] = [];
  const names = JSON.stringify(gen.terms.map(traceLabel));
  for (const fen of fens) {
    setFen(engine, fen);
    const value = engine.eval();
    const trace = engine.trace();
    const ref = interpretWorkspace(ws, fen);
    const labels = JSON.stringify(trace.terms.map((t) => t.label));
    if (labels !== names || labels !== JSON.stringify(ref.map((r) => traceLabel(r.label)))) bad.push(`${fen}: trace labels ${labels}, terms ${names}`);
    if (trace.total !== value) bad.push(`${fen}: trace total ${trace.total}, cb_eval ${value}`);
    if (evalFromTrace(trace) !== value) bad.push(`${fen}: the terms add up to ${evalFromTrace(trace)}, cb_eval ${value}`);
    if (!Number.isInteger(value) || Math.abs(value) > EVAL_LIMIT) bad.push(`${fen}: eval ${value} out of bounds`);
    ref.forEach((r, i) => {
      const t = trace.terms[i];
      if (t && (t.white !== r.white || t.black !== r.black)) {
        bad.push(`${fen}: term “${r.label}” engine ${t.white}/${t.black}, reference ${r.white}/${r.black}`);
      }
    });
  }
  return bad.slice(0, 20);
}

/** eval(mirror(p)) == −eval(p), and per term White's and Black's values swap. */
function compareWithMirror({ engine }: Built, fens: readonly string[]): string[] {
  const bad: string[] = [];
  for (const fen of fens) {
    setFen(engine, fen);
    const value = engine.eval();
    const trace = engine.trace();
    setFen(engine, mirrorFen(fen));
    const mirrored = engine.eval();
    const mtrace = engine.trace();
    if (mirrored !== -value) bad.push(`${fen}: eval ${value}, mirrored ${mirrored}`);
    trace.terms.forEach((t, i) => {
      const m = mtrace.terms[i];
      if (!m || m.white !== t.black || m.black !== t.white) bad.push(`${fen}: term “${t.label}” ${t.white}/${t.black}, mirrored ${m?.white}/${m?.black}`);
    });
  }
  return bad.slice(0, 20);
}

/** Depth-4 searches: a legal best move, depth 4 reported, and a legal PV starting with that move. */
function searchProblems({ engine }: Built, fens: readonly string[]): string[] {
  const bad: string[] = [];
  for (const fen of fens) {
    const legal = legalUciMoves(fen);
    engine.newGame();
    setFen(engine, fen);
    const { best, infos } = engine.go({ depth: 4 });
    if (legal.length === 0) {
      if (best !== null) bad.push(`${fen}: no legal move, but the engine played ${best}`);
      continue;
    }
    if (!best || !legal.includes(best)) {
      bad.push(`${fen}: illegal best move ${best}`);
      continue;
    }
    const last = infos[infos.length - 1];
    if (!last || last.depth !== 4) bad.push(`${fen}: last report at depth ${last?.depth}`);
    const chess = new Chess(fen);
    for (const uci of last?.pv ?? []) {
      try {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        bad.push(`${fen}: illegal PV move ${uci} in ${last!.pv.join(" ")}`);
        break;
      }
    }
    if (last?.pv.length && last.pv[0] !== best) bad.push(`${fen}: PV starts with ${last.pv[0]}, best move ${best}`);
  }
  return bad;
}

/** Tapered PeSTO material balance (White − Black), the backbone of the starter evaluation. */
function materialBalance(fen: string): number {
  const p = new RefPosition(fen);
  const side = (c: number): number => {
    const sum = (v: { P: number; N: number; B: number; R: number; Q: number }) =>
      v.P * p.count(c, 0) + v.N * p.count(c, 1) + v.B * p.count(c, 2) + v.R * p.count(c, 3) + v.Q * p.count(c, 4);
    return taper(sum(PESTO_MATERIAL.mg), sum(PESTO_MATERIAL.eg), p.phase());
  };
  return side(0) - side(1);
}

/** The standard checks for one workspace. */
function standardChecks(name: string, ws: object, opts: { symmetric: boolean }): { built: () => Built } {
  let built: Built | null = null;
  beforeAll(async () => {
    built = await build(ws);
  });
  it(`${name}: every term matches the reference, and the trace names the terms and adds up`, () => {
    expect(compareWithReference(ws, built!, POSITIONS)).toEqual([]);
  });
  if (opts.symmetric) {
    it(`${name}: is colour-symmetric on every position and in every term`, () => {
      expect(compareWithMirror(built!, POSITIONS)).toEqual([]);
    });
  }
  it(`${name}: a depth-4 search returns a legal move`, () => {
    expect(searchProblems(built!, SEARCH_POSITIONS)).toEqual([]);
  });
  return { built: () => built! };
}

describe("starter evaluation (DEFAULT_WORKSPACE)", () => {
  const { built } = standardChecks("starter", DEFAULT_WORKSPACE, { symmetric: true });
  let template: TestEngine;
  beforeAll(async () => {
    const out = await compileEngine(null); // the template's own eval.ts
    expect(out.wasm, out.log).not.toBeNull();
    template = await TestEngine.create(out.wasm!, { hashMb: 1 });
  });

  it("generates without warnings", () => {
    expect(built().gen.warnings).toEqual([]);
  });

  it("scores the start position as just the tempo bonus", () => {
    const { engine } = built();
    setFen(engine, CURATED[0]!);
    expect(engine.eval()).toBe(12);
    setFen(engine, CURATED[1]!);
    expect(engine.eval()).toBe(-12);
  });

  it("stays close to the template's eval.ts and to the material balance", () => {
    const { engine } = built();
    const bad: string[] = [];
    for (const fen of POSITIONS) {
      setFen(engine, fen);
      setFen(template, fen);
      const value = engine.eval();
      const reference = template.eval();
      const material = materialBalance(fen);
      // Same PeSTO material and tables as eval.ts, slightly different extras (measured: ≤ 128 cp).
      if (Math.abs(value - reference) > 200) bad.push(`${fen}: blocks ${value}, template eval.ts ${reference}`);
      // Everything but material is worth at most a few pawns (measured: ≤ 436 cp) …
      if (Math.abs(value - material) > 800) bad.push(`${fen}: eval ${value}, material balance ${material}`);
      // … and a clear material advantage decides the sign.
      if (Math.abs(material) >= 300 && Math.sign(value) !== Math.sign(material)) bad.push(`${fen}: eval ${value} against material ${material}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("kitchen sink: every block type and every dropdown option", () => {
  const ws = everythingWorkspace();

  it("contains every block type and every dropdown option", () => {
    const types = blockTypesIn(ws);
    const missing: string[] = [];
    for (const t of [...BLOCK_DEFINITIONS.map((d) => d.type), ...BUILTIN_BLOCK_TYPES]) if (!types.has(t)) missing.push(t);
    const choices = dropdownChoicesIn(ws);
    const wanted: string[] = [
      ...["EQ", "NEQ", "LT", "LTE", "GT", "GTE"].map((op) => `logic_compare.OP=${op}`),
      "logic_operation.OP=AND",
      "logic_operation.OP=OR",
      "logic_boolean.BOOL=TRUE",
      "logic_boolean.BOOL=FALSE",
    ];
    for (const def of BLOCK_DEFINITIONS) {
      for (const [name, f] of BLOCK_INFO.get(def.type)!.fields) {
        if (f.type === "field_dropdown") for (const [, value] of f.options) wanted.push(`${def.type}.${name}=${value}`);
      }
    }
    for (const w of wanted) if (!choices.has(w)) missing.push(w);
    expect(missing).toEqual([]);
    // An if with an else-if and an else.
    expect(JSON.stringify(ws)).toContain('"elseIfCount":1,"hasElse":true');
  });

  // "light squares" and "dark squares" are only used side by side here (their sum is symmetric).
  standardChecks("kitchen sink", ws, { symmetric: true });
});

describe("term names in the evaluation breakdown", () => {
  const names = [
    'Back\\slash and "quotes"',
    "Tab\tand\nnew line",
    "Émile's 🐎 pawns",
    "Ends a comment */ // here",
    `${"x".repeat(59)}🐎 is cut after the horse`,
    "",
    "total",
    "   spaced    out   ",
  ];
  const ws = workspace([
    block("cb_evaluation", {
      inputs: { TERMS: stack(...names.map((n, i) => term(n, [block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(i + 1) } })])))! },
    }),
  ]);
  const { built } = standardChecks("names", ws, { symmetric: true });

  it("labels each trace line with its term's name (UTF-8, as cb_eval_trace prints it)", () => {
    const { engine, gen } = built();
    setFen(engine, CURATED[0]!);
    const trace = engine.trace();
    expect(trace.terms.map((t) => t.label)).toEqual([
      'Back\\slash and "quotes"',
      "Tab and new line",
      "Émile's 🐎 pawns",
      "Ends a comment */ // here",
      `${"x".repeat(59)}🐎`, // cut after 60 characters, never inside the emoji's surrogate pair
      "Term 6",
      "total (term)", // the trace's own last line is "total"
      "spaced out",
    ]);
    expect(trace.terms.map((t) => t.white)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(gen.warnings.join("\n")).toContain("is shown as “total (term)”");
  });
});

describe("light and dark squares are the real square colours", () => {
  const count = (name: string, area: string) =>
    term(name, [
      block("cb_add", {
        fields: { OP: "ADD" },
        inputs: { VALUE: block("cb_count_on", { fields: { SIDE: "US", PIECE: "ANY" }, inputs: { ZONE: block("cb_zone_area", { fields: { AREA: area } }) } }) },
      }),
    ]);
  const ws = workspace([block("cb_evaluation", { inputs: { TERMS: stack(count("Light", "LIGHT"), count("Dark", "DARK"))! } })]);
  // Not mirror-symmetric by design: flipping the board turns light squares into dark ones.
  const { built } = standardChecks("light/dark", ws, { symmetric: false });

  it("a colour flip swaps light and dark", () => {
    const { engine } = built();
    const bad: string[] = [];
    for (const fen of POSITIONS) {
      setFen(engine, fen);
      const [light, dark] = engine.trace().terms;
      setFen(engine, mirrorFen(fen));
      const [mLight, mDark] = engine.trace().terms;
      if (mLight!.white !== dark!.black || mDark!.white !== light!.black) bad.push(fen);
    }
    expect(bad).toEqual([]);
  });
});

describe("for each visits our pieces from our own back rank", () => {
  // "set" inside a loop keeps the last piece visited, so the visiting order matters: here it
  // must be our most advanced pawn for White and for Black alike.
  const ws = workspace(
    [
      block("cb_evaluation", {
        inputs: {
          TERMS: term("Most advanced pawn", [
            block("cb_for_each", {
              fields: { PIECE: "PAWN" },
              inputs: { DO: block("variables_set", { fields: { VAR: { id: "v-last" } }, inputs: { VALUE: block("cb_it_rank") } }) },
            }),
            block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: block("variables_get", { fields: { VAR: { id: "v-last" } } }) } }),
          ]),
        },
      }),
    ],
    [{ name: "last rank", id: "v-last" }],
  );
  const { built } = standardChecks("order", ws, { symmetric: true });

  it("so that order-dependent blocks are symmetric", () => {
    const { engine } = built();
    setFen(engine, "8/5k2/1p6/1P1p4/3P4/2P3p1/2P3P1/6K1 w - - 0 40");
    // White's most advanced pawn is on b5 (5th rank), Black's on g3 (its 6th rank).
    expect(engine.trace().terms[0]).toMatchObject({ white: 5, black: 6 });
  });
});

describe("random workspaces (seeded)", () => {
  for (const seed of [11, 12, 13]) {
    describe(`seed ${seed}`, () => {
      standardChecks(`random ${seed}`, randomWorkspace(seed, { squareColours: false }), { symmetric: true });
    });
  }
  describe("seed 99: deep nesting, many empty slots, square colours", () => {
    standardChecks("random 99", randomWorkspace(99, { maxDepth: 6, emptySlots: 0.15 }), { symmetric: false });
  });
});
