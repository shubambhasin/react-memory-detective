import type { SourceLocation } from "../core/types.js";

/** Frames belonging to this package, and to the engine itself. */
const IGNORED = /react-memory-detective|node_modules[/\\](react|react-dom)|<anonymous>/;

/**
 * Where a resource was created, from a captured stack.
 *
 * No build step required, which is why it is worth having — but capturing a
 * stack costs real time, so it is opt-in and never on the hot path by default.
 * Frames point at compiled output unless the consumer applies source maps.
 */
export function captureSource(): SourceLocation | undefined {
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;

    for (const line of stack.split("\n").slice(2)) {
      if (IGNORED.test(line)) continue;
      // `at fn (file:line:col)` or `at file:line:col`
      const match = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
      if (!match) continue;
      const [, file, lineNo, columnNo] = match;
      if (!file || file.startsWith("node:")) continue;
      return { file: shorten(file), line: Number(lineNo), column: Number(columnNo) };
    }
  } catch {
    /* a diagnostic must never throw into the application */
  }
  return undefined;
}

/**
 * `http://localhost:3000/src/ChatPanel.tsx?t=1712` → `src/ChatPanel.tsx`
 *
 * Vite serves files outside the project root under `/@fs/<absolute path>`,
 * which is normal in a monorepo and produced a line of unreadable noise in the
 * first real application this was pointed at. The `?t=` cache-busting query and
 * `?import` suffix have to go too, or two references to one file look like two
 * different files.
 */
export function shorten(file: string): string {
  let path = file;
  try {
    path = new URL(file).pathname;
  } catch {
    /* already a bare path */
  }
  path = path.replace(/[?#].*$/, "");
  // `/@fs/Users/me/repo/packages/ui/Button.tsx` → `/Users/me/repo/packages/ui/Button.tsx`
  const fs = path.match(/^\/?@fs(\/.*)$/);
  if (fs?.[1]) return fs[1];
  return path.replace(/^\//, "");
}

export function formatSource(source: SourceLocation | undefined): string | undefined {
  if (!source) return undefined;
  return source.line ? `${source.file}:${source.line}:${source.column ?? 0}` : source.file;
}
