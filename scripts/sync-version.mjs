#!/usr/bin/env node
/**
 * Propagate the version to the places npm does not know about.
 *
 * `npm version` edits package.json and the lockfile and stops there. The README
 * status line and the website's status block also carry the version, and both
 * went stale during the 0.1.x releases until they were fixed by hand each time.
 * Run from the `version` lifecycle script, so the bump and these edits land in
 * one commit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Each target names the pattern that carries a version, so a miss is loud. */
const targets = [
  { file: "README.md", pattern: /> \*\*Status: \d+\.\d+\.\d+, early release\.\*\*/, replace: `> **Status: ${version}, early release.**` },

];

let failed = false;
for (const { file, pattern, replace } of targets) {
  const path = join(root, file);
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) {
    console.error(`sync-version: no version string matching ${pattern} in ${file}. Update the pattern or the file.`);
    failed = true;
    continue;
  }
  writeFileSync(path, source.replace(pattern, replace));
  console.log(`sync-version: ${file} → ${version}`);
}

process.exit(failed ? 1 : 0);
