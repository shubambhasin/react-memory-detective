import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { memoryDetective } from "../../src/vite/index.js";
import { defineConfig } from "vite";

// fileURLToPath, not `.pathname`: the latter percent-encodes spaces in the path.
const src = (file: string) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));

export default defineConfig({
  // The plugin runs before @vitejs/plugin-react so it sees JSX, and it is the
  // reason the uninstrumented components below get attributed at all.
  plugins: [memoryDetective({ importSource: src("index.ts") }), react()],
  resolve: {
    alias: [
      { find: /^react-memory-detective\/overlay$/, replacement: src("overlay/index.ts") },
      { find: /^react-memory-detective\/core$/, replacement: src("core/index.ts") },
      { find: /^react-memory-detective$/, replacement: src("index.ts") },
    ],
  },
});
