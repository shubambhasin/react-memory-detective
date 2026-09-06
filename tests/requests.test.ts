import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceRegistry } from "../src/core/registry.js";
import { runInOwnerScope } from "../src/core/owner.js";
import { instrumentRequests } from "../src/resources/requests.js";
import { diagnoseOutlivedResources } from "../src/core/diagnose.js";

const owner = { instanceId: "i1", name: "SearchResults" };
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  vi.restoreAllMocks();
});

const setup = (impl: typeof fetch) => {
  vi.stubGlobal("fetch", impl);
  const registry = new ResourceRegistry(() => 100);
  restores.push(instrumentRequests(registry, () => false));
  restores.push(() => vi.unstubAllGlobals());
  return registry;
};

describe("in-flight requests", () => {
  it("records a request and releases it when it settles", async () => {
    const registry = setup((async () => new Response("ok")) as typeof fetch);

    await runInOwnerScope(owner, () => fetch("/api/search?q=x"));
    expect(registry.all()[0]?.label).toContain("/api/search");
    // Settling is the request resolving itself, not a cleanup anyone performed.
    expect(registry.all()[0]?.status).toBe("self-resolved");
  });

  it("records a rejection as resolved too, since nothing is left holding on", async () => {
    const registry = setup((async () => {
      throw new Error("network");
    }) as typeof fetch);

    await expect(runInOwnerScope(owner, () => fetch("/api/x"))).rejects.toThrow("network");
    expect(registry.all()[0]?.status).toBe("self-resolved");
  });

  it("treats an abort as the cleanup it is", async () => {
    const registry = setup(((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch);

    const controller = new AbortController();
    const pending = runInOwnerScope(owner, () => fetch("/api/slow", { signal: controller.signal }));
    expect(registry.activeFor("i1")).toHaveLength(1);

    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(registry.all()[0]?.status).toBe("released");
  });

  it("never becomes a finding on its own, because that is normal", () => {
    /*
     * A request continuing after unmount is ordinary: the response may fill a
     * cache, or a write must complete whatever the user navigated away from.
     * It is recorded for context and excluded from the diagnosis.
     */
    const finding = diagnoseOutlivedResources({
      resources: [
        {
          id: "r1",
          type: "request",
          label: "fetch /api/search",
          status: "active",
          createdAt: 0,
          owner,
          ownership: "owned",
          outlivedOwnerAt: 100,
        },
      ],
      cycles: 20,
      cyclesWithRetention: 20,
      gracePeriodMs: 1000,
    });
    expect(finding).toBeUndefined();
  });
});
