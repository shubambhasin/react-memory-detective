import babelPlugin from "../babel/index.js";
import type { MemoryDetectivePluginOptions } from "../babel/index.js";

export interface VitePluginOptions extends MemoryDetectivePluginOptions {
  filter?: (id: string) => boolean;
}

/*
 * Vite's own Plugin type, not a hand-rolled structural one.
 *
 * A structural stand-in was tried first, to avoid a type dependency. It failed
 * in the first real application the plugin was added to: Vite configs are
 * TypeScript and are often type-checked, and no approximation of `transform`
 * satisfies Rollup's `ObjectHook` — the returned map has to be a real
 * `SourceMapInput`. Anyone importing this entry has Vite installed by
 * definition, so importing its type is honest and always matches their major.
 * The import is type-only and disappears at build time.
 */
import type { Plugin } from "vite";

const DEFAULT_FILTER = (id: string): boolean =>
  /\.[jt]sx$/.test(id.split("?")[0] ?? id) && !id.includes("node_modules");

/** Dev-only Vite wrapper around the Babel plugin, so both bundlers behave identically. */
export function memoryDetective(options: VitePluginOptions = {}): Plugin {
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
      if (!result?.code) return null;
      /*
       * Babel allows `file: null` in a source map and Rollup does not, so the
       * map is normalised rather than cast. This was a genuine mismatch, not a
       * typing formality: handing Vite a map it does not accept is a broken
       * source map in the one place it matters, a dev server.
       */
      return { code: result.code, map: result.map ? normaliseMap(result.map) : null };
    },
  };
}

/**
 * Babel and Rollup disagree in four small ways — a nullable `file`, readonly
 * arrays, and nullable entries in both `sources` and `sourcesContent` — so the
 * map is rebuilt rather than passed through. Nothing here is decorative: an unusable source map in a dev
 * server is the difference between a stack trace and a guess.
 */
function normaliseMap(map: NonNullable<Awaited<ReturnType<typeof import("@babel/core").transformAsync>>>["map"]): {
  version: number;
  file?: string;
  mappings: string;
  names: string[];
  sources: string[];
  sourcesContent?: string[];
  sourceRoot?: string;
} | null {
  if (!map) return null;
  return {
    version: 3,
    file: map.file ?? undefined,
    mappings: map.mappings,
    names: [...map.names],
    sources: map.sources.map((source) => source ?? ""),
    sourcesContent: map.sourcesContent ? map.sourcesContent.map((content) => content ?? "") : undefined,
    sourceRoot: map.sourceRoot,
  };
}

export default memoryDetective;
export type { MemoryDetectivePluginOptions };
