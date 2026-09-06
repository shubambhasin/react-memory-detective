#!/usr/bin/env node
/** Bundle-size budget gate (§40). Zero dependencies — node:zlib does the work. */
import { gzipSync } from "node:zlib";
import { transformSync } from "esbuild";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const baselinePath = join(root, ".size-baseline.json");

/**
 * Budgets in bytes, gzipped, measured minified (see docs/BUNDLE-SIZE.md for how
 * these were set and where they differ from the original targets).
 *
 * Each entry is measured *with* the shared chunks it imports, so the per-entry
 * numbers overlap and do not sum. `total` is deduplicated, and is the figure
 * that answers "what does everything cost".
 *
 *   core    collection + comparison + the diagnostic engine
 *   index   core + React integration + console reporter
 *   overlay the dev inspector, lazily imported
 *   total   everything, i.e. the full developer experience
 */
const BUDGETS = {
  core: 6 * 1024,
  index: 12 * 1024,
  overlay: 30 * 1024,
  total: 40 * 1024,
};

/**
 * Build-time only: these run in the bundler, never in the browser, so they are
 * reported but not budgeted. What *is* enforced is that they never leak into a
 * runtime entry — see the contamination check below.
 */
const BUILD_TIME_ENTRIES = [];

function bytesFor(entry) {
  // An entry's real cost is its own chunk plus the shared chunks it imports.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(join(dist, file))) return;
    seen.add(file);
    const source = readFileSync(join(dist, file), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*['"]\.\/([^'"]+\.js)['"]/g)) walk(match[1]);
  };
  walk(`${entry}.js`);
  const raw = minified([...seen]);
  return { gzip: gzipSync(raw, { level: 9 }).length, min: raw.length, files: [...seen] };
}

/**
 * dist ships unminified so stack traces stay readable. The budget is about what
 * a consumer's bundler actually emits, so measure the minified form.
 */
function minified(files) {
  const code = files
    .map((f) => transformSync(readFileSync(join(dist, f), "utf8"), { minify: true, loader: "js", legalComments: "none" }).code)
    .join("\n");
  return Buffer.from(code, "utf8");
}

if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const entries = ["core", "index", "overlay"];
const results = {};
let failed = false;

const allFiles = new Set();
for (const entry of entries) {
  const r = bytesFor(entry);
  r.files.forEach((f) => allFiles.add(f));
  results[entry] = r.gzip;
  const budget = BUDGETS[entry];
  const ok = r.gzip <= budget;
  failed ||= !ok;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${entry.padEnd(8)} ${kb(r.gzip).padStart(8)} gzip  ${kb(r.min).padStart(9)} min   budget ${kb(budget)}`,
  );
}

// A runtime entry that reaches the Babel plugin would ship a compiler to the
// browser. Assert the separation rather than trusting the config.
for (const entry of entries) {
  const { files } = bytesFor(entry);
  const leaked = files.filter((f) => /babel|vite/.test(f));
  if (leaked.length > 0) {
    console.log(`FAIL  ${entry} pulls in build-time code: ${leaked.join(", ")}`);
    failed = true;
  }
}

for (const entry of BUILD_TIME_ENTRIES) {
  const r = bytesFor(entry);
  console.log(`      ${entry.padEnd(8)} ${kb(r.gzip).padStart(8)} gzip  ${kb(r.min).padStart(9)} min   build-time only, not budgeted`);
}

const totalRaw = minified([...allFiles]);
const total = gzipSync(totalRaw, { level: 9 }).length;
results.total = total;
const totalOk = total <= BUDGETS.total;
failed ||= !totalOk;
console.log(`${totalOk ? "PASS" : "FAIL"}  ${"total".padEnd(8)} ${kb(total).padStart(8)} gzip                budget ${kb(BUDGETS.total)}`);

if (existsSync(baselinePath)) {
  const previous = JSON.parse(readFileSync(baselinePath, "utf8"));
  console.log("\nChange vs baseline");
  for (const key of Object.keys(results)) {
    const before = previous[key];
    if (typeof before !== "number") continue;
    const delta = results[key] - before;
    const pct = before === 0 ? 0 : (delta / before) * 100;
    console.log(`  ${key.padEnd(8)} ${kb(before)} → ${kb(results[key])}  ${delta >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
  }
}

if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log("\nBaseline written.");
}

if (process.argv.includes("--list")) {
  console.log(`\nFiles in dist: ${readdirSync(dist).length}`);
}

process.exit(failed ? 1 : 0);

function kb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}
