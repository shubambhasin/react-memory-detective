# When this is publishable

Version is `0.0.0` on purpose: it cannot be published by accident, and it will not be published to
have something on npm. A tool whose entire value is *not overclaiming* is worth less than nothing if
it ships before it can back its claims.

Every box has to be ticked, and each is checkable rather than a judgement call.

## Correctness

- [ ] **Every resource type in the README is actually instrumented.** Claiming sockets and observers
      while shipping only timers and listeners is the exact failure this tool exists to criticise.
      → timers ✅ · listeners ✅ · sockets ✅ · observers ✅ · workers ✅ · requests ☐
- [ ] **The false-positive suite passes.** Legitimate patterns that must produce *no* high-confidence
      finding: a global singleton, an application-level listener, a shared socket, a long-running
      request, a persistent cache, StrictMode.
- [ ] **The detection suite passes**, one fixture per supported resource, each with a known answer.
- [ ] **Ownership is never guessed.** A resource created outside a tracked scope reports no owner.

## The tool must not be the leak

- [x] **Self-leak test**: thousands of React mount/unmount cycles plus 100,000 raw resource events,
      asserting the registry stays bounded and every patched global is restored. Mandatory — a leak
      detector that leaks is worse than none.

      It earned its place immediately: it found that `maxRecords` was captured once at construction,
      so `configure({ maxRecords })` silently did nothing and the cap was always the default. A
      documented option that quietly has no effect is precisely the class of bug this project cannot
      afford to ship.

## Honesty

- [ ] No output says "leak" as a conclusion. Retention, evidence, confidence.
- [ ] Every finding carries evidence and a confidence level.
- [ ] Behaviour with **no memory API** is tested, not just handled — that is the majority case.

## Contact with reality

- [ ] Run against a **real application**, not only fixtures. On the sibling project, every single
      round of real contact found bugs that a green suite had missed — four from a browser, four
      from one afternoon in a production codebase. Fixtures agree with their author.
- [ ] Verified in a real browser, not only jsdom. jsdom's `window` differs from a browser's in ways
      that have already caused two bugs here.

## Mechanics

- [ ] Packed tarball installs and works in a clean project: ESM, CJS and types.
- [ ] CI green on React 18 and 19.
- [ ] Size budgets met.
- [ ] `CHANGELOG` entry, and a `0.1.x` version that says preview and means it.

---

Only when all of the above hold does the question "should we publish?" even get asked.
