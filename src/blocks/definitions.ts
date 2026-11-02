// Blockly JSON definitions of every custom block. Pure data (no Blockly import) so the
// generator can read field defaults and input names in Node / workers without Blockly.
//
// Value types (Blockly connection checks):
//   "Number"  — an i32 (centipawns, counts, distances …)
//   "Boolean" — a bool
//   "Zone"    — a set of squares (u64 bitboard), always seen from "our" side
// Statement checks: "Term" (inside the Evaluation block) and "Action" (inside a term).

import {
  ADD_OPTIONS,
  AREA_OPTIONS,
  ARITH_OPTIONS,
  ATTACKER_OPTIONS,
  CASTLE_OPTIONS,
  FILE_KIND_OPTIONS,
  FILE_OPTIONS,
  IT_FILE_OPTIONS,
  MINMAX_OPTIONS,
  MOBILITY_PIECE_OPTIONS,
  PAWN_RANK_OPTIONS,
  PAWN_STRUCTURE_OPTIONS,
  PIECE_OPTIONS,
  PIECE_OR_ANY_OPTIONS,
  RANK_OPTIONS,
  ROOK_FILE_OPTIONS,
  SIDE_OUR,
  SIDE_THEIR_FIRST,
  SIDE_WE,
  SQUARE_RANK_OPTIONS,
  UNARY_OPTIONS,
  ZONE_COMBINE_OPTIONS,
  type Option,
} from "./catalog";
import { PESTO_MATERIAL } from "./pst";

export type FieldArg =
  | { type: "field_dropdown"; name: string; options: Option[] }
  | { type: "field_number"; name: string; value: number; min?: number; max?: number; precision?: number }
  | { type: "field_input"; name: string; text: string; spellcheck?: boolean }
  | { type: "field_pst"; name: string; preset: string }
  | { type: "field_label"; text: string; class?: string };

export type InputArg =
  | { type: "input_value"; name: string; check?: string | string[]; align?: "LEFT" | "RIGHT" | "CENTRE" }
  | { type: "input_statement"; name: string; check?: string | string[] }
  | { type: "input_dummy"; name?: string }
  | { type: "input_end_row"; name?: string };

export type BlockArg = FieldArg | InputArg;

/** The subset of Blockly's JSON block definition format used here. */
export interface BlockDefinition {
  type: string;
  message0: string;
  args0?: BlockArg[];
  message1?: string;
  args1?: BlockArg[];
  message2?: string;
  args2?: BlockArg[];
  message3?: string;
  args3?: BlockArg[];
  output?: string | null;
  outputShape?: number;
  previousStatement?: string | null;
  nextStatement?: string | null;
  inputsInline?: boolean;
  style: string;
  tooltip: string;
  helpUrl?: string;
}

/** Zelos renderer output shapes. */
const SHAPE_SQUARE = 3;

const NUM = "Number";
const BOOL = "Boolean";
const ZONE = "Zone";
const ACTION = "Action";
const TERM = "Term";

const side = (name = "SIDE"): FieldArg => ({ type: "field_dropdown", name, options: SIDE_OUR });
const pieceField = (name = "PIECE", options: Option[] = PIECE_OPTIONS): FieldArg => ({ type: "field_dropdown", name, options });
const numField = (name: string, value: number, min = -5000, max = 5000): FieldArg => ({
  type: "field_number",
  name,
  value,
  min,
  max,
  precision: 1,
});
const valueIn = (name: string, check: string): InputArg => ({ type: "input_value", name, check });

function action(def: Omit<BlockDefinition, "previousStatement" | "nextStatement">): BlockDefinition {
  return { ...def, previousStatement: ACTION, nextStatement: ACTION };
}
function value(check: string, def: Omit<BlockDefinition, "output">): BlockDefinition {
  return { ...def, output: check, ...(check === ZONE ? { outputShape: SHAPE_SQUARE } : {}) };
}

// ───────────────────────────── Structure ─────────────────────────────

const structure: BlockDefinition[] = [
  {
    type: "cb_evaluation",
    message0: "Evaluation",
    message1: "%1",
    args1: [{ type: "input_statement", name: "TERMS", check: TERM }],
    message2: "score = White's terms − Black's terms",
    style: "cb_root",
    tooltip:
      "The root of your evaluation. Put Term blocks inside it. Every term is worked out twice — once with White as “us” and once with Black as “us” — and the final score is White's total minus Black's total, in centipawns (100 = one pawn).",
  },
  {
    type: "cb_term",
    message0: "term %1",
    args0: [{ type: "field_input", name: "NAME", text: "My term", spellcheck: false }],
    message1: "%1",
    args1: [{ type: "input_statement", name: "DO", check: ACTION }],
    previousStatement: TERM,
    nextStatement: TERM,
    style: "cb_structure",
    tooltip:
      "A named part of the evaluation. The blocks inside add points for “us”. The name is shown in the evaluation breakdown of the test panel, so you can see what each term contributes.",
  },
];

// ───────────────────────────── Add points ─────────────────────────────

const points: BlockDefinition[] = [
  action({
    type: "cb_add",
    message0: "%1 %2 points",
    args0: [{ type: "field_dropdown", name: "OP", options: ADD_OPTIONS }, valueIn("VALUE", NUM)],
    inputsInline: true,
    style: "cb_points",
    tooltip: "Adds (or subtracts) this many centipawns to our score. 100 points = one pawn.",
  }),
  action({
    type: "cb_add_tapered",
    message0: "%1 %2 in the middlegame and %3 in the endgame",
    args0: [{ type: "field_dropdown", name: "OP", options: ADD_OPTIONS }, valueIn("MG", NUM), valueIn("EG", NUM)],
    inputsInline: true,
    style: "cb_points",
    tooltip:
      "Adds a different amount depending on the game phase: the middlegame value while all pieces are on the board, the endgame value when only kings and pawns are left, and a smooth blend in between.",
  }),
  action({
    type: "cb_add_each",
    message0: "%1 %2 points for each %3",
    args0: [{ type: "field_dropdown", name: "OP", options: ADD_OPTIONS }, valueIn("VALUE", NUM), valueIn("COUNT", NUM)],
    inputsInline: true,
    style: "cb_points",
    tooltip: "Adds the points once for every unit of the count, e.g. “add 10 points for each number of our passed pawns”.",
  }),
  action({
    type: "cb_add_each_tapered",
    message0: "%1 %2 in the middlegame and %3 in the endgame for each %4",
    args0: [
      { type: "field_dropdown", name: "OP", options: ADD_OPTIONS },
      valueIn("MG", NUM),
      valueIn("EG", NUM),
      valueIn("COUNT", NUM),
    ],
    inputsInline: true,
    style: "cb_points",
    tooltip:
      "Like “add … for each”, with separate middlegame and endgame amounts that are blended by the game phase.",
  }),
];

// ───────────────────────────── Classic evaluation ─────────────────────────────

const PIECE_VALUES_MESSAGE = "pawn %1  knight %2  bishop %3  rook %4  queen %5";
const pieceValueArgs = (prefix: string, v: { P: number; N: number; B: number; R: number; Q: number }): FieldArg[] => [
  numField(`${prefix}P`, v.P, -5000, 5000),
  numField(`${prefix}N`, v.N, -5000, 5000),
  numField(`${prefix}B`, v.B, -5000, 5000),
  numField(`${prefix}R`, v.R, -5000, 5000),
  numField(`${prefix}Q`, v.Q, -5000, 5000),
];
const STANDARD = { P: 100, N: 320, B: 330, R: 500, Q: 900 };

const classic: BlockDefinition[] = [
  action({
    type: "cb_material",
    message0: "count material   " + PIECE_VALUES_MESSAGE,
    args0: pieceValueArgs("", STANDARD),
    style: "cb_classic",
    tooltip:
      "Adds the value of all our pieces: every pawn, knight, bishop, rook and queen counts the given number of centipawns. The king has no material value.",
  }),
  action({
    type: "cb_material_tapered",
    message0: "count material",
    message1: "middlegame   " + PIECE_VALUES_MESSAGE,
    args1: pieceValueArgs("MG_", PESTO_MATERIAL.mg),
    message2: "endgame   " + PIECE_VALUES_MESSAGE,
    args2: pieceValueArgs("EG_", PESTO_MATERIAL.eg),
    style: "cb_classic",
    tooltip:
      "Material with separate middlegame and endgame values (blended by the game phase). The defaults are PeSTO's tuned values: knights are worth less and rooks more as pieces come off.",
  }),
  action({
    type: "cb_pst",
    message0: "piece-square table for our %1 %2",
    args0: [pieceField(), { type: "field_pst", name: "TABLE", preset: "CENTER" }],
    style: "cb_classic",
    tooltip:
      "Adds a bonus or penalty for each of our pieces of this kind depending on the square it stands on. Click the little board to edit the numbers. Tables are drawn from White's side (rank 8 at the top); for Black they are mirrored automatically.",
  }),
  action({
    type: "cb_pst_tapered",
    message0: "piece-square table for our %1",
    args0: [pieceField()],
    message1: "middlegame %1   endgame %2",
    args1: [
      { type: "field_pst", name: "MG", preset: "CENTER" },
      { type: "field_pst", name: "EG", preset: "CENTER" },
    ],
    style: "cb_classic",
    tooltip:
      "A piece-square table with one board for the middlegame and one for the endgame, blended by the game phase — e.g. the king should hide in the middlegame but walk to the center in the endgame. Click a board to edit it.",
  }),
  value(NUM, {
    type: "cb_mobility",
    message0: "mobility of %1 %2",
    args0: [side(), pieceField("PIECE", MOBILITY_PIECE_OPTIONS)],
    style: "cb_classic",
    tooltip:
      "How many squares these pieces can move to, not counting squares occupied by their own pieces or attacked by enemy pawns. More mobility usually means more active pieces.",
  }),
  value(NUM, {
    type: "cb_pawn_structure",
    message0: "number of %1 %2 pawns",
    args0: [side(), { type: "field_dropdown", name: "KIND", options: PAWN_STRUCTURE_OPTIONS }],
    style: "cb_classic",
    tooltip:
      "Counts pawns with a structural feature. Passed: no enemy pawn can stop it. Isolated: no friendly pawn on a neighbouring file. Doubled: another friendly pawn in front on the same file. Connected: defended by or standing next to a friendly pawn. Backward: behind its neighbours and unable to advance safely.",
  }),
  value(NUM, {
    type: "cb_passed_rank",
    message0: "number of %1 passed pawns on the %2 rank or further",
    args0: [side(), { type: "field_dropdown", name: "RANK", options: PAWN_RANK_OPTIONS }],
    style: "cb_classic",
    tooltip:
      "Counts passed pawns that have reached at least this rank (counted from their own side, so the 7th rank is one step from promoting).",
  }),
  value(NUM, {
    type: "cb_rooks_files",
    message0: "number of %1 rooks on %2 files",
    args0: [side(), { type: "field_dropdown", name: "KIND", options: ROOK_FILE_OPTIONS }],
    style: "cb_classic",
    tooltip:
      "Rooks love open files (no pawns at all) and half-open files (none of their own pawns, but an enemy pawn to attack), where they can work down the file.",
  }),
  value(BOOL, {
    type: "cb_bishop_pair",
    message0: "%1 have the bishop pair",
    args0: [{ type: "field_dropdown", name: "SIDE", options: SIDE_WE }],
    style: "cb_classic",
    tooltip: "True if this side has bishops on both light and dark squares. Two bishops together are usually worth extra.",
  }),
  value(NUM, {
    type: "cb_king_shield",
    message0: "number of pawns shielding %1 king",
    args0: [side()],
    style: "cb_classic",
    tooltip: "Own pawns on the king's file and the two files next to it, one or two ranks in front of the king.",
  }),
  value(NUM, {
    type: "cb_king_attacks",
    message0: "enemy attacks near %1 king",
    args0: [side()],
    style: "cb_classic",
    tooltip:
      "How many times enemy pieces attack the king's square and the squares around it (each piece × square counts once). A high number means the king is in danger.",
  }),
  value(NUM, {
    type: "cb_king_distance",
    message0: "distance between the kings",
    style: "cb_classic",
    tooltip: "King moves needed to walk from one king to the other (1 – 7). Useful in endgames: the stronger side wants its king close.",
  }),
  value(NUM, {
    type: "cb_king_center",
    message0: "%1 king's distance from the center",
    args0: [side()],
    style: "cb_classic",
    tooltip: "0 when the king is on d4, e4, d5 or e5, up to 3 on the edge of the board.",
  }),
  value(NUM, {
    type: "cb_hanging",
    message0: "number of %1 hanging pieces",
    args0: [side()],
    style: "cb_classic",
    tooltip: "Knights, bishops, rooks and queens that are attacked by the enemy and not defended at all.",
  }),
];

// ───────────────────────────── Pieces ─────────────────────────────

const materialValueArgs = (): FieldArg[] => [
  numField("P", 100),
  numField("N", 320),
  numField("B", 330),
  numField("R", 500),
  numField("Q", 900),
];

const pieces: BlockDefinition[] = [
  value(BOOL, {
    type: "cb_any_on",
    message0: "any of %1 %2 on %3",
    args0: [side(), pieceField("PIECE", PIECE_OR_ANY_OPTIONS), valueIn("ZONE", ZONE)],
    inputsInline: true,
    style: "cb_pieces",
    tooltip:
      "True if at least one of these pieces stands in the chosen squares. Change the squares by editing the square block, or drop any block from the Squares category into the slot.",
  }),
  value(NUM, {
    type: "cb_count_on",
    message0: "number of %1 %2 on %3",
    args0: [side(), pieceField("PIECE", PIECE_OR_ANY_OPTIONS), valueIn("ZONE", ZONE)],
    inputsInline: true,
    style: "cb_pieces",
    tooltip: "How many of these pieces stand in the chosen squares.",
  }),
  value(NUM, {
    type: "cb_count",
    message0: "number of %1 %2",
    args0: [side(), pieceField("PIECE", PIECE_OR_ANY_OPTIONS)],
    style: "cb_pieces",
    tooltip: "How many of these pieces this side has on the board.",
  }),
  value(NUM, {
    type: "cb_material_value",
    message0: "%1 material   pawn %2 knight %3 bishop %4 rook %5 queen %6",
    args0: [side(), ...materialValueArgs()],
    style: "cb_pieces",
    tooltip: "The total value of this side's pieces, using the values you set (standard: 100 / 320 / 330 / 500 / 900).",
  }),
  value(NUM, {
    type: "cb_material_diff",
    message0: "material difference (ours − theirs)   pawn %1 knight %2 bishop %3 rook %4 queen %5",
    args0: materialValueArgs(),
    style: "cb_pieces",
    tooltip:
      "Our material minus their material. Positive when we are ahead. Handy for “trade pieces when ahead” ideas.",
  }),
];

// ───────────────────────────── Squares (zones) ─────────────────────────────

const zones: BlockDefinition[] = [
  value(ZONE, {
    type: "cb_zone_rank",
    message0: "%1 %2 rank",
    args0: [side("WHOSE"), { type: "field_dropdown", name: "RANK", options: RANK_OPTIONS }],
    style: "cb_zone",
    tooltip:
      "A whole rank, counted from that side's point of view: our 1st rank is our back rank, our 7th rank is where our pawns are about to promote. For Black this is mirrored automatically.",
  }),
  value(ZONE, {
    type: "cb_zone_ranks",
    message0: "%1 %2 to %3 rank",
    args0: [
      side("WHOSE"),
      { type: "field_dropdown", name: "FROM", options: RANK_OPTIONS },
      { type: "field_dropdown", name: "TO", options: RANK_OPTIONS },
    ],
    style: "cb_zone",
    tooltip: "Several ranks in a row, e.g. “our 5th to 7th rank”, counted from that side's point of view.",
  }),
  value(ZONE, {
    type: "cb_zone_file",
    message0: "the %1-file",
    args0: [{ type: "field_dropdown", name: "FILE", options: FILE_OPTIONS }],
    style: "cb_zone",
    tooltip: "A whole file (column). Files are the same for both sides.",
  }),
  value(ZONE, {
    type: "cb_zone_square",
    message0: "square %1%2 (mirrored for Black)",
    args0: [
      { type: "field_dropdown", name: "FILE", options: FILE_OPTIONS },
      { type: "field_dropdown", name: "RANK", options: SQUARE_RANK_OPTIONS },
    ],
    style: "cb_zone",
    tooltip:
      "A single square as seen by White. When Black is “us” the square is mirrored, so “e4” means e4 for White and e5 for Black.",
  }),
  value(ZONE, {
    type: "cb_zone_area",
    message0: "%1",
    args0: [{ type: "field_dropdown", name: "AREA", options: AREA_OPTIONS }],
    style: "cb_zone",
    tooltip:
      "A common group of squares. “Our half” is ranks 1–4 from our side. Light and dark squares are the real square colours (not mirrored).",
  }),
  value(ZONE, {
    type: "cb_zone_attacked",
    message0: "squares attacked by %1 %2",
    args0: [side("WHOSE"), { type: "field_dropdown", name: "BY", options: ATTACKER_OPTIONS }],
    style: "cb_zone",
    tooltip: "Every square that these pieces attack right now.",
  }),
  value(ZONE, {
    type: "cb_zone_king",
    message0: "squares around %1 king",
    args0: [side("WHOSE")],
    style: "cb_zone",
    tooltip: "The king's square and the (up to) eight squares next to it.",
  }),
  value(ZONE, {
    type: "cb_zone_pieces",
    message0: "squares of %1 %2",
    args0: [side("WHOSE"), pieceField("PIECE", PIECE_OR_ANY_OPTIONS)],
    style: "cb_zone",
    tooltip: "The squares these pieces stand on.",
  }),
  value(ZONE, {
    type: "cb_zone_files",
    message0: "%1",
    args0: [{ type: "field_dropdown", name: "KIND", options: FILE_KIND_OPTIONS }],
    style: "cb_zone",
    tooltip: "Open files have no pawns at all. A half-open file has none of that side's pawns but at least one enemy pawn.",
  }),
  value(ZONE, {
    type: "cb_zone_combine",
    message0: "%1 %2 %3",
    args0: [valueIn("A", ZONE), { type: "field_dropdown", name: "OP", options: ZONE_COMBINE_OPTIONS }, valueIn("B", ZONE)],
    inputsInline: true,
    style: "cb_zone",
    tooltip:
      "Combines two groups of squares: “or” = squares in either, “and also in” = squares in both, “but not” = squares in the first but not the second.",
  }),
];

// ───────────────────────────── Game state ─────────────────────────────

const state: BlockDefinition[] = [
  value(NUM, {
    type: "cb_phase",
    message0: "game phase (24 = opening … 0 = endgame)",
    style: "cb_state",
    tooltip:
      "How much material is left: knights and bishops count 1, rooks 2, queens 4. 24 at the start of the game, 0 when only kings and pawns remain.",
  }),
  value(BOOL, {
    type: "cb_is_endgame",
    message0: "it is an endgame (game phase ≤ %1)",
    args0: [numField("PHASE", 8, 0, 24)],
    style: "cb_state",
    tooltip: "True when the game phase is at most this number (0 = only kings and pawns, 24 = all pieces).",
  }),
  value(BOOL, {
    type: "cb_our_turn",
    message0: "it is our turn to move",
    style: "cb_state",
    tooltip: "True when “us” is the side to move. Being on move is worth a little (a “tempo”).",
  }),
  value(BOOL, {
    type: "cb_in_check",
    message0: "%1 in check",
    args0: [
      {
        type: "field_dropdown",
        name: "WHO",
        options: [
          ["we are", "US"],
          ["they are", "THEM"],
        ],
      },
    ],
    style: "cb_state",
    tooltip: "True when that side's king is attacked.",
  }),
  value(BOOL, {
    type: "cb_can_castle",
    message0: "%1 can still castle %2",
    args0: [{ type: "field_dropdown", name: "WHO", options: SIDE_WE }, { type: "field_dropdown", name: "WAY", options: CASTLE_OPTIONS }],
    style: "cb_state",
    tooltip: "True while that side still has the right to castle (the king and that rook have not moved yet).",
  }),
  value(NUM, {
    type: "cb_halfmove",
    message0: "moves since the last capture or pawn move",
    style: "cb_state",
    tooltip: "The fifty-move counter, in half-moves (plies). At 100 the game is a draw.",
  }),
];

// ───────────────────────────── For each piece ─────────────────────────────

const LOOP_NOTE = " Only works inside a “for each of our …” block.";

const loop: BlockDefinition[] = [
  action({
    type: "cb_for_each",
    message0: "for each of our %1",
    args0: [pieceField()],
    message1: "%1",
    args1: [{ type: "input_statement", name: "DO", check: ACTION }],
    style: "cb_loop",
    tooltip:
      "Runs the blocks inside once for every one of our pieces of this kind. Inside, the green “it …” blocks describe the piece currently being looked at.",
  }),
  value(NUM, {
    type: "cb_it_rank",
    message0: "its rank (1 – 8 from our side)",
    style: "cb_loop",
    tooltip: "The rank the piece stands on, counted from our side: 1 = our back rank, 7 = one step from promotion." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_file",
    message0: "its file (a = 1 … h = 8)",
    style: "cb_loop",
    tooltip: "The file the piece stands on, a = 1 up to h = 8." + LOOP_NOTE,
  }),
  value(BOOL, {
    type: "cb_it_attacked",
    message0: "it is attacked by them",
    style: "cb_loop",
    tooltip: "True if an enemy piece attacks this piece." + LOOP_NOTE,
  }),
  value(BOOL, {
    type: "cb_it_defended",
    message0: "it is defended by us",
    style: "cb_loop",
    tooltip: "True if another of our pieces protects this piece." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_mobility",
    message0: "its mobility",
    style: "cb_loop",
    tooltip:
      "How many squares this piece can move to (not counting squares with our own pieces or attacked by enemy pawns). A pawn counts its moves forward and its captures." +
      LOOP_NOTE,
  }),
  value(BOOL, {
    type: "cb_it_passed",
    message0: "it is a passed pawn",
    style: "cb_loop",
    tooltip: "True if this is a pawn that no enemy pawn can stop on its way to promotion." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_king_distance",
    message0: "its distance to %1 king",
    args0: [{ type: "field_dropdown", name: "WHOSE", options: SIDE_THEIR_FIRST }],
    style: "cb_loop",
    tooltip: "King moves between this piece and that king (0 – 7)." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_center_distance",
    message0: "its distance from the center (0 – 3)",
    style: "cb_loop",
    tooltip: "0 on d4, e4, d5 or e5, up to 3 on the edge of the board." + LOOP_NOTE,
  }),
  value(BOOL, {
    type: "cb_it_open_file",
    message0: "it is on %1 file",
    args0: [{ type: "field_dropdown", name: "KIND", options: IT_FILE_OPTIONS }],
    style: "cb_loop",
    tooltip: "Open file: no pawns at all. Half-open: none of our pawns, but at least one of theirs." + LOOP_NOTE,
  }),
  value(BOOL, {
    type: "cb_it_on",
    message0: "it is on %1",
    args0: [valueIn("ZONE", ZONE)],
    inputsInline: true,
    style: "cb_loop",
    tooltip: "True if the piece stands in these squares." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_attacks_in",
    message0: "number of squares it attacks in %1",
    args0: [valueIn("ZONE", ZONE)],
    inputsInline: true,
    style: "cb_loop",
    tooltip: "How many of these squares the piece attacks, e.g. squares around their king." + LOOP_NOTE,
  }),
  value(NUM, {
    type: "cb_it_pst",
    message0: "value of its square in %1",
    args0: [{ type: "field_pst", name: "TABLE", preset: "CENTER" }],
    style: "cb_loop",
    tooltip: "Looks up the piece's square in this table (drawn from White's side, mirrored for Black)." + LOOP_NOTE,
  }),
];

// ───────────────────────────── Math ─────────────────────────────

const math: BlockDefinition[] = [
  value(NUM, {
    type: "cb_arith",
    message0: "%1 %2 %3",
    args0: [valueIn("A", NUM), { type: "field_dropdown", name: "OP", options: ARITH_OPTIONS }, valueIn("B", NUM)],
    inputsInline: true,
    style: "cb_math",
    tooltip:
      "Whole-number arithmetic. Division rounds toward zero, and dividing by zero gives 0 instead of crashing the engine.",
  }),
  value(NUM, {
    type: "cb_minmax",
    message0: "the %1 of %2 and %3",
    args0: [{ type: "field_dropdown", name: "OP", options: MINMAX_OPTIONS }, valueIn("A", NUM), valueIn("B", NUM)],
    inputsInline: true,
    style: "cb_math",
    tooltip: "The smaller (minimum) or larger (maximum) of two numbers.",
  }),
  value(NUM, {
    type: "cb_unary",
    message0: "%1 %2",
    args0: [{ type: "field_dropdown", name: "OP", options: UNARY_OPTIONS }, valueIn("A", NUM)],
    inputsInline: true,
    style: "cb_math",
    tooltip: "Absolute value (drops the minus sign) or the negative of a number.",
  }),
  value(NUM, {
    type: "cb_clamp",
    message0: "limit %1 between %2 and %3",
    args0: [valueIn("X", NUM), valueIn("LO", NUM), valueIn("HI", NUM)],
    inputsInline: true,
    style: "cb_math",
    tooltip: "Keeps a number inside a range: below the lower limit gives the lower limit, above the upper limit gives the upper limit.",
  }),
  value(NUM, {
    type: "cb_by_rank",
    message0: "pick by rank %1 %2",
    args0: [valueIn("RANK", NUM), { type: "input_end_row" }],
    inputsInline: true,
    message1: "1st %1 2nd %2 3rd %3 4th %4 5th %5 6th %6 7th %7 8th %8",
    args1: [
      numField("R1", 0),
      numField("R2", 0),
      numField("R3", 10),
      numField("R4", 20),
      numField("R5", 35),
      numField("R6", 60),
      numField("R7", 100),
      numField("R8", 0),
    ],
    style: "cb_math",
    tooltip:
      "Picks one of eight numbers by a rank from 1 to 8 (smaller values count as 1, larger as 8). Plug in “its rank” to give pawns a bonus that grows as they advance.",
  }),
];

/** Every custom block definition, in toolbox order. */
export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  ...structure,
  ...points,
  ...classic,
  ...pieces,
  ...zones,
  ...state,
  ...loop,
  ...math,
];

/** Built-in Blockly blocks the toolbox uses (the generator supports exactly these). */
export const BUILTIN_BLOCK_TYPES = [
  "controls_if",
  "controls_ifelse",
  "logic_compare",
  "logic_operation",
  "logic_negate",
  "logic_boolean",
  "logic_ternary",
  "math_number",
  "variables_get",
  "variables_set",
  "math_change",
] as const;

/** Blocks that may only be used inside a "for each" loop. */
export const LOOP_VALUE_TYPES = new Set(
  BLOCK_DEFINITIONS.filter((d) => d.type.startsWith("cb_it_")).map((d) => d.type),
);

/** Field/input metadata extracted from a definition (used by the generator). */
export interface BlockInfo {
  type: string;
  output: string | null;
  statement: boolean;
  fields: Map<string, FieldArg>;
  inputs: Map<string, InputArg>;
}

function collectArgs(def: BlockDefinition): BlockArg[] {
  return [...(def.args0 ?? []), ...(def.args1 ?? []), ...(def.args2 ?? []), ...(def.args3 ?? [])];
}

function infoFor(def: BlockDefinition): BlockInfo {
  const fields = new Map<string, FieldArg>();
  const inputs = new Map<string, InputArg>();
  for (const arg of collectArgs(def)) {
    if (arg.type === "input_value" || arg.type === "input_statement") inputs.set(arg.name, arg);
    else if (arg.type !== "input_dummy" && arg.type !== "input_end_row" && arg.type !== "field_label") fields.set(arg.name, arg);
  }
  return {
    type: def.type,
    output: def.output ?? null,
    statement: def.previousStatement !== undefined || def.nextStatement !== undefined,
    fields,
    inputs,
  };
}

export const BLOCK_INFO: ReadonlyMap<string, BlockInfo> = new Map(BLOCK_DEFINITIONS.map((d) => [d.type, infoFor(d)]));

function argText(arg: BlockArg | undefined): string {
  if (!arg) return "…";
  switch (arg.type) {
    case "field_dropdown":
      return arg.options[0]?.[0] ?? "…";
    case "field_number":
      return String(arg.value);
    case "field_input":
      return `“${arg.text}”`;
    case "field_label":
      return arg.text;
    case "field_pst":
      return "[table]";
    default:
      return "…";
  }
}

/** Short human-readable block names ("add … points"), used to prefix generator messages. */
export function blockDisplayName(type: string): string {
  const def = BLOCK_DEFINITIONS.find((d) => d.type === type);
  if (def) {
    const parts: string[] = [];
    const messages: [string | undefined, BlockArg[] | undefined][] = [
      [def.message0, def.args0],
      [def.message1, def.args1],
    ];
    for (const [message, args] of messages) {
      if (!message) continue;
      parts.push(message.replace(/%(\d+)/g, (_, n: string) => argText(args?.[Number(n) - 1])));
    }
    const text = parts
      .join(" ")
      .replace(/(…\s*)+/g, "… ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 56 ? text.slice(0, 54).trimEnd() + "…" : text;
  }
  const builtin: Record<string, string> = {
    controls_if: "if",
    controls_ifelse: "if / else",
    logic_compare: "compare",
    logic_operation: "and / or",
    logic_negate: "not",
    logic_boolean: "true / false",
    logic_ternary: "choose if … else …",
    math_number: "number",
    variables_get: "variable",
    variables_set: "set variable",
    math_change: "change variable",
  };
  return builtin[type] ?? type;
}
