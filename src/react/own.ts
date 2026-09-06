import type { ComponentRef } from "../core/types.js";
import { getDetective } from "../core/detective.js";

/**
 * Runs an effect body — and its cleanup — inside its component's owner scope.
 *
 * This is what makes automatic attribution possible. Effects run after render,
 * outside anything React exposes during rendering, so without wrapping the
 * callback there is no way to know which component created the socket that an
 * effect opened — and a resource created in a plain `useEffect` would be
 * recorded with no owner and never reported at all.
 *
 * The destructor is scoped too. Releases are paired by handle and do not need
 * it, but a *failed* release does: when `removeEventListener` matches nothing,
 * knowing which component was cleaning up is the only honest way to say whose
 * listener was stranded. Without it the detector has to guess between every
 * listener registered for that event, which in a real application is several.
 */
export function ownEffect(self: ComponentRef | undefined, effect: () => void | (() => void)): () => void | (() => void) {
  return () => {
    if (!self) return effect();
    const detective = getDetective();
    const cleanup = detective.withOwner(self, effect);
    if (typeof cleanup !== "function") return cleanup;
    return () => detective.withOwner(self, cleanup);
  };
}
