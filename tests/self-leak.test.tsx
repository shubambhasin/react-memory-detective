import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getDetective } from "../src/core/detective.js";
import { init, reset, useMemoryTracking } from "../src/index.js";

afterEach(() => {
  cleanup();
  reset();
});

/**
 * The detector must not be the leak.
 *
 * This is the one test the product cannot ship without: a tool that grows
 * without bound while hunting for things that grow without bound is worse than
 * no tool, and the README makes the claim explicitly.
 */
function Subject({ leak }: { leak: boolean }) {
  const self = useMemoryTracking("Subject");
  const detective = getDetective();
  useEffect(() => {
    if (!self) return;
    const id = detective.withOwner(self, () => setInterval(() => {}, 10_000));
    // When `leak` is set, the cleanup is deliberately absent.
    return leak ? undefined : () => clearInterval(id);
  }, [detective, self, leak]);
  return <i>subject</i>;
}

const cycle = (leak: boolean) => {
  const { unmount } = render(<Subject leak={leak} />);
  unmount();
};

describe("the detector does not leak", () => {
  it("stays bounded across thousands of mount/unmount cycles", async () => {
    init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 5, maxRecords: 500 });
    const detective = getDetective();

    /*
     * 2,000 React cycles rather than 10,000: rendering dominates the runtime and
     * 10,000 took over two minutes, which is too slow to run on every commit.
     * The 100,000-event test below covers boundedness far more cheaply, and this
     * one covers the React path.
     */
    for (let i = 0; i < 2_000; i++) cycle(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Records are capped regardless of how many cycles ran.
    expect(detective.registry.all().length).toBeLessThanOrEqual(500);
    expect(detective.getFindings().length).toBeLessThanOrEqual(500);

    const report = detective.getReport();
    expect(report.components.find((c) => c.name === "Subject")?.mounts).toBe(2_000);
    // Nothing was retained, so nothing is reported.
    expect(report.components.find((c) => c.name === "Subject")?.resourcesOutlivingOwner).toBe(0);
  });

  it("stays bounded even when every cycle leaks, which is the harder case", async () => {
    init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 5, maxRecords: 300 });
    const detective = getDetective();

    for (let i = 0; i < 2_000; i++) cycle(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    /*
     * 2,000 uncleaned intervals are genuinely still active, so the registry is
     * holding real evidence — but it must still honour its cap rather than
     * growing with the application's problem.
     */
    expect(detective.registry.all().length).toBeLessThanOrEqual(300);
    expect(detective.getFindings().length).toBeLessThanOrEqual(300);
  });

  it("stays bounded across 100,000 resource events", () => {
    init({ enabled: true, mode: "silent", maxRecords: 1_000 });
    const detective = getDetective();

    for (let i = 0; i < 100_000; i++) {
      const record = detective.registry.create({ type: "custom", label: `r${i}` });
      if (i % 2 === 0) detective.registry.release(record.id);
    }

    expect(detective.registry.all().length).toBeLessThanOrEqual(1_000);
  });

  it("leaves no timers or patched globals behind after shutdown", () => {
    const originals = {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      addEventListener: globalThis.EventTarget.prototype.addEventListener,
    };

    init({ enabled: true, mode: "silent" });
    render(<Subject leak />).unmount();
    reset();

    expect(globalThis.setInterval).toBe(originals.setInterval);
    expect(globalThis.clearInterval).toBe(originals.clearInterval);
    expect(globalThis.setTimeout).toBe(originals.setTimeout);
    expect(globalThis.EventTarget.prototype.addEventListener).toBe(originals.addEventListener);
  });

  it("holds nothing when disabled", () => {
    init({ enabled: false });
    for (let i = 0; i < 500; i++) cycle(true);
    expect(getDetective().registry.all()).toHaveLength(0);
  });
});
