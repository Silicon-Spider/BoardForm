// Dropdown option lists shared by the block definitions (labels shown to the user) and the
// generator (values). Pure data: no Blockly import, safe to use in workers and Node.

/** A Blockly dropdown option: [label shown on the block, stored value]. */
export type Option = [string, string];

export const PIECE_TYPES = ["PAWN", "KNIGHT", "BISHOP", "ROOK", "QUEEN", "KING"] as const;
export type PieceType = (typeof PIECE_TYPES)[number];

/** Plural piece names, as used in "our [knights]". */
export const PIECE_OPTIONS: Option[] = [
  ["pawns", "PAWN"],
  ["knights", "KNIGHT"],
  ["bishops", "BISHOP"],
  ["rooks", "ROOK"],
  ["queens", "QUEEN"],
  ["king", "KING"],
];

/** Piece names plus "pieces" meaning every piece of that side. */
export const PIECE_OR_ANY_OPTIONS: Option[] = [...PIECE_OPTIONS, ["pieces (any kind)", "ANY"]];

/** Pieces that have a meaningful mobility. */
export const MOBILITY_PIECE_OPTIONS: Option[] = [
  ["knights", "KNIGHT"],
  ["bishops", "BISHOP"],
  ["rooks", "ROOK"],
  ["queens", "QUEEN"],
  ["king", "KING"],
  ["pieces (N + B + R + Q)", "ALL"],
];

export const SIDE_OUR: Option[] = [
  ["our", "US"],
  ["their", "THEM"],
];
export const SIDE_WE: Option[] = [
  ["we", "US"],
  ["they", "THEM"],
];
export const SIDE_US: Option[] = [
  ["us", "US"],
  ["them", "THEM"],
];
/** "their" first: for "distance to [their] king". */
export const SIDE_THEIR_FIRST: Option[] = [
  ["their", "THEM"],
  ["our", "US"],
];

export const RANK_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
/** Ranks 1..8 as ordinals ("7th"), values "1".."8". */
export const RANK_OPTIONS: Option[] = RANK_ORDINALS.map((label, i) => [label, String(i + 1)]);
/** Ranks a passed pawn can stand on (2nd..7th). */
export const PAWN_RANK_OPTIONS: Option[] = RANK_OPTIONS.slice(1, 7);

export const FILE_LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h"];
export const FILE_OPTIONS: Option[] = FILE_LETTERS.map((f) => [f, f.toUpperCase()]);
export const SQUARE_RANK_OPTIONS: Option[] = RANK_ORDINALS.map((_, i) => [String(i + 1), String(i + 1)]);

export const AREA_OPTIONS: Option[] = [
  ["the center (d4 e4 d5 e5)", "CENTER"],
  ["the big center (c3 – f6)", "BIG_CENTER"],
  ["our half of the board", "OUR_HALF"],
  ["their half of the board", "THEIR_HALF"],
  ["light squares", "LIGHT"],
  ["dark squares", "DARK"],
  ["the edge of the board", "EDGE"],
  ["the queenside (files a – d)", "QUEENSIDE"],
  ["the kingside (files e – h)", "KINGSIDE"],
  ["empty squares", "EMPTY"],
  ["the whole board", "ALL"],
];

export const ATTACKER_OPTIONS: Option[] = [
  ["pieces", "ANY"],
  ["pawns", "PAWN"],
  ["knights", "KNIGHT"],
  ["bishops", "BISHOP"],
  ["rooks", "ROOK"],
  ["queens", "QUEEN"],
  ["king", "KING"],
];

export const FILE_KIND_OPTIONS: Option[] = [
  ["open files (no pawns)", "OPEN"],
  ["half-open files for us", "HALF_US"],
  ["half-open files for them", "HALF_THEM"],
];

export const ZONE_COMBINE_OPTIONS: Option[] = [
  ["or", "OR"],
  ["and also in", "AND"],
  ["but not", "MINUS"],
];

export const PAWN_STRUCTURE_OPTIONS: Option[] = [
  ["passed", "PASSED"],
  ["isolated", "ISOLATED"],
  ["doubled", "DOUBLED"],
  ["connected", "CONNECTED"],
  ["backward", "BACKWARD"],
];

export const ROOK_FILE_OPTIONS: Option[] = [
  ["open", "OPEN"],
  ["half-open", "HALF"],
];

export const IT_FILE_OPTIONS: Option[] = [
  ["an open", "OPEN"],
  ["a half-open", "HALF"],
];

export const CASTLE_OPTIONS: Option[] = [
  ["either way", "EITHER"],
  ["king side (O-O)", "KING"],
  ["queen side (O-O-O)", "QUEEN"],
];

export const ADD_OPTIONS: Option[] = [
  ["add", "ADD"],
  ["subtract", "SUB"],
];

export const ARITH_OPTIONS: Option[] = [
  ["+", "ADD"],
  ["−", "SUB"],
  ["×", "MUL"],
  ["÷", "DIV"],
  ["remainder", "MOD"],
];

export const MINMAX_OPTIONS: Option[] = [
  ["smaller", "MIN"],
  ["larger", "MAX"],
];

export const UNARY_OPTIONS: Option[] = [
  ["absolute value of", "ABS"],
  ["negative of", "NEG"],
];

/** Values of a dropdown option list. */
export function optionValues(options: Option[]): string[] {
  return options.map((o) => o[1]);
}

/** Label of a dropdown value (falls back to the value itself). */
export function optionLabel(options: Option[], value: string): string {
  return options.find((o) => o[1] === value)?.[0] ?? value;
}
