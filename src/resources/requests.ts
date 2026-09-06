import type { ResourceRegistry } from "../core/registry.js";
import { captureSource } from "./source.js";

/**
 * In-flight requests.
 *
 * Deliberately never a finding on its own. A request continuing after its
 * component unmounts is normal — the response may populate a cache, or the
 * write must complete regardless of what the user navigated away from. The
 * spec is right that an unresolved promise is not a leak.
 *
 * So requests are recorded, shown in the report and the overlay, and excluded
 * from the diagnosis. What they are good for is context: "this component
 * unmounted with three requests outstanding" next to a genuine finding tells a
 * developer where to look.
 */
export function instrumentRequests(registry: ResourceRegistry, shouldCaptureSource: () => boolean): () => void {
  const target = globalThis as { fetch?: typeof fetch };
  const originalFetch = target.fetch;
  if (typeof originalFetch !== "function") return () => {};

  target.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let recordId: string | undefined;
    try {
      const record = registry.create({
        type: "request",
        label: `fetch ${describe(input)}`,
        source: shouldCaptureSource() ? captureSource() : undefined,
      });
      recordId = record.id;

      // An abort is a real cleanup; settling is the request resolving itself.
      init?.signal?.addEventListener("abort", () => registry.release(recordId), { once: true });
    } catch {
      /* instrumentation must never break a request */
    }

    return originalFetch.call(globalThis, input, init).then(
      (response) => {
        registry.release(recordId, "self-resolved");
        return response;
      },
      (error: unknown) => {
        registry.release(recordId, "self-resolved");
        throw error;
      },
    );
  } as typeof fetch;

  return () => {
    target.fetch = originalFetch;
  };
}

function describe(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return trim(input);
    if (input instanceof URL) return trim(input.pathname);
    return trim((input as Request).url ?? "");
  } catch {
    return "";
  }
}

const trim = (url: string): string => (url.length > 60 ? `${url.slice(0, 60)}…` : url);
