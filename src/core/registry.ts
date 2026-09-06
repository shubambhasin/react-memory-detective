import { currentOwner } from "./owner.js";
import type {
  ComponentRef,
  ResourceRecord,
  ResourceStatus,
  ResourceType,
  SourceLocation,
} from "./types.js";

export interface CreateResourceInput {
  type: ResourceType;
  label: string;
  /**
   * The thing that must eventually be released — a timer id, a socket, an
   * observer. Held **weakly** where it is an object, so tracking a resource can
   * never be the reason it stays alive.
   */
  handle?: object;
  /** Explicit owner, overriding the current scope. */
  owner?: ComponentRef;
  source?: SourceLocation;
}

/**
 * The resource registry — the spine of the product.
 *
 * "This component created a `setInterval` and no `clearInterval` was ever
 * observed for that handle" is exact, needs no memory API, and is available in
 * every browser. Memory figures are a supporting signal; this is the evidence.
 */
export class ResourceRegistry {
  private records = new Map<string, ResourceRecord>();
  /** Insertion order, so the oldest can be dropped when the cap is reached. */
  private order: string[] = [];
  private nextId = 0;

  /** Object handles → record id. Weak: the registry never retains a resource. */
  private byHandle = new WeakMap<object, string>();
  /**
   * Timer handles are not objects, so they need a strong map. They are also not
   * always numbers: browsers return an integer, while Node returns a `Timeout`
   * object, and jsdom hands back whichever the host provides. Keying on the
   * stringified handle works for both without assuming either.
   */
  private byNumericHandle = new Map<string, string>();

  /**
   * The cap is read through a function, not captured at construction.
   *
   * It was a snapshot, and `configure({ maxRecords })` silently did nothing —
   * the registry kept whatever the default had been when it was built. The
   * self-leak test caught it, which is the entire reason that test exists.
   */
  constructor(private getMaxRecords: () => number) {}

  create(input: CreateResourceInput): ResourceRecord {
    const owner = input.owner ?? currentOwner();
    const record: ResourceRecord = {
      id: `res_${++this.nextId}`,
      type: input.type,
      label: input.label,
      status: "active",
      createdAt: now(),
      owner,
      /*
       * Ownership is only claimed when a scope was actually established. A
       * resource created while some component happened to be mounted is not
       * owned by it, and saying so would invent causation.
       */
      ownership: owner ? "owned" : "none",
      source: input.source,
    };

    this.records.set(record.id, record);
    this.order.push(record.id);
    if (input.handle) this.byHandle.set(input.handle, record.id);
    this.evictIfNeeded();
    return record;
  }

  /** Numeric handles (timers) need their own index, keyed by type and id. */
  indexNumeric(type: ResourceType, handle: unknown, recordId: string): void {
    this.byNumericHandle.set(handleKey(type, handle), recordId);
  }

  release(recordId: string | undefined, status: ResourceStatus = "released"): ResourceRecord | undefined {
    if (!recordId) return undefined;
    const record = this.records.get(recordId);
    if (!record || record.status !== "active") return record;
    record.status = status;
    record.releasedAt = now();
    return record;
  }

  releaseByHandle(handle: object, status: ResourceStatus = "released"): ResourceRecord | undefined {
    return this.release(this.byHandle.get(handle), status);
  }

  releaseByNumericHandle(type: ResourceType, handle: unknown, status: ResourceStatus = "released"): ResourceRecord | undefined {
    const key = handleKey(type, handle);
    const id = this.byNumericHandle.get(key);
    this.byNumericHandle.delete(key);
    return this.release(id, status);
  }

  get(recordId: string): ResourceRecord | undefined {
    return this.records.get(recordId);
  }

  /** Marks everything this component still holds as having outlived it. */
  markOutlived(instanceId: string, at: number): ResourceRecord[] {
    const outlived: ResourceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (record.owner?.instanceId !== instanceId) continue;
      record.outlivedOwnerAt ??= at;
      outlived.push(record);
    }
    return outlived;
  }

  activeFor(instanceId: string): ResourceRecord[] {
    return [...this.records.values()].filter((r) => r.status === "active" && r.owner?.instanceId === instanceId);
  }

  all(): ResourceRecord[] {
    return [...this.records.values()];
  }

  get activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.status === "active") count++;
    return count;
  }

  clear(): void {
    this.records.clear();
    this.order.length = 0;
    this.byNumericHandle.clear();
    // byHandle is a WeakMap; its entries go when the handles do.
  }

  /**
   * Bounded by construction. A leak detector that grows without limit would be
   * the very thing it is looking for — so records are dropped oldest-first, and
   * released ones go before active ones, since an active record is still
   * evidence.
   */
  private evictIfNeeded(): void {
    const cap = this.getMaxRecords();
    if (this.order.length <= cap) return;

    const surplus = this.order.length - cap;
    let removed = 0;
    const keep: string[] = [];

    for (const id of this.order) {
      const record = this.records.get(id);
      if (removed < surplus && record && record.status !== "active") {
        this.records.delete(id);
        removed++;
        continue;
      }
      keep.push(id);
    }

    // Still over the cap because everything is active: drop the oldest anyway.
    while (keep.length > cap) {
      const id = keep.shift();
      if (id) this.records.delete(id);
    }
    this.order = keep;
  }
}

/**
 * Objects stringify to `[object Object]`, which would collide, so they get an
 * identity tag instead.
 */
const handleIds = new WeakMap<object, number>();
let nextHandleId = 0;

function handleKey(type: ResourceType, handle: unknown): string {
  if (handle !== null && (typeof handle === "object" || typeof handle === "function")) {
    let id = handleIds.get(handle as object);
    if (id === undefined) handleIds.set(handle as object, (id = ++nextHandleId));
    return `${type}:obj:${id}`;
  }
  return `${type}:${String(handle)}`;
}

export const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
