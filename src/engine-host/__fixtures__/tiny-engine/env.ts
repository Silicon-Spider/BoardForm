// @ts-nocheck — AssemblyScript source (test fixture). The app's TypeScript program must not check it.
//
// Host imports of the tiny test engine. AssemblyScript imports a `declare function` from the module
// named after its file, so declaring these in "env.ts" imports them from "env" (no decorators needed).

export declare function cb_now(): f64;
export declare function cb_should_stop(): i32;
export declare function cb_info(depth: i32, seldepth: i32, score: i32, mate: i32, nodes: f64, timeMs: f64, pvLen: i32): void;
export declare function cb_log(len: i32): void;

/** Not provided by the host: exercises the "stub unknown imports" rule. */
export declare function mystery_import(x: i32): i32;
