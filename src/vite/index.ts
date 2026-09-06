import babelPlugin from "../babel/index.js";
import type { MemoryDetectivePluginOptions } from "../babel/index.js";

export interface VitePluginOptions extends MemoryDetectivePluginOptions {
  filter?: (id: string) => boolean;
}

interface MinimalVitePlugin {
  name: string;
  enforce?: "pre" | "post";
  apply?: "serve" | "build";
  transform?: (code: string, id: string) => Promise<{ code: string; map: unknown } | null>;
}

const DEFAULT_FILTER = (id: string): boolean =>
  /\.[jt]sx$/.test(id.split("?")[0] ?? id) && !id.includes("node_modules");

/** Dev-only Vite wrapper around the Babel plugin, so both bundlers behave identically. */
export function memoryDetective(options: VitePluginOptions = {}): MinimalVitePlugin {
  const filter = options.filter ?? DEFAULT_FILTER;
  let transformAsync: typeof import("@babel/core").transformAsync | undefined;

  return {
    name: "react-memory-detective",
    enforce: "pre",
    apply: "serve",
    async transform(code: string, id: string) {
      if (!filter(id) || !code.includes("useEffect")) return null;
      if (!transformAsync) {
        // Babel 8 is ESM with named exports; Babel 7 is CJS and may arrive
        // under `default`. Support both rather than assuming the user's major.
        const mod = (await import("@babel/core")) as unknown as {
          transformAsync?: typeof import("@babel/core").transformAsync;
          default?: { transformAsync?: typeof import("@babel/core").transformAsync };
        };
        transformAsync = mod.transformAsync ?? mod.default?.transformAsync;
        if (!transformAsync) throw new Error("[react-memory-detective] @babel/core is required for automatic attribution.");
      }
      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: ["jsx", "typescript"] },
        // The plugin's public signature is narrowed to keep @babel/core out of
        // consumers' type-checking; Babel accepts it unchanged at runtime.
        plugins: [[babelPlugin as unknown as import("@babel/core").PluginTarget, { enabled: true, ...options }]],
      });
      return result?.code ? { code: result.code, map: result.map } : null;
    },
  };
}

export default memoryDetective;
export type { MemoryDetectivePluginOptions };
