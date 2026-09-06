import { diagnoseListenerMismatch } from "./diagnose-listener.js";
import { diagnoseOutlivedResources } from "./diagnose.js";
import { MemoryProvider } from "./memory.js";
import { now, ResourceRegistry } from "./registry.js";
import { runInOwnerScope } from "./owner.js";
import { instrumentListeners } from "../resources/listeners.js";
import type { ListenerMismatch } from "../resources/listeners.js";
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
  readonly registry = new ResourceRegistry({ maxRecords: defaultConfig.maxRecords });
  readonly memory = new MemoryProvider();

  private instances = new Map<string, InstanceRecord>();
  private stats = new Map<string, NameStats>();
  private findings: Finding[] = [];
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
    this.findings.push(finding);
    if (this.findings.length > this.config.maxRecords) this.findings.shift();
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
    return [...this.findings];
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
    this.findings.length = 0;
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
