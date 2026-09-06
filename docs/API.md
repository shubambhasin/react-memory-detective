# API Reference

Everything is exported from the package root. `react-memory-detective/core` is the React-free model
and diagnosis; `react-memory-detective/overlay` is the optional inspector.

## Setup

### `init(options?): void`

Enables instrumentation and attaches the console reporter. **Idempotent** — repeated calls
reconfigure the single instance and never patch a global twice.

```ts
init({
  enabled: process.env.NODE_ENV !== "production",
  mode: "console",              // "silent" | "console" | "verbose"
  cleanupGracePeriodMs: 1500,   // wait before treating a live resource as notable
  maxRecords: 2000,             // bounded history
  captureSource: true,          // capture a stack at creation for file:line
  track: { timers: true, listeners: true, observers: true, sockets: true, workers: true, requests: true },
  onFinding: (finding) => {},
});
```

`enabled` defaults to `true` unless `NODE_ENV === "production"` is positively detected — calling
`init()` is the intent to turn it on, and guarding the call is what lets a bundler remove it.

### `shutdown(): void` · `reset(): void`

`shutdown` restores every patched global and stops reporting. `reset` also clears all state.

## Tracking

### `useMemoryTracking(name): ComponentRef | undefined`

Tracks this component's lifecycle and returns its identity. Instance identity is per mount, so two
`<UserCard />`s are never merged.

### `useTrackedResource(owner, spec): void`

| field | |
| --- | --- |
| `type` | a `ResourceType` |
| `name` | label shown in findings |
| `create()` | runs inside the owner scope, so what it creates is attributed |
| `cleanup(resource)` | required — forgetting it is a type error |
| `deps` | effect dependencies |

### `trackResource({ type, name, cleanup? }): () => void`

Registers a resource created outside a tracked effect and returns its release function. Return that
from your effect to both clean up and record the cleanup.

## Reading results

### `getMemoryReport(): MemoryReport`

Per-component lifecycle counts, active resources, resources outliving their owner, findings, and
memory when available.

### `getFindings(): Finding[]` · `subscribe(listener): () => void` · `clear()` · `printReport()`

## Types

```ts
type ResourceType =
  | "timeout" | "interval" | "animation-frame" | "idle-callback"
  | "event-listener" | "websocket" | "event-source"
  | "mutation-observer" | "resize-observer" | "intersection-observer"
  | "broadcast-channel" | "worker" | "subscription" | "request" | "custom";

/** "released" = someone released it. "self-resolved" = it ended on its own. */
type ResourceStatus = "active" | "released" | "self-resolved";

/** Claimed only with a tracked scope; otherwise "none". Never guessed. */
type OwnershipKind = "owned" | "associated" | "none";

type FindingKind = "outlived-owner" | "listener-mismatch" | "repeated-retention" | "growth-pattern";

interface Finding {
  kind: FindingKind;
  component?: ComponentRef;
  resources: ResourceRecord[];
  summary: string;          // never says "leak"
  evidence: string[];
  suggestion?: string;
  confidence: "high" | "medium" | "low";
  severity: "info" | "warning" | "high" | "critical";
}
```

## `react-memory-detective/core`

`ResourceRegistry`, `MemoryProvider`, `diagnoseOutlivedResources`, `diagnoseListenerMismatch`,
`runInOwnerScope`, and the types. No globals are patched by importing it, and no React is involved —
the diagnostic engine is testable on its own, which is where the accuracy claims are earned.

## `react-memory-detective/vite`

```ts
import { memoryDetective } from "react-memory-detective/vite";

memoryDetective({
  enabled?: boolean;          // defaults to NODE_ENV !== "production"
  include?: (string | RegExp)[];
  exclude?: (string | RegExp)[];
  importSource?: string;      // override the runtime import, for monorepos
  filter?: (id: string) => boolean;  // defaults to .jsx/.tsx outside node_modules
});
```

A Vite plugin with `apply: "serve"` and `enforce: "pre"`, so it sees JSX before
`@vitejs/plugin-react` and never runs in a production build. It requires `@babel/core`, which is an
optional peer dependency: install it if you use the plugin, ignore it if you do not.

## `react-memory-detective/babel`

The same transform as a plain Babel plugin, for Next.js, CRA, Metro and Webpack. It accepts the same
options minus `filter`.

**What it does, exactly.** For each function whose name is capitalised and which returns JSX, and
only if that component calls an effect hook:

```diff
  function ChatPanel() {
+   const _rmdSelf = useMemoryTracking("ChatPanel");
-   useEffect(() => { … }, []);
+   useEffect(ownEffect(_rmdSelf, () => { … }), []);
    return <div />;
  }
```

Nothing else is touched: not custom hooks, not helper functions, not components without effects, and
nothing under `node_modules`. A component that already calls `useMemoryTracking` has its own
variable reused, so mounts are never counted twice.

## `ownEffect(self, effect)`

The runtime half of the plugin, exported for hand-written use and for build setups that cannot take
a plugin:

```tsx
const self = useMemoryTracking("ChatPanel");
useEffect(ownEffect(self, () => {
  const socket = new WebSocket(url);   // attributed to ChatPanel
  return () => socket.close();
}), []);
```

It wraps only the creation path; the destructor it returns is passed through untouched, because
releases are paired by handle rather than by scope.
