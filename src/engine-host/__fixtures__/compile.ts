// Test helper (Node only): compiles fixture engines with the real AssemblyScript compiler.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWithAsc } from "@/compiler/core";
import { loadAsc } from "@/compiler/load-asc.js";
import type { CompileRequest, CompileResult } from "@/types";

/** All .ts files of a fixture directory, keyed by file name. */
export function fixtureFiles(name: string): Record<string, string> {
  const root = fileURLToPath(new URL(`./${name}/`, import.meta.url));
  const files: Record<string, string> = {};
  for (const file of readdirSync(root)) if (file.endsWith(".ts")) files[file] = readFileSync(join(root, file), "utf8");
  return files;
}

export async function compileSources(files: Record<string, string>, entry = "main.ts", extra: Partial<CompileRequest> = {}): Promise<CompileResult> {
  return compileWithAsc(await loadAsc(), { files, entry, ...extra });
}

const cache = new Map<string, Promise<Uint8Array>>();

/** Compiled bytes of a fixture engine (compiled once per test file). Throws on compile errors. */
export function compileFixture(name = "tiny-engine"): Promise<Uint8Array> {
  let p = cache.get(name);
  if (!p) {
    p = compileSources(fixtureFiles(name)).then((r) => {
      if (!r.ok || !r.wasm) throw new Error(`fixture ${name} failed to compile:\n${r.log}`);
      return r.wasm;
    });
    cache.set(name, p);
  }
  return p;
}

/** Compiles a small inline AssemblyScript program (e.g. a deliberately broken engine). */
export async function compileInline(mainTs: string): Promise<Uint8Array> {
  const r = await compileSources({ "main.ts": mainTs });
  if (!r.ok || !r.wasm) throw new Error(`inline module failed to compile:\n${r.log}`);
  return r.wasm;
}

/**
 * A minimal ABI-conforming engine without optional exports (always plays `move`).
 * `abiVersion` lets tests produce a wrong-version module.
 */
export function minimalEngineSource(opts: { move?: string; abiVersion?: number; extra?: string } = {}): string {
  const move = opts.move ?? "e2e4";
  return `
const IN: usize = memory.data(65536);
const OUT: usize = memory.data(65536);
export function cb_abi_version(): i32 { return ${opts.abiVersion ?? 1}; }
export function cb_init(): void {}
export function cb_in(): usize { return IN; }
export function cb_out(): usize { return OUT; }
export function cb_new_game(): void {}
export function cb_position(len: i32): i32 { return 1; }
export function cb_go(depth: i32, nodes: f64, movetime: i32, wtime: i32, btime: i32, winc: i32, binc: i32, movestogo: i32): i32 {
  const m = "${move}";
  for (let i = 0; i < m.length; i++) store<u8>(OUT + <usize>i, <u8>m.charCodeAt(i));
  return m.length;
}
${opts.extra ?? ""}
`;
}
