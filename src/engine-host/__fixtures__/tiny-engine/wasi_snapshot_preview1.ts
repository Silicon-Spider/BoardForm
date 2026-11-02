// @ts-nocheck — AssemblyScript source (test fixture). The app's TypeScript program must not check it.
//
// A few WASI preview1 functions (module "wasi_snapshot_preview1", named after this file) so the
// tests can exercise the host's WASI shim the way C/Rust engines use it.

export declare function fd_write(fd: i32, iovs: usize, iovsLen: i32, nwritten: usize): i32;
export declare function clock_time_get(id: i32, precision: i64, time: usize): i32;
export declare function random_get(buf: usize, len: i32): i32;
export declare function fd_prestat_get(fd: i32, buf: usize): i32;
/** Not implemented by the shim: must return ENOSYS (52). */
export declare function sock_accept(fd: i32, flags: i32, resultFd: usize): i32;
export declare function proc_exit(code: i32): void;
