/**
 * The diagnostic model, with no globals patched and no React.
 *
 * `Detective` deliberately lives at the package root instead: it wires in every
 * instrumentation, so exporting it here would drag the global patching into an
 * entry point whose whole purpose is to be inert. Anything built on the event
 * model — a custom reporter, a test harness — can import this and pay for
 * nothing else.
 */
export { ResourceRegistry, now } from "./registry.js";
export { runInOwnerScope, currentOwner, clearOwnerScope } from "./owner.js";
export { MemoryProvider } from "./memory.js";
export { diagnoseOutlivedResources } from "./diagnose.js";
export { diagnoseListenerMismatch } from "./diagnose-listener.js";
export type { OutlivedInput } from "./diagnose.js";
export * from "./types.js";
