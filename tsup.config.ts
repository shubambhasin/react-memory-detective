import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", core: "src/core/index.ts", overlay: "src/overlay/index.ts", babel: "src/babel/index.ts", vite: "src/vite/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: true,
  sourcemap: true,
  target: "es2021",
  external: ["react", "react-dom", "@babel/core"],
});
