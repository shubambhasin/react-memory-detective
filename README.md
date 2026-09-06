# React Memory Detective

[![npm](https://img.shields.io/npm/v/react-memory-detective?color=%230b7285)](https://www.npmjs.com/package/react-memory-detective)
[![bundle](https://img.shields.io/badge/runtime-9.4%20KB%20gzip-0b7285)](docs/GUIDE.md)
[![dependencies](https://img.shields.io/badge/dependencies-0-0b7285)](https://www.npmjs.com/package/react-memory-detective?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/react-memory-detective?color=%230b7285)](LICENSE)

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

```bash
npm install --save-dev react-memory-detective
```

> **Status: 0.1.0, published with provenance.** Dev-time only, zero runtime dependencies, and it
> refuses to run in a production build. Released from CI on a tag, never from a laptop.
> [Every box that had to be ticked first.](docs/RELEASE-CRITERIA.md)

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

## What it found in a real application

Before release it was pointed at [Excalidraw](https://github.com/excalidraw/excalidraw) — 218
component files, 111 effect call sites, 229 live resources at rest — with a leak planted in one real
component. Twelve mount/unmount cycles later, two findings and nothing else:

```text
▲ ColorPickerComponent unmounted, but 2 × interval, 2 × event-listener created by it are still active.

Component:   ColorPickerComponent
Confidence:  high
  • ColorPickerComponent unmounted, and 4 resources created by it are still active more than 1500ms later.
  • Still active: 2 × interval, 2 × event-listener.
  •   setInterval(1000ms) — created at packages/excalidraw/components/ColorPicker/ColorPicker.tsx:275:5
  •   resize on window   — created at packages/excalidraw/components/ColorPicker/ColorPicker.tsx:279:12
  • Every one of 12 mount/unmount cycles left resources behind. That is a pattern, not a race.
  • Garbage collection cannot be observed from a page, so this is retention evidence, not proof of a leak.
```

Remove the planted leak and it goes silent again: twelve more cycles, zero findings. Both halves
matter — quiet on correct code, and still accurate inside 229 resources of real-application noise.
*(Absolute monorepo paths shortened above for width.)*

That exercise also found five defects in this package that a green test suite and a perfect fixture
app had both missed, the worst of which was a mismatch finding that blamed the first listener
registered for an event rather than the one actually stranded. The fixture app had exactly one
listener per event, so it was always right; real applications have several.
[The full list is in the changelog.](CHANGELOG.md)

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
npm install --save-dev react-memory-detective
```

### 1. Add the build plugin

This is the step that makes the tool useful on code you have not already instrumented. Effects run
after render, so a socket opened inside a plain `useEffect` arrives with no way to tell which
component opened it. The plugin runs the effect body inside its component's scope, and everything
created in there is attributed automatically.

```ts
// vite.config.ts
import { memoryDetective } from "react-memory-detective/vite";

export default defineConfig({
  plugins: [memoryDetective(), react()],
});
```

```js
// babel.config.js — Next.js, CRA, Metro, Webpack
module.exports = {
  plugins: [process.env.NODE_ENV !== "production" && "react-memory-detective/babel"].filter(Boolean),
};
```

The plugin only touches components — functions whose name is capitalised and which return JSX. It
skips `node_modules`, does nothing when `NODE_ENV` is `production`, and adds no runtime dependency:
the compiler stays in your build, never in the bundle.

### 2. Initialise

```tsx
import { init } from "react-memory-detective";
if (process.env.NODE_ENV !== "production") init();
```

That is the whole setup. Mount and unmount a screen a few times and findings appear in the console.

### Without the plugin

If you would rather not add a build step, declare ownership by hand. This is also the right tool for
a resource created outside an effect:

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

`cleanup` is a required argument, so forgetting it is a type error rather than a silent leak. The
plugin recognises a component that already calls `useMemoryTracking` and reuses it, so the two
approaches mix freely and nothing is counted twice.

Timers and listeners are instrumented globally either way, so a mismatched `removeEventListener` is
caught with no setup at all — it just cannot be blamed on a component without the plugin.

The plugin covers plain function components and `memo` / `forwardRef` wrappers — 89% of effect call
sites in Excalidraw, measured. Effects inside **custom hooks** and **class components** are not
attributed; their resources are still tracked, but no component is blamed.
[The full table is in the guide.](docs/GUIDE.md)

## One problem is one finding

Ten mount/unmount cycles of one leaky interval are one finding seen ten times, not ten findings. A
report that grows with every cycle is unreadable exactly when it matters, so findings are keyed by
component, resource type and source location, and carry an `occurrences` count. When repetition
proves a leak the earlier low-confidence suspicion is dropped rather than listed beside it, and a
retained listener that a mismatch already explains is reported once — as the mismatch, which is the
finding that names the fix.

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
- **Fixtures agree with their author.** Every claim above was checked against a real application,
  because five of the bugs fixed before release were invisible to a green suite and a fixture app
  that behaved perfectly. Running it against real code is a release criterion, not an intention.

## Known limitations

Written down rather than discovered by you:

- **Effects inside custom hooks are not attributed.** If your codebase keeps effects in
  `useInterval`-style utilities, those resources are tracked but no component is blamed. Closing
  this needs the owner captured during render rather than during the effect — a design change, not
  a patch.
- **Class components are not attributed.** `componentDidMount` is outside the plugin's reach.
- **A resource is not proof of a leak.** Retention is what is observable from a page; collection is
  not. Every finding says so.
- **Memory figures are supporting evidence, never the finding.** On Firefox and Safari there are
  none at all, and the diagnosis is unaffected.

## Documentation

- [Guide](docs/GUIDE.md) — setup, what is detected, reading a finding, troubleshooting
- [API](docs/API.md) — every export, both plugins, and the types
- [Feasibility report](docs/FEASIBILITY.md) — written before any code; what is reliable, inferred, or impossible
- [Release criteria](docs/RELEASE-CRITERIA.md) — what had to be true before publishing
- [Changelog](CHANGELOG.md)

## Licence

MIT
