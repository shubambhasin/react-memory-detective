import type { ComponentRef } from "./types.js";

/**
 * Which component is executing right now.
 *
 * Resources are overwhelmingly created inside effects, and effects run after
 * render — outside any React context we could read. So ownership is established
 * by running the effect body inside a scope, which the build plugin does
 * automatically and `useTrackedResource` does explicitly.
 *
 * A stack, not a single value: an effect may render or call into another
 * tracked scope, and the innermost one owns what it creates.
 */
const stack: ComponentRef[] = [];

export function runInOwnerScope<T>(owner: ComponentRef, fn: () => T): T {
  stack.push(owner);
  try {
    return fn();
  } finally {
    stack.pop();
  }
}

/** The owner to attribute a resource to, or undefined when none is established. */
export function currentOwner(): ComponentRef | undefined {
  return stack[stack.length - 1];
}

export function clearOwnerScope(): void {
  stack.length = 0;
}
