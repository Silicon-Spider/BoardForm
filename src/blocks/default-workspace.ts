// The starter hand-crafted evaluation every new blocks engine begins with: tapered PeSTO
// material and piece-square tables plus the classic extras (mobility, bishop pair, passed
// pawns, pawn structure, rooks on open files, king safety, tempo). Block comments explain
// each idea. Pure data.

import { block, num, rankZone, term, workspace } from "./builder";
import { PESTO_MATERIAL, pestoTable, type PestoKey } from "./pst";
import { walkBlocks, type BlockState, type WorkspaceState } from "./workspace-json";

const pieceTables = (piece: string, key: string) =>
  block("cb_pst_tapered", {
    fields: { PIECE: piece, MG: pestoTable(`${key}_MG` as PestoKey), EG: pestoTable(`${key}_EG` as PestoKey) },
  });

const eachTapered = (sub: boolean, mg: number, eg: number, count: BlockState) =>
  block("cb_add_each_tapered", {
    fields: { OP: sub ? "SUB" : "ADD" },
    inputs: { MG: num(mg), EG: num(eg), COUNT: count },
  });

const tapered = (mg: number, eg: number) => block("cb_add_tapered", { fields: { OP: "ADD" }, inputs: { MG: num(mg), EG: num(eg) } });

const ifThen = (cond: BlockState, ...body: BlockState[]) => {
  const inputs: Record<string, BlockState> = { IF0: cond };
  if (body[0]) {
    for (let i = 0; i < body.length - 1; i++) body[i]!.next = { block: body[i + 1]! };
    inputs.DO0 = body[0];
  }
  return block("controls_if", { inputs });
};

/** A square table whose value only depends on the rank (index 0 = 1st rank). */
const rankTable = (byRank: number[]): number[] => Array.from({ length: 64 }, (_, sq) => byRank[sq >> 3] ?? 0);

function buildDefault(): WorkspaceState {
  const m = PESTO_MATERIAL;
  const terms = [
    term(
      "Material",
      [
        block("cb_material_tapered", {
          fields: {
            MG_P: m.mg.P, MG_N: m.mg.N, MG_B: m.mg.B, MG_R: m.mg.R, MG_Q: m.mg.Q,
            EG_P: m.eg.P, EG_N: m.eg.N, EG_B: m.eg.B, EG_R: m.eg.R, EG_Q: m.eg.Q,
          },
        }),
      ],
      {
        comment:
          "Material is the biggest part of any evaluation. Values are centipawns (100 = one pawn). These are PeSTO's tuned numbers: the middlegame and endgame values are blended by how many pieces are left.",
      },
    ),
    term(
      "Piece-square tables",
      [
        pieceTables("PAWN", "PAWN"),
        pieceTables("KNIGHT", "KNIGHT"),
        pieceTables("BISHOP", "BISHOP"),
        pieceTables("ROOK", "ROOK"),
        pieceTables("QUEEN", "QUEEN"),
        pieceTables("KING", "KING"),
      ],
      {
        comment:
          "Where a piece stands matters: knights love the center, rooks the 7th rank, and the king hides in the middlegame but walks to the center in the endgame. Click any little board to edit its numbers (green = bonus, red = penalty).",
      },
    ),
    term(
      "Mobility",
      [
        eachTapered(false, 4, 4, block("cb_mobility", { fields: { SIDE: "US", PIECE: "KNIGHT" } })),
        eachTapered(false, 4, 5, block("cb_mobility", { fields: { SIDE: "US", PIECE: "BISHOP" } })),
        eachTapered(false, 2, 4, block("cb_mobility", { fields: { SIDE: "US", PIECE: "ROOK" } })),
        eachTapered(false, 1, 2, block("cb_mobility", { fields: { SIDE: "US", PIECE: "QUEEN" } })),
      ],
      { comment: "Pieces with many safe squares to go to are active. Each reachable square earns a few points." },
    ),
    term("Bishop pair", [ifThen(block("cb_bishop_pair", { fields: { SIDE: "US" } }), tapered(25, 50))], {
      comment: "Two bishops work well together, especially in open endgames.",
    }),
    term(
      "Passed pawns",
      [
        block("cb_for_each", {
          fields: { PIECE: "PAWN" },
          inputs: {
            DO: ifThen(
              block("cb_it_passed"),
              block("cb_add_tapered", {
                fields: { OP: "ADD" },
                inputs: {
                  MG: block("cb_it_pst", { fields: { TABLE: rankTable([0, 0, 5, 10, 20, 35, 55, 0]) } }),
                  EG: block("cb_it_pst", { fields: { TABLE: rankTable([0, 5, 10, 20, 35, 60, 90, 0]) } }),
                },
              }),
            ),
          },
        }),
      ],
      {
        comment:
          "A passed pawn has no enemy pawn in its way. The bonus comes from the two little boards: it grows as the pawn advances and is bigger in the endgame, when fewer pieces can stop it. Click a board to change the numbers.",
      },
    ),
    term(
      "Pawn on our 7th rank",
      [
        ifThen(
          block("cb_any_on", { fields: { SIDE: "US", PIECE: "PAWN" }, inputs: { ZONE: rankZone(7) } }),
          block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(10) } }),
        ),
      ],
      {
        comment:
          "“Increase the evaluation if any of our pawns is on our 7th rank.” Click “pawns” or “7th” to change the piece or the rank, or the number to change the bonus.",
      },
    ),
    term(
      "Pawn structure",
      [
        eachTapered(true, 10, 15, block("cb_pawn_structure", { fields: { SIDE: "US", KIND: "ISOLATED" } })),
        eachTapered(true, 10, 20, block("cb_pawn_structure", { fields: { SIDE: "US", KIND: "DOUBLED" } })),
      ],
      { comment: "Isolated and doubled pawns are weak: they are hard to defend and can't protect each other." },
    ),
    term(
      "Rooks on open files",
      [
        eachTapered(false, 20, 10, block("cb_rooks_files", { fields: { SIDE: "US", KIND: "OPEN" } })),
        eachTapered(false, 10, 5, block("cb_rooks_files", { fields: { SIDE: "US", KIND: "HALF" } })),
      ],
      { comment: "Rooks are strongest on files without pawns, where they can reach deep into the enemy camp." },
    ),
    term(
      "King safety",
      [
        eachTapered(false, 8, 0, block("cb_king_shield", { fields: { SIDE: "US" } })),
        eachTapered(true, 6, 0, block("cb_king_attacks", { fields: { SIDE: "US" } })),
      ],
      {
        comment:
          "In the middlegame the king wants pawns in front of it and few enemy pieces aiming at it. In the endgame (0 points) the king becomes a fighting piece instead.",
      },
    ),
    term("Tempo", [ifThen(block("cb_our_turn"), block("cb_add", { fields: { OP: "ADD" }, inputs: { VALUE: num(12) } }))], {
      comment: "Having the move is worth a little.",
    }),
  ];

  // Chain the terms inside the Evaluation block.
  for (let i = 0; i < terms.length - 1; i++) terms[i]!.next = { block: terms[i + 1]! };
  const root = block("cb_evaluation", {
    x: 40,
    y: 40,
    inputs: { TERMS: terms[0]! },
    comment:
      "Every term below is scored twice: once for White and once for Black (each time as “us”). The evaluation is White's total minus Black's total, in centipawns (100 = one pawn).",
  });

  const ws = workspace([root]);
  // A sticky note (workspace comment) next to the stack introduces the editor.
  ws.workspaceComments = [
    {
      id: "start-intro",
      text:
        "Welcome! This is your evaluation function: it tells the engine how good a position is.\n\n" +
        "• Click any number, word with ▾ or little board to change it.\n" +
        "• Drag new blocks in from the toolbox on the left — “Ready-made terms” is a good start.\n" +
        "• Click the ? on a term to read what it does.\n" +
        "• Your changes are saved automatically.",
      x: 700,
      y: 40,
      width: 350,
      height: 236,
    },
  ];
  // Stable ids make diagnostics and tests deterministic.
  let n = 0;
  walkBlocks([root], (b) => {
    b.id ??= `start-${++n}`;
  });
  return ws;
}

function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/**
 * Starter HCE workspace (Blockly JSON serialization). Deep-frozen: copy it
 * (e.g. `structuredClone(DEFAULT_WORKSPACE)`) before changing anything.
 */
export const DEFAULT_WORKSPACE: object = deepFreeze(buildDefault());
