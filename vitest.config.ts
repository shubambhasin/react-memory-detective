import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
});
