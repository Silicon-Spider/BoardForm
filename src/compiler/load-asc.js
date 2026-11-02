// Loads the AssemblyScript compiler (assemblyscript/asc, ~13 MB including Binaryen).
//
// This is a plain .js file ON PURPOSE (typed by load-asc.d.ts): if any .ts file imported
// "assemblyscript/asc", TypeScript would load asc's declaration files, whose top-level AssemblyScript
// globals (i32, Array.prototype.at(): T, ...) silently change type checking for the whole app.
// Vite still bundles this import normally (as a lazy chunk of whichever worker uses it).

/** @returns {Promise<import("./asc-types").AscModule>} */
export async function loadAsc() {
  const mod = await import("assemblyscript/asc");
  return mod.default ?? mod;
}
