import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceRegistry } from "../src/core/registry.js";
import { runInOwnerScope } from "../src/core/owner.js";
import { instrumentTimers } from "../src/resources/timers.js";
import { instrumentListeners } from "../src/resources/listeners.js";
import type { ListenerMismatch } from "../src/resources/listeners.js";

const owner = { instanceId: "i1", name: "ChatPanel" };
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

const setup = () => {
  const registry = new ResourceRegistry(() => 500);
  return registry;
};

describe("timer instrumentation", () => {
  it("pairs an interval with the clearInterval that releases it", () => {
    const registry = setup();
    restores.push(instrumentTimers(registry, () => false));

    const id = runInOwnerScope(owner, () => setInterval(() => {}, 50));
    expect(registry.activeFor("i1")).toHaveLength(1);

    clearInterval(id);
    expect(registry.activeFor("i1")).toHaveLength(0);
    expect(registry.all()[0]?.status).toBe("released");
  });

  it("marks a fired timeout as self-resolved, not as a cleanup", async () => {
    const registry = setup();
    restores.push(instrumentTimers(registry, () => false));

    runInOwnerScope(owner, () => setTimeout(() => {}, 1));
    await new Promise((r) => globalThis.setTimeout(r, 20));

    // It released itself. Reporting that as a cleanup would be wrong, and
    // reporting it as retention would bury the resources that matter.
    expect(registry.all()[0]?.status).toBe("self-resolved");
    expect(registry.activeFor("i1")).toHaveLength(0);
  });

  it("attributes to the scope that was running, and to nothing otherwise", () => {
    const registry = setup();
    restores.push(instrumentTimers(registry, () => false));

    const owned = runInOwnerScope(owner, () => setInterval(() => {}, 50));
    const orphan = setInterval(() => {}, 50);

    const records = registry.all();
    expect(records[0]?.ownership).toBe("owned");
    expect(records[0]?.owner?.name).toBe("ChatPanel");
    // Created with no scope: claiming an owner here would invent causation.
    expect(records[1]?.ownership).toBe("none");
    expect(records[1]?.owner).toBeUndefined();

    clearInterval(owned);
    clearInterval(orphan);
  });

  it("restores the globals it patched, so repeated setup cannot stack", () => {
    const registry = setup();
    const original = globalThis.setInterval;
    const restore = instrumentTimers(registry, () => false);
    expect(globalThis.setInterval).not.toBe(original);
    restore();
    expect(globalThis.setInterval).toBe(original);
  });
});

describe("listener instrumentation", () => {
  const listeners = (registry: ResourceRegistry, onMismatch = vi.fn()) => {
    restores.push(instrumentListeners(registry, () => false, onMismatch));
    return onMismatch;
  };

  it("pairs add and remove when the same reference is used", () => {
    const registry = setup();
    listeners(registry);
    const handler = () => {};

    runInOwnerScope(owner, () => window.addEventListener("resize", handler));
    expect(registry.activeFor("i1")).toHaveLength(1);

    window.removeEventListener("resize", handler);
    expect(registry.activeFor("i1")).toHaveLength(0);
  });

  it("catches the cleanup that looks right and removes nothing", () => {
    const registry = setup();
    const onMismatch = listeners(registry);
    const handler = () => {};

    runInOwnerScope(owner, () => window.addEventListener("scroll", handler));
    // The classic: a fresh closure in the cleanup. Reviews fine, does nothing.
    window.removeEventListener("scroll", () => handler());

    expect(onMismatch).toHaveBeenCalledTimes(1);
    const mismatch = onMismatch.mock.calls[0]?.[0] as ListenerMismatch;
    expect(mismatch.event).toBe("scroll");
    expect(mismatch.target).toBe("window");
    expect(mismatch.addedOwner?.name).toBe("ChatPanel");
    expect(mismatch.reason).toBe("reference");
    // And the original is still registered, so it stays active.
    expect(registry.activeFor("i1")).toHaveLength(1);
  });

  it("treats capture as part of the identity, because the browser does", () => {
    const registry = setup();
    const onMismatch = listeners(registry);
    const handler = () => {};

    runInOwnerScope(owner, () => window.addEventListener("click", handler, true));
    window.removeEventListener("click", handler); // no capture: does not match

    expect(onMismatch).toHaveBeenCalledTimes(1);
    // Same function, wrong flag — a different mistake needing a different fix.
    expect(onMismatch.mock.calls[0]?.[0]?.reason).toBe("capture");
    expect(registry.activeFor("i1")).toHaveLength(1);
  });

  it("does not flag a once listener, which releases itself", () => {
    const registry = setup();
    listeners(registry);
    runInOwnerScope(owner, () => window.addEventListener("load", () => {}, { once: true }));
    expect(registry.activeFor("i1")).toHaveLength(0);
  });

  it("says nothing when a listener it never saw is removed", () => {
    const registry = setup();
    const onMismatch = listeners(registry);
    window.removeEventListener("resize", () => {});
    expect(onMismatch).not.toHaveBeenCalled();
  });
});

describe("the registry does not become the leak", () => {
  it("stays bounded, and keeps active records in preference to released ones", () => {
    const registry = new ResourceRegistry(() => 100);
    for (let i = 0; i < 1000; i++) {
      const record = registry.create({ type: "custom", label: `r${i}` });
      if (i % 2 === 0) registry.release(record.id);
    }
    expect(registry.all().length).toBeLessThanOrEqual(100);
    // Active records are evidence; released ones are history.
    expect(registry.activeCount).toBeGreaterThan(0);
  });

  it("holds object handles weakly", () => {
    const registry = new ResourceRegistry(() => 10);
    const socket = {};
    registry.create({ type: "websocket", label: "ws", handle: socket });
    // A WeakMap keyed on the handle: tracking a resource can never be the
    // reason it stays alive.
    expect(registry.releaseByHandle(socket)?.status).toBe("released");
  });
});
