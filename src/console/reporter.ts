import type { Detective } from "../core/detective.js";
import type { Finding } from "../core/types.js";

const ICON: Record<Finding["severity"], string> = { info: "·", warning: "▲", high: "■", critical: "■■" };

/**
 * Console output.
 *
 * Findings are rare and each one is worth reading, so unlike a render profiler
 * this reports per finding rather than batching. What it will not do is shout:
 * the wording tracks the confidence, and low-confidence observations stay quiet
 * unless asked for.
 */
export function attachConsoleReporter(detective: Detective): () => void {
  return detective.subscribe((finding) => {
    const mode = detective.config.mode;
    if (mode === "silent") return;
    // A single unexplained resource is usually an async close, not a defect.
    if (mode === "console" && finding.confidence === "low") return;

    try {
      print(finding, mode === "verbose");
    } catch {
      /* diagnostics must never break the app */
    }
  });
}

function print(finding: Finding, verbose: boolean): void {
  const header = `[Memory Detective] ${ICON[finding.severity]} ${finding.summary}`;
  const log = finding.severity === "info" ? console.log : console.warn;

  const lines: string[] = [];
  if (finding.component) lines.push(`Component:   ${finding.component.name}`);
  lines.push(`Confidence:  ${finding.confidence}`);
  for (const line of finding.evidence.slice(0, verbose ? finding.evidence.length : 4)) {
    lines.push(`  • ${line}`);
  }
  if (finding.suggestion) lines.push(`Next step:   ${finding.suggestion}`);

  log(`${header}\n${lines.join("\n")}`);
}
