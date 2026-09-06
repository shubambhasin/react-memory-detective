import type { MemorySample } from "./types.js";

interface LegacyMemory {
  usedJSHeapSize: number;
}

/**
 * Memory measurement, where it exists at all.
 *
 * Both APIs are conditional and neither apportions memory by component, so this
 * exists to report honestly rather than to produce a number at any cost.
 * `performance.memory` is Chrome-only and quantised;
 * `measureUserAgentSpecificMemory` needs cross-origin isolation that most
 * applications do not have.
 */
export class MemoryProvider {
  readonly source: MemorySample["source"];

  constructor() {
    this.source = detectSource();
  }

  get available(): boolean {
    return this.source !== "unavailable";
  }

  /** Synchronous best effort. Returns no bytes when unavailable. */
  sample(): MemorySample {
    if (this.source === "performance.memory") {
      const memory = (performance as unknown as { memory?: LegacyMemory }).memory;
      if (memory) return { at: Date.now(), usedBytes: memory.usedJSHeapSize, source: this.source };
    }
    /*
     * No bytes means nothing was measured, whatever API was detected. Naming a
     * source here would suggest a figure exists and was merely omitted.
     */
    return { at: Date.now(), source: "unavailable" };
  }

  /** The accurate path, where the page is cross-origin isolated. */
  async measure(): Promise<MemorySample> {
    if (this.source === "measureUserAgentSpecificMemory") {
      try {
        const api = (performance as unknown as {
          measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
        }).measureUserAgentSpecificMemory;
        if (api) {
          const result = await api.call(performance);
          return { at: Date.now(), usedBytes: result.bytes, source: this.source };
        }
      } catch {
        /* fall through to the synchronous path */
      }
    }
    return this.sample();
  }

  /** Why measurement is unavailable, in terms a developer can act on. */
  explainUnavailable(): string {
    if (this.available) return "";
    return (
      "No memory API is available in this browser. `performance.memory` exists only in Chrome and Edge, " +
      "and `measureUserAgentSpecificMemory()` requires the page to be cross-origin isolated (COOP + COEP). " +
      "Resource and lifecycle diagnostics are unaffected — they are the stronger signal in any case."
    );
  }
}

function detectSource(): MemorySample["source"] {
  try {
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    const hasPrecise =
      typeof performance !== "undefined" &&
      typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory ===
        "function";
    if (isolated && hasPrecise) return "measureUserAgentSpecificMemory";
    if (typeof performance !== "undefined" && (performance as unknown as { memory?: LegacyMemory }).memory) {
      return "performance.memory";
    }
  } catch {
    /* ignore */
  }
  return "unavailable";
}
