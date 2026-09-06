import { afterEach, describe, expect, it } from "vitest";
import { ResourceRegistry } from "../src/core/registry.js";
import { runInOwnerScope } from "../src/core/owner.js";
import { instrumentConnections } from "../src/resources/connections.js";

const owner = { instanceId: "i1", name: "ChatPanel" };
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

/** jsdom has no WebSocket worth driving, so a minimal stand-in is installed. */
class FakeSocket extends EventTarget {
  closed = false;
  constructor(public url: string) {
    super();
  }
  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

class FakeObserver {
  connected = true;
  disconnect(): void {
    this.connected = false;
  }
}

const withGlobals = (fn: () => void) => {
  const g = globalThis as unknown as Record<string, unknown>;
  const priorSocket = g.WebSocket;
  const priorObserver = g.MutationObserver;
  g.WebSocket = FakeSocket;
  g.MutationObserver = FakeObserver;
  try {
    fn();
  } finally {
    g.WebSocket = priorSocket;
    g.MutationObserver = priorObserver;
  }
};

const setup = (registry: ResourceRegistry) => {
  restores.push(instrumentConnections(registry, () => false, () => true));
};

describe("connections and observers", () => {
  it("pairs a socket with the close() that releases it", () => {
    withGlobals(() => {
      const registry = new ResourceRegistry(() => 100);
      setup(registry);

      const socket = runInOwnerScope(owner, () => new (globalThis as never as { WebSocket: typeof FakeSocket }).WebSocket("wss://x"));
      expect(registry.activeFor("i1")).toHaveLength(1);
      expect(registry.all()[0]?.label).toContain("wss://x");

      socket.close();
      expect(registry.activeFor("i1")).toHaveLength(0);
    });
  });

  it("does not blame the component when the peer closes the socket", () => {
    withGlobals(() => {
      const registry = new ResourceRegistry(() => 100);
      setup(registry);

      const socket = runInOwnerScope(owner, () => new (globalThis as never as { WebSocket: typeof FakeSocket }).WebSocket("wss://x"));
      // A server-side close is not a cleanup the component failed to do.
      socket.dispatchEvent(new Event("close"));

      expect(registry.all()[0]?.status).toBe("self-resolved");
      expect(registry.activeFor("i1")).toHaveLength(0);
    });
  });

  it("pairs an observer with disconnect()", () => {
    withGlobals(() => {
      const registry = new ResourceRegistry(() => 100);
      setup(registry);

      const observer = runInOwnerScope(
        owner,
        () => new (globalThis as never as { MutationObserver: typeof FakeObserver }).MutationObserver(),
      );
      expect(registry.activeFor("i1")).toHaveLength(1);

      observer.disconnect();
      expect(registry.activeFor("i1")).toHaveLength(0);
      expect(observer.connected).toBe(false); // the real behaviour still happens
    });
  });

  it("keeps instanceof working, so instrumentation cannot change app behaviour", () => {
    withGlobals(() => {
      setup(new ResourceRegistry(() => 100));
      const Socket = (globalThis as never as { WebSocket: typeof FakeSocket }).WebSocket;
      const socket = new Socket("wss://x");
      expect(socket).toBeInstanceOf(FakeSocket);
      expect(Socket.name).toBe("WebSocket");
    });
  });

  it("restores both the constructor and the release method", () => {
    withGlobals(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      const originalCtor = g.WebSocket;
      const originalClose = FakeSocket.prototype.close;

      const restore = instrumentConnections(new ResourceRegistry(() => 10), () => false, () => true);
      expect(g.WebSocket).not.toBe(originalCtor);
      restore();

      expect(g.WebSocket).toBe(originalCtor);
      expect(FakeSocket.prototype.close).toBe(originalClose);
    });
  });
});
