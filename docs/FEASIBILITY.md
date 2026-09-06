# Phase 1 — Technical Feasibility Report

What a browser and React can actually tell us about retained memory, and what they cannot.
Written before implementation, because the spec's central risk is claiming a leak from evidence
that only shows memory usage.

| Tier | Meaning |
| --- | --- |
| ✅ Reliable | Deterministic, public API, works in every supported browser |
| 🟡 Evidence | Real signal, but correlational — must carry a confidence level |
| 🧪 Conditional | Works only where a specific browser feature exists |
| ⛔ Not possible | Requires a heap walk, a private API, or knowledge JS does not expose |

---

## 1. The finding that should shape the product

**The memory numbers are the weakest part of this tool, not the strongest.**

| API | Reality |
| --- | --- |
| `performance.memory` | Chrome/Edge only. Non-standard. Deliberately **quantised** to resist fingerprinting, and reports the whole JS heap for the agent — never per component. |
| `performance.measureUserAgentSpecificMemory()` | Requires `crossOriginIsolated` (COOP + COEP headers). Most applications are not isolated, so for most users this simply does not exist. Also throttled by design. |
| Firefox, Safari | Neither API. |

So a product built around a megabyte counter would be unavailable or misleading for the majority of
its users. The **resource registry is the spine**: "this component created a `setInterval` and no
`clearInterval` was ever observed for that handle" is exact, universal, actionable, and requires no
memory API at all.

Memory trend is therefore a *supporting* signal, reported when available and clearly absent when
not — never the basis of a diagnosis on its own.

## 2. Resource creation and cleanup pairing — ✅ Reliable

Patching a global in development is deterministic and reversible. For each of these, the create call
and the release call are observable, and they carry a handle that pairs them exactly:

| Resource | Created | Released | Pairing key |
| --- | --- | --- | --- |
| timers | `setTimeout`, `setInterval` | `clearTimeout`, `clearInterval` | numeric id |
| frames | `requestAnimationFrame`, `requestIdleCallback` | `cancel*` | numeric id |
| listeners | `addEventListener` | `removeEventListener` | target + type + **function identity** + capture |
| sockets | `new WebSocket` | `close()` | instance |
| SSE | `new EventSource` | `close()` | instance |
| observers | `new MutationObserver` etc. | `disconnect()` | instance |
| channels | `new BroadcastChannel` | `close()` | instance |
| workers | `new Worker` | `terminate()` | instance |
| requests | `fetch` + `AbortController` | settle or `abort()` | instance |

This is the highest-value, lowest-risk part of the product, and none of it needs a memory API.

**Listener mismatch is exact and unusually actionable.** `removeEventListener` only removes a
listener when the function reference, type and capture flag all match. A cleanup that passes a
freshly created closure removes nothing — and because we hold both references, we can say so with
certainty rather than suspicion.

## 3. Ownership — 🟡 the genuinely hard part

Knowing a resource exists is easy. Knowing *which component created it* is not, because resources
are overwhelmingly created inside effects, and effects run **after** render, outside any context we
establish during render.

Three approaches, in descending reliability:

1. **Build-time wrapping of effects** — a Babel/Vite transform rewrites `useEffect(fn, deps)` so that
   `fn` runs inside an owner scope. Ownership then becomes exact, and the effect index is known too
   (`ChatPanel → useEffect #2 → WebSocket`). This is the design the product should aim at.
2. **Explicit API** — `useTrackedResource` / `trackResource`. Exact, but opt-in, so coverage depends
   on the developer already suspecting something.
3. **"Most recently mounted component"** — cheap and wrong often enough to be dangerous.
   If it is used at all, the result must be labelled **associated**, never **owned**, exactly as the
   spec requires.

Anything created outside a tracked scope — module scope, a singleton, a third-party library — has no
owner, and the correct output is "no owner established", not a guess.

## 4. Did the memory actually get released? — 🟡 asymmetric, and better than heap size

`WeakRef` and `FinalizationRegistry` (ES2021, all modern browsers) let us hold a component instance
token weakly and observe whether it is ever collected.

The signal is **asymmetric**, which is what makes it honest:

- A token that **is** collected proves the instance was released. Strong negative evidence: no leak.
- A token that is **not** collected proves nothing on its own. GC may simply not have run.

So the tool can *clear* a component confidently and can only ever *suspect* retention — which is
precisely the asymmetry the product's language needs. Repetition converts suspicion into confidence:
if 100 mount/unmount cycles leave 100 uncollected tokens after idle periods, that is a pattern, not
a coincidence.

Caveats to state in the docs: `FinalizationRegistry` callbacks are explicitly *not guaranteed* to
run, timing is unspecified, and engines may never collect a short-lived object. Never build a
countdown or a percentage on it.

## 5. Forcing garbage collection — ⛔ not from a page

`window.gc` exists only when Chrome is launched with `--js-flags="--expose-gc"`. There is no
standard way to force collection, and attempting to coerce it with allocation pressure is a hack
that distorts the very measurement being taken.

The product must therefore treat GC as an *opportunity*, not an event: wait for idle, sample again,
repeat across cycles. Where `window.gc` happens to exist (test environments, a flagged browser), use
it and say that results are stronger.

## 6. Source locations — ✅ available at runtime, at a cost

`new Error().stack` captured at the moment a resource is created yields the file, line and column of
the call site, with no build step. Two constraints: capturing a stack is expensive (hundreds of
nanoseconds to microseconds), so it must be bounded or opt-in; and the frames point at the compiled
output unless source maps are applied. A build plugin gives cheaper and more accurate locations, but
the runtime path means the feature degrades rather than disappears.

## 7. StrictMode — 🟡 mandatory to handle, and worse here than for renders

In development, StrictMode mounts, unmounts and remounts every component, running each effect's
cleanup once. For a *render* profiler that inflates counts; for a *leak* detector it is far more
dangerous, because it produces exactly the shape the tool is looking for — a resource created,
then a component unmount.

Two mitigations: the simulated unmount reuses the same fiber, so the instance token is unchanged and
can be recognised; and a resource created and released within the same double-invoke window is
StrictMode exercising cleanup correctly, which is the opposite of a leak.

## 8. What is out of reach — ⛔

- **Retaining paths.** Why an object is still reachable requires a heap walk. That is Chrome
  DevTools' job, and the spec is right that this tool should not try to replace it.
- **Proving a leak.** "Unreachable" is not observable from inside the language.
- **Detached DOM detection.** Requires heap inspection. A weak reference to a removed node can hint,
  but attribution to a component cannot be established this way.
- **Per-component memory attribution in megabytes.** No API apportions heap by component. Any figure
  claiming this would be invented.

---

## Summary — what V1 should ship

| Capability | Tier | Confidence ceiling |
| --- | --- | --- |
| Mount/unmount per instance | ✅ | high |
| Resource create/cleanup pairing | ✅ | high |
| Listener reference mismatch | ✅ | high |
| Cleanup-after-unmount detection | ✅ | high with repetition |
| Ownership via build plugin or explicit API | ✅ | high |
| Ownership by proximity | 🟡 | "associated", never "owned" |
| Instance collected (WeakRef) | 🟡 | proves *absence* of a leak only |
| Repeated-cycle retention pattern | 🟡 | high after N cycles |
| Memory trend | 🧪 Chrome, or isolated contexts | supporting evidence only |
| Forced GC | ⛔ except with a browser flag | — |
| Retaining paths, detached DOM, per-component MB | ⛔ | — |

When the evidence does not support a conclusion, the output is
`No cleanup observed — retention not confirmed`, never `MEMORY LEAK DETECTED`.
