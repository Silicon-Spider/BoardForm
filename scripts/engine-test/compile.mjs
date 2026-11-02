// Compiles an AssemblyScript engine directory with the same flags the app uses
// (see docs/ENGINE_TEMPLATE.md):
//
//   asc main.ts --outFile engine.wasm -O3 --runtime incremental --enable simd --noColors
//
// Uses the programmatic asc API with an in-memory output file, so nothing is written to disk.

import asc from "assemblyscript/asc";
import fs from "node:fs";
import path from "node:path";

export const APP_FLAGS = ["-O3", "--runtime", "incremental", "--enable", "simd", "--noColors"];

/**
 * @param {string} dir    engine source directory (absolute or relative to cwd)
 * @param {string} entry  entry file inside `dir`, e.g. "main.ts"
 * @param {Record<string, string>} [overrides]  file name inside `dir` -> path of the file to
 *        compile instead (e.g. { "eval.ts": "engine/variants/eval-nnue.ts" })
 * @returns {Promise<{ wasm: Uint8Array, log: string, ms: number }>}
 */
export async function compileEngine(dir, entry, overrides = {}) {
  const root = path.resolve(dir);
  const replaced = new Map(Object.entries(overrides).map(([name, file]) => [path.resolve(root, name), path.resolve(file)]));
  const outputs = {};
  const t0 = performance.now();
  const { error, stdout, stderr } = await asc.main([entry, "--outFile", "engine.wasm", ...APP_FLAGS], {
    readFile(name, baseDir) {
      const file = path.resolve(root, baseDir, name);
      try {
        return fs.readFileSync(replaced.get(file) ?? file, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(name, contents) {
      outputs[name] = contents;
    },
    listFiles(dirname, baseDir) {
      try {
        return fs.readdirSync(path.resolve(root, baseDir, dirname)).filter((f) => f.endsWith(".ts"));
      } catch {
        return null;
      }
    },
  });
  const ms = performance.now() - t0;
  const log = (stdout.toString() + stderr.toString()).trim();
  if (error || !outputs["engine.wasm"]) {
    const err = new Error(`compilation failed: ${error ? error.message : "no output"}\n${log}`);
    err.log = log;
    throw err;
  }
  return { wasm: outputs["engine.wasm"], log, ms };
}
