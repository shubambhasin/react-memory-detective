import type { ResourceRegistry } from "../core/registry.js";
import { captureSource } from "./source.js";
import type { ResourceType } from "../core/types.js";

interface ConnectionSpec {
  /** Global constructor name, e.g. `WebSocket`. */
  global: string;
  type: ResourceType;
  /** Method that releases it. */
  release: string;
  /** Human label from the instance. */
  describe: (instance: unknown) => string;
  /**
   * Events after which the resource is gone without anyone calling `release` —
   * a socket the server closed is not something the component failed to clean
   * up, and reporting it as retention would be wrong.
   */
  selfResolvesOn?: string[];
}

const SPECS: ConnectionSpec[] = [
  {
    global: "WebSocket",
    type: "websocket",
    release: "close",
    describe: (i) => `WebSocket ${(i as { url?: string }).url ?? ""}`.trim(),
    selfResolvesOn: ["close", "error"],
  },
  {
    global: "EventSource",
    type: "event-source",
    release: "close",
    describe: (i) => `EventSource ${(i as { url?: string }).url ?? ""}`.trim(),
    selfResolvesOn: ["error"],
  },
  {
    global: "BroadcastChannel",
    type: "broadcast-channel",
    release: "close",
    describe: (i) => `BroadcastChannel ${(i as { name?: string }).name ?? ""}`.trim(),
  },
  { global: "Worker", type: "worker", release: "terminate", describe: () => "Worker" },
  { global: "MutationObserver", type: "mutation-observer", release: "disconnect", describe: () => "MutationObserver" },
  { global: "ResizeObserver", type: "resize-observer", release: "disconnect", describe: () => "ResizeObserver" },
  {
    global: "IntersectionObserver",
    type: "intersection-observer",
    release: "disconnect",
    describe: () => "IntersectionObserver",
  },
];

type Ctor = new (...args: never[]) => object;

/**
 * Connections, observers and workers.
 *
 * All seven share one shape — constructed, then released by a single method —
 * so they share one implementation. The constructor is wrapped rather than the
 * prototype, so the instance is known at creation time and can be paired with
 * its release without a registry lookup by identity.
 */
export function instrumentConnections(
  registry: ResourceRegistry,
  shouldCaptureSource: () => boolean,
  enabled: (type: ResourceType) => boolean,
): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const restores: Array<() => void> = [];

  for (const spec of SPECS) {
    if (!enabled(spec.type)) continue;
    const Original = target[spec.global] as Ctor | undefined;
    if (typeof Original !== "function") continue;

    const releaseName = spec.release;
    const originalRelease = (Original.prototype as Record<string, unknown>)[releaseName];
    if (typeof originalRelease !== "function") continue;

    const Patched = function PatchedConnection(this: object, ...args: never[]) {
      const instance = new Original(...args);
      try {
        const record = registry.create({
          type: spec.type,
          label: spec.describe(instance),
          handle: instance,
          source: shouldCaptureSource() ? captureSource() : undefined,
        });

        /*
         * A socket the peer closed is gone, and the component did not fail to
         * clean anything up. Marking it self-resolved keeps it out of the
         * findings without pretending a cleanup was observed.
         */
        for (const event of spec.selfResolvesOn ?? []) {
          (instance as EventTarget).addEventListener?.(event, () => {
            registry.release(record.id, "self-resolved");
          });
        }
      } catch {
        /* instrumentation must never break construction */
      }
      return instance;
    } as unknown as Ctor;

    // Keep the prototype chain intact: `socket instanceof WebSocket` must hold.
    Patched.prototype = Original.prototype;
    Object.setPrototypeOf(Patched, Original);
    Object.defineProperty(Patched, "name", { value: spec.global, configurable: true });

    (Original.prototype as Record<string, unknown>)[releaseName] = function patchedRelease(this: object, ...args: never[]) {
      registry.releaseByHandle(this);
      return (originalRelease as (...a: never[]) => unknown).apply(this, args);
    };

    target[spec.global] = Patched;
    restores.push(() => {
      target[spec.global] = Original;
      (Original.prototype as Record<string, unknown>)[releaseName] = originalRelease;
    });
  }

  return () => {
    while (restores.length) restores.pop()?.();
  };
}
