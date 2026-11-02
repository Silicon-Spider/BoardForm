// Minimal WASI preview1 shim so engines built with wasi-sdk (C/C++), Rust wasm32-wasi(p1), Zig,
// TinyGo... can run: stdout/stderr go to the engine log, clocks and random numbers work, there
// are no arguments, environment variables, files or preopened directories.
import type { WasmMemoryAccess } from "./memory";

export const WASI_MODULES: ReadonlySet<string> = new Set(["wasi_snapshot_preview1", "wasi_unstable"]);

export const WASI_ERRNO = {
  SUCCESS: 0,
  BADF: 8,
  INVAL: 28,
  NOSYS: 52,
  SPIPE: 70,
} as const;

/** Thrown by proc_exit: ends the current engine call. */
export class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`Engine called proc_exit(${code})`);
    this.name = "WasiExit";
  }
}

type WasiFunction = (...args: never[]) => number | void;

export interface WasiShim {
  functions: Record<string, WasiFunction>;
  /** Emits any partial (unterminated) output lines. */
  flush(): void;
}

const MAX_RANDOM_CHUNK = 65536; // crypto.getRandomValues limit

const num = (v: number | bigint): number => (typeof v === "bigint" ? Number(v) : v);

/**
 * @param emit receives complete output lines (fd 1 = stdout, 2 = stderr).
 */
export function createWasiShim(mem: WasmMemoryAccess, emit: (fd: number, line: string) => void): WasiShim {
  const decoders = new Map<number, TextDecoder>();
  const pending = new Map<number, string>();

  const output = (fd: number, bytes: Uint8Array) => {
    let decoder = decoders.get(fd);
    if (!decoder) {
      decoder = new TextDecoder("utf-8");
      decoders.set(fd, decoder);
    }
    const text = (pending.get(fd) ?? "") + decoder.decode(bytes, { stream: true });
    const lines = text.split("\n");
    pending.set(fd, lines.pop() ?? "");
    for (const line of lines) emit(fd, line.replace(/\r$/, ""));
  };

  const setU32 = (ptr: number, value: number) => mem.dataView().setUint32(num(ptr), value, true);
  const setU64 = (ptr: number, value: bigint) => mem.dataView().setBigUint64(num(ptr), value, true);
  const isStdio = (fd: number) => fd >= 0 && fd <= 2;

  const functions: Record<string, WasiFunction> = {
    args_get: () => WASI_ERRNO.SUCCESS,
    args_sizes_get: (argc: number, bufSize: number) => {
      setU32(argc, 0);
      setU32(bufSize, 0);
      return WASI_ERRNO.SUCCESS;
    },
    environ_get: () => WASI_ERRNO.SUCCESS,
    environ_sizes_get: (count: number, bufSize: number) => {
      setU32(count, 0);
      setU32(bufSize, 0);
      return WASI_ERRNO.SUCCESS;
    },
    clock_res_get: (_id: number, resPtr: number) => {
      setU64(resPtr, 1000n); // 1 µs
      return WASI_ERRNO.SUCCESS;
    },
    clock_time_get: (id: number, _precision: bigint, timePtr: number) => {
      let ns: bigint;
      if (id === 0) ns = BigInt(Date.now()) * 1_000_000n; // realtime
      else if (id >= 1 && id <= 3) ns = BigInt(Math.round(performance.now() * 1e6)); // monotonic / cpu time
      else return WASI_ERRNO.INVAL;
      setU64(timePtr, ns);
      return WASI_ERRNO.SUCCESS;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
      if (fd !== 1 && fd !== 2) return WASI_ERRNO.BADF;
      const view = mem.dataView();
      let total = 0;
      for (let i = 0; i < num(iovsLen); i++) {
        const base = num(iovs) + i * 8;
        const ptr = view.getUint32(base, true);
        const len = view.getUint32(base + 4, true);
        output(fd, mem.read(ptr, len));
        total += len;
      }
      setU32(nwritten, total);
      return WASI_ERRNO.SUCCESS;
    },
    fd_read: (fd: number, _iovs: number, _iovsLen: number, nread: number) => {
      if (fd !== 0) return WASI_ERRNO.BADF;
      setU32(nread, 0); // stdin is always at end-of-file
      return WASI_ERRNO.SUCCESS;
    },
    fd_close: (fd: number) => (isStdio(fd) ? WASI_ERRNO.SUCCESS : WASI_ERRNO.BADF),
    fd_sync: (fd: number) => (isStdio(fd) ? WASI_ERRNO.SUCCESS : WASI_ERRNO.BADF),
    fd_seek: (fd: number) => (isStdio(fd) ? WASI_ERRNO.SPIPE : WASI_ERRNO.BADF),
    fd_fdstat_get: (fd: number, buf: number) => {
      if (!isStdio(fd)) return WASI_ERRNO.BADF;
      const view = mem.dataView();
      const p = num(buf);
      view.setUint8(p, 2); // filetype: character device
      view.setUint16(p + 2, 0, true); // fdflags
      view.setBigUint64(p + 8, 0xffffffffffffffffn, true); // rights base
      view.setBigUint64(p + 16, 0n, true); // rights inheriting
      return WASI_ERRNO.SUCCESS;
    },
    fd_fdstat_set_flags: (fd: number) => (isStdio(fd) ? WASI_ERRNO.SUCCESS : WASI_ERRNO.BADF),
    // No preopened directories: libc probes fd 3, 4, ... until it gets EBADF.
    fd_prestat_get: () => WASI_ERRNO.BADF,
    fd_prestat_dir_name: () => WASI_ERRNO.BADF,
    proc_exit: (code: number) => {
      throw new WasiExit(num(code));
    },
    random_get: (buf: number, len: number) => {
      const total = num(len);
      for (let off = 0; off < total; off += MAX_RANDOM_CHUNK) {
        const chunk = new Uint8Array(Math.min(MAX_RANDOM_CHUNK, total - off));
        crypto.getRandomValues(chunk);
        if (!mem.write(num(buf) + off, chunk)) return WASI_ERRNO.INVAL;
      }
      return WASI_ERRNO.SUCCESS;
    },
    sched_yield: () => WASI_ERRNO.SUCCESS,
  };

  return {
    functions,
    flush() {
      for (const [fd, text] of pending) {
        if (text) emit(fd, text);
        pending.set(fd, "");
      }
    },
  };
}
