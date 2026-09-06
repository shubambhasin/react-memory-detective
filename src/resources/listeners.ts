import type { ResourceRegistry } from "../core/registry.js";
import { captureSource } from "./source.js";
import type { ComponentRef, SourceLocation } from "../core/types.js";

export interface ListenerMismatch {
  target: string;
  event: string;
  /**
   * Why the removal did nothing. `removeEventListener` matches on the function
   * reference *and* the capture flag, and the two failures need different fixes.
   */
  reason: "reference" | "capture";
  /** The listener that is still registered. */
  addedSource?: SourceLocation;
  addedOwner?: ComponentRef;
  /** Where the failed removal was attempted. */
  removedSource?: SourceLocation;
  at: number;
}

interface Registration {
  recordId: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
}

/**
 * Event listener instrumentation.
 *
 * The reason this is worth more than counting: `removeEventListener` only
 * removes a listener when the **function reference**, the type and the capture
 * flag all match. A cleanup that passes a freshly created closure —
 *
 *   return () => window.removeEventListener("resize", () => handler());
 *
 * — removes nothing at all, silently. Because both references pass through
 * here, that can be reported as fact rather than suspicion.
 */
export function instrumentListeners(
  registry: ResourceRegistry,
  shouldCaptureSource: () => boolean,
  onMismatch: (mismatch: ListenerMismatch) => void,
): () => void {
  /*
   * `EventTarget.prototype` covers most targets, but `window` and `document`
   * often carry their own `addEventListener` — jsdom does exactly this — and a
   * prototype patch never sees those calls. Patch whichever objects actually
   * own the method.
   */
  const targets: object[] = [];
  const proto = globalThis.EventTarget?.prototype;
  if (proto) targets.push(proto);
  for (const host of [globalThis.window, globalThis.document]) {
    if (host && Object.prototype.hasOwnProperty.call(host, "addEventListener")) targets.push(host);
  }
  if (targets.length === 0) return () => {};

  type Patchable = {
    addEventListener: typeof EventTarget.prototype.addEventListener;
    removeEventListener: typeof EventTarget.prototype.removeEventListener;
  };

  const originals = targets.map((t) => {
    const target = t as Patchable;
    return { target, add: target.addEventListener, remove: target.removeEventListener };
  });

  /*
   * Each patched object must delegate to *its own* original. jsdom's
   * `window.addEventListener` is not `EventTarget.prototype.addEventListener`,
   * and invoking the prototype's version with `this === window` throws
   * "called on an object that is not a valid instance of EventTarget".
   */
  const byTarget = new Map(originals.map((entry) => [entry.target, entry]));
  const protoEntry = originals[0]!;
  const resolve = (self: EventTarget) => byTarget.get(self as unknown as Patchable) ?? protoEntry;

  /** Per target, weakly: `type|capture` → registrations still attached. */
  const registrations = new WeakMap<EventTarget, Map<string, Registration[]>>();

  const patchedAdd = function patchedAdd(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    resolve(this).add.call(this, type, listener, options);
    if (!listener) return;

    try {
      const capture = typeof options === "boolean" ? options : options?.capture === true;
      /*
       * `once` releases itself when it fires, so it is not something a
       * component can fail to clean up.
       */
      const once = typeof options === "object" && options?.once === true;

      const record = registry.create({
        type: "event-listener",
        label: `${type} on ${describeTarget(this)}`,
        source: shouldCaptureSource() ? captureSource() : undefined,
      });

      if (once) {
        registry.release(record.id, "self-resolved");
        return;
      }

      const key = `${type}|${capture}`;
      let byKey = registrations.get(this);
      if (!byKey) registrations.set(this, (byKey = new Map()));
      const list = byKey.get(key) ?? [];
      list.push({ recordId: record.id, listener, capture });
      byKey.set(key, list);
    } catch {
      /* never break the application */
    }
  };

  const patchedRemove = function patchedRemove(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    resolve(this).remove.call(this, type, listener, options);
    if (!listener) return;

    try {
      const capture = typeof options === "boolean" ? options : options?.capture === true;
      const key = `${type}|${capture}`;
      const byKey = registrations.get(this);
      const list = byKey?.get(key);

      const index = list?.findIndex((r) => r.listener === listener) ?? -1;
      if (list && index >= 0) {
        registry.release(list[index]?.recordId);
        list.splice(index, 1);
        return;
      }

      /*
       * Nothing matched. Either the reference differs — the classic cleanup that
       * reviews correctly and removes nothing — or the capture flag does, which
       * fails just as silently and is easier to miss.
       */
      const otherList = byKey?.get(`${type}|${!capture}`);
      const captureMismatch = otherList?.some((r) => r.listener === listener) === true;
      const stranded = captureMismatch ? otherList?.find((r) => r.listener === listener) : list?.[0];
      if (!stranded) return;

      const record = registry.get(stranded.recordId);
      onMismatch({
        target: describeTarget(this),
        event: type,
        reason: captureMismatch ? "capture" : "reference",
        addedSource: record?.source,
        addedOwner: record?.owner,
        removedSource: shouldCaptureSource() ? captureSource() : undefined,
        at: Date.now(),
      });
    } catch {
      /* never break the application */
    }
  };

  for (const entry of originals) {
    entry.target.addEventListener = patchedAdd;
    entry.target.removeEventListener = patchedRemove;
  }

  return () => {
    for (const entry of originals) {
      entry.target.addEventListener = entry.add;
      entry.target.removeEventListener = entry.remove;
    }
  };
}

function describeTarget(target: EventTarget): string {
  if (typeof window !== "undefined" && target === window) return "window";
  if (typeof document !== "undefined" && target === document) return "document";
  const element = target as { tagName?: string; id?: string; className?: unknown };
  if (!element.tagName) return target.constructor?.name ?? "EventTarget";
  const tag = element.tagName.toLowerCase();
  if (element.id) return `${tag}#${element.id}`;
  const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : undefined;
  return className ? `${tag}.${className}` : tag;
}
