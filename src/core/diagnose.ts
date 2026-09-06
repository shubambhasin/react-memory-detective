import { formatSource } from "../resources/source.js";
import type { Confidence, Finding, ResourceRecord } from "./types.js";

export interface OutlivedInput {
  /** Resources still active after their owner unmounted, past the grace period. */
  resources: ResourceRecord[];
  /** How many mount/unmount cycles this component has completed. */
  cycles: number;
  /** How many of those cycles left resources behind. */
  cyclesWithRetention: number;
  gracePeriodMs: number;
}

/**
 * Resources that never self-resolve. An uncleared `setInterval` runs forever;
 * an unfired `setTimeout` is just a timeout that has not fired yet.
 */
const NEVER_SELF_RESOLVES = new Set([
  "interval",
  "event-listener",
  "websocket",
  "event-source",
  "mutation-observer",
  "resize-observer",
  "intersection-observer",
  "broadcast-channel",
  "worker",
  "subscription",
]);

/**
 * Pure. No React, no globals, no I/O — so the reasoning can be tested directly,
 * which is where the accuracy claims have to be earned.
 */
export function diagnoseOutlivedResources(input: OutlivedInput): Finding | undefined {
  const { resources, cycles, cyclesWithRetention } = input;
  if (resources.length === 0) return undefined;

  const component = resources[0]?.owner;
  const persistent = resources.filter((r) => NEVER_SELF_RESOLVES.has(r.type));
  const transient = resources.filter((r) => !NEVER_SELF_RESOLVES.has(r.type));

  /*
   * A pending timeout is not a leak — it is a timeout that has not fired. Only
   * resources that never resolve on their own can outlive a component in any
   * meaningful sense, so a finding made purely of transient resources is not
   * worth raising.
   */
  if (persistent.length === 0) return undefined;

  const byType = new Map<string, number>();
  for (const r of persistent) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const breakdown = [...byType.entries()].map(([type, count]) => `${count} × ${type}`).join(", ");

  const repeated = cycles >= 3 && cyclesWithRetention >= 3;
  const everyCycle = cycles >= 3 && cyclesWithRetention >= cycles;

  /*
   * Confidence comes from repetition, not from a single observation. One
   * uncleaned resource can be a race with an async close; the same resource
   * uncleaned on every one of twenty cycles is a pattern.
   */
  const confidence: Confidence = everyCycle ? "high" : repeated ? "medium" : "low";

  const evidence = [
    `${component?.name ?? "The owner"} unmounted, and ${persistent.length} resource${persistent.length === 1 ? "" : "s"} created by it ${persistent.length === 1 ? "is" : "are"} still active more than ${input.gracePeriodMs}ms later.`,
    `Still active: ${breakdown}.`,
    ...persistent.slice(0, 5).map((r) => {
      const where = formatSource(r.source);
      return `  ${r.label}${where ? ` — created at ${where}` : ""}`;
    }),
  ];

  if (transient.length > 0) {
    evidence.push(
      `${transient.length} pending timeout${transient.length === 1 ? "" : "s"} ${transient.length === 1 ? "was" : "were"} also outstanding, and ${transient.length === 1 ? "is" : "are"} not counted: a timeout that has not fired is not a retained resource.`,
    );
  }

  if (everyCycle) {
    evidence.push(`Every one of ${cycles} mount/unmount cycles left resources behind. That is a pattern, not a race.`);
  } else if (repeated) {
    evidence.push(`${cyclesWithRetention} of ${cycles} cycles left resources behind.`);
  } else {
    evidence.push(
      "Seen once so far. A single occurrence can be an asynchronous close that had not completed — repeat the interaction to tell the difference.",
    );
  }

  evidence.push("Garbage collection cannot be observed from a page, so this is retention evidence, not proof of a leak.");

  return {
    id: `finding_${component?.instanceId ?? "unknown"}_${Math.round(persistent[0]?.outlivedOwnerAt ?? 0)}`,
    kind: repeated ? "repeated-retention" : "outlived-owner",
    component,
    resources: persistent,
    summary: `${component?.name ?? "A component"} unmounted, but ${breakdown} created by it ${persistent.length === 1 ? "is" : "are"} still active.`,
    evidence,
    suggestion: suggestionFor(persistent),
    confidence,
    severity: everyCycle ? "high" : repeated ? "warning" : "info",
    observedAt: persistent[0]?.outlivedOwnerAt ?? Date.now(),
  };
}

const RELEASE_CALL: Partial<Record<ResourceRecord["type"], string>> = {
  interval: "clearInterval(id)",
  "event-listener": "removeEventListener with the same function reference",
  websocket: "socket.close()",
  "event-source": "source.close()",
  "mutation-observer": "observer.disconnect()",
  "resize-observer": "observer.disconnect()",
  "intersection-observer": "observer.disconnect()",
  "broadcast-channel": "channel.close()",
  worker: "worker.terminate()",
  subscription: "the unsubscribe function",
};

function suggestionFor(resources: ResourceRecord[]): string | undefined {
  const first = resources[0];
  if (!first) return undefined;
  const call = RELEASE_CALL[first.type];
  if (!call) return undefined;
  const where = formatSource(first.source);
  return `Return a cleanup from the effect that calls ${call}${where ? `, for the resource created at ${where}` : ""}.`;
}
