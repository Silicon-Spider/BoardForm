import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The AssemblyScript compiler (asc.js) and Binaryen import Node built-ins (fs, path, module, url)
// only inside "running in Node" branches. In the browser build these become an empty module —
// what Vite would do anyway, minus a warning for each one. Applies to the compiler worker bundle.
const COMPILER_NODE_BUILTINS = new Set(["fs", "url", "module", "path", "node:module"]);
const EMPTY_NODE_BUILTIN = "\0node-builtin-stub";
function compilerNodeBuiltins(): Plugin {
  return {
    name: "boardform:compiler-node-builtins",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      const fromCompiler = importer !== undefined && /[\\/]node_modules[\\/](assemblyscript|binaryen)[\\/]/.test(importer);
      return fromCompiler && COMPILER_NODE_BUILTINS.has(source) ? EMPTY_NODE_BUILTIN : null;
    },
    load(id) {
      return id === EMPTY_NODE_BUILTIN ? "export default {};" : null;
    },
  };
}

// Cross-origin isolation enables SharedArrayBuffer (used to stop engine searches instantly
// and to share training buffers between workers).
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// CB_NO_WATCH=1 turns off file watching (no reloads while other files change), which keeps
// long end-to-end runs stable. The e2e config sets it.
const noWatch = Boolean(process.env.CB_NO_WATCH);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { headers: isolationHeaders, port: 5173, ...(noWatch ? { watch: null } : {}) },
  preview: { headers: isolationHeaders, port: 4173 },
  worker: { format: "es", plugins: () => [compilerNodeBuiltins()] },
  build: { target: "es2022", chunkSizeWarningLimit: 20000 },
  optimizeDeps: {
    exclude: ["assemblyscript", "binaryen"],
    // Pre-bundled at start-up so the dev server never reloads the page halfway through a session
    // because it discovered a dependency late.
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "zustand",
      "idb",
      "chess.js",
      "marked",
      "blockly",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lang-javascript",
      "@codemirror/autocomplete",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/theme-one-dark",
    ],
  },
});
