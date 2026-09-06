import { useEffect, useRef, useState } from "react";
import { getDetective } from "../core/detective.js";
import type { ComponentRef, ResourceType } from "../core/types.js";

/**
 * Tracks this component's lifecycle, and returns a scope runner so anything it
 * creates can be attributed to it.
 *
 * Instance identity comes from a lazily created object held in state, so two
 * `<UserCard />`s are never merged — which matters, because "37 mounts, 25
 * closes" is only meaningful per instance.
 */
export function useMemoryTracking(name: string): ComponentRef | undefined {
  const detective = getDetective();
  const [component] = useState<ComponentRef | undefined>(() =>
    detective.enabled ? detective.createInstance(name) : undefined,
  );

  useEffect(() => {
    if (!component) return;
    detective.mount(component);
    return () => detective.unmount(component);
  }, [detective, component]);

  return component;
}

export interface TrackedResourceSpec<T> {
  type: ResourceType;
  name: string;
  /** Creates the resource. Runs inside the owner scope, so it is attributed. */
  create: () => T;
  /** Releases it. Recorded when it runs, which is what proves cleanup happened. */
  cleanup: (resource: T) => void;
  deps?: unknown[];
}

/**
 * Create a resource inside an effect and have both its creation and its release
 * recorded.
 *
 * The point is not only diagnosis: writing the cleanup as a required argument
 * makes forgetting it a type error rather than a silent leak.
 */
export function useTrackedResource<T>(owner: ComponentRef | undefined, spec: TrackedResourceSpec<T>): void {
  const detective = getDetective();
  const specRef = useRef(spec);
  specRef.current = spec;

  useEffect(() => {
    const current = specRef.current;
    if (!detective.enabled || !owner) {
      const resource = current.create();
      return () => current.cleanup(resource);
    }

    const { resource, recordId } = detective.withOwner(owner, () => {
      const created = current.create();
      const record = detective.registry.create({
        type: current.type,
        label: current.name,
        handle: typeof created === "object" && created !== null ? (created as object) : undefined,
        owner,
      });
      return { resource: created, recordId: record.id };
    });

    return () => {
      try {
        current.cleanup(resource);
      } finally {
        detective.registry.release(recordId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, spec.deps ?? []);
}
