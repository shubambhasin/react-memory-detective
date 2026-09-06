import { afterEach, describe, expect, it } from "vitest";
import { MemoryProvider } from "../src/core/memory.js";

const perf = performance as unknown as Record<string, unknown>;
const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function stub(key: string, value: unknown): void {
  const had = Object.prototype.hasOwnProperty.call(perf, key);
  const prior = perf[key];
  Object.defineProperty(perf, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (had) Object.defineProperty(perf, key, { value: prior, configurable: true, writable: true });
    else delete perf[key];
  });
}

function stubIsolated(value: boolean): void {
  const g = globalThis as Record<string, unknown>;
  const prior = g.crossOriginIsolated;
  Object.defineProperty(g, "crossOriginIsolated", { value, configurable: true, writable: true });
  restores.push(() => {
    Object.defineProperty(g, "crossOriginIsolated", { value: prior, configurable: true, writable: true });
  });
}

/**
 * jsdom, Firefox and Safari all report nothing. That is the majority case, not
 * an edge case, so it is tested as the default rather than as a fallback.
 */
describe("memory measurement is honest about being unavailable", () => {
  it("reports unavailable with no bytes when no API exists", () => {
    const provider = new MemoryProvider();
    expect(provider.available).toBe(false);
    const sample = provider.sample();
    expect(sample.source).toBe("unavailable");
    expect(sample.usedBytes).toBeUndefined();
  });

  it("explains why, in terms a developer can act on", () => {
    const explanation = new MemoryProvider().explainUnavailable();
    expect(explanation).toContain("cross-origin isolated");
    // The point of the sentence: the diagnosis does not depend on this number.
    expect(explanation).toContain("Resource and lifecycle diagnostics are unaffected");
  });

  it("says nothing at all when a measurement is available", () => {
    stub("memory", { usedJSHeapSize: 1024 });
    expect(new MemoryProvider().explainUnavailable()).toBe("");
  });

  it("uses performance.memory when Chrome offers it", () => {
    stub("memory", { usedJSHeapSize: 4096 });
    const sample = new MemoryProvider().sample();
    expect(sample.source).toBe("performance.memory");
    expect(sample.usedBytes).toBe(4096);
  });

  it("prefers the precise API only when the page is cross-origin isolated", async () => {
    stub("memory", { usedJSHeapSize: 4096 });
    stub("measureUserAgentSpecificMemory", async () => ({ bytes: 9999 }));

    stubIsolated(false);
    expect(new MemoryProvider().source).toBe("performance.memory");

    stubIsolated(true);
    const provider = new MemoryProvider();
    expect(provider.source).toBe("measureUserAgentSpecificMemory");
    await expect(provider.measure()).resolves.toMatchObject({ usedBytes: 9999 });
  });

  it("falls back rather than throwing when the precise API rejects", async () => {
    stubIsolated(true);
    stub("measureUserAgentSpecificMemory", async () => {
      throw new Error("not allowed");
    });
    const sample = await new MemoryProvider().measure();
    expect(sample.usedBytes).toBeUndefined();
    // A sample with no bytes is unavailable, not "measured by an API that failed".
    expect(sample.source).toBe("unavailable");
  });
});
