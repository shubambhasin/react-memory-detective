# When this is publishable

The version sat at `0.0.0` until every box below was ticked, so it could not be published by
accident or to have something on npm. A tool whose entire value is *not overclaiming* is worth less
than nothing if it ships before it can back its claims.

**Status at 0.1.0: all boxes ticked but one, which is recorded rather than quietly dropped —
see "Contact with reality".**

## Correctness

- [x] **Every resource type in the README is actually instrumented.** Claiming sockets and observers
      while shipping only timers and listeners is the exact failure this tool exists to criticise.
      → timers ✅ · listeners ✅ · sockets ✅ · observers ✅ · workers ✅ · requests ✅
- [x] **The false-positive suite passes.** Ten legitimate patterns that must produce no
      high-confidence finding: an application-level singleton, a global listener, a release that
      lands just after unmount, a component that cleans up on every one of thirty cycles, a fired
      timeout, a timeout still pending at unmount, StrictMode, a tidy neighbour unmounting alongside
      a leaky one, and a single observation staying at low confidence until it repeats.

      **The suite was mutation-tested rather than trusted.** Forcing every finding to high confidence
      was caught. Removing the self-resolving exclusion was *not* — the timeout test waited long
      enough for the timer to fire, so it never exercised the branch it existed to protect. A
      pending-timeout case was added, and the mutation is now caught.
- [x] **The detection suite passes**, one fixture per supported resource, each with a known answer
      (`tests/detection.test.tsx`): an uncleared interval, an undisconnected observer, an unclosed
      socket, and a mismatched listener — each attributed to the component that created it.
- [x] **Ownership is never guessed.** A resource created outside a tracked scope reports no owner,
      and an unowned resource produces no finding at all. This is what made the build plugin
      non-optional: without it, resources created in an ordinary `useEffect` are unowned, so the
      first browser run of the fixture app found one of its three planted bugs. The alternative —
      blaming whichever component happened to be mounted — is the behaviour this tool criticises.

## The tool must not be the leak

- [x] **Self-leak test**: thousands of React mount/unmount cycles plus 100,000 raw resource events,
      asserting the registry stays bounded and every patched global is restored. Mandatory — a leak
      detector that leaks is worse than none.

      It earned its place immediately: it found that `maxRecords` was captured once at construction,
      so `configure({ maxRecords })` silently did nothing and the cap was always the default. A
      documented option that quietly has no effect is precisely the class of bug this project cannot
      afford to ship.

## Honesty

- [x] No output says "leak" as a conclusion. Retention, evidence, confidence. Asserted over every
      finding the detection suite produces, not just reviewed by eye.
- [x] Every finding carries evidence and a confidence level, and every retention finding ends with
      the sentence saying collection cannot be observed from a page.
- [x] Behaviour with **no memory API** is tested, not just handled — that is the majority case
      (`tests/memory-api.test.ts`). It found that a sample with no bytes still named the API it had
      detected, implying a figure existed and had been withheld.

## Contact with reality

- [ ] **Run against a real application, not only fixtures. Still outstanding at 0.1.0.** The only
      large React application on hand is a work repository that is off-limits to this project, and
      adding a build plugin to it means editing its config. It is left unticked rather than
      reasoned away: on the sibling project every single round of real contact found bugs a green
      suite had missed — four from a browser, four from one afternoon in a production codebase.
      Fixtures agree with their author. This is the reason 0.1.0 is a preview.
- [x] Verified in a real browser, not only jsdom. jsdom's `window` differs from a browser's in ways
      that caused three bugs here: a prototype patch that missed `window`'s own `addEventListener`,
      timer globals called without their receiver ("Illegal invocation", which broke the entire
      fixture app while every test passed), and the attribution gap above. The fixture app now
      reports exactly its three planted bugs and stays silent on the three clean components, the
      pending timeout and the module-scope interval.

## Mechanics

- [x] Packed tarball installs and works in a clean project: ESM, CJS, subpath entries, the plugin,
      and types under both `bundler` and `node16` resolution (`npm run smoke`, and in CI). It found
      two packaging bugs on its first run — the shipped types pulled `@babel/core` into every
      consumer's type-check, and an example in the docs did not compile.
- [x] CI green on React 18 and 19.
- [x] Size budgets met: core 3.24 KB, index 7.41 KB, overlay 8.16 KB, total 9.19 KB gzipped, against
      a 40 KB budget — and the build-time plugin is asserted never to reach a runtime bundle.
- [x] `CHANGELOG` entry, and a `0.1.0` version that says preview and means it.

---

Only when all of the above hold does the question "should we publish?" even get asked — and it is a
question for a person, not something this repository decides. Publishing runs from CI on a tag, and
the tag is pushed by hand.
