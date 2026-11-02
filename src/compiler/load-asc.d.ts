// Types for load-asc.js (see the comment there for why this is not a .ts file).
import type { AscModule } from "./asc-types";

/** Dynamically imports `assemblyscript/asc`. */
export function loadAsc(): Promise<AscModule>;
