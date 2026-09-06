#!/usr/bin/env node
/**
 * Publish guard. Runs from `prepublishOnly`, so it cannot be forgotten.
 *
 * It checks the **packed tarball** and the **git cleanliness of the manifest**,
 * not just the source tree, because the source tree is what lied to us twice:
 *
 *   an earlier sibling project shipped a `package.json` into which npm had injected ~200 transitive
 *   dev packages as runtime dependencies — a package advertising zero
 *   dependencies that pulled in the whole dev toolchain and failed to install
 *   on Linux. It happened again, from a different npm command, while verifying
 *   0.1.2. Both times the trigger was npm reifying a node_modules tree left out
 *   of sync by an earlier `--no-save` install.
 *
 * Every assertion below corresponds to something that actually went wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * react is the only required peer. @babel/core and vite are optional: needed
 * by the build plugin and the Vite entry respectively, never by the runtime,
 * and never installed for consumers who use neither. Every addition here has to
 * be deliberate — an accidental peer breaks installs, which is the whole reason
 * this list is a fixed allowlist rather than a check of the manifest against
 * itself.
 */
const ALLOWED_PEERS = ["react", "@babel/core", "vite"];
const REQUIRED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/dist/index.js",
  "package/dist/index.cjs",
  "package/dist/index.d.ts",
  "package/dist/core.js",
  "package/dist/overlay.js",
  "package/dist/babel.js",
  "package/dist/babel.cjs",
  "package/dist/babel.d.ts",
  "package/dist/vite.js",
  "package/dist/vite.d.ts",
];
/** Anything matching these must never reach the registry. */
const FORBIDDEN = [/^package\/(src|tests|bench|examples|site|scripts|docs)\//, /\.env/, /\.tgz$/, /node_modules/];

const failures = [];
const fail = (message) => failures.push(message);

/*
 * `--allow-dirty` downgrades the "manifest matches HEAD" check to a warning, so
 * a release can be sanity-checked before the version bump is committed. Every
 * tarball check still runs. `prepublishOnly` never passes it, so a real publish
 * is always strict — which is the case that matters, since publishing an
 * uncommitted manifest is what shipped 0.1.1 and 0.1.2.
 */
const allowDirty = process.argv.includes("--allow-dirty");

// fileURLToPath, not `.pathname`: the latter percent-encodes spaces in the path.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/*
 * 1. The manifest must be exactly what is committed.
 *
 * This is the check that would have stopped 0.1.1: npm had rewritten
 * package.json in the working tree, and the publish went out from that.
 */
try {
  const dirty = git("status", "--porcelain", "--", "package.json").trim();
  if (dirty) {
    const committed = JSON.parse(git("show", "HEAD:package.json"));
    const working = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const added = Object.keys(working).filter((k) => !(k in committed));
    const detail =
      "package.json has uncommitted changes; publish only what is committed.\n" +
      (added.length ? `      Keys npm appears to have added: ${added.join(", ")}\n` : "") +
      "      Run `git diff package.json`, then `git checkout package.json` if npm wrote it.";
    if (allowDirty) {
      // Still shout about keys npm added — that is never an intentional edit.
      if (added.length > 0) fail(detail);
      else console.warn(`Warning: ${detail.split("\n")[0]} (allowed by --allow-dirty)`);
    } else {
      fail(detail);
    }
  }
} catch {
  // Not a git checkout (e.g. publishing from an extracted tarball) — skip.
}

const staging = mkdtempSync(join(tmpdir(), "rrd-verify-"));
try {
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", staging], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarball = join(staging, JSON.parse(out)[0].filename);

  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
  const local = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // 2. The defect that produced 0.1.1.
  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.length > 0) {
    fail(
      `the package declares ${deps.length} runtime dependencies; it must declare none.\n` +
        `      First few: ${deps.slice(0, 5).join(", ")}`,
    );
  }

  // 3. Peers are the supported surface; an accidental extra one breaks installs.
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const unexpected = peers.filter((p) => !ALLOWED_PEERS.includes(p));
  if (unexpected.length > 0) fail(`unexpected peerDependencies: ${unexpected.join(", ")}`);
  if (!peers.includes("react")) fail("react is missing from peerDependencies");

  // An optional peer that is not marked optional is installed for everyone.
  const meta = manifest.peerDependenciesMeta ?? {};
  for (const peer of peers) {
    if (peer !== "react" && meta[peer]?.optional !== true) {
      fail(`peerDependency ${peer} must be marked optional in peerDependenciesMeta`);
    }
  }

  // 4. The tarball must match the tree it claims to come from.
  if (manifest.version !== local.version) {
    fail(`tarball version ${manifest.version} does not match package.json ${local.version}`);
  }
  if (manifest.private) fail("the package is marked private");
  if (manifest.publishConfig?.access !== "public") fail('publishConfig.access must be "public"');
  if (manifest.sideEffects !== false) fail("sideEffects must be false so consumers can tree-shake");

  // 5. Ship everything needed, and nothing else.
  for (const required of REQUIRED_FILES) {
    if (!entries.includes(required)) fail(`missing from the tarball: ${required}`);
  }
  for (const entry of entries) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(entry)) fail(`must not be published: ${entry}`);
    }
  }

  // 6. A build that cannot be loaded is worse than no build.
  const cjs = execFileSync("tar", ["-xzOf", tarball, "package/dist/index.cjs"], { encoding: "utf8" });
  for (const name of ["init", "trackResource", "getMemoryReport", "ownEffect"]) {
    if (!cjs.includes(name)) fail(`the built CJS bundle does not export ${name}`);
  }

  // 7. The compiler must stay in the build. A runtime entry that reaches
  // @babel/core would ship it to every user of the app.
  for (const entry of ["index", "core", "overlay"]) {
    for (const ext of ["js", "cjs"]) {
      let code = "";
      try {
        code = execFileSync("tar", ["-xzOf", tarball, `package/dist/${entry}.${ext}`], { encoding: "utf8" });
      } catch {
        continue;
      }
      if (/@babel\/core/.test(code)) fail(`dist/${entry}.${ext} references @babel/core; build-time code must not ship to the browser`);
    }
  }

  if (failures.length === 0) {
    const sizeKb = (readFileSync(tarball).length / 1024).toFixed(1);
    console.log(
      `Package verified: ${manifest.name}@${manifest.version} — ${entries.length} files, ${sizeKb} KB\n` +
        `  runtime dependencies: 0   peers: ${peers.join(", ")}   manifest matches HEAD`,
    );
  }
} catch (error) {
  fail(`could not pack or inspect the package: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nRefusing to publish — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nNothing was published.\n");
  process.exit(1);
}
