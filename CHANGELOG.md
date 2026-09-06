# Changelog

## 0.1.0

First release. Dev-time only, zero runtime dependencies, and it refuses to run in a production
build. The version says preview and means it: the diagnoses it makes are ones it can defend, and it
stays quiet about everything else.

### Added

- **Feasibility report first** ([docs/FEASIBILITY.md](docs/FEASIBILITY.md)), classifying every
  capability before any of it was built. Its central finding shaped the design: the browser memory
  APIs are the *weakest* signal available — `performance.memory` is Chrome-only and deliberately
  quantised, and `measureUserAgentSpecificMemory()` needs cross-origin isolation most apps do not
  have. So the resource registry is the spine, and memory figures are supporting evidence.
- **Resource registry** pairing creation with release, bounded by construction, holding object
  handles in a `WeakMap` so tracking a resource can never be the reason it stays alive.
- **Timer instrumentation** that distinguishes a fired `setTimeout` (self-resolved, not a leak and
  not a cleanup) from an uncleared `setInterval` (never resolves itself).
- **Listener instrumentation** detecting the two silent failures of `removeEventListener`: a
  different function reference, and a different capture flag. Both are stated as fact rather than
  suspicion, because both references are observed directly.
- **Ownership by scope**, not by proximity. A resource created inside a tracked scope is *owned*;
  one created while some component merely happened to be mounted has no owner, and the tool says so.
- **Diagnostic engine**, pure and React-free, where confidence is earned by repetition.
- **Connections, observers and workers** — WebSocket, EventSource, BroadcastChannel, Worker,
  MutationObserver, ResizeObserver, IntersectionObserver. All seven share one shape (constructed,
  released by a single method) and one implementation. A socket the *peer* closes is marked
  self-resolved rather than blamed on the component, and `instanceof` keeps working so
  instrumentation cannot change application behaviour.
- **False-positive suite** — ten legitimate patterns that a naive detector reports as leaks, each
  of which must stay quiet. It was mutation-tested rather than trusted: one deliberate break was
  caught, a second was not, and the test that should have caught it turned out to wait long enough
  for the timer to fire and so never reached the branch it protected. Fixed, and the mutation is now
  caught.
- **Self-leak test**, which immediately found a real bug: `maxRecords` was captured at construction,
  so configuring it silently did nothing and the cap was always the default.
- **Build plugin** for Vite and Babel, and this is what makes the tool usable on code that was not
  written for it. Effects run after render, so at the moment a `setInterval` is created nothing in
  the runtime says whose effect is running — a resource created in an ordinary `useEffect` had no
  owner, and an unattributed resource is not reported at all, because guessing the nearest mounted
  component is the behaviour this project exists to avoid. Verified in a browser: with the plugin,
  the six-component fixture app reports exactly its three real bugs and nothing else; without it,
  it reported one, unattributed. The compiler stays in the build and is asserted never to reach a
  runtime bundle.
- **`ownEffect(self, effect)`**, the runtime half of the plugin, exported for hand-written use.
- **Detection suite**: one fixture per resource type with an answer known in advance, plus an
  assertion that no finding ever states a leak as a conclusion.
- **Clean-install smoke test** (`npm run smoke`) that installs the packed tarball into an empty
  project and exercises ESM, CJS, every subpath entry, the plugin, and a type-check under both
  `bundler` and `node16` resolution. It found two packaging bugs on its first run that every test in
  this repo had passed.

### Changed

- **One problem is now one finding.** Ten leaking cycles previously produced ten findings, and the
  fixture app accumulated 52 for three bugs — the same unreadable-at-scale mistake the console
  reporter was already redesigned to avoid. Findings are keyed by component, resource type and
  source location, and carry an `occurrences` count. When repetition proves a leak the earlier
  low-confidence suspicion is dropped rather than listed beside it, and a retained listener that a
  mismatch already explains is reported once, as the mismatch — the finding that names the fix.
- The build plugin's public types no longer reference `@babel/core`, so consumers are not forced to
  install `@types/babel__core` to type-check their own application.

### Fixed

- **"Illegal invocation" in a real browser.** Patched timer globals were called without their
  receiver; jsdom tolerates this and Chrome does not, so the whole fixture app failed to start while
  every test stayed green. This is the second project where only real-browser contact caught a class
  of bug that fixtures could not.
- A memory sample carrying no bytes reported the API it had detected rather than `unavailable`,
  which implied a figure existed and had merely been omitted.
