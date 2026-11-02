// =============================================================================
//  Minimal — a small chess engine written from scratch          (Engine ABI v1)
// =============================================================================
//  A complete chess engine in one file, written to be read, changed and
//  extended. It is deliberately simple (no bitboards, no hash table, no pruning
//  tricks) and shows the classic ideas almost every engine is built on:
//
//     2  the 0x88 board                     7  making and unmaking moves
//     3  Zobrist keys (repetitions)         8  perft, the move generator test
//     4  FEN and the position command       9  evaluation: material + piece-square tables
//     5  attack detection                  10  search: iterative deepening, alpha-beta,
//     6  move generation (castling, en         quiescence, move ordering, time control
//        passant, promotion)               11  the cb_* functions Chess Builder calls
//
//  How the app talks to an engine: Help → Engine ABI (docs/ENGINE_ABI.md).
//
//  Ideas for making it stronger, roughly in order of how much they help:
//    1. a transposition table (the Zobrist keys from section 3 are ready for it)
//    2. null-move pruning and late move reductions
//    3. more evaluation: pawn structure, mobility, king safety, the bishop pair
//    4. the history heuristic for ordering quiet moves
//  https://www.chessprogramming.org explains all of them. After touching the
//  move generator, run Perft in the Workshop's test panel: from the start
//  position depths 1-5 must give 20, 400, 8902, 197281 and 4865609.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. Talking to the app
// -----------------------------------------------------------------------------

/** Milliseconds since some fixed point (like performance.now()). Use differences only. */
@external("env", "cb_now")
declare function cb_now(): f64;

/** Non-zero when the app wants the current search to stop as soon as possible. */
@external("env", "cb_should_stop")
declare function cb_should_stop(): i32;

/** Search progress; `score` is from the side to move's view, `mate` is "mate in N" or 0.
 *  The PV ("e2e4 e7e5 ...") must be at the start of the output buffer, `pvLen` bytes. */
@external("env", "cb_info")
declare function cb_info(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32): void;

/** Shows `len` bytes from the start of the output buffer in the engine console. */
@external("env", "cb_log")
declare function cb_log(len: i32): void;

// Text travels through two 64 KiB byte buffers inside our own memory.
const BUFFER_SIZE: i32 = 65536;
const INPUT: usize = memory.data(BUFFER_SIZE); // the app writes commands here
const OUTPUT: usize = memory.data(BUFFER_SIZE); // we write moves, PVs and log text here

/** Reads the `len` bytes the app wrote into the input buffer as a string. */
function readInput(len: i32): string {
  return String.UTF8.decodeUnsafe(INPUT, <usize>min(max(len, 0), BUFFER_SIZE));
}

/** Writes `text` as UTF-8 into the output buffer at byte `at`; returns where it ends. */
function writeOutput(text: string, at: i32 = 0): i32 {
  const size = String.UTF8.byteLength(text);
  if (at < 0 || at + size > BUFFER_SIZE) return at; // would not fit: write nothing
  // changetype<usize>(text) is the address of the string's characters in memory.
  String.UTF8.encodeUnsafe(changetype<usize>(text), text.length, OUTPUT + <usize>at);
  return at + size;
}

/** Prints a line in the engine console (handy for debugging). */
function log(text: string): void {
  cb_log(writeOutput(text));
}

// -----------------------------------------------------------------------------
// 2. The board
// -----------------------------------------------------------------------------
//
// A "0x88" board is an array of 128 squares, 16 per rank, of which only the
// left 8 columns are real:
//
//            a    b    c    d    e    f    g    h   | off the board
//   rank 8  0x70 0x71 0x72 0x73 0x74 0x75 0x76 0x77 | 0x78 ... 0x7f
//    ...
//   rank 1  0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 | 0x08 ... 0x0f
//
//   square = rank * 16 + file      (file 0..7 = a..h, rank 0..7 = 1st..8th)
//
// A step is an addition (north +16, east +1, north-east +17, ...), and every
// step that leaves the board lands on a square with bit 0x08 (file too big) or
// bit 0x80 (rank out of range, also for negative numbers) set. So the single
// test `(sq & 0x88) != 0` means "off the board", which keeps move generation short.

const WHITE: i32 = 0, BLACK: i32 = 1;
const PAWN: i32 = 0, KNIGHT: i32 = 1, BISHOP: i32 = 2, ROOK: i32 = 3, QUEEN: i32 = 4, KING: i32 = 5;

// A piece code combines colour and type: piece = color * 6 + type.
// 0..5 are the white P N B R Q K, 6..11 the black ones; EMPTY is a free square.
const EMPTY: i32 = 12;
function makePiece(color: i32, type: i32): i32 { return color * 6 + type; }
function colorOf(piece: i32): i32 { return piece / 6; } // only for real pieces, not EMPTY
function typeOf(piece: i32): i32 { return piece % 6; } // only for real pieces, not EMPTY

const NO_SQUARE: i32 = -1;
// The kings' and rooks' starting squares (castling needs them).
const A1: i32 = 0x00, E1: i32 = 0x04, H1: i32 = 0x07;
const A8: i32 = 0x70, E8: i32 = 0x74, H8: i32 = 0x77;

// Castling rights, one bit each: White O-O, White O-O-O, Black O-O, Black O-O-O.
const CASTLE_WK: i32 = 1, CASTLE_WQ: i32 = 2, CASTLE_BK: i32 = 4, CASTLE_BQ: i32 = 8;

// How pieces move, as 0x88 steps. SLIDE_DIRS 0-3 are the diagonals (bishop),
// 4-7 the straight lines (rook); a queen uses all eight.
const KNIGHT_STEPS: StaticArray<i32> = [33, 31, 18, 14, -14, -18, -31, -33];
const KING_STEPS: StaticArray<i32> = [16, 17, 1, -15, -16, -17, -1, 15];
const SLIDE_DIRS: StaticArray<i32> = [17, 15, -15, -17, 16, -16, 1, -1];

// The position.
const board = new StaticArray<i32>(128); // piece code (or EMPTY) on every square
let side: i32 = WHITE; // side to move
let castling: i32 = 0; // CASTLE_* rights still allowed
let epSquare: i32 = NO_SQUARE; // square a pawn may capture onto en passant
let halfmoveClock: i32 = 0; // plies since the last capture or pawn move (fifty-move rule)
let fullmoveNumber: i32 = 1;
const kingSquare = new StaticArray<i32>(2); // where each king stands
let key: u64 = 0; // Zobrist key of the position (section 3)

// A move is packed into one i32:   from | (to << 8) | (promotion << 16)
// `promotion` is the piece type a pawn becomes (KNIGHT..QUEEN), or 0. Whether a
// move captures, castles or takes en passant can be read off the board.
const NO_MOVE: i32 = 0; // "a1 to a1" is never a real move
function encodeMove(from: i32, to: i32, promotion: i32): i32 { return from | (to << 8) | (promotion << 16); }
function moveFrom(move: i32): i32 { return move & 0xff; }
function moveTo(move: i32): i32 { return (move >> 8) & 0xff; }
function movePromotion(move: i32): i32 { return move >> 16; }

/** "e4" for square 0x34 ('a' is character 97, '1' is 49). */
function squareName(sq: i32): string {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4));
}

/** UCI notation: "e2e4", "e7e8q"; castling is the king's move, e.g. "e1g1". */
function moveToUci(move: i32): string {
  let text = squareName(moveFrom(move)) + squareName(moveTo(move));
  if (movePromotion(move) != 0) text += " nbrq".charAt(movePromotion(move)); // KNIGHT = 1 .. QUEEN = 4
  return text;
}

// -----------------------------------------------------------------------------
// 3. Zobrist keys
// -----------------------------------------------------------------------------
//
// A Zobrist key is a 64-bit fingerprint of a position. Every (piece, square)
// pair, the side to move, each set of castling rights and each en-passant square
// gets a fixed random number; the key is the XOR of the numbers of everything
// that is "on". XOR undoes itself, so moving a piece is just two XORs:
//     key ^= number(piece, from); key ^= number(piece, to);
// We use the keys to spot repeated positions (a transposition table would too).

const zobristPiece = new StaticArray<u64>(12 * 128); // [piece * 128 + square]
const zobristCastling = new StaticArray<u64>(16); // [castling rights]
const zobristEp = new StaticArray<u64>(128); // [en-passant square]
let zobristSide: u64 = 0; // included when Black is to move

/** A tiny pseudo-random generator (xorshift64): the same numbers on every run. */
let randomState: u64 = 0x2545f4914f6cdd1d;
function random64(): u64 {
  randomState ^= randomState << 13;
  randomState ^= randomState >> 7;
  randomState ^= randomState << 17;
  return randomState;
}

function initZobrist(): void {
  for (let i = 0; i < 12 * 128; i++) zobristPiece[i] = random64();
  for (let i = 0; i < 16; i++) zobristCastling[i] = random64();
  for (let i = 0; i < 128; i++) zobristEp[i] = random64();
  zobristSide = random64();
}

/** The key of the current position, computed from scratch. */
function computeKey(): u64 {
  let k: u64 = 0;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) == 0 && board[sq] != EMPTY) k ^= zobristPiece[board[sq] * 128 + sq];
  }
  k ^= zobristCastling[castling];
  if (epSquare != NO_SQUARE) k ^= zobristEp[epSquare];
  if (side == BLACK) k ^= zobristSide;
  return k;
}

// -----------------------------------------------------------------------------
// 4. Setting up a position: FEN and the "position" command
// -----------------------------------------------------------------------------

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Splits text into words at spaces (several spaces in a row count as one). */
function splitWords(text: string): string[] {
  const words = new Array<string>();
  let start = -1; // where the current word started, -1 = between words
  for (let i = 0; i <= text.length; i++) {
    const isSpace = i == text.length || text.charCodeAt(i) <= 32;
    if (!isSpace && start < 0) start = i;
    if (isSpace && start >= 0) {
      words.push(text.substring(start, i));
      start = -1;
    }
  }
  return words;
}

/** "e3" -> 0x24, or NO_SQUARE if `name` is not a square. */
function parseSquare(name: string): i32 {
  if (name.length != 2) return NO_SQUARE;
  const file = name.charCodeAt(0) - 97; // 'a'
  const rank = name.charCodeAt(1) - 49; // '1'
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return NO_SQUARE;
  return rank * 16 + file;
}

/** "42" -> 42; `fallback` if the text is not a small non-negative number. */
function parseNumber(text: string, fallback: i32): i32 {
  if (text.length == 0 || text.length > 6) return fallback;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const digit = text.charCodeAt(i) - 48; // '0'
    if (digit < 0 || digit > 9) return fallback;
    n = n * 10 + digit;
  }
  return n;
}

/**
 * Sets up a position from FEN, e.g. the start position
 *   rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
 * = pieces (rank 8 first, digits are empty squares), side to move, castling
 * rights, en-passant square, halfmove clock, move number.
 * Returns false if the FEN is malformed or the position is impossible.
 */
function setFen(fen: string): bool {
  const fields = splitWords(fen);
  if (fields.length < 4) return false;

  // Field 1: the pieces. Upper case is White. "PNBRQKpnbrqk".indexOf(c) is
  // exactly our piece code, because piece = color * 6 + type.
  for (let sq = 0; sq < 128; sq++) board[sq] = EMPTY;
  let rank = 7;
  let file = 0;
  for (let i = 0; i < fields[0].length; i++) {
    const c = fields[0].charAt(i);
    const piece = "PNBRQKpnbrqk".indexOf(c);
    const digit = "12345678".indexOf(c);
    if (c == "/") {
      if (file != 8 || rank == 0) return false; // every rank needs exactly 8 squares
      rank--;
      file = 0;
    } else if (digit >= 0 && file + digit < 8) {
      file += digit + 1;
    } else if (piece >= 0 && file < 8) {
      board[rank * 16 + file] = piece;
      file++;
    } else {
      return false;
    }
  }
  if (rank != 0 || file != 8) return false;

  // Fields 2-4: side to move, castling rights ("KQkq" letters, index = bit number), en passant.
  if (fields[1] == "w") side = WHITE;
  else if (fields[1] == "b") side = BLACK;
  else return false;
  castling = 0;
  if (fields[2] != "-") {
    for (let i = 0; i < fields[2].length; i++) {
      const right = "KQkq".indexOf(fields[2].charAt(i));
      if (right < 0) return false;
      castling |= 1 << right;
    }
  }
  epSquare = NO_SQUARE;
  if (fields[3] != "-") {
    epSquare = parseSquare(fields[3]);
    if (epSquare == NO_SQUARE) return false;
  }
  // Fields 5 and 6 are optional.
  halfmoveClock = fields.length > 4 ? parseNumber(fields[4], 0) : 0;
  fullmoveNumber = fields.length > 5 ? parseNumber(fields[5], 1) : 1;

  // Sanity checks, so the rest of the engine can trust the position: one king
  // per side, no pawns on the first or last rank, and the side that just moved
  // must not be in check.
  let whiteKings = 0;
  let blackKings = 0;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) != 0 || board[sq] == EMPTY) continue;
    const piece = board[sq];
    if (typeOf(piece) == PAWN && ((sq >> 4) == 0 || (sq >> 4) == 7)) return false;
    if (typeOf(piece) != KING) continue;
    kingSquare[colorOf(piece)] = sq;
    if (colorOf(piece) == WHITE) whiteKings++;
    else blackKings++;
  }
  if (whiteKings != 1 || blackKings != 1) return false;
  if (isAttacked(kingSquare[side ^ 1], side)) return false;

  // Drop castling rights whose king or rook has left its starting square, and
  // an en-passant square that doesn't belong to a pawn that just moved two
  // steps (FENs found in the wild sometimes get these wrong).
  const whiteKingHome = board[E1] == makePiece(WHITE, KING);
  const blackKingHome = board[E8] == makePiece(BLACK, KING);
  if (!whiteKingHome || board[H1] != makePiece(WHITE, ROOK)) castling &= ~CASTLE_WK;
  if (!whiteKingHome || board[A1] != makePiece(WHITE, ROOK)) castling &= ~CASTLE_WQ;
  if (!blackKingHome || board[H8] != makePiece(BLACK, ROOK)) castling &= ~CASTLE_BK;
  if (!blackKingHome || board[A8] != makePiece(BLACK, ROOK)) castling &= ~CASTLE_BQ;
  if (epSquare != NO_SQUARE) {
    const forward = side == WHITE ? 16 : -16; // the way the side to move's pawns go
    const valid =
      (epSquare >> 4) == (side == WHITE ? 5 : 2) && // e.g. "e6" when White is to move
      board[epSquare] == EMPTY &&
      board[epSquare + forward] == EMPTY && // where the enemy pawn came from...
      board[epSquare - forward] == makePiece(side ^ 1, PAWN); // ...and where it is now
    if (!valid) epSquare = NO_SQUARE;
  }

  hply = 0; // no move history yet (section 7)
  key = computeKey();
  return true;
}

/** Finds the legal move with this UCI text ("e2e4", "e7e8q"), or NO_MOVE. */
function parseMove(uci: string): i32 {
  const count = generateMoves(0, false);
  for (let i = 0; i < count; i++) {
    const move = moveList[i];
    if (moveToUci(move) != uci) continue;
    makeMove(move);
    const legal = !leftKingInCheck();
    unmakeMove();
    return legal ? move : NO_MOVE;
  }
  return NO_MOVE;
}

// -----------------------------------------------------------------------------
// 5. Attacks
// -----------------------------------------------------------------------------

/** The piece on `sq`, or EMPTY if the square is empty or off the board. */
function pieceAt(sq: i32): i32 {
  return (sq & 0x88) != 0 ? EMPTY : board[sq];
}

/** Is square `sq` attacked by a piece of colour `by`? */
function isAttacked(sq: i32, by: i32): bool {
  // Pawns capture diagonally forward, so look diagonally *backward* from sq.
  const pawn = makePiece(by, PAWN);
  const back = by == WHITE ? -16 : 16;
  if (pieceAt(sq + back - 1) == pawn || pieceAt(sq + back + 1) == pawn) return true;

  // Knights and kings: a single jump or step away.
  for (let i = 0; i < 8; i++) {
    if (pieceAt(sq + KNIGHT_STEPS[i]) == makePiece(by, KNIGHT)) return true;
    if (pieceAt(sq + KING_STEPS[i]) == makePiece(by, KING)) return true;
  }

  // Sliding pieces: walk outwards in each direction until something blocks.
  for (let d = 0; d < 8; d++) {
    const dir = SLIDE_DIRS[d];
    for (let t = sq + dir; (t & 0x88) == 0; t += dir) {
      const piece = board[t];
      if (piece == EMPTY) continue;
      if (colorOf(piece) == by) {
        const type = typeOf(piece);
        if (type == QUEEN || type == (d < 4 ? BISHOP : ROOK)) return true;
      }
      break; // something is in the way
    }
  }
  return false;
}

/** Is the side to move in check? */
function inCheck(): bool { return isAttacked(kingSquare[side], side ^ 1); }

/** Call right after makeMove(): did that move leave the mover's own king in check? */
function leftKingInCheck(): bool { return isAttacked(kingSquare[side ^ 1], side); }

// -----------------------------------------------------------------------------
// 6. Move generation
// -----------------------------------------------------------------------------
//
// We generate *pseudo-legal* moves: moves that follow the piece rules but may
// leave our own king in check. Instead of working out pins, the search makes
// each move and skips it if leftKingInCheck(). Simple and correct.

const MAX_PLY: i32 = 64; // deepest ply the search can reach (incl. quiescence)
const MAX_MOVES: i32 = 256; // room per ply (no position has more than 218 moves)

// Every ply gets its own slice of MAX_MOVES entries, so a deeper search level
// never overwrites the list a shallower level is still looping over.
const moveList = new StaticArray<i32>(MAX_PLY * MAX_MOVES);
const moveScore = new StaticArray<i32>(MAX_PLY * MAX_MOVES); // ordering scores (section 10)
let genBase: i32 = 0; // where the list being generated starts in moveList
let genCount: i32 = 0; // how many moves it holds so far

function addMove(from: i32, to: i32, promotion: i32): void {
  moveList[genBase + genCount] = encodeMove(from, to, promotion);
  genCount++;
}

/** Adds a pawn move, or the promotions if the pawn reaches the last rank. */
function addPawnMove(from: i32, to: i32, capturesOnly: bool): void {
  if ((to >> 4) != 0 && (to >> 4) != 7) {
    addMove(from, to, 0);
    return;
  }
  addMove(from, to, QUEEN);
  if (capturesOnly) return; // under-promotions are rarely useful: quiescence skips them
  addMove(from, to, ROOK);
  addMove(from, to, BISHOP);
  addMove(from, to, KNIGHT);
}

function generatePawnMoves(from: i32, capturesOnly: bool): void {
  const forward = side == WHITE ? 16 : -16;
  // Pushes: one step onto a free square, two steps from the start rank.
  // A push onto the last rank promotes, which counts as a "tactical" move.
  const one = from + forward;
  if ((one & 0x88) == 0 && board[one] == EMPTY) {
    const promotes = (one >> 4) == (side == WHITE ? 7 : 0);
    if (promotes || !capturesOnly) addPawnMove(from, one, capturesOnly);
    const two = one + forward;
    if (!capturesOnly && (from >> 4) == (side == WHITE ? 1 : 6) && board[two] == EMPTY) addMove(from, two, 0);
  }
  // Captures: one step diagonally forward, onto an enemy piece or en passant.
  for (let to = one - 1; to <= one + 1; to += 2) {
    if ((to & 0x88) != 0) continue;
    const target = board[to];
    if (target != EMPTY && colorOf(target) != side) addPawnMove(from, to, capturesOnly);
    else if (to == epSquare) addMove(from, to, 0);
  }
}

/** Knight and king moves: one step in each of 8 directions. */
function generateStepMoves(from: i32, steps: StaticArray<i32>, capturesOnly: bool): void {
  for (let i = 0; i < 8; i++) {
    const to = from + steps[i];
    if ((to & 0x88) != 0) continue;
    const target = board[to];
    if (target == EMPTY) {
      if (!capturesOnly) addMove(from, to, 0);
    } else if (colorOf(target) != side) {
      addMove(from, to, 0);
    }
  }
}

/** Bishop, rook and queen moves: slide along SLIDE_DIRS[firstDir .. lastDir-1]. */
function generateSlideMoves(from: i32, firstDir: i32, lastDir: i32, capturesOnly: bool): void {
  for (let d = firstDir; d < lastDir; d++) {
    const dir = SLIDE_DIRS[d];
    for (let to = from + dir; (to & 0x88) == 0; to += dir) {
      const target = board[to];
      if (target == EMPTY) {
        if (!capturesOnly) addMove(from, to, 0);
        continue;
      }
      if (colorOf(target) != side) addMove(from, to, 0);
      break; // can't slide through a piece
    }
  }
}

/**
 * Castling: the right must still exist, the squares between king and rook must
 * be empty, and the king may not be in check or cross an attacked square.
 * (Landing on an attacked square is caught by the normal legality test.)
 */
function generateCastling(): void {
  const them = side ^ 1;
  const king = side == WHITE ? E1 : E8; // the rights guarantee the king is there
  const kingSide = side == WHITE ? CASTLE_WK : CASTLE_BK;
  const queenSide = side == WHITE ? CASTLE_WQ : CASTLE_BQ;
  if ((castling & kingSide) != 0 && board[king + 1] == EMPTY && board[king + 2] == EMPTY &&
      !isAttacked(king, them) && !isAttacked(king + 1, them)) {
    addMove(king, king + 2, 0);
  }
  if ((castling & queenSide) != 0 && board[king - 1] == EMPTY && board[king - 2] == EMPTY &&
      board[king - 3] == EMPTY && !isAttacked(king, them) && !isAttacked(king - 1, them)) {
    addMove(king, king - 2, 0);
  }
}

/**
 * Generates the pseudo-legal moves of the side to move into moveList, starting
 * at index ply * MAX_MOVES, and returns how many there are. With capturesOnly
 * (for quiescence search) only captures and queen promotions are generated.
 */
function generateMoves(ply: i32, capturesOnly: bool): i32 {
  genBase = ply * MAX_MOVES;
  genCount = 0;
  for (let from = 0; from < 128; from++) {
    if ((from & 0x88) != 0) continue;
    const piece = board[from];
    if (piece == EMPTY || colorOf(piece) != side) continue;
    const type = typeOf(piece);
    if (type == PAWN) generatePawnMoves(from, capturesOnly);
    else if (type == KNIGHT) generateStepMoves(from, KNIGHT_STEPS, capturesOnly);
    else if (type == KING) generateStepMoves(from, KING_STEPS, capturesOnly);
    else if (type == BISHOP) generateSlideMoves(from, 0, 4, capturesOnly);
    else if (type == ROOK) generateSlideMoves(from, 4, 8, capturesOnly);
    else generateSlideMoves(from, 0, 8, capturesOnly); // queen
  }
  if (!capturesOnly) generateCastling();
  return genCount;
}

// -----------------------------------------------------------------------------
// 7. Making and unmaking moves
// -----------------------------------------------------------------------------
//
// makeMove() pushes everything it can't undo by itself onto these stacks, and
// unmakeMove() pops it again; `hply` is the number of moves on them. They also
// keep the keys of earlier positions, which is how isRepetition() works.

const MAX_HISTORY: i32 = 1024;
const historyMove = new StaticArray<i32>(MAX_HISTORY);
const historyCaptured = new StaticArray<i32>(MAX_HISTORY);
const historyCastling = new StaticArray<i32>(MAX_HISTORY);
const historyEp = new StaticArray<i32>(MAX_HISTORY);
const historyHalfmove = new StaticArray<i32>(MAX_HISTORY);
const historyKey = new StaticArray<u64>(MAX_HISTORY);
let hply: i32 = 0;

// After every move: castling &= castlingMask[from] & castlingMask[to]. A king
// move loses both rights of its side; a move from or to a rook's corner (the
// rook moves, or is captured) loses that rook's right.
const castlingMask = new StaticArray<i32>(128);
function initCastlingMask(): void {
  for (let sq = 0; sq < 128; sq++) castlingMask[sq] = 15;
  castlingMask[E1] = 15 & ~(CASTLE_WK | CASTLE_WQ);
  castlingMask[H1] = 15 & ~CASTLE_WK;
  castlingMask[A1] = 15 & ~CASTLE_WQ;
  castlingMask[E8] = 15 & ~(CASTLE_BK | CASTLE_BQ);
  castlingMask[H8] = 15 & ~CASTLE_BK;
  castlingMask[A8] = 15 & ~CASTLE_BQ;
}

// makeMove() changes the board only through these two, so the key stays right.
function putPiece(sq: i32, piece: i32): void {
  board[sq] = piece;
  key ^= zobristPiece[piece * 128 + sq];
}
function removePiece(sq: i32): void {
  key ^= zobristPiece[board[sq] * 128 + sq];
  board[sq] = EMPTY;
}

function makeMove(move: i32): void {
  const from = moveFrom(move);
  const to = moveTo(move);
  const promotion = movePromotion(move);
  const piece = board[from];
  const type = typeOf(piece);
  const captured = board[to]; // EMPTY for quiet moves and for en passant

  // 1. Remember what unmakeMove() will need.
  historyMove[hply] = move;
  historyCaptured[hply] = captured;
  historyCastling[hply] = castling;
  historyEp[hply] = epSquare;
  historyHalfmove[hply] = halfmoveClock;
  historyKey[hply] = key;
  hply++;

  // 2. Move the piece, capturing whatever stands on the target square.
  if (captured != EMPTY) removePiece(to);
  removePiece(from);
  putPiece(to, promotion != 0 ? makePiece(side, promotion) : piece);

  // 3. Special moves.
  if (type == PAWN && to == epSquare) removePiece(side == WHITE ? to - 16 : to + 16); // en passant
  if (type == KING) {
    kingSquare[side] = to;
    if (to == from + 2) { // O-O: rook from the h-file to the f-file
      removePiece(to + 1);
      putPiece(to - 1, makePiece(side, ROOK));
    } else if (to == from - 2) { // O-O-O: rook from the a-file to the d-file
      removePiece(to - 2);
      putPiece(to + 1, makePiece(side, ROOK));
    }
  }

  // 4. The rest of the state, keeping the key in step.
  key ^= zobristCastling[castling];
  castling &= castlingMask[from] & castlingMask[to];
  key ^= zobristCastling[castling];
  if (epSquare != NO_SQUARE) key ^= zobristEp[epSquare];
  epSquare = NO_SQUARE;
  if (type == PAWN && abs(to - from) == 32) { // double step: remember the square it jumped over
    epSquare = (from + to) >> 1;
    key ^= zobristEp[epSquare];
  }
  halfmoveClock = (type == PAWN || captured != EMPTY) ? 0 : halfmoveClock + 1;
  if (side == BLACK) fullmoveNumber++;
  side ^= 1;
  key ^= zobristSide;
}

function unmakeMove(): void {
  hply--;
  const move = historyMove[hply];
  const from = moveFrom(move);
  const to = moveTo(move);
  side ^= 1; // back to the side that made the move
  if (side == BLACK) fullmoveNumber--;
  castling = historyCastling[hply];
  epSquare = historyEp[hply];
  halfmoveClock = historyHalfmove[hply];
  key = historyKey[hply];

  // Put the piece back (a promoted piece turns back into a pawn).
  const piece = movePromotion(move) != 0 ? makePiece(side, PAWN) : board[to];
  board[from] = piece;
  board[to] = historyCaptured[hply];
  const type = typeOf(piece);
  if (type == PAWN && to == epSquare) board[side == WHITE ? to - 16 : to + 16] = makePiece(side ^ 1, PAWN);
  if (type == KING) {
    kingSquare[side] = from;
    if (to == from + 2) { // rook back to the h-file
      board[to + 1] = board[to - 1];
      board[to - 1] = EMPTY;
    } else if (to == from - 2) { // rook back to the a-file
      board[to - 2] = board[to + 1];
      board[to + 1] = EMPTY;
    }
  }
}

/** Has this position occurred before, since the last capture or pawn move? */
function isRepetition(): bool {
  // Equal positions have the same side to move, so step back two plies at a
  // time; before the last capture or pawn move nothing can repeat.
  for (let i = hply - 2; i >= max(0, hply - halfmoveClock); i -= 2) {
    if (historyKey[i] == key) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// 8. Perft: counts the leaf nodes of the legal move tree
// -----------------------------------------------------------------------------
// The best test for a move generator: compare with the known numbers on
// https://www.chessprogramming.org/Perft_Results. A wrong count means a bug in
// sections 5-7 (usually castling, en passant or promotion).

function perft(depth: i32, ply: i32): f64 {
  if (depth == 0) return 1;
  const count = generateMoves(ply, false);
  let leaves: f64 = 0;
  for (let i = 0; i < count; i++) {
    makeMove(moveList[ply * MAX_MOVES + i]);
    if (!leftKingInCheck()) leaves += perft(depth - 1, ply + 1);
    unmakeMove();
  }
  return leaves;
}

// -----------------------------------------------------------------------------
// 9. Evaluation
// -----------------------------------------------------------------------------
//
// evaluate() scores the position in centipawns from WHITE's point of view
// (+100 = White is a pawn ahead); the search flips the sign for Black. It adds:
//   material      pawn 100, knight 320, bishop 330, rook 500, queen 900
//   piece-square  a bonus or penalty for every piece depending on its square
//                 (knights like the centre, pawns like to advance, ...)
// The values are Tomasz Michniewski's "Simplified Evaluation Function".
// Change them and watch how the engine's style changes!

const PIECE_VALUE: StaticArray<i32> = [100, 320, 330, 500, 900, 0]; // P N B R Q K

// The tables are drawn the way you see the board from White's side: first row
// = 8th rank, last row = 1st rank, files a..h from left to right. Black uses
// them mirrored (see pstIndex): a black knight on c6 scores like a white one on c3.
const PAWN_PST: StaticArray<i32> = [
    0,   0,   0,   0,   0,   0,   0,   0,
   50,  50,  50,  50,  50,  50,  50,  50,
   10,  10,  20,  30,  30,  20,  10,  10,
    5,   5,  10,  25,  25,  10,   5,   5,
    0,   0,   0,  20,  20,   0,   0,   0,
    5,  -5, -10,   0,   0, -10,  -5,   5,
    5,  10,  10, -20, -20,  10,  10,   5,
    0,   0,   0,   0,   0,   0,   0,   0,
];
const KNIGHT_PST: StaticArray<i32> = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP_PST: StaticArray<i32> = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK_PST: StaticArray<i32> = [
    0,   0,   0,   0,   0,   0,   0,   0,
    5,  10,  10,  10,  10,  10,  10,   5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
    0,   0,   0,   5,   5,   0,   0,   0,
];
const QUEEN_PST: StaticArray<i32> = [
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,   5,   5,   5,   0, -10,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   5,   5,   5,   5,   5,   0, -10,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
];
// The king hides behind its pawns in the middlegame...
const KING_MIDDLEGAME_PST: StaticArray<i32> = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
];
// ...but becomes an active piece in the endgame.
const KING_ENDGAME_PST: StaticArray<i32> = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

// Game phase: knights and bishops count 1, rooks 2, queens 4. 24 = all pieces
// still on the board (middlegame), 0 = only kings and pawns left (endgame).
const PHASE_WEIGHT: StaticArray<i32> = [0, 1, 1, 2, 4, 0];

/** Index into a piece-square table for a piece of `color` on 0x88 square `sq`. */
function pstIndex(color: i32, sq: i32): i32 {
  const rank = sq >> 4;
  return (color == WHITE ? 7 - rank : rank) * 8 + (sq & 7);
}

function pstValue(type: i32, index: i32): i32 {
  if (type == PAWN) return PAWN_PST[index];
  if (type == KNIGHT) return KNIGHT_PST[index];
  if (type == BISHOP) return BISHOP_PST[index];
  if (type == ROOK) return ROOK_PST[index];
  return QUEEN_PST[index];
}

// evaluate() leaves its terms here, per side (positive = good for that side),
// for cb_eval_trace's breakdown.
let termMaterialWhite: i32 = 0, termMaterialBlack: i32 = 0;
let termPstWhite: i32 = 0, termPstBlack: i32 = 0;

/** Static evaluation in centipawns from White's point of view. */
function evaluate(): i32 {
  let materialWhite = 0, materialBlack = 0, pstWhite = 0, pstBlack = 0;
  let phase = 0, whiteKingIndex = 0, blackKingIndex = 0;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) != 0 || board[sq] == EMPTY) continue;
    const color = colorOf(board[sq]);
    const type = typeOf(board[sq]);
    const index = pstIndex(color, sq);
    phase += PHASE_WEIGHT[type];
    if (type == KING) {
      if (color == WHITE) whiteKingIndex = index;
      else blackKingIndex = index;
    } else if (color == WHITE) {
      materialWhite += PIECE_VALUE[type];
      pstWhite += pstValue(type, index);
    } else {
      materialBlack += PIECE_VALUE[type];
      pstBlack += pstValue(type, index);
    }
  }
  // Blend the two king tables by game phase (a "tapered" evaluation).
  phase = min(phase, 24); // more than 24 is possible after promotions
  pstWhite += (KING_MIDDLEGAME_PST[whiteKingIndex] * phase + KING_ENDGAME_PST[whiteKingIndex] * (24 - phase)) / 24;
  pstBlack += (KING_MIDDLEGAME_PST[blackKingIndex] * phase + KING_ENDGAME_PST[blackKingIndex] * (24 - phase)) / 24;

  termMaterialWhite = materialWhite;
  termMaterialBlack = materialBlack;
  termPstWhite = pstWhite;
  termPstBlack = pstBlack;
  return materialWhite - materialBlack + (pstWhite - pstBlack);
}

/** evaluate() from the side to move's point of view, as the search needs it. */
function evaluateForSideToMove(): i32 {
  return side == WHITE ? evaluate() : -evaluate();
}

// -----------------------------------------------------------------------------
// 10. Search
// -----------------------------------------------------------------------------
//
// Negamax: the score of a position for the side to move is the best of
// -score(child) over all moves (the opponent's gain is our loss).
// Alpha-beta: alpha = the score we are already sure of, beta = the most the
// opponent will allow. As soon as a move reaches beta, the opponent would avoid
// this position, so the remaining moves can be skipped (a "beta cutoff").
// Searching the best moves first makes cutoffs come early: that is the whole
// point of move ordering.

const INFINITY: i32 = 32001;
const MATE: i32 = 32000; // being checkmated n plies from the root scores -(MATE - n)
const MATE_BOUND: i32 = 31000; // |score| > MATE_BOUND means "mate found"
const MAX_DEPTH: i32 = 32; // iterative deepening never goes deeper than this

let nodeCount: i64 = 0; // positions searched in this cb_go call
let nodeLimit: i64 = 0; // stop after this many nodes (0 = no limit)
let startTime: f64 = 0;
let hardDeadline: f64 = Infinity; // stop searching at this time (a cb_now() value)
let softDeadline: f64 = Infinity; // don't start another iteration after this time
let stopped: bool = false; // a limit was hit: everything unwinds
let selDepth: i32 = 0; // deepest ply reached in the current iteration

// The principal variation (best line), as a "triangular" table: row `ply`
// holds the best line from that ply on, pvLength[ply] moves long.
const pvTable = new StaticArray<i32>(MAX_PLY * MAX_PLY);
const pvLength = new StaticArray<i32>(MAX_PLY);
// The PV of the last finished iteration: the next iteration searches it first.
const previousPv = new StaticArray<i32>(MAX_PLY);
let previousPvLength: i32 = 0;
// Killer moves: two quiet moves per ply that recently caused a beta cutoff.
const killers = new StaticArray<i32>(MAX_PLY * 2);

/** Called at every node: sets `stopped` once the node, time or stop limit is hit. */
function checkLimits(): void {
  if (nodeLimit > 0 && nodeCount >= nodeLimit) stopped = true;
  // Asking the app costs a little, so only do it every 1024 nodes.
  else if ((nodeCount & 1023) == 0 && (cb_should_stop() != 0 || cb_now() >= hardDeadline)) stopped = true;
}

/** Move ordering: give every move a score; higher scores are searched first. */
function scoreMoves(ply: i32, count: i32, pvMove: i32): void {
  const base = ply * MAX_MOVES;
  for (let i = 0; i < count; i++) {
    const move = moveList[base + i];
    const attacker = board[moveFrom(move)];
    const victim = board[moveTo(move)];
    let score = 0;
    if (move == pvMove) score = 2000000; // the previous iteration's best move
    // Captures, MVV-LVA: Most Valuable Victim first, then Least Valuable Attacker.
    else if (victim != EMPTY) score = 1000000 + 10 * PIECE_VALUE[typeOf(victim)] - typeOf(attacker);
    else if (typeOf(attacker) == PAWN && moveTo(move) == epSquare) score = 1000000 + 10 * PIECE_VALUE[PAWN];
    else if (movePromotion(move) == QUEEN) score = 900000;
    else if (move == killers[ply * 2]) score = 800000;
    else if (move == killers[ply * 2 + 1]) score = 700000;
    moveScore[base + i] = score;
  }
}

/** One step of selection sort: swap the best-scored of moves i..count-1 into slot i. */
function pickNextMove(base: i32, i: i32, count: i32): void {
  let best = i;
  for (let j = i + 1; j < count; j++) {
    if (moveScore[base + j] > moveScore[base + best]) best = j;
  }
  const move = moveList[base + i];
  moveList[base + i] = moveList[base + best];
  moveList[base + best] = move;
  const score = moveScore[base + i];
  moveScore[base + i] = moveScore[base + best];
  moveScore[base + best] = score;
}

function storeKiller(ply: i32, move: i32): void {
  if (killers[ply * 2] == move) return;
  killers[ply * 2 + 1] = killers[ply * 2];
  killers[ply * 2] = move;
}

/** The PV at `ply` becomes `move` followed by the PV of the next ply. */
function updatePv(ply: i32, move: i32): void {
  const childLength = pvLength[ply + 1];
  pvTable[ply * MAX_PLY] = move;
  for (let i = 0; i < childLength; i++) pvTable[ply * MAX_PLY + 1 + i] = pvTable[(ply + 1) * MAX_PLY + i];
  pvLength[ply] = childLength + 1;
}

/**
 * Quiescence search: at the end of the main search, keep searching captures
 * until the position is quiet, so we never stop in the middle of an exchange
 * (say right after QxP, before PxQ).
 */
function quiescence(alpha: i32, beta: i32, ply: i32): i32 {
  pvLength[ply] = 0;
  nodeCount++;
  checkLimits();
  if (stopped) return 0;
  selDepth = max(selDepth, ply);

  // "Stand pat": we don't have to capture, so the static score is a lower bound.
  const standPat = evaluateForSideToMove();
  if (ply >= MAX_PLY - 1) return standPat;
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  const base = ply * MAX_MOVES;
  const count = generateMoves(ply, true);
  scoreMoves(ply, count, NO_MOVE);
  for (let i = 0; i < count; i++) {
    pickNextMove(base, i, count);
    const move = moveList[base + i];
    makeMove(move);
    if (leftKingInCheck()) {
      unmakeMove();
      continue;
    }
    const score = -quiescence(-beta, -alpha, ply + 1);
    unmakeMove();
    if (stopped) return 0;
    if (score > alpha) {
      alpha = score;
      updatePv(ply, move);
      if (score >= beta) return beta;
    }
  }
  return alpha;
}

/**
 * Negamax alpha-beta search `depth` plies deep; returns the score for the side
 * to move. `onPv` is true while we are still on the previous iteration's best
 * line, so that line's next move can be tried first.
 */
function negamax(depth: i32, alpha: i32, beta: i32, ply: i32, onPv: bool): i32 {
  pvLength[ply] = 0;
  // Draws: a repeated position, or 50 moves without a capture or pawn move.
  // (Not at the root: there we still have to choose a move.)
  if (ply > 0 && (halfmoveClock >= 100 || isRepetition())) return 0;
  if (ply >= MAX_PLY - 1) return evaluateForSideToMove();

  const checked = inCheck();
  if (checked) depth++; // check extension: don't stop the search while in check
  if (depth <= 0) return quiescence(alpha, beta, ply);

  nodeCount++;
  checkLimits();
  if (stopped) return 0;
  selDepth = max(selDepth, ply);

  const base = ply * MAX_MOVES;
  const count = generateMoves(ply, false);
  const pvMove = onPv && ply < previousPvLength ? previousPv[ply] : NO_MOVE;
  scoreMoves(ply, count, pvMove);

  let legalMoves = 0;
  for (let i = 0; i < count; i++) {
    pickNextMove(base, i, count);
    const move = moveList[base + i];
    const quiet = board[moveTo(move)] == EMPTY && movePromotion(move) == 0;
    makeMove(move);
    if (leftKingInCheck()) {
      unmakeMove();
      continue;
    }
    legalMoves++;
    const score = -negamax(depth - 1, -beta, -alpha, ply + 1, move == pvMove);
    unmakeMove();
    if (stopped) return 0; // this score is unreliable: just unwind
    if (score > alpha) {
      alpha = score;
      updatePv(ply, move);
      if (score >= beta) {
        if (quiet) storeKiller(ply, move);
        return beta; // beta cutoff
      }
    }
  }
  // No legal move: checkmate (the sooner, the worse) or stalemate.
  if (legalMoves == 0) return checked ? -MATE + ply : 0;
  return alpha;
}

/** The first legal move in the current position, or NO_MOVE. */
function firstLegalMove(): i32 {
  const count = generateMoves(0, false);
  for (let i = 0; i < count; i++) {
    makeMove(moveList[i]);
    const legal = !leftKingInCheck();
    unmakeMove();
    if (legal) return moveList[i];
  }
  return NO_MOVE;
}

/** Reports a finished iteration to the app. */
function reportProgress(depth: i32, score: i32): void {
  let mate = 0;
  if (score > MATE_BOUND) mate = (MATE - score + 1) / 2; // we mate in this many moves
  else if (score < -MATE_BOUND) mate = -((MATE + score) / 2); // we get mated
  let pv = "";
  for (let i = 0; i < pvLength[0]; i++) pv += (i > 0 ? " " : "") + moveToUci(pvTable[i]);
  cb_info(depth, selDepth, score, mate, <f64>nodeCount, cb_now() - startTime, writeOutput(pv));
}

/**
 * Iterative deepening: search depth 1, then 2, 3, ... until a limit is hit.
 * Each iteration searches the previous best line first, which makes it much
 * faster, and we always have a move ready when time runs out.
 */
function think(maxDepth: i32): i32 {
  nodeCount = 0;
  stopped = false;
  previousPvLength = 0;
  for (let i = 0; i < MAX_PLY * 2; i++) killers[i] = NO_MOVE;

  // In case we're stopped before even depth 1 is done: any legal move will do.
  let bestMove = firstLegalMove();
  if (bestMove == NO_MOVE) return NO_MOVE; // checkmate or stalemate

  for (let depth = 1; depth <= maxDepth; depth++) {
    selDepth = 0;
    const score = negamax(depth, -INFINITY, INFINITY, 0, true);
    if (stopped) {
      // Cut short. The root moves we finished still count: the first one was
      // the previous best move, so pvTable[0] is that move or a better one.
      if (pvLength[0] > 0) bestMove = pvTable[0];
      break;
    }
    bestMove = pvTable[0];
    previousPvLength = pvLength[0];
    for (let i = 0; i < previousPvLength; i++) previousPv[i] = pvTable[i];
    reportProgress(depth, score);

    // A mate found within this depth can't be improved by searching deeper.
    if (abs(score) > MATE_BOUND && MATE - abs(score) <= depth) break;
    // The next iteration would probably not finish in time.
    if (cb_now() >= softDeadline) break;
  }
  return bestMove;
}

/** How many milliseconds to spend on this move when a clock is running. */
function timeForMove(timeLeft: i32, increment: i32, movesToGo: i32): f64 {
  const left = <f64>max(timeLeft, 0);
  const moves: f64 = movesToGo > 0 ? <f64>movesToGo : 30; // sudden death: plan for 30 more moves
  const budget = left / moves + <f64>max(increment, 0) * 0.75;
  return Math.max(Math.min(budget, left * 0.8), 1); // never risk the whole clock
}

// -----------------------------------------------------------------------------
// 11. The functions Chess Builder calls (Engine ABI v1)
// -----------------------------------------------------------------------------

export function cb_abi_version(): i32 { return 1; }
export function cb_in(): i32 { return <i32>INPUT; }
export function cb_out(): i32 { return <i32>OUTPUT; }

export function cb_init(): void {
  initZobrist();
  initCastlingMask();
  setFen(START_FEN);
}

export function cb_new_game(): void {
  for (let i = 0; i < MAX_PLY * 2; i++) killers[i] = NO_MOVE;
  setFen(START_FEN);
}

/** "startpos [moves e2e4 ...]" or "fen <FEN> [moves ...]". Returns 1 if OK, 0 if not. */
export function cb_position(len: i32): i32 {
  const words = splitWords(readInput(len));
  let fen = START_FEN;
  let i = 1; // the first word after the position itself
  if (words.length > 0 && words[0] == "fen") {
    fen = ""; // the FEN is every word up to "moves" (normally 6 words)
    for (; i < words.length && words[i] != "moves"; i++) fen += (fen.length > 0 ? " " : "") + words[i];
  } else if (words.length == 0 || words[0] != "startpos") {
    log("position: expected 'startpos' or 'fen ...'");
    return 0;
  }
  if (!setFen(fen)) {
    log("position: invalid FEN '" + fen + "'");
    setFen(START_FEN); // keep a sane position
    return 0;
  }
  if (i < words.length && words[i] != "moves") {
    log("position: expected 'moves' after the position, got '" + words[i] + "'");
    return 0;
  }
  for (let j = i + 1; j < words.length; j++) {
    const move = parseMove(words[j]);
    if (move == NO_MOVE) {
      log("position: illegal move '" + words[j] + "'");
      return 0;
    }
    makeMove(move);
    // Positions before a capture or pawn move can never come back, so we can
    // forget them. That also keeps the history stacks small in long games.
    if (halfmoveClock == 0 || hply > MAX_HISTORY - MAX_PLY - 16) hply = 0;
  }
  return 1;
}

/**
 * Searches the current position and writes the best move to the output buffer;
 * returns its length (0 = no legal move). Limits, the first one reached wins:
 *   depth > 0         at most this many plies of iterative deepening
 *   nodes > 0         stop after about this many nodes
 *   movetime > 0      use at most this many milliseconds
 *   wtime, btime >= 0 a clock is running: ms left for each side, increments
 *                     winc/binc, movestogo moves to the next time control (0 = none)
 *   none of these     search until the app says stop (cb_should_stop)
 */
export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  startTime = cb_now();
  hardDeadline = Infinity;
  softDeadline = Infinity;
  const maxDepth = depth > 0 ? min(depth, MAX_DEPTH) : MAX_DEPTH;
  nodeLimit = nodes > 0 ? <i64>Math.min(Math.ceil(nodes), 1e15) : 0;
  if (movetime > 0) {
    hardDeadline = startTime + <f64>movetime;
    softDeadline = hardDeadline; // use all of it: this time can't be saved for later
  }
  if (wtime >= 0 && btime >= 0) {
    const budget = side == WHITE ? timeForMove(wtime, winc, movestogo) : timeForMove(btime, binc, movestogo);
    hardDeadline = Math.min(hardDeadline, startTime + budget);
    // Once half the budget is gone, don't start another iteration: it would
    // usually take longer than all previous ones together.
    softDeadline = Math.min(softDeadline, startTime + budget * 0.5);
  }
  const best = think(maxDepth);
  return best == NO_MOVE ? 0 : writeOutput(moveToUci(best));
}

/** Leaf count of the legal move tree `depth` plies deep (Test panel → Perft). */
export function cb_perft(depth: i32): f64 {
  return depth <= 0 ? 1 : perft(min(depth, MAX_PLY - 1), 0);
}

/** Static evaluation, centipawns, White's point of view (Test panel → Eval). */
export function cb_eval(): i32 { return evaluate(); }

/** Evaluation breakdown: one "label\twhite\tblack" line per term, then the total. */
export function cb_eval_trace(): i32 {
  const total = evaluate();
  let text = "Material\t" + termMaterialWhite.toString() + "\t" + termMaterialBlack.toString() + "\n";
  text += "Piece-square tables\t" + termPstWhite.toString() + "\t" + termPstBlack.toString() + "\n";
  return writeOutput(text + "total\t" + total.toString() + "\t0\n");
}

export function cb_name(): i32 { return writeOutput("Minimal 1.0 (0x88, alpha-beta)"); }
