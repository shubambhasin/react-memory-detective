import { formatSource } from "../resources/source.js";
import type { ListenerMismatch } from "../resources/listeners.js";
import type { Finding } from "./types.js";

/**
 * A listener-cleanup mismatch is the one finding this tool can state as fact.
 *
 * `removeEventListener` is a no-op unless the function reference matches, so a
 * cleanup passing a new closure removes nothing — and we hold both references,
 * so no inference is involved. It also reviews as correct, which is why it
 * survives in codebases.
 */
export function diagnoseListenerMismatch(mismatch: ListenerMismatch, occurrences: number): Finding {
  const added = formatSource(mismatch.addedSource);
  const removed = formatSource(mismatch.removedSource);

  const isCapture = mismatch.reason === "capture";

  return {
    id: `mismatch_${mismatch.target}_${mismatch.event}_${Math.round(mismatch.at)}`,
    kind: "listener-mismatch",
    component: mismatch.addedOwner,
    resources: [],
    summary: isCapture
      ? `removeEventListener("${mismatch.event}") on ${mismatch.target} was called with a different capture flag than the one used to add it — the original listener is still attached.`
      : `removeEventListener("${mismatch.event}") on ${mismatch.target} was called with a different function than the one added — the original listener is still attached.`,
    evidence: [
      `removeEventListener only detaches a listener when the function reference, event type and capture flag all match.`,
      added ? `The listener still attached was added at ${added}.` : "The listener still attached was added earlier.",
      removed
        ? `The removal was attempted at ${removed}.`
        : isCapture
          ? "The removal passed the same function but the opposite capture flag."
          : "The removal passed a different function reference.",
      occurrences > 1 ? `This has happened ${occurrences} times.` : "Seen once so far.",
      "Both references were observed directly, so this is a fact rather than an inference.",
    ],
    suggestion: isCapture
      ? "Pass the same capture flag to removeEventListener as to addEventListener — `{ capture: true }` and the default are different registrations."
      : "Hold the handler in a variable or a ref and pass that same reference to both addEventListener and removeEventListener. An inline arrow in the cleanup creates a new function and removes nothing.",
    // The only finding that does not need repetition: the mechanism is certain.
    confidence: "high",
    severity: occurrences > 1 ? "high" : "warning",
    observedAt: mismatch.at,
  };
}
