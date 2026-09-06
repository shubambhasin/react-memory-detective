/** Public event and diagnostic model. Everything else is internal. */

export type ResourceType =
  | "timeout"
  | "interval"
  | "animation-frame"
  | "idle-callback"
  | "event-listener"
  | "websocket"
  | "event-source"
  | "mutation-observer"
  | "resize-observer"
  | "intersection-observer"
  | "broadcast-channel"
  | "worker"
  | "subscription"
  | "request"
  | "custom";

export type ResourceStatus =
  /** Created, no release observed. */
  | "active"
  /** Released, and we saw the release. */
  | "released"
  /**
   * Released itself without our seeing it — a timeout that fired, a request
   * that settled. Not a leak, and not a cleanup either.
   */
  | "self-resolved";

/**
 * How firmly a resource is tied to a component.
 *
 * The distinction is load-bearing: a resource created inside a tracked effect
 * is *owned*, while one created merely while a component happened to be
 * mounted is at best *associated*, and saying otherwise invents causation.
 */
export type OwnershipKind = "owned" | "associated" | "none";

export interface SourceLocation {
  /** `ChatPanel.tsx:47:12` when it could be determined. */
  file: string;
  line?: number;
  column?: number;
}

export interface ComponentRef {
  /** Unique per mounted instance — two `<UserCard />`s are never merged. */
  instanceId: string;
  name: string;
  /** Index of the effect that was running, when known. */
  effectIndex?: number;
}

export interface ResourceRecord {
  id: string;
  type: ResourceType;
  /** `setInterval`, `resize on window`, `wss://…` — enough to recognise it. */
  label: string;
  status: ResourceStatus;
  createdAt: number;
  releasedAt?: number;
  owner?: ComponentRef;
  ownership: OwnershipKind;
  source?: SourceLocation;
  /** Set when the owning component unmounted while this was still active. */
  outlivedOwnerAt?: number;
}

export type LifecyclePhase = "mount" | "unmount";

export interface LifecycleEvent {
  component: ComponentRef;
  phase: LifecyclePhase;
  at: number;
  /**
   * StrictMode's development remount, not a real one. Excluded from every
   * count, because it produces exactly the shape a leak detector looks for.
   */
  strictModeReplay: boolean;
}

export type Confidence = "high" | "medium" | "low";

/**
 * Deliberately not "leak". The tool observes retention; a leak is a conclusion
 * that needs evidence this runtime often cannot supply.
 */
export type FindingKind =
  /** A resource is still active after its owner unmounted. */
  | "outlived-owner"
  /** removeEventListener was called with a different function reference. */
  | "listener-mismatch"
  /** The same retention repeated across mount/unmount cycles. */
  | "repeated-retention"
  /** Instances were never collected across cycles, and memory rose with them. */
  | "growth-pattern";

export interface Finding {
  id: string;
  kind: FindingKind;
  component?: ComponentRef;
  resources: ResourceRecord[];
  /** One line: what was observed. Never a claim beyond the evidence. */
  summary: string;
  /** Ordered facts supporting it, most relevant first. */
  evidence: string[];
  /** Present only when the evidence supports one. */
  suggestion?: string;
  confidence: Confidence;
  severity: "info" | "warning" | "high" | "critical";
  observedAt: number;
  /** How many times this same problem has been observed. */
  occurrences?: number;
  firstObservedAt?: number;
}

export interface MemorySample {
  at: number;
  /** Bytes, when a memory API is available. */
  usedBytes?: number;
  source: "performance.memory" | "measureUserAgentSpecificMemory" | "unavailable";
}

export interface ComponentStats {
  name: string;
  mounts: number;
  unmounts: number;
  /** Instances whose weak token has not been collected. Suspicion, not proof. */
  uncollectedInstances: number;
  activeResources: number;
  resourcesOutlivingOwner: number;
}

export interface MemoryReport {
  components: ComponentStats[];
  activeResources: number;
  findings: Finding[];
  memory: {
    available: boolean;
    source: MemorySample["source"];
    baselineBytes?: number;
    currentBytes?: number;
  };
}

export interface DetectiveConfig {
  enabled: boolean;
  mode: "silent" | "console" | "verbose";
  /**
   * How long to wait after an unmount before treating a still-active resource
   * as notable. Some resources legitimately close asynchronously.
   */
  cleanupGracePeriodMs: number;
  /** Ring-buffer capacity for resources and findings. */
  maxRecords: number;
  /** Capture a stack at creation to locate the call site. Costs time. */
  captureSource: boolean;
  /** Which globals to instrument. */
  track: {
    timers: boolean;
    listeners: boolean;
    observers: boolean;
    sockets: boolean;
    workers: boolean;
    requests: boolean;
  };
  onFinding?: (finding: Finding) => void;
}

export type DetectiveOptions = Partial<Omit<DetectiveConfig, "track">> & {
  track?: Partial<DetectiveConfig["track"]>;
};
