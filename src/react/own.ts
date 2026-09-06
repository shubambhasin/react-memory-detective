import type { ComponentRef } from "../core/types.js";
import { getDetective } from "../core/detective.js";

/**
 * Runs an effect body inside its component's owner scope.
 *
 * This is what makes automatic attribution possible. Effects run after render,
 * outside anything React exposes during rendering, so without wrapping the
 * callback there is no way to know which component created the socket that an
 * effect opened — and a resource created in a plain `useEffect` would be
 * recorded with no owner and never reported at all.
 *
 * Only creation needs the scope. Cleanup is paired by handle, so the returned
 * destructor is passed through untouched.
 */
export function ownEffect(self: ComponentRef | undefined, effect: () => void | (() => void)): () => void | (() => void) {
  return () => {
    if (!self) return effect();
    return getDetective().withOwner(self, effect);
  };
}
