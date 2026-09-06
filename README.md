# React Memory Detective

**Find what your React components forgot to clean up.**

Not:

```text
Heap: 142 MB
Detached DOM tree
```

But:

```text
▲ ChatPanel unmounted, but 1 × websocket created by it is still active.

Component:   ChatPanel
Confidence:  high
  • ChatPanel unmounted, and 1 resource created by it is still active more than 1500ms later.
  • Still active: 1 × websocket.
  •   wss://chat.example.com — created at src/ChatPanel.tsx:47:12
  • Every one of 20 mount/unmount cycles left resources behind. That is a pattern, not a race.
  • Garbage collection cannot be observed from a page, so this is retention evidence, not proof of a leak.
Next step:   Return a cleanup from the effect that calls socket.close(), for the resource created at src/ChatPanel.tsx:47:12.
```

> **Status: pre-release, deliberately.** The core is built and tested; nothing is published, and the
> version is `0.0.0` so it cannot go out by accident. [What has to be true first.](docs/RELEASE-CRITERIA.md)

---

## What it does

It connects three things the browser keeps separate:

```text
React component  →  the effect that ran  →  the resource it created  →  whether it was released
```

Chrome DevTools can tell you an object is retained. It cannot tell you which component made it, in
which effect, or that the matching `clearInterval` was never called. That gap is the product.

## What it will not do

**It will never print "MEMORY LEAK DETECTED".** Garbage collection is not observable from a page, so
a resource still alive after unmount is *evidence of retention*, not proof of a leak. Every finding
carries a confidence level, and confidence is earned by repetition:

| observation | confidence |
| --- | --- |
| one resource outlived one unmount | low — quite possibly an async close mid-flight |
| several cycles left resources behind | medium |
| every one of N cycles did | high |
| `removeEventListener` was called with the wrong function | **high immediately** — the mechanism is certain |

That last row is the exception. `removeEventListener` only detaches a listener when the function
reference, event type and capture flag all match, so a cleanup like

```js
return () => window.removeEventListener("resize", () => handler());
```

removes nothing at all. Both references pass through the instrumentation, so this is reported as
fact, not suspicion — and the wrong-capture-flag variant is caught separately, because it needs a
different fix.

## Honest about memory

The megabyte counter is the **weakest** signal here, and the design says so:

- `performance.memory` is Chrome and Edge only, non-standard, and deliberately quantised.
- `performance.measureUserAgentSpecificMemory()` needs the page to be cross-origin isolated
  (COOP + COEP), which most applications are not.
- Firefox and Safari have neither.

So the **resource registry is the spine**. "This component created a `setInterval` and no
`clearInterval` was ever observed for that handle" is exact, universal, and needs no memory API.
Where a memory figure is available it is reported as supporting evidence; where it is not, the tool
says so and carries on.

Read [docs/FEASIBILITY.md](docs/FEASIBILITY.md) — every capability is classified as reliable,
inferred, or impossible, and it was written before any of it was built.

## Install

```bash
npm install react-memory-detective
```

```tsx
import { init } from "react-memory-detective";
if (process.env.NODE_ENV !== "production") init();
```

Track a component and the resources it owns:

```tsx
import { useMemoryTracking, useTrackedResource } from "react-memory-detective";

function ChatPanel() {
  const self = useMemoryTracking("ChatPanel");

  useTrackedResource(self, {
    type: "websocket",
    name: "chat socket",
    create: () => new WebSocket(url),
    cleanup: (socket) => socket.close(),
  });
}
```

`cleanup` is a required argument, so forgetting it is a type error rather than a silent leak.

Timers and listeners are instrumented globally, so they are caught with no code changes at all.

## Design commitments

- **Ownership is claimed, never guessed.** A resource created inside a tracked scope is *owned*; one
  created while some component merely happened to be mounted has no owner, and the tool says so
  rather than picking the nearest candidate.
- **The tool must not be the leak.** Object handles live in a `WeakMap`, records are bounded and
  evicted released-first, and `shutdown()` restores every patched global. There is a dedicated test
  for this.
- **StrictMode is handled first, not last.** Its simulated unmount produces exactly the shape a leak
  detector looks for; without special handling every component in every StrictMode app would be
  reported. The remount is recognised and the count reversed.
- **A fired `setTimeout` is not a leak.** It released itself. Conflating that with an uncleared
  `setInterval` would bury the findings that matter.
- **Nothing leaves the browser.** No telemetry, no network, no storage — which matters more here
  than usual, because memory debugging touches tokens and user data.

## Licence

MIT
