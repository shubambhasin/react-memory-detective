import { useEffect, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getFindings, init, ownEffect, reset, useMemoryTracking } from "../src/index.js";
import type { Finding } from "../src/core/types.js";

const restores: Array<() => void> = [];

afterEach(() => {
  cleanup();
  reset();
  while (restores.length) restores.pop()?.();
});

/** jsdom ships neither a ResizeObserver nor a socket worth driving. */
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
class FakeSocket extends EventTarget {
  constructor(public url: string) {
    super();
  }
  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

/** Must run before init(), which is when the globals are patched. */
function installFakes(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of [["ResizeObserver", FakeResizeObserver], ["WebSocket", FakeSocket]] as const) {
    const prior = g[name];
    g[name] = value;
    restores.push(() => {
      g[name] = prior;
    });
  }
}

const setup = () => init({ enabled: true, mode: "silent", cleanupGracePeriodMs: 20 });

/**
 * Mounts and unmounts a component the way the build plugin would have written
 * it: the effect body runs inside its component's owner scope. Confidence is
 * earned by repetition, so a real answer needs several cycles.
 */
async function cycle(ui: React.ReactElement, times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    const view = render(ui);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
  }
}

const forComponent = (name: string): Finding[] => getFindings().filter((f) => f.component?.name === name);

/**
 * One fixture per resource type, each with an answer known in advance. These
 * are the claims the package makes in its README; if one of them stops holding,
 * the documentation is wrong and the tool is not worth installing.
 */
describe("known leaks are detected and attributed", () => {
  it("finds an uncleared interval and names the component", async () => {
    setup();
    function LeakyPoller() {
      const self = useMemoryTracking("LeakyPoller");
      useEffect(ownEffect(self, () => { setInterval(() => {}, 1000); }), []);
      return <div />;
    }
    await cycle(<LeakyPoller />);
    const findings = forComponent("LeakyPoller");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.confidence === "high")).toBe(true);
    expect(findings.some((f) => f.resources.some((r) => r.type === "interval"))).toBe(true);
  });

  it("finds an undisconnected observer", async () => {
    installFakes();
    setup();
    function LeakyObserver() {
      const self = useMemoryTracking("LeakyObserver");
      const ref = useRef<HTMLDivElement>(null);
      useEffect(ownEffect(self, () => {
        if (ref.current) new ResizeObserver(() => {}).observe(ref.current);
      }), []);
      return <div ref={ref} />;
    }
    await cycle(<LeakyObserver />);
    expect(forComponent("LeakyObserver").some((f) => f.confidence === "high")).toBe(true);
  });

  it("finds an unclosed socket", async () => {
    installFakes();
    setup();
    function LeakySocket() {
      const self = useMemoryTracking("LeakySocket");
      useEffect(ownEffect(self, () => { new WebSocket("ws://localhost:1/"); }), []);
      return <div />;
    }
    await cycle(<LeakySocket />);
    expect(forComponent("LeakySocket").some((f) => f.resources.some((r) => r.type === "websocket"))).toBe(true);
  });

  it("finds a mismatched listener immediately, with high confidence and no repetition", async () => {
    setup();
    function MismatchedListener() {
      const self = useMemoryTracking("MismatchedListener");
      useEffect(ownEffect(self, () => {
        const handler = () => {};
        window.addEventListener("resize", handler);
        return () => window.removeEventListener("resize", () => handler());
      }), []);
      return <div />;
    }
    await cycle(<MismatchedListener />, 1);
    const findings = forComponent("MismatchedListener");
    expect(findings.some((f) => f.kind === "listener-mismatch" && f.confidence === "high")).toBe(true);
  });
});

describe("one problem is one finding", () => {
  it("collapses repeated observations into a count rather than a growing list", async () => {
    setup();
    function LeakyPoller() {
      const self = useMemoryTracking("LeakyPoller");
      useEffect(ownEffect(self, () => { setInterval(() => {}, 1000); }), []);
      return <div />;
    }
    await cycle(<LeakyPoller />, 8);
    const findings = forComponent("LeakyPoller");
    // Eight leaking cycles, still one problem.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences ?? 0).toBeGreaterThan(1);
    expect(findings[0]?.firstObservedAt).toBeLessThanOrEqual(findings[0]!.observedAt);
  });

  it("drops the early suspicion once the same leak is proven by repetition", async () => {
    setup();
    function LeakyPoller() {
      const self = useMemoryTracking("LeakyPoller");
      useEffect(ownEffect(self, () => { setInterval(() => {}, 1000); }), []);
      return <div />;
    }
    await cycle(<LeakyPoller />, 6);
    const kinds = forComponent("LeakyPoller").map((f) => f.kind);
    expect(kinds).toContain("repeated-retention");
    expect(kinds).not.toContain("outlived-owner");
  });

  it("reports a mismatched listener once, not also as a retained listener", async () => {
    setup();
    function MismatchedListener() {
      const self = useMemoryTracking("MismatchedListener");
      useEffect(ownEffect(self, () => {
        const handler = () => {};
        window.addEventListener("resize", handler);
        return () => window.removeEventListener("resize", () => handler());
      }), []);
      return <div />;
    }
    await cycle(<MismatchedListener />, 5);
    const kinds = new Set(forComponent("MismatchedListener").map((f) => f.kind));
    expect(kinds).toEqual(new Set(["listener-mismatch"]));
  });

  it("still reports a second, different leak from a component that also mismatches a listener", async () => {
    setup();
    function DoublyLeaky() {
      const self = useMemoryTracking("DoublyLeaky");
      useEffect(ownEffect(self, () => {
        const handler = () => {};
        window.addEventListener("resize", handler);
        setInterval(() => {}, 1000);
        return () => window.removeEventListener("resize", () => handler());
      }), []);
      return <div />;
    }
    await cycle(<DoublyLeaky />, 5);
    const kinds = new Set(forComponent("DoublyLeaky").map((f) => f.kind));
    expect(kinds).toContain("listener-mismatch");
    expect([...kinds].some((k) => k === "repeated-retention" || k === "outlived-owner")).toBe(true);
  });
});

describe("nothing the tool says is an overclaim", () => {
  it("never states a leak as a conclusion, however strong the evidence", async () => {
    setup();
    function LeakyPoller() {
      const self = useMemoryTracking("LeakyPoller");
      useEffect(ownEffect(self, () => {
        const handler = () => {};
        window.addEventListener("resize", handler);
        setInterval(() => {}, 1000);
        return () => window.removeEventListener("resize", () => handler());
      }), []);
      return <div />;
    }
    await cycle(<LeakyPoller />, 6);

    const findings = getFindings();
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      const text = [finding.summary, ...finding.evidence, finding.suggestion ?? ""].join(" ");
      /*
       * The word may appear in a component's own name, and it appears in the
       * standing disclaimer ("not proof of a leak"). What must never appear is
       * the word used as an assertion, which would claim that collection was
       * observed — something a page cannot do.
       */
      expect(text).not.toMatch(/\b(memory leak|leaked|leaking|is a leak|leak detected)\b/i);
      expect(finding.confidence).toBeTruthy();
      expect(finding.evidence.length).toBeGreaterThan(0);
      if (finding.kind !== "listener-mismatch") {
        expect(finding.evidence.at(-1)).toContain("retention evidence, not proof of a leak");
      }
    }
  });
});

/**
 * The case a fixture app cannot produce: several components, and library code,
 * all listening to the same event on the same target. Blaming the first
 * registration is a confident finding pointing at the wrong component.
 */
describe("attribution when many listeners share one event", () => {
  it("blames the component that actually stranded the listener, not the first registrant", async () => {
    setup();
    // A bystander registers first, exactly as application or library code does.
    const bystander = () => {};
    window.addEventListener("resize", bystander);
    restores.push(() => window.removeEventListener("resize", bystander));

    function Culprit() {
      const self = useMemoryTracking("Culprit");
      useEffect(ownEffect(self, () => {
        const handler = () => {};
        window.addEventListener("resize", handler);
        return () => window.removeEventListener("resize", () => handler());
      }), []);
      return <div />;
    }
    await cycle(<Culprit />, 2);

    const mismatches = getFindings().filter((f) => f.kind === "listener-mismatch");
    expect(mismatches.length).toBeGreaterThan(0);
    for (const finding of mismatches) {
      expect(finding.component?.name ?? "Culprit").toBe("Culprit");
    }
  });

  it("states the mismatch but names no component when it genuinely cannot tell", async () => {
    setup();
    // Two unowned listeners on one event; the removal matches neither.
    const first = () => {};
    const second = () => {};
    window.addEventListener("scroll", first);
    window.addEventListener("scroll", second);
    restores.push(() => {
      window.removeEventListener("scroll", first);
      window.removeEventListener("scroll", second);
    });
    window.removeEventListener("scroll", () => {});

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const mismatches = getFindings().filter((f) => f.kind === "listener-mismatch");
    expect(mismatches.length).toBeGreaterThan(0);
    // The fact is stated; the blame is not invented.
    expect(mismatches[0]?.component).toBeUndefined();
  });

  it("says nothing when a removal matches no listener at all", async () => {
    setup();
    window.removeEventListener("pointerdown", () => {});
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getFindings().filter((f) => f.kind === "listener-mismatch")).toHaveLength(0);
  });
});
