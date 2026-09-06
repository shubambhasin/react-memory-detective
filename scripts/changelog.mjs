#!/usr/bin/env node
/**
 * Changelog tooling: check, start, render.
 *
 * The prose stays hand-written. A generator turns "the first attempt inferred
 * this at runtime and broke the moment a user clicked more than five seconds
 * apart" into "fix: remount detection", and the reasoning is the part worth
 * keeping. What is automated here is the mechanics that actually go wrong:
 * forgetting the entry, forgetting the heading, and the version strings npm
 * does not know about.
 *
 *   node scripts/changelog.mjs --check [version]   assert an entry exists
 *   node scripts/changelog.mjs --start <version>   insert a heading skeleton
 *   node scripts/changelog.mjs --html <out.html>   render for the website
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changelogPath = join(root, "CHANGELOG.md");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(changelogPath, "utf8");

const args = process.argv.slice(2);
const flag = args[0];
const value = args[1];

/** Splits the file into `{ version, body }` sections on `## ` headings. */
function sections(text) {
  const out = [];
  const lines = text.split("\n");
  let current;
  for (const line of lines) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (current) out.push(current);
      current = { heading: match[1].trim(), version: (match[1].trim().match(/\d+\.\d+\.\d+/) ?? [""])[0], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
}

if (flag === "--check") {
  const version = value ?? pkg.version;
  const found = sections(source).find((s) => s.version === version);
  if (!found) {
    console.error(
      `CHANGELOG.md has no entry for ${version}.\n\n` +
        `Add a "## ${version}" section describing what changed and why, then retry.\n` +
        `A release with no entry is a release nobody can evaluate.`,
    );
    process.exit(1);
  }
  if (found.body.length < 40) {
    console.error(`The CHANGELOG entry for ${version} is empty or near-empty. Write what changed and why.`);
    process.exit(1);
  }
  console.log(`CHANGELOG entry for ${version} present (${found.body.split("\n").length} lines).`);
  process.exit(0);
}

if (flag === "--start") {
  const version = value;
  if (!version) {
    console.error("Usage: node scripts/changelog.mjs --start <version>");
    process.exit(1);
  }
  if (sections(source).some((s) => s.version === version)) {
    console.log(`CHANGELOG already has an entry for ${version}.`);
    process.exit(0);
  }
  const marker = "\n## ";
  const at = source.indexOf(marker);
  const skeleton =
    `## ${version}\n\n` +
    `<!-- Say what changed and WHY. Someone deciding whether to upgrade reads this. -->\n\n` +
    `### Added\n\n### Changed\n\n### Fixed\n\n`;
  const next = at === -1 ? `${source.trimEnd()}\n\n${skeleton}` : source.slice(0, at + 1) + skeleton + source.slice(at + 1);
  writeFileSync(changelogPath, next);
  console.log(`Inserted a CHANGELOG skeleton for ${version}. Fill it in before tagging.`);
  process.exit(0);
}

if (flag === "--html") {
  const out = value ?? join(root, "site", "changelog.html");
  writeFileSync(out, renderPage(sections(source)));
  console.log(`Wrote ${out}`);
  process.exit(0);
}

console.error("Usage: --check [version] | --start <version> | --html [out]");
process.exit(1);

/* ------------------------------------------------------------------ rendering */

// Function declarations, not consts: these are used by renderPage(), which the
// CLI dispatch above calls before this point in the file is evaluated.
function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline subset actually used by this changelog: code, bold, links. */
function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Block subset: h3, paragraphs, bullet lists, pipe tables. */
function blocks(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  let list = null;
  let table = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
      list = null;
    }
  };
  const flushTable = () => {
    if (table) {
      const [head, ...body] = table;
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      table = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushAll();
      continue;
    }
    const heading = /^### (.+)$/.exec(trimmed);
    if (heading) {
      flushAll();
      html.push(`<h3>${inline(heading[1])}</h3>`);
      continue;
    }
    if (/^\|/.test(trimmed)) {
      flushParagraph();
      flushList();
      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      // The |---|---| separator row carries no content.
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      (table ??= []).push(cells);
      continue;
    }
    const bullet = /^[-*] (.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      flushTable();
      (list ??= []).push(bullet[1]);
      continue;
    }
    if (trimmed.startsWith("<!--")) continue;
    flushList();
    flushTable();
    paragraph.push(trimmed);
  }
  flushAll();
  return html.join("\n");
}

function renderPage(all) {
  const entries = all
    .filter((s) => s.version)
    .map(
      (s) => `<section class="release">
  <h2 id="v${s.version}">${escape(s.heading)} <a class="anchor" href="#v${s.version}">#</a></h2>
  ${blocks(s.body)}
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog — React Render Detective</title>
<meta name="description" content="Every release of react-render-detective, what changed and why.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔍</text></svg>">
<style>
  :root {
    --bg:#fff; --bg-soft:#f6f7f9; --text:#16181d; --muted:#5b6472; --line:#e3e6ea; --accent:#2f6df6;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0c0e12; --bg-soft:#14171d; --text:#e6e9ee; --muted:#98a2b3; --line:#232833; --accent:#6f9bff;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.65}
  a{color:var(--accent)}
  .wrap{max-width:820px;margin:0 auto;padding:0 24px}
  header{padding:56px 0 24px;border-bottom:1px solid var(--line)}
  .eyebrow{font-family:var(--mono);font-size:13px;color:var(--muted)}
  h1{font-size:clamp(30px,5vw,42px);margin:12px 0 8px;letter-spacing:-.02em}
  .lede{color:var(--muted);margin:0 0 20px;max-width:56ch}
  .release{padding:36px 0;border-bottom:1px solid var(--line)}
  h2{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}
  h2 .anchor{color:var(--line);text-decoration:none;font-size:16px}
  h2:hover .anchor{color:var(--accent)}
  h3{font-size:15px;margin:24px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  p{margin:10px 0}
  code{font-family:var(--mono);font-size:.9em;background:var(--bg-soft);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
  ul{padding-left:20px} li{margin:6px 0}
  table{width:100%;border-collapse:collapse;font-size:14.5px;margin:14px 0}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-size:13px}
  footer{padding:32px 0 64px;color:var(--muted);font-size:14px}
  footer a{color:var(--muted)}
  nav{display:flex;gap:14px;font-size:14px;margin-top:14px}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="eyebrow">react-render-detective</div>
    <h1>Changelog</h1>
    <p class="lede">Every release, what changed and why — including the mistakes, because the reasoning is
    the part worth reading when you are deciding whether to upgrade.</p>
    <nav>
      <a href="./">Overview</a>
      <a href="https://github.com/shubambhasin/react-render-detective">GitHub</a>
      <a href="https://www.npmjs.com/package/react-render-detective">npm</a>
    </nav>
  </div>
</header>
<main class="wrap">
${entries}
</main>
<footer>
  <div class="wrap">Generated from <a href="https://github.com/shubambhasin/react-render-detective/blob/main/CHANGELOG.md">CHANGELOG.md</a> at deploy time.</div>
</footer>
</body>
</html>
`;
}
