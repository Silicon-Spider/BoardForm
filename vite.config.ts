import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

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
  worker: { format: "es" },
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
