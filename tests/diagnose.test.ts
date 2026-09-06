import { describe, expect, it } from "vitest";
import { diagnoseOutlivedResources } from "../src/core/diagnose.js";
import { diagnoseListenerMismatch } from "../src/core/diagnose-listener.js";
import type { ResourceRecord, ResourceType } from "../src/core/types.js";

const owner = { instanceId: "i1", name: "ChatPanel" };

const resource = (type: ResourceType, over: Partial<ResourceRecord> = {}): ResourceRecord => ({
  id: `r_${type}_${Math.random()}`,
  type,
  label: type,
  status: "active",
  createdAt: 0,
  owner,
  ownership: "owned",
  outlivedOwnerAt: 1000,
  ...over,
});

const input = (over: Partial<Parameters<typeof diagnoseOutlivedResources>[0]> = {}) => ({
  resources: [resource("websocket")],
  cycles: 1,
  cyclesWithRetention: 1,
  gracePeriodMs: 1000,
  ...over,
});

describe("resources that outlive their owner", () => {
  it("reports a socket left open, and says how to release it", () => {
    const finding = diagnoseOutlivedResources(input()) as NonNullable<ReturnType<typeof diagnoseOutlivedResources>>;
    expect(finding.kind).toBe("outlived-owner");
    expect(finding.summary).toContain("ChatPanel");
    expect(finding.summary).toContain("websocket");
    expect(finding.suggestion).toContain("socket.close()");
  });

  it("never claims proof, because collection cannot be observed from a page", () => {
    const finding = diagnoseOutlivedResources(input())!;
    expect(finding.evidence.join(" ")).toContain("not proof of a leak");
    expect(finding.summary).not.toMatch(/leak/i);
  });

  it("stays low confidence on a single observation", () => {
    const finding = diagnoseOutlivedResources(input({ cycles: 1, cyclesWithRetention: 1 }))!;
    expect(finding.confidence).toBe("low");
    expect(finding.evidence.join(" ")).toContain("asynchronous close");
  });

  it("earns confidence through repetition, not through a louder single case", () => {
    const some = diagnoseOutlivedResources(input({ cycles: 10, cyclesWithRetention: 4 }))!;
    expect(some.confidence).toBe("medium");

    const every = diagnoseOutlivedResources(input({ cycles: 20, cyclesWithRetention: 20 }))!;
    expect(every.confidence).toBe("high");
    expect(every.kind).toBe("repeated-retention");
    expect(every.evidence.join(" ")).toContain("pattern, not a race");
  });

  it("does not treat a pending timeout as a retained resource", () => {
    // A setTimeout that has not fired is not a leak; it is a timeout.
    expect(diagnoseOutlivedResources(input({ resources: [resource("timeout")] }))).toBeUndefined();
    expect(diagnoseOutlivedResources(input({ resources: [resource("animation-frame")] }))).toBeUndefined();
  });

  it("counts the persistent resources and mentions the transient ones separately", () => {
    const finding = diagnoseOutlivedResources(
      input({ resources: [resource("interval"), resource("timeout"), resource("timeout")] }),
    )!;
    expect(finding.resources).toHaveLength(1);
    expect(finding.summary).toContain("1 × interval");
    expect(finding.evidence.join(" ")).toContain("2 pending timeouts");
    expect(finding.evidence.join(" ")).toContain("not counted");
  });

  it("says nothing when nothing outlived the component", () => {
    expect(diagnoseOutlivedResources(input({ resources: [] }))).toBeUndefined();
  });
});

describe("listener cleanup mismatch", () => {
  const mismatch = {
    target: "window",
    event: "resize",
    reason: "reference" as const,
    addedSource: { file: "src/SearchPanel.tsx", line: 43, column: 5 },
    removedSource: { file: "src/SearchPanel.tsx", line: 46, column: 7 },
    at: 1000,
  };

  it("is stated as fact, because both references were observed", () => {
    const finding = diagnoseListenerMismatch(mismatch, 1);
    // The only finding that needs no repetition: the mechanism is certain.
    expect(finding.confidence).toBe("high");
    expect(finding.evidence.join(" ")).toContain("fact rather than an inference");
    expect(finding.summary).toContain("still attached");
  });

  it("distinguishes a wrong capture flag, which needs a different fix", () => {
    const finding = diagnoseListenerMismatch({ ...mismatch, reason: "capture" }, 1);
    expect(finding.summary).toContain("different capture flag");
    expect(finding.suggestion).toContain("capture: true");
  });

  it("names both call sites and the actual fix", () => {
    const finding = diagnoseListenerMismatch(mismatch, 3);
    expect(finding.evidence.join(" ")).toContain("src/SearchPanel.tsx:43:5");
    expect(finding.evidence.join(" ")).toContain("src/SearchPanel.tsx:46:7");
    expect(finding.suggestion).toContain("same reference");
    expect(finding.severity).toBe("high");
  });
});
