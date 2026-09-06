import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFindings,
  getMemoryReport,
  init,
  reset,
  shutdown,
  useMemoryTracking,
  useTrackedResource,
} from "../src/index.js";

afterEach(() => {
  cleanup();
  reset();
});

const setup = (options = {}) => init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 20, ...options });
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
};

/** Leaks an interval: no cleanup returned. */
function Leaky({ name = "Leaky" }: { name?: string }) {
  const self = useMemoryTracking(name);
  useEffect(() => {
    if (!self) return;
    self && undefined;
  }, [self]);
  useTrackedResourceLeak(self);
  return <i>leaky</i>;
}

/** Deliberately registers a resource and never releases it. */
function useTrackedResourceLeak(self: ReturnType<typeof useMemoryTracking>) {
  const detective = getDetectiveForTest();
  useEffect(() => {
    if (!self) return;
    detective.withOwner(self, () => setInterval(() => {}, 1000));
  }, [detective, self]);
}

function getDetectiveForTest() {
  // Imported lazily to keep the public surface honest in the tests above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (globalThis as never as Record<symbol, never>)[Symbol.for("react-memory-detective.instance")] as never as {
    withOwner: <T>(o: unknown, fn: () => T) => T;
  };
}

/** Cleans up properly. */
function Clean() {
  const self = useMemoryTracking("Clean");
  useTrackedResource(self, {
    type: "interval",
    name: "poll",
    create: () => setInterval(() => {}, 1000),
    cleanup: (id) => clearInterval(id),
  });
  return <i>clean</i>;
}

describe("lifecycle and retention", () => {
  it("says nothing about a component that cleans up after itself", async () => {
    setup();
    const { unmount } = render(<Clean />);
    unmount();
    await settle();

    expect(getFindings()).toHaveLength(0);
    const report = getMemoryReport();
    expect(report.components.find((c) => c.name === "Clean")?.resourcesOutlivingOwner).toBe(0);
  });

  it("reports a resource still active after its owner unmounted", async () => {
    setup();
    const { unmount } = render(<Leaky />);
    unmount();
    await settle();

    const finding = getFindings()[0];
    expect(finding).toBeDefined();
    expect(finding?.component?.name).toBe("Leaky");
    expect(finding?.summary).toContain("interval");
    expect(finding?.suggestion).toContain("clearInterval");
    // One observation is not a pattern.
    expect(finding?.confidence).toBe("low");
  });

  it("waits out the grace period, because some resources close asynchronously", async () => {
    setup({ cleanupGracePeriodMs: 200 });
    const { unmount } = render(<Leaky />);
    unmount();

    // Immediately after unmount there is deliberately nothing to report.
    expect(getFindings()).toHaveLength(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 280));
    });
    expect(getFindings().length).toBeGreaterThan(0);
  });

  it("keeps two instances of the same component apart", async () => {
    setup();
    const { unmount } = render(
      <>
        <Leaky name="Twin" />
        <Leaky name="Twin" />
      </>,
    );
    unmount();
    await settle();

    const report = getMemoryReport();
    const twin = report.components.find((c) => c.name === "Twin");
    expect(twin?.mounts).toBe(2);
    expect(twin?.unmounts).toBe(2);
    // Two instances, two intervals — not one instance counted twice.
    expect(twin?.resourcesOutlivingOwner).toBe(2);
  });
});

describe("StrictMode", () => {
  it("does not manufacture a finding from the development remount", async () => {
    setup();
    /*
     * StrictMode mounts, unmounts and remounts every component. That is exactly
     * the shape this tool looks for, so without special handling it would report
     * a leak for every component in every StrictMode app.
     */
    render(
      <StrictMode>
        <Clean />
      </StrictMode>,
    );
    await settle();

    expect(getFindings()).toHaveLength(0);
    const clean = getMemoryReport().components.find((c) => c.name === "Clean");
    expect(clean?.mounts).toBe(1);
    expect(clean?.unmounts).toBe(0);
  });
});

describe("lifecycle of the tool itself", () => {
  it("restores the globals it patched", () => {
    const original = globalThis.setInterval;
    setup();
    expect(globalThis.setInterval).not.toBe(original);
    shutdown();
    expect(globalThis.setInterval).toBe(original);
  });

  it("patches once however many times init is called", () => {
    const original = globalThis.setInterval;
    setup();
    const patched = globalThis.setInterval;
    setup();
    setup();
    expect(globalThis.setInterval).toBe(patched);
    shutdown();
    expect(globalThis.setInterval).toBe(original);
  });

  it("does nothing at all when disabled", () => {
    const original = globalThis.setInterval;
    init({ enabled: false });
    expect(globalThis.setInterval).toBe(original);
    render(<Clean />);
    expect(getMemoryReport().components).toHaveLength(0);
  });
});
