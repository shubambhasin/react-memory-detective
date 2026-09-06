import { useEffect, useRef, useState } from "react";
// Only TidyPoller imports anything. Every other component below is ordinary
// React code: the build plugin attributes their resources automatically.
import { useMemoryTracking, useTrackedResource } from "react-memory-detective";

/* ─────────────────────────── deliberately leaky ─────────────────────────── */

/** LEAK 1 — an interval with no cleanup. Never resolves itself. */
function LeakyPoller() {
  useEffect(() => {
    setInterval(() => {}, 1000);
  }, []);
  return <li>LeakyPoller — setInterval, no clearInterval</li>;
}

/** LEAK 2 — a listener removed with a *different* function reference. */
function MismatchedListener() {
  useEffect(() => {
    const handler = () => {};
    window.addEventListener("resize", handler);
    // Reviews as correct. Removes nothing: a new closure every time.
    return () => window.removeEventListener("resize", () => handler());
  }, []);
  return <li>MismatchedListener — removeEventListener with a new closure</li>;
}

/** LEAK 3 — an observer never disconnected. */
function LeakyObserver() {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() => {});
    observer.observe(ref.current);
  }, []);
  return <li ref={ref}>LeakyObserver — ResizeObserver, no disconnect</li>;
}

/* ───────────────────────────── correct code ─────────────────────────────── */

/** Clean: the same interval, released. Must never be reported. */
function TidyPoller() {
  const self = useMemoryTracking("TidyPoller");
  useTrackedResource(self, {
    type: "interval",
    name: "poll",
    create: () => setInterval(() => {}, 1000),
    cleanup: (id) => clearInterval(id),
  });
  return <li>TidyPoller — interval, cleaned up</li>;
}

/** Clean: same reference on both sides. Must never be reported. */
function TidyListener() {
  useEffect(() => {
    const handler = () => {};
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);
  return <li>TidyListener — listener, same reference removed</li>;
}

/** Clean: a pending timeout at unmount is a timeout, not a leak. */
function PendingTimeout() {
  useEffect(() => {
    setTimeout(() => {}, 60_000);
  }, []);
  return <li>PendingTimeout — long timeout, never cleared (not a leak)</li>;
}

/* ─────────────────────────────── the app ────────────────────────────────── */

// Created at module scope: nobody owns it, and nobody should be blamed for it.
setInterval(() => {}, 30_000);

export function App() {
  const [mounted, setMounted] = useState(true);
  const [cycles, setCycles] = useState(0);

  const runCycles = async (count: number) => {
    for (let i = 0; i < count; i++) {
      setMounted(false);
      await new Promise((r) => setTimeout(r, 30));
      setMounted(true);
      await new Promise((r) => setTimeout(r, 30));
      setCycles((c) => c + 1);
    }
  };

  return (
    <main>
      <h1>Memory Detective — leak fixtures</h1>
      <p className="lede">
        Three components leak, three do not, and one resource belongs to nobody. Only one of them
        is instrumented by hand — the rest are plain React. Mount and unmount them a few times:
        confidence comes from repetition, so the first cycle is only ever a suspicion.
      </p>

      <div className="controls">
        <button onClick={() => setMounted((m) => !m)}>{mounted ? "Unmount" : "Mount"}</button>
        <button onClick={() => void runCycles(10)}>Run 10 cycles</button>
        <button onClick={() => (window as never as { rmd: { printReport(): void } }).rmd.printReport()}>
          Print report
        </button>
        <span className="dim">{cycles} cycles</span>
      </div>

      {mounted && (
        <ul>
          <LeakyPoller />
          <MismatchedListener />
          <LeakyObserver />
          <TidyPoller />
          <TidyListener />
          <PendingTimeout />
        </ul>
      )}

      <p className="dim">
        Expected: findings for LeakyPoller, MismatchedListener and LeakyObserver. Nothing for the
        tidy three, the pending timeout, or the module-scope interval.
      </p>
    </main>
  );
}
