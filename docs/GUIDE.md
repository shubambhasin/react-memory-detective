# Guide

1. [Quick start](#quick-start) · 2. [What it detects](#what-it-detects) · 3. [What it cannot detect](#what-it-cannot-detect)
4. [Reading a finding](#reading-a-finding) · 5. [Custom resources](#custom-resources) · 6. [The overlay](#the-overlay)
7. [Memory APIs](#memory-apis) · 8. [StrictMode](#strictmode) · 9. [Performance](#performance)
10. [Privacy](#privacy) · 11. [Troubleshooting](#troubleshooting)

## Quick start

```bash
npm install --save-dev react-memory-detective
```

Add the build plugin — this is what attributes resources to components automatically:

```ts
// vite.config.ts
import { memoryDetective } from "react-memory-detective/vite";
export default defineConfig({ plugins: [memoryDetective(), react()] });
```

```js
// babel.config.js
module.exports = {
  plugins: [process.env.NODE_ENV !== "production" && "react-memory-detective/babel"].filter(Boolean),
};
```

Then initialise:

```tsx
import { init } from "react-memory-detective";

if (process.env.NODE_ENV !== "production") {
  init();
  void import("react-memory-detective/overlay").then((m) => m.mountOverlay());
}
```

Timers, listeners, sockets, observers, workers and `fetch` are instrumented globally from that
moment. The plugin supplies the missing half: which component created each one.

### Why a build step

Effects run after render, so at the moment a `setInterval` is created there is nothing in the
runtime that says which component's effect is running. Without the plugin, a resource created in an
ordinary `useEffect` has no owner — it is still tracked, but it cannot be attributed, and an
unattributed resource is not reported at all, because blaming whichever component happened to be
mounted is exactly the guesswork this tool refuses to do.

The plugin wraps each component's effect bodies in that component's scope. Everything created inside
is attributed; nothing else changes, and nothing ships to the browser.

### Declaring ownership by hand

For a resource created outside an effect, or if you would rather not add a build step:

```tsx
import { useMemoryTracking, useTrackedResource } from "react-memory-detective";

function ChatPanel({ url }) {
  const self = useMemoryTracking("ChatPanel");

  useTrackedResource(self, {
    type: "websocket",
    name: "chat socket",
    create: () => new WebSocket(url),
    cleanup: (socket) => socket.close(),
    deps: [url],
  });
}
```

`cleanup` is a required argument, so forgetting it is a type error rather than a silent leak.

## What it detects

| | how certain |
| --- | --- |
| an interval, listener, socket, observer, channel or worker still alive after its owner unmounted | evidence; confidence grows with repetition |
| `removeEventListener` called with a different function reference | **fact** — both references were observed |
| `removeEventListener` called with a different capture flag | **fact**, and a different fix |
| the same retention repeating across mount/unmount cycles | high confidence |

## What it cannot detect

Read [FEASIBILITY.md](FEASIBILITY.md) for the full classification. In short:

- **Whether an object is actually unreachable.** Garbage collection is not observable from a page,
  so a resource still alive after unmount is *retention evidence*, never proof of a leak.
- **Retaining paths.** Why an object is still reachable needs a heap walk — that is Chrome
  DevTools' job, and this tool does not try to replace it.
- **Detached DOM nodes**, or per-component memory in megabytes. No API apportions heap by component;
  any such figure would be invented.
- **Resources created outside a tracked scope.** They are recorded with no owner rather than
  attributed to whichever component happened to be mounted.

## Reading a finding

```text
▲ ChatPanel unmounted, but 1 × websocket created by it is still active.

Component:   ChatPanel
Confidence:  high
  • ChatPanel unmounted, and 1 resource created by it is still active more than 1500ms later.
  • Still active: 1 × websocket.
  •   WebSocket wss://chat.example.com — created at src/ChatPanel.tsx:47:12
  • Every one of 20 mount/unmount cycles left resources behind. That is a pattern, not a race.
  • Garbage collection cannot be observed from a page, so this is retention evidence, not proof of a leak.
Next step:   Return a cleanup from the effect that calls socket.close(), for the resource created at src/ChatPanel.tsx:47:12.
```

Confidence is earned by repetition, not asserted:

| | |
| --- | --- |
| `low` | seen once — quite possibly an async close that had not finished |
| `medium` | several cycles left resources behind |
| `high` | every one of N cycles did, or a listener mismatch, which needs no repetition |

`console` mode hides low-confidence observations; `verbose` shows everything.

## Custom resources

For anything not instrumented automatically — a store subscription, a third-party handle:

```tsx
import { trackResource } from "react-memory-detective";

useEffect(() => {
  const unsubscribe = store.subscribe(onChange);
  return trackResource({ type: "subscription", name: "user-store", cleanup: unsubscribe });
}, []);
```

`trackResource` returns the release function, so returning it from the effect both cleans up and
records that cleanup happened.

## The overlay

```ts
const { mountOverlay } = await import("react-memory-detective/overlay");
mountOverlay();
```

Findings, evidence and the active resource count, in a shadow root **outside** the React tree —
an inspector rendered inside the tree would add the very lifecycle events it reports on. It is
lazily imported and never reaches a production bundle.

## Memory APIs

Usually unavailable, and the tool says so rather than inventing a number:

- `performance.memory` — Chrome and Edge only, non-standard, deliberately quantised
- `measureUserAgentSpecificMemory()` — needs cross-origin isolation (COOP + COEP)
- Firefox and Safari — neither

This is why the resource registry is the product and megabytes are a footnote. Everything above
works with no memory API at all.

## StrictMode

React mounts, unmounts and remounts every component in development. That is exactly the shape a
leak detector hunts for, so without special handling every component in every StrictMode app would
be reported. The remount is recognised, the unmount count reversed, and nothing is diagnosed from
the simulated cycle.

## Performance

Instrumentation is a wrapper around each patched global and a `Map` write per resource. Diagnosis
runs on a timer after unmount, never during render. Records are bounded by `maxRecords` (default
2000) and evicted released-first, since an active record is still evidence.

`shutdown()` restores every patched global. `init()` is idempotent — three calls patch once.

## Privacy

No network, no telemetry, no storage. Nothing leaves the browser. That matters more here than
usual: memory debugging touches tokens, user data and API responses.

Resource labels contain URLs (a socket's endpoint, a fetch path). They stay in memory and are never
transmitted, but they are visible in the overlay — worth knowing before screen-sharing.

## Troubleshooting

**Nothing is reported.** `init()` may have decided you are in production; pass `enabled: true`.
Findings also wait out `cleanupGracePeriodMs` (default 1500ms) after unmount.

**A finding has no component, or a leak you can see is not reported at all.** The resource was
created outside a tracked scope. Add the build plugin — this is the usual cause, and the reason the
plugin is the first step of the quick start rather than an optional extra. Failing that, wrap the
effect with `ownEffect(self, …)` or create the resource with `useTrackedResource`.

**A component's mount count is doubled.** Either `useMemoryTracking` is being called twice for it,
or StrictMode is on and the replay was not recognised — the second is a bug worth reporting.

**A legitimate global is being reported.** It should not be — that is what the false-positive suite
covers. If it happens, it is a bug worth reporting, with the finding's evidence.

**Everything is low confidence.** That is the design. Repeat the interaction: confidence comes from
the pattern repeating, not from one convincing-looking observation.
