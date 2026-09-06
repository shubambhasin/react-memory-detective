# Changelog

## Unreleased

First working core. Nothing is published yet.

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
