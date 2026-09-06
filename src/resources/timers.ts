import type { ResourceRegistry } from "../core/registry.js";
import { captureSource } from "./source.js";
import type { ResourceType } from "../core/types.js";

interface TimerGlobals {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  requestAnimationFrame?: typeof requestAnimationFrame;
  cancelAnimationFrame?: typeof cancelAnimationFrame;
}

/**
 * Timer instrumentation.
 *
 * A `setTimeout` that fires has released itself — that is `self-resolved`, not
 * a cleanup and not a leak. A `setInterval` never resolves itself, so an
 * uncleared one genuinely outlives whatever made it. The two must not be
 * conflated: reporting every fired timeout as an uncleaned resource would bury
 * the intervals that matter.
 */
export function instrumentTimers(registry: ResourceRegistry, shouldCaptureSource: () => boolean): () => void {
  const target = globalThis as unknown as TimerGlobals;
  const original: Partial<TimerGlobals> = {
    setTimeout: target.setTimeout,
    clearTimeout: target.clearTimeout,
    setInterval: target.setInterval,
    clearInterval: target.clearInterval,
    requestAnimationFrame: target.requestAnimationFrame,
    cancelAnimationFrame: target.cancelAnimationFrame,
  };

  const track = (type: ResourceType, label: string, handle: unknown): string => {
    const record = registry.create({
      type,
      label,
      source: shouldCaptureSource() ? captureSource() : undefined,
    });
    registry.indexNumeric(type, handle, record.id);
    return record.id;
  };

  target.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const wrapped =
      typeof handler === "function"
        ? (...callArgs: unknown[]) => {
            // Fired, so it released itself. Not a cleanup, not a leak.
            registry.releaseByNumericHandle("timeout", id, "self-resolved");
            return (handler as (...a: unknown[]) => unknown)(...callArgs);
          }
        : handler;
    const id = original.setTimeout!(wrapped as TimerHandler, timeout, ...args) as unknown as number;
    track("timeout", `setTimeout(${timeout ?? 0}ms)`, id);
    return id;
  }) as typeof setTimeout;

  target.clearTimeout = ((handle?: unknown) => {
    if (handle !== undefined) registry.releaseByNumericHandle("timeout", handle);
    return original.clearTimeout!(handle as number);
  }) as typeof clearTimeout;

  target.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = original.setInterval!(handler, timeout, ...args) as unknown as number;
    // Never self-resolves: it runs until someone clears it.
    track("interval", `setInterval(${timeout ?? 0}ms)`, id);
    return id;
  }) as typeof setInterval;

  target.clearInterval = ((handle?: unknown) => {
    if (handle !== undefined) registry.releaseByNumericHandle("interval", handle);
    return original.clearInterval!(handle as number);
  }) as typeof clearInterval;

  if (original.requestAnimationFrame && original.cancelAnimationFrame) {
    target.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = original.requestAnimationFrame!((time) => {
        registry.releaseByNumericHandle("animation-frame", id, "self-resolved");
        return callback(time);
      });
      track("animation-frame", "requestAnimationFrame", id);
      return id;
    }) as typeof requestAnimationFrame;

    target.cancelAnimationFrame = ((handle: number) => {
      registry.releaseByNumericHandle("animation-frame", handle);
      return original.cancelAnimationFrame!(handle);
    }) as typeof cancelAnimationFrame;
  }

  return () => {
    // Restoring exactly what was there, so repeated init/shutdown cannot stack.
    Object.assign(target, original);
  };
}
