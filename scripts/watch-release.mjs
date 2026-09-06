#!/usr/bin/env node
/**
 * Wait for the workflow run belonging to a specific commit, and report it.
 *
 *   node scripts/watch-release.mjs v0.6.0
 *   node scripts/watch-release.mjs            # HEAD, ci.yml
 *
 * Why this exists: the obvious one-liner is wrong.
 *
 *   until [ "$(gh run list --limit 1 --json status -q '.[0].status')" = completed ]; do sleep; done
 *
 * Immediately after a push the new run does not exist yet, so `--limit 1`
 * returns the *previous* run, which is already `completed` — the loop exits at
 * once and reports the wrong run's result. That is how a release that was still
 * running got reported as published, and then as failed when the registry did
 * not have it. Both readings were wrong.
 *
 * So: first wait for a run whose head commit matches, then wait for that run.
 */
import { execFileSync } from "node:child_process";

const RUN_APPEAR_TIMEOUT_MS = 180_000;
const RUN_FINISH_TIMEOUT_MS = 900_000;
const POLL_MS = 10_000;

const ref = process.argv[2] ?? "HEAD";
const workflow = process.argv[3] ?? (ref === "HEAD" ? "ci.yml" : "release.yml");

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sha;
try {
  // `^{}` dereferences an annotated tag to the commit it points at.
  sha = sh("git", ["rev-parse", `${ref}^{}`]);
} catch {
  console.error(`Cannot resolve "${ref}" to a commit. Is the tag created?`);
  process.exit(1);
}
const short = sha.slice(0, 7);

/*
 * A transient API failure is not a verdict.
 *
 * The first version exited on any `gh` error, so a TLS handshake timeout during
 * a ten-minute wait aborted the watch and looked like a failed run — the same
 * mistake as before, dressed differently: reporting a conclusion that came from
 * infrastructure rather than from the run.
 */
const MAX_CONSECUTIVE_API_FAILURES = 5;
let consecutiveFailures = 0;

function listRuns() {
  try {
    const runs = JSON.parse(
      sh("gh", ["run", "list", "--workflow", workflow, "--limit", "20", "--json", "databaseId,headSha,status,conclusion,createdAt"]),
    );
    consecutiveFailures = 0;
    return runs;
  } catch (error) {
    consecutiveFailures++;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (consecutiveFailures >= MAX_CONSECUTIVE_API_FAILURES) {
      console.error(`\ngh failed ${consecutiveFailures} times in a row, giving up: ${message}`);
      console.error("The run itself may still be fine — check GitHub directly.");
      process.exit(1);
    }
    console.warn(`  gh call failed (${consecutiveFailures}/${MAX_CONSECUTIVE_API_FAILURES}), retrying: ${message}`);
    return null;
  }
}

console.log(`Waiting for a ${workflow} run for ${ref} (${short})…`);

/*
 * Match on the head commit, never on recency. A tag push and a branch push
 * produce runs seconds apart, and "newest" picks whichever raced ahead.
 */
let run;
const appearDeadline = Date.now() + RUN_APPEAR_TIMEOUT_MS;
while (!run) {
  run = listRuns()?.find((r) => r.headSha === sha);
  if (run) break;
  if (Date.now() > appearDeadline) {
    console.error(
      `No ${workflow} run for ${short} appeared within ${RUN_APPEAR_TIMEOUT_MS / 1000}s.\n` +
        `The push may not have triggered it — check the workflow's trigger and paths filter.`,
    );
    process.exit(1);
  }
  await sleep(POLL_MS);
}

console.log(`Found run ${run.databaseId} for ${short}. Waiting for it to finish…`);

const finishDeadline = Date.now() + RUN_FINISH_TIMEOUT_MS;
while (run.status !== "completed") {
  if (Date.now() > finishDeadline) {
    console.error(`Run ${run.databaseId} did not finish within ${RUN_FINISH_TIMEOUT_MS / 60000} minutes.`);
    process.exit(1);
  }
  await sleep(POLL_MS);
  const refreshed = listRuns()?.find((r) => r.databaseId === run.databaseId);
  if (refreshed) run = refreshed;
}

let steps;
try {
  steps = JSON.parse(sh("gh", ["run", "view", String(run.databaseId), "--json", "jobs"]));
} catch {
  // The run's conclusion is already known; per-step detail is a nicety.
  steps = { jobs: [] };
}
const failed = [];
for (const job of steps.jobs ?? []) {
  for (const step of job.steps ?? []) {
    if (step.conclusion === "failure") failed.push(`${job.name} › ${step.name}`);
  }
}

console.log(`\n${workflow} for ${ref} (${short}): ${run.conclusion}`);
for (const job of steps.jobs ?? []) console.log(`  ${job.name}: ${job.conclusion}`);

if (run.conclusion !== "success") {
  if (failed.length > 0) {
    console.error("\nFailed steps:");
    for (const f of failed) console.error(`  ✗ ${f}`);
  }
  console.error(`\nLogs: gh run view ${run.databaseId} --log-failed`);
  process.exit(1);
}
