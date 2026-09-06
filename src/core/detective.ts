import { diagnoseListenerMismatch } from "./diagnose-listener.js";
import { diagnoseOutlivedResources } from "./diagnose.js";
import { MemoryProvider } from "./memory.js";
import { now, ResourceRegistry } from "./registry.js";
import { runInOwnerScope } from "./owner.js";
import { instrumentListeners } from "../resources/listeners.js";
import type { ListenerMismatch } from "../resources/listeners.js";
import { instrumentConnections } from "../resources/connections.js";
import { instrumentRequests } from "../resources/requests.js";
import { instrumentTimers } from "../resources/timers.js";
import type {
  ComponentRef,
  ComponentStats,
  DetectiveConfig,
  DetectiveOptions,
  Finding,
  MemoryReport,
} from "./types.js";

export const defaultConfig: DetectiveConfig = {
  enabled: false,
  mode: "console",
  cleanupGracePeriodMs: 1500,
  maxRecords: 2000,
  captureSource: true,
  track: { timers: true, listeners: true, observers: true, sockets: true, workers: true, requests: true },
};

interface InstanceRecord {
  component: ComponentRef;
  mountedAt: number;
  unmountedAt?: number;
  /** Cancels the pending grace-period check when StrictMode remounts. */
  pendingCheck?: ReturnType<typeof setTimeout>;
}

interface NameStats {
  mounts: number;
  unmounts: number;
  cycles: number;
  cyclesWithRetention: number;
  strictModeReplays: number;
}

export class Detective {
  config: DetectiveConfig = { ...defaultConfig };
  readonly registry = new ResourceRegistry(() => this.config.maxRecords);
  readonly memory = new MemoryProvider();

  private instances = new Map<string, InstanceRecord>();
  private stats = new Map<string, NameStats>();
  /**
   * Keyed by problem, not by observation. Ten mount/unmount cycles of one
   * leaky interval are one finding seen ten times, not ten findings — a list
   * that grows with every cycle is unreadable exactly when it matters most.
   */
  private findings = new Map<string, Finding>();
  private listeners = new Set<(finding: Finding) => void>();
  private restore: Array<() => void> = [];
  private mismatchCounts = new Map<string, number>();
  private baselineBytes?: number;
  private nextInstance = 0;
  private started = false;

  /** Idempotent: repeated calls reconfigure, they never patch a global twice. */
  init(options: DetectiveOptions = {}): void {
    this.configure(options);
    if (!this.config.enabled || this.started) return;
    this.started = true;
    this.baselineBytes = this.memory.sample().usedBytes;

    const captureSource = () => this.config.captureSource;
    if (this.config.track.timers) this.restore.push(instrumentTimers(this.registry, captureSource));
    if (this.config.track.listeners) {
      this.restore.push(instrumentListeners(this.registry, captureSource, (m) => this.onListenerMismatch(m)));
    }

    const connectionEnabled = (type: string): boolean => {
      if (type === "websocket" || type === "event-source" || type === "broadcast-channel") {
        return this.config.track.sockets;
      }
      if (type === "worker") return this.config.track.workers;
      return this.config.track.observers;
    };
    this.restore.push(instrumentConnections(this.registry, captureSource, connectionEnabled));
    if (this.config.track.requests) this.restore.push(instrumentRequests(this.registry, captureSource));
  }

  configure(options: DetectiveOptions = {}): void {
    const { track, ...rest } = options;
    this.config = { ...this.config, ...rest, track: { ...this.config.track, ...track } };
  }

  /** Restores every patched global. Safe to call when never started. */
  shutdown(): void {
    while (this.restore.length) {
      try {
        this.restore.pop()?.();
      } catch {
        /* ignore */
      }
    }
    for (const instance of this.instances.values()) {
      if (instance.pendingCheck) clearTimeout(instance.pendingCheck);
    }
    this.started = false;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  subscribe(listener: (finding: Finding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------- lifecycle

  createInstance(name: string): ComponentRef {
    return { instanceId: `c${++this.nextInstance}`, name };
  }

  mount(component: ComponentRef): void {
    const existing = this.instances.get(component.instanceId);
    if (existing?.unmountedAt !== undefined) {
      /*
       * The same instance unmounting and mounting again is StrictMode
       * exercising cleanup, not a real remount. It must not count: it produces
       * exactly the shape this tool looks for — resource created, component
       * unmounted — and would manufacture a finding on every component.
       */
      if (existing.pendingCheck) clearTimeout(existing.pendingCheck);
      existing.unmountedAt = undefined;
      existing.pendingCheck = undefined;

      const stats = this.statsFor(component.name);
      stats.strictModeReplays++;
      // The unmount that just happened was simulated, so undo the count as
      // well as the pending check. Leaving it would report one more unmount
      // than mount for every component in a StrictMode application.
      stats.unmounts = Math.max(0, stats.unmounts - 1);
      return;
    }

    this.instances.set(component.instanceId, { component, mountedAt: now() });
    this.statsFor(component.name).mounts++;
  }

  unmount(component: ComponentRef): void {
    const instance = this.instances.get(component.instanceId);
    if (!instance || instance.unmountedAt !== undefined) return;
    instance.unmountedAt = now();
    this.statsFor(component.name).unmounts++;

    /*
     * Never report at the moment of unmount. Some resources close
     * asynchronously, and StrictMode's simulated unmount is undone within the
     * same tick — checking immediately would be wrong in both cases.
     */
    instance.pendingCheck = setTimeout(() => {
      instance.pendingCheck = undefined;
      this.checkRetention(instance);
    }, this.config.cleanupGracePeriodMs);
    (instance.pendingCheck as { unref?: () => void }).unref?.();
  }

  /** Runs `fn` attributed to this component, so anything it creates is owned. */
  withOwner<T>(component: ComponentRef, fn: () => T): T {
    return runInOwnerScope(component, fn);
  }

  private checkRetention(instance: InstanceRecord): void {
    const stats = this.statsFor(instance.component.name);
    stats.cycles++;

    const outlived = this.registry.markOutlived(instance.component.instanceId, now());
    if (outlived.length === 0) {
      this.instances.delete(instance.component.instanceId);
      return;
    }

    stats.cyclesWithRetention++;
    const finding = diagnoseOutlivedResources({
      resources: outlived,
      cycles: stats.cycles,
      cyclesWithRetention: stats.cyclesWithRetention,
      gracePeriodMs: this.config.cleanupGracePeriodMs,
    });
    if (finding) this.emit(finding);
    this.instances.delete(instance.component.instanceId);
  }

  private onListenerMismatch(mismatch: ListenerMismatch): void {
    const key = `${mismatch.target}|${mismatch.event}|${mismatch.reason}`;
    const count = (this.mismatchCounts.get(key) ?? 0) + 1;
    this.mismatchCounts.set(key, count);
    this.emit(diagnoseListenerMismatch(mismatch, count));
  }

  private emit(finding: Finding): void {
    const key = findingKey(finding);
    const previous = this.findings.get(key);
    if (previous) {
      // Keep the newest evidence, and carry the count forward. Deleting first
      // re-inserts at the end, so the list stays ordered by last seen.
      finding.occurrences = (previous.occurrences ?? 1) + 1;
      finding.firstObservedAt = previous.firstObservedAt ?? previous.observedAt;
      finding.id = previous.id;
      this.findings.delete(key);
    } else {
      finding.occurrences = 1;
      finding.firstObservedAt = finding.observedAt;
    }
    this.findings.set(key, finding);
    while (this.findings.size > this.config.maxRecords) {
      const oldest = this.findings.keys().next().value;
      if (oldest === undefined) break;
      this.findings.delete(oldest);
    }
    this.config.onFinding?.(finding);
    for (const listener of this.listeners) {
      try {
        listener(finding);
      } catch {
        /* a subscriber must not break the pipeline */
      }
    }
  }

  private statsFor(name: string): NameStats {
    let stats = this.stats.get(name);
    if (!stats) this.stats.set(name, (stats = { mounts: 0, unmounts: 0, cycles: 0, cyclesWithRetention: 0, strictModeReplays: 0 }));
    return stats;
  }

  // ----------------------------------------------------------------- query

  getFindings(): Finding[] {
    return suppressExplained([...this.findings.values()]);
  }

  getReport(): MemoryReport {
    const components: ComponentStats[] = [];
    for (const [name, stats] of this.stats) {
      const active = this.registry.all().filter((r) => r.status === "active" && r.owner?.name === name);
      components.push({
        name,
        mounts: stats.mounts,
        unmounts: stats.unmounts,
        uncollectedInstances: [...this.instances.values()].filter(
          (i) => i.component.name === name && i.unmountedAt !== undefined,
        ).length,
        activeResources: active.length,
        resourcesOutlivingOwner: active.filter((r) => r.outlivedOwnerAt !== undefined).length,
      });
    }

    const current = this.memory.sample().usedBytes;
    return {
      components: components.sort((a, b) => b.resourcesOutlivingOwner - a.resourcesOutlivingOwner),
      activeResources: this.registry.activeCount,
      findings: this.getFindings(),
      memory: {
        available: this.memory.available,
        source: this.memory.source,
        baselineBytes: this.baselineBytes,
        currentBytes: current,
      },
    };
  }

  clear(): void {
    this.registry.clear();
    this.findings.clear();
    this.stats.clear();
    this.mismatchCounts.clear();
  }

  reset(): void {
    this.shutdown();
    this.clear();
    this.instances.clear();
    this.listeners.clear();
    this.config = { ...defaultConfig };
  }
}

const KEY = Symbol.for("react-memory-detective.instance");
type Global = typeof globalThis & { [KEY]?: Detective };

export function getDetective(): Detective {
  const g = globalThis as Global;
  if (!g[KEY]) g[KEY] = new Detective();
  return g[KEY] as Detective;
}

/**
 * Identifies the *problem*, not the observation: the same uncleared interval in
 * the same component at the same source line is one problem however many times
 * it is seen.
 */
function findingKey(finding: Finding): string {
  const owner = finding.component?.name ?? "unattributed";
  const shape = finding.resources
    .map((r) => `${r.type}@${r.source ? `${r.source.file}:${r.source.line}` : r.label}`)
    .sort()
    .join(",");
  return `${finding.kind}|${owner}|${shape}`;
}

/**
 * A mismatched removeEventListener also shows up as a retained listener. Both
 * are true, but they are one bug, and the mismatch is the finding that names
 * the cause and the fix — so the retention finding is dropped rather than
 * reported alongside it.
 */
function suppressExplained(findings: Finding[]): Finding[] {
  const explained = new Set<string>();
  /*
   * Retention that has already repeated is the same problem as the first
   * suspicion of it, only better evidenced. Reporting both would show the same
   * leak twice and invite the reader to trust the weaker of the two.
   */
  const superseded = new Set<string>();
  for (const finding of findings) {
    if (finding.kind === "listener-mismatch") explained.add(finding.component?.name ?? "unattributed");
    if (finding.kind === "repeated-retention") superseded.add(shapeKey(finding));
  }
  findings = findings.filter((f) => f.kind !== "outlived-owner" || !superseded.has(shapeKey(f)));
  if (explained.size === 0) return findings;
  return findings.filter((finding) => {
    if (finding.kind === "listener-mismatch") return true;
    const owner = finding.component?.name ?? "unattributed";
    if (!explained.has(owner)) return true;
    // Only when *every* resource in it is a listener: an interval leaked by
    // the same component is a separate bug and must still be reported.
    return !finding.resources.every((r) => r.type === "event-listener");
  });
}

/** Owner plus the set of resources involved, ignoring which diagnosis produced it. */
function shapeKey(finding: Finding): string {
  return findingKey(finding).split("|").slice(1).join("|");
}
