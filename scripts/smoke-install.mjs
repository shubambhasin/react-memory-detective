#!/usr/bin/env node
/**
 * Installs the packed tarball into a clean project and uses it three ways:
 * ESM import, CJS require, and a TypeScript compile against the shipped types.
 *
 * `npm pack` proves the files exist. This proves they load. Those are different
 * claims, and only the second one is what a user experiences — a broken exports
 * map or a missing type entry passes every test in this repo and fails on the
 * first line of someone else's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "rmd-smoke-"));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let failed = false;
const step = (name, fn) => {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed = true;
    const detail = error.stdout || error.stderr || error.message;
    console.log(`  FAIL  ${name}\n${String(detail).split("\n").map((l) => `          ${l}`).join("\n")}`);
  }
};

try {
  console.log("Packing…");
  const tarball = join(dir, JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir], root))[0].filename);

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", version: "1.0.0", type: "module", private: true }, null, 2));
  console.log("Installing into a clean project…");
  run("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball, "react@19", "typescript@5", "@types/react@19"]);

  step("ESM import of the main entry", () => {
    writeFileSync(join(dir, "esm.mjs"), `
      import { init, shutdown, getMemoryReport, ownEffect, useMemoryTracking } from "react-memory-detective";
      init({ enabled: true, mode: "silent" });
      const report = getMemoryReport();
      if (typeof report.activeResources !== "number") throw new Error("report shape is wrong");
      if (typeof ownEffect !== "function" || typeof useMemoryTracking !== "function") throw new Error("missing exports");
      shutdown();
      console.log("esm ok");
    `);
    run("node", ["esm.mjs"]);
  });

  step("CJS require of the main entry", () => {
    writeFileSync(join(dir, "cjs.cjs"), `
      const { init, shutdown, getFindings } = require("react-memory-detective");
      init({ enabled: true, mode: "silent" });
      if (!Array.isArray(getFindings())) throw new Error("getFindings did not return an array");
      shutdown();
      console.log("cjs ok");
    `);
    run("node", ["cjs.cjs"]);
  });

  step("subpath entries resolve", () => {
    writeFileSync(join(dir, "subpaths.mjs"), `
      const core = await import("react-memory-detective/core");
      if (typeof core.ResourceRegistry !== "function") throw new Error("core entry is wrong");
      const vite = await import("react-memory-detective/vite");
      if (typeof vite.memoryDetective !== "function") throw new Error("vite entry is wrong");
      const babel = await import("react-memory-detective/babel");
      if (typeof (babel.default ?? babel) !== "function") throw new Error("babel entry is wrong");
      console.log("subpaths ok");
    `);
    run("node", ["subpaths.mjs"]);
  });

  step("the build plugin actually transforms a component", () => {
    writeFileSync(join(dir, "plugin.mjs"), `
      const { transformSync } = await import("@babel/core");
      const plugin = (await import("react-memory-detective/babel")).default;
      const out = transformSync("function W(){ useEffect(() => {}, []); return <div/>; }", {
        filename: "/app/W.jsx", babelrc: false, configFile: false,
        parserOpts: { plugins: ["jsx"] },
        plugins: [[plugin, { enabled: true }]],
      }).code;
      if (!out.includes("useMemoryTracking")) throw new Error("the plugin did not instrument the component");
      console.log("plugin ok");
    `);
    // @babel/core is an optional peer, so the consumer installs it themselves.
    run("npm", ["install", "--no-audit", "--no-fund", "--silent", "@babel/core@7"]);
    run("node", ["plugin.mjs"]);
  });

  step("TypeScript resolves the shipped types under bundler resolution", () => {
    mkdirSync(join(dir, "ts"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, target: "ES2022", module: "ESNext",
        moduleResolution: "bundler", jsx: "react-jsx", skipLibCheck: false,
      },
      include: ["ts"],
    }, null, 2));
    writeFileSync(join(dir, "ts", "use.ts"), `
      import { init, getFindings, type Finding } from "react-memory-detective";
      import { memoryDetective } from "react-memory-detective/vite";
      // Exactly how a consumer calls it: a partial config, no imports of internals.
      init({ enabled: true, mode: "silent" });
      const first: Finding | undefined = getFindings()[0];
      export const confidence = first?.confidence;
      export const plugin = memoryDetective({ enabled: true });
    `);
    run("npx", ["tsc", "-p", "tsconfig.json"]);
  });

  step("node16 resolution, which is stricter about exports maps", () => {
    writeFileSync(join(dir, "tsconfig.node16.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, target: "ES2022", module: "node16",
        moduleResolution: "node16", jsx: "react-jsx", skipLibCheck: true,
      },
      include: ["ts"],
    }, null, 2));
    run("npx", ["tsc", "-p", "tsconfig.node16.json"]);
  });
} catch (error) {
  failed = true;
  console.error(`\nSmoke install could not run: ${error.stdout || error.stderr || error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? "\nClean-install smoke test FAILED.\n" : "\nClean-install smoke test passed.\n");
process.exit(failed ? 1 : 0);
