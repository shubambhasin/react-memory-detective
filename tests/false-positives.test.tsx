import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getDetective } from "../src/core/detective.js";
import { getFindings, getMemoryReport, init, reset, useMemoryTracking } from "../src/index.js";

afterEach(() => {
  cleanup();
  reset();
});

const setup = () => init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 20 });
const settle = async (ms = 80) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};
const highConfidence = () => getFindings().filter((f) => f.confidence === "high");

/**
 * Everything here is a legitimate pattern that a naive detector reports as a
 * leak. Each one must produce no high-confidence finding, and most must produce
 * no finding at all.
 *
 * This suite matters more than any additional resource type: a tool that cries
 * wolf is uninstalled after the second false alarm, and every claim it makes
 * afterwards is discounted.
 */
describe("legitimate patterns must not be reported", () => {
  it("does not blame a component for an application-level singleton", async () => {
    setup();
    // Created at module scope, outside any tracked scope — nobody owns it.
    const appWide = setInterval(() => {}, 10_000);

    function Consumer() {
      useMemoryTracking("Consumer");
      return <i>uses the singleton</i>;
    }
    render(<Consumer />).unmount();
    await settle();

    expect(getFindings()).toHaveLength(0);
    // The resource is tracked, but with no owner — not attributed to whoever
    // happened to be mounted when it appeared.
    const record = getDetective().registry.all()[0];
    expect(record?.ownership).toBe("none");
    expect(record?.owner).toBeUndefined();
    clearInterval(appWide);
  });

  it("does not blame a component for a global listener it merely uses", async () => {
    setup();
    const handler = () => {};
    window.addEventListener("online", handler); // app-level, deliberately permanent

    function Consumer() {
      useMemoryTracking("Consumer");
      return <i>x</i>;
    }
    render(<Consumer />).unmount();
    await settle();

    expect(getFindings()).toHaveLength(0);
    window.removeEventListener("online", handler);
  });

  it("does not report a resource released just after unmount, inside the grace period", async () => {
    init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 120 });
    const detective = getDetective();
    let id: ReturnType<typeof setInterval> | undefined;

    function Async() {
      const self = useMemoryTracking("Async");
      useEffect(() => {
        if (!self) return;
        id = detective.withOwner(self, () => setInterval(() => {}, 1000));
        // A close that completes shortly after unmount — common, and not a leak.
        return () => void setTimeout(() => clearInterval(id), 30);
      }, [self]);
      return <i>x</i>;
    }

    render(<Async />).unmount();
    await settle(200);
    expect(getFindings()).toHaveLength(0);
  });

  it("does not accumulate findings for a component that cleans up every cycle", async () => {
    setup();
    const detective = getDetective();

    function Tidy() {
      const self = useMemoryTracking("Tidy");
      useEffect(() => {
        if (!self) return;
        const id = detective.withOwner(self, () => setInterval(() => {}, 1000));
        return () => clearInterval(id);
      }, [self]);
      return <i>x</i>;
    }

    for (let i = 0; i < 30; i++) render(<Tidy />).unmount();
    await settle();

    expect(getFindings()).toHaveLength(0);
    expect(getMemoryReport().components.find((c) => c.name === "Tidy")?.resourcesOutlivingOwner).toBe(0);
  });

  it("does not treat a fired timeout as something the component failed to clean up", async () => {
    setup();
    const detective = getDetective();

    function Delayed() {
      const self = useMemoryTracking("Delayed");
      useEffect(() => {
        if (!self) return;
        // No cleanup, deliberately — a timeout that fires is not a leak.
        detective.withOwner(self, () => setTimeout(() => {}, 5));
      }, [self]);
      return <i>x</i>;
    }

    render(<Delayed />).unmount();
    await settle();
    expect(getFindings()).toHaveLength(0);
  });

  it("does not report a timeout that is still pending when the component unmounts", async () => {
    setup();
    const detective = getDetective();

    function Pending() {
      const self = useMemoryTracking("Pending");
      useEffect(() => {
        if (!self) return;
        // Long enough that it is still outstanding at unmount, and never
        // cleared. A timeout that has not fired yet is a timeout, not a leak:
        // it will fire, release itself, and be gone.
        detective.withOwner(self, () => setTimeout(() => {}, 60_000));
      }, [self]);
      return <i>x</i>;
    }

    render(<Pending />).unmount();
    await settle();

    // The resource really is still active — the diagnosis has to decline it.
    expect(detective.registry.activeCount).toBeGreaterThan(0);
    expect(getFindings()).toHaveLength(0);
  });

  it("does not report anything for a StrictMode double mount", async () => {
    setup();
    const detective = getDetective();

    function Tidy() {
      const self = useMemoryTracking("StrictTidy");
      useEffect(() => {
        if (!self) return;
        const id = detective.withOwner(self, () => setInterval(() => {}, 1000));
        return () => clearInterval(id);
      }, [self]);
      return <i>x</i>;
    }

    render(
      <StrictMode>
        <Tidy />
      </StrictMode>,
    );
    await settle();
    expect(getFindings()).toHaveLength(0);
  });

  it("blames only the component that actually leaked", async () => {
    setup();
    const detective = getDetective();

    function Leaky() {
      const self = useMemoryTracking("TheLeaker");
      useEffect(() => {
        if (!self) return;
        detective.withOwner(self, () => setInterval(() => {}, 1000));
      }, [self]);
      return <i>leaky</i>;
    }
    function Innocent() {
      const self = useMemoryTracking("Innocent");
      useEffect(() => {
        if (!self) return;
        const id = detective.withOwner(self, () => setInterval(() => {}, 1000));
        return () => clearInterval(id);
      }, [self]);
      return <i>fine</i>;
    }

    render(
      <>
        <Leaky />
        <Innocent />
      </>,
    ).unmount();
    await settle();

    const names = getFindings().map((f) => f.component?.name);
    expect(names).toContain("TheLeaker");
    // Unmounting together must not implicate the neighbour.
    expect(names).not.toContain("Innocent");
  });

  it("keeps a single unexplained resource at low confidence", async () => {
    setup();
    const detective = getDetective();

    function Once() {
      const self = useMemoryTracking("Once");
      useEffect(() => {
        if (!self) return;
        detective.withOwner(self, () => setInterval(() => {}, 1000));
      }, [self]);
      return <i>x</i>;
    }

    render(<Once />).unmount();
    await settle();

    expect(getFindings()).toHaveLength(1);
    // One observation is never high confidence, however clear it looks.
    expect(highConfidence()).toHaveLength(0);
  });

  it("only reaches high confidence once the pattern repeats", async () => {
    setup();
    const detective = getDetective();

    function AlwaysLeaks() {
      const self = useMemoryTracking("AlwaysLeaks");
      useEffect(() => {
        if (!self) return;
        detective.withOwner(self, () => setInterval(() => {}, 1000));
      }, [self]);
      return <i>x</i>;
    }

    for (let i = 0; i < 5; i++) {
      render(<AlwaysLeaks />).unmount();
      await settle(40);
    }

    const last = getFindings().at(-1);
    expect(last?.confidence).toBe("high");
    expect(last?.evidence.join(" ")).toContain("pattern, not a race");
  });
});
