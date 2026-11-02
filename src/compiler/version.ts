// Compiler version string, available on the main thread without loading the 13 MB compiler.
// Read from the installed package so it always equals what core.ts reports from `asc.version`
// (build caches key on it: a compiler upgrade must invalidate every cached engine build).
import ascPackage from "assemblyscript/package.json";

/** e.g. "assemblyscript 0.28.20" */
export const COMPILER_VERSION: string = `assemblyscript ${ascPackage.version}`;
