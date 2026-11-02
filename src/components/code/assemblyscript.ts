// AssemblyScript vocabulary for highlighting and autocompletion: value types, a few builtins,
// decorators, keywords and code snippets. Plain data (headless).

export interface VocabularyItem {
  name: string;
  /** Shown in the completion info panel. */
  info: string;
  /** Builtins: call signature. */
  signature?: string;
}

/** Value and reference types (also highlighted as types where used like functions: `i32(x)`). */
export const AS_TYPES: readonly VocabularyItem[] = [
  { name: "i32", info: "32-bit signed integer: the engine's default for squares, scores and counters." },
  { name: "u64", info: "64-bit unsigned integer: one bit per square, used for bitboards." },
  { name: "bool", info: "true / false (stored as 0 / 1)." },
  { name: "i8", info: "8-bit signed integer (-128 … 127)." },
  { name: "u8", info: "8-bit unsigned integer (0 … 255)." },
  { name: "i16", info: "16-bit signed integer (-32768 … 32767)." },
  { name: "u16", info: "16-bit unsigned integer (0 … 65535). Moves fit in 16 bits." },
  { name: "u32", info: "32-bit unsigned integer." },
  { name: "i64", info: "64-bit signed integer." },
  { name: "isize", info: "Pointer-sized signed integer (32 bits in wasm32)." },
  { name: "usize", info: "Pointer-sized unsigned integer (32 bits in wasm32): memory addresses and sizes." },
  { name: "f32", info: "32-bit floating point number." },
  { name: "f64", info: "64-bit floating point number (a JavaScript number)." },
  { name: "v128", info: "128-bit SIMD vector, e.g. eight i16 lanes (see nnue.ts)." },
  { name: "string", info: "UTF-16 string. Creating strings allocates memory: keep them out of evaluate()." },
  { name: "void", info: "No value (return type of functions that return nothing)." },
  { name: "StaticArray", info: "Fixed-length array, e.g. new StaticArray<i32>(64). The fastest array type: use it for tables." },
  { name: "Array", info: "Resizable array. Allocates memory; prefer StaticArray in hot code." },
  { name: "ArrayBuffer", info: "A block of raw bytes." },
  { name: "Uint8Array", info: "Typed array view of u8 values." },
  { name: "Int16Array", info: "Typed array view of i16 values." },
  { name: "Int32Array", info: "Typed array view of i32 values." },
  { name: "Uint32Array", info: "Typed array view of u32 values." },
  { name: "Uint64Array", info: "Typed array view of u64 values." },
  { name: "Float32Array", info: "Typed array view of f32 values." },
  { name: "Float64Array", info: "Typed array view of f64 values." },
  { name: "Map", info: "Hash map, e.g. new Map<u64, i32>(). Allocates memory." },
  { name: "Set", info: "Hash set, e.g. new Set<u64>(). Allocates memory." },
  { name: "String", info: "The string class (String.fromCharCode, String.UTF8, ...)." },
  { name: "Math", info: "Math functions on f64 (Math.log, Math.sqrt, ...). Mathf is the f32 version." },
];

export const AS_TYPE_NAMES: ReadonlySet<string> = new Set(AS_TYPES.filter((t) => /^[a-z]/.test(t.name) || t.name === "StaticArray").map((t) => t.name));

/** Built-in functions every AssemblyScript file can call without importing. */
export const AS_BUILTINS: readonly VocabularyItem[] = [
  { name: "unchecked", signature: "unchecked<T>(expr: T): T", info: "Array access without the bounds check: faster, but you must be sure the index is valid." },
  { name: "popcnt", signature: "popcnt<T>(value: T): T", info: "Number of set bits (bitboard.ts wraps it as popcount)." },
  { name: "ctz", signature: "ctz<T>(value: T): T", info: "Number of trailing zero bits: the index of the lowest set bit (64 for 0 as u64)." },
  { name: "clz", signature: "clz<T>(value: T): T", info: "Number of leading zero bits." },
  { name: "bswap", signature: "bswap<T>(value: T): T", info: "Reverses the byte order. On a bitboard this mirrors the board vertically." },
  { name: "rotl", signature: "rotl<T>(value: T, shift: T): T", info: "Rotates the bits left." },
  { name: "rotr", signature: "rotr<T>(value: T, shift: T): T", info: "Rotates the bits right." },
  { name: "abs", signature: "abs<T>(value: T): T", info: "Absolute value." },
  { name: "min", signature: "min<T>(a: T, b: T): T", info: "The smaller of two values." },
  { name: "max", signature: "max<T>(a: T, b: T): T", info: "The larger of two values." },
  { name: "select", signature: "select<T>(ifTrue: T, ifFalse: T, condition: bool): T", info: "Branch-free choice between two values." },
  { name: "assert", signature: "assert<T>(value: T, message?: string): T", info: "Aborts (the host reports the message) when value is false or zero." },
  { name: "load", signature: "load<T>(ptr: usize, offset?: usize): T", info: "Reads a value of type T from linear memory." },
  { name: "store", signature: "store<T>(ptr: usize, value: T, offset?: usize): void", info: "Writes a value of type T to linear memory." },
  { name: "sizeof", signature: "sizeof<T>(): usize", info: "Size of type T in bytes." },
  { name: "changetype", signature: "changetype<T>(value: any): T", info: "Reinterprets a reference or pointer as another type (unsafe)." },
];

export const AS_BUILTIN_NAMES: ReadonlySet<string> = new Set(AS_BUILTINS.map((b) => b.name));

/** Decorators, completed after "@". */
export const AS_DECORATORS: readonly VocabularyItem[] = [
  { name: "inline", info: "Always inline this function into its callers. The template uses it for tiny helpers in hot code." },
  { name: "external", info: 'Imports a host function: @external("env", "cb_log") declare function log(len: i32): void;' },
  { name: "lazy", info: "Initialises a global only when it is first used." },
  { name: "global", info: "Makes a declaration visible in every file without an import." },
  { name: "unsafe", info: "Marks code that uses unsafe operations (only checked with --noUnsafe)." },
  { name: "final", info: "The class cannot be subclassed." },
  { name: "unmanaged", info: "Instances are not garbage collected (memory managed by hand)." },
  { name: "operator", info: 'Overloads an operator on a class: @operator("+") add(other: T): T' },
];

/** Keywords offered by autocompletion (the subset of TypeScript that AssemblyScript supports). */
export const AS_KEYWORDS: readonly string[] = [
  "abstract", "as", "break", "case", "class", "const", "continue", "declare", "default", "do", "else", "enum",
  "export", "extends", "false", "for", "from", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "namespace", "new", "null", "private", "protected", "public", "readonly", "return",
  "static", "super", "switch", "this", "throw", "true", "type", "typeof", "var", "while",
];

export interface SnippetTemplate {
  label: string;
  detail: string;
  /** @codemirror/autocomplete snippet syntax: ${name} fields, \t = one indent unit. */
  template: string;
  info: string;
}

export const AS_SNIPPETS: readonly SnippetTemplate[] = [
  { label: "for", detail: "counting loop", template: "for (let ${i} = 0; ${i} < ${count}; ${i}++) {\n\t${}\n}", info: "Loop with an i32 counter." },
  {
    label: "while",
    detail: "loop over a bitboard",
    template: "let ${bb} = ${pos.pieces(WHITE, PAWN)};\nwhile (${bb} != 0) {\n\tconst sq = lsb(${bb});\n\t${bb} &= ${bb} - 1;\n\t${}\n}",
    info: "Visits every square of a bitboard: lsb() gives the lowest square, b &= b - 1 removes it.",
  },
  { label: "while", detail: "loop", template: "while (${condition}) {\n\t${}\n}", info: "Loop while a condition holds." },
  { label: "if", detail: "block", template: "if (${condition}) {\n\t${}\n}", info: "Conditional block." },
  { label: "if", detail: "/ else block", template: "if (${condition}) {\n\t${}\n} else {\n\t${}\n}", info: "Conditional with an else branch." },
  { label: "function", detail: "definition", template: "function ${name}(${pos}: Position): i32 {\n\t${}\n\treturn 0;\n}", info: "A helper function taking the position." },
  {
    label: "traceTerm",
    detail: "report an eval term",
    template: 'if (tracing) traceTerm("${label}", ${white}, ${black});',
    info: "Adds a line to the evaluation breakdown (Test panel). white / black: that term's centipawns for each side.",
  },
  { label: "import", detail: "named", template: 'import { ${names} } from "./${module}";', info: "Imports names from another file of the engine." },
];
