import { attachConsoleReporter } from "./console/reporter.js";
import { getDetective } from "./core/detective.js";
import type { DetectiveOptions, Finding, MemoryReport, ResourceType } from "./core/types.js";

const REPORTER = Symbol.for("react-memory-detective.reporter");
type Global = typeof globalThis & { [REPORTER]?: () => void };

declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Positive production detection: this returns true only when it can *see*
 * `NODE_ENV === "production"`. Anything else — including a browser with no
 * `process` at all — counts as "not known to be production", so calling
 * `init()` actually turns the tool on rather than silently doing nothing.
 */
function detectProduction(): boolean {
  try {
    const env = typeof process !== "undefined" ? process?.env : undefined;
    if (env && env.NODE_ENV) return env.NODE_ENV === "production";
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Enable diagnostics. Idempotent — repeated calls reconfigure the single
 * instance and never patch a global twice.
 */
export function init(options: DetectiveOptions = {}): void {
  const detective = getDetective();
  detective.init({ enabled: !detectProduction(), ...options });

  const g = globalThis as Global;
  g[REPORTER]?.();
  g[REPORTER] = undefined;

  if (detective.enabled && detective.config.mode !== "silent") {
    g[REPORTER] = attachConsoleReporter(detective);
  } else if (!detective.enabled) {
    console.info("[Memory Detective] Disabled (enabled: false, or a production build was detected).");
  }

  if (detective.enabled && !detective.memory.available && detective.config.mode === "verbose") {
    console.info(`[Memory Detective] ${detective.memory.explainUnavailable()}`);
  }
}

/** Restores every patched global and stops reporting. */
export function shutdown(): void {
  const g = globalThis as Global;
  g[REPORTER]?.();
  g[REPORTER] = undefined;
  getDetective().shutdown();
}

export function reset(): void {
  shutdown();
  getDetective().reset();
}

export function getMemoryReport(): MemoryReport {
  return getDetective().getReport();
}

export function getFindings(): Finding[] {
  return getDetective().getFindings();
}

export function subscribe(listener: (finding: Finding) => void): () => void {
  return getDetective().subscribe(listener);
}

export function clear(): void {
  getDetective().clear();
}

/**
 * Register a resource created outside a tracked effect — a store subscription,
 * a third-party handle. Returns a release function to call in cleanup.
 */
export function trackResource(spec: { type: ResourceType; name: string; cleanup?: () => void }): () => void {
  const detective = getDetective();
  if (!detective.enabled) return spec.cleanup ?? (() => {});

  const record = detective.registry.create({ type: spec.type, label: spec.name });
  return () => {
    try {
      spec.cleanup?.();
    } finally {
      detective.registry.release(record.id);
    }
  };
}

export function printReport(): void {
  const report = getMemoryReport();
  const lines = [
    "React Memory Detective",
    "",
    `Active resources        ${report.activeResources}`,
    `Findings                ${report.findings.length}`,
    report.memory.available
      ? `Memory                  ${format(report.memory.currentBytes)} (baseline ${format(report.memory.baselineBytes)}, via ${report.memory.source})`
      : "Memory                  unavailable in this browser — resource diagnostics are unaffected",
  ];

  const suspects = report.components.filter((c) => c.resourcesOutlivingOwner > 0).slice(0, 5);
  if (suspects.length > 0) {
    lines.push("", "Components with resources outliving them");
    for (const c of suspects) {
      lines.push(`  ${c.name.padEnd(22)} ${c.resourcesOutlivingOwner} active after unmount   (${c.mounts} mounts, ${c.unmounts} unmounts)`);
    }
  }
  console.log(lines.join("\n"));
}

const format = (bytes?: number): string => (bytes === undefined ? "—" : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export { useMemoryTracking, useTrackedResource } from "./react/track.js";
export { ownEffect } from "./react/own.js";
export type { TrackedResourceSpec } from "./react/track.js";
export type * from "./core/types.js";
