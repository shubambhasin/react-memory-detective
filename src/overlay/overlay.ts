import { getDetective } from "../core/detective.js";
import { formatSource } from "../resources/source.js";
import type { Finding, MemoryReport } from "../core/types.js";

export interface OverlayHandle {
  destroy: () => void;
  show: () => void;
  hide: () => void;
}

const MOUNTED = Symbol.for("react-memory-detective.overlay");
type Global = typeof globalThis & { [MOUNTED]?: OverlayHandle };

const TONE: Record<Finding["confidence"], string> = { high: "bad", medium: "warn", low: "dim" };

/**
 * Development overlay.
 *
 * Plain DOM in a shadow root, deliberately: rendering an inspector inside the
 * React tree it is inspecting would add the very lifecycle events it reports
 * on. It consumes the same findings as the console — no diagnostic logic lives
 * here.
 */
export function mountOverlay(): OverlayHandle {
  const g = globalThis as Global;
  if (g[MOUNTED]) return g[MOUNTED] as OverlayHandle;
  if (typeof document === "undefined") {
    return { destroy: () => {}, show: () => {}, hide: () => {} };
  }

  const detective = getDetective();
  const root = document.createElement("div");
  root.setAttribute("data-rmd-overlay", "");
  root.attachShadow({ mode: "open" });
  const shadow = root.shadowRoot as ShadowRoot;
  shadow.innerHTML = TEMPLATE;
  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string): T => shadow.querySelector(sel) as T;
  const panel = $<HTMLDivElement>("#panel");
  const summary = $<HTMLDivElement>("#summary");
  const list = $<HTMLDivElement>("#list");
  const detail = $<HTMLPreElement>("#detail");

  let selected: string | undefined;
  let dirty = true;

  const unsubscribe = detective.subscribe(() => {
    dirty = true;
  });

  $("#clear").addEventListener("click", () => {
    detective.clear();
    selected = undefined;
    detail.textContent = "";
    dirty = true;
  });
  $("#close").addEventListener("click", () => handle.hide());
  list.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
    if (!row) return;
    selected = row.dataset.id;
    dirty = true;
  });

  const timer = setInterval(() => {
    if (!dirty || panel.hidden) return;
    dirty = false;
    render();
  }, 700);

  function render(): void {
    const report = detective.getReport();
    summary.innerHTML = summaryHtml(report);

    const findings = report.findings.slice().reverse();
    list.innerHTML =
      findings.length === 0
        ? `<div class="empty">No retention observed yet. Mount and unmount the components you suspect — confidence comes from repetition.</div>`
        : findings
            .map((f) => {
              const cls = TONE[f.confidence];
              return `<div class="row${f.id === selected ? " sel" : ""}" data-id="${escape(f.id)}">
                <span class="dot ${cls}"></span>
                <span class="name">${escape(f.component?.name ?? "unattributed")}</span>
                <span class="kind">${escape(f.kind.replace(/-/g, " "))}</span>
                <span class="conf ${cls}">${f.confidence}</span>
              </div>`;
            })
            .join("");

    const finding = findings.find((f) => f.id === selected);
    detail.textContent = finding ? formatFinding(finding) : "Select a finding to see the evidence.";
  }

  const handle: OverlayHandle = {
    destroy() {
      unsubscribe();
      clearInterval(timer);
      root.remove();
      (globalThis as Global)[MOUNTED] = undefined;
    },
    show() {
      panel.hidden = false;
      dirty = true;
    },
    hide() {
      panel.hidden = true;
    },
  };

  g[MOUNTED] = handle;
  return handle;
}

function summaryHtml(report: MemoryReport): string {
  const memory = report.memory.available
    ? `${mb(report.memory.currentBytes)} <span class="dim">(baseline ${mb(report.memory.baselineBytes)})</span>`
    : `<span class="dim">unavailable in this browser</span>`;
  return (
    `<div><b>${report.activeResources}</b> active resources · <b>${report.findings.length}</b> findings</div>` +
    `<div class="dim">Memory ${memory}</div>`
  );
}

/** The same text the console prints, so the two can never disagree. */
export function formatFinding(finding: Finding): string {
  const lines = [finding.summary, ""];
  if (finding.component) lines.push(`Component:   ${finding.component.name}`);
  lines.push(`Confidence:  ${finding.confidence}`, "", "Evidence");
  for (const line of finding.evidence) lines.push(`  • ${line}`);
  for (const resource of finding.resources.slice(0, 8)) {
    const where = formatSource(resource.source);
    lines.push(`  – ${resource.label}${where ? `  ${where}` : ""}`);
  }
  if (finding.suggestion) lines.push("", "Next step", `  ${finding.suggestion}`);
  return lines.join("\n");
}

const mb = (bytes?: number): string => (bytes === undefined ? "—" : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

const TEMPLATE = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; right: 16px; bottom: 16px; width: 460px; max-height: 72vh;
    display: flex; flex-direction: column; z-index: 2147483000;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #14161a; color: #e6e6e6; border: 1px solid #2b2f36; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden;
  }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #1b1e24; border-bottom: 1px solid #2b2f36; }
  header b { font-weight: 600; letter-spacing: .02em; }
  .spacer { flex: 1; }
  button { font: inherit; color: inherit; background: #23272e; border: 1px solid #333842; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
  #summary { padding: 6px 10px; border-bottom: 1px solid #2b2f36; }
  #list { overflow: auto; max-height: 30vh; }
  .row { display: flex; gap: 8px; padding: 5px 10px; cursor: pointer; align-items: baseline; }
  .row:hover { background: #1d2128; }
  .row.sel { background: #263041; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kind { color: #9aa4b2; }
  .conf { min-width: 52px; text-align: right; }
  .bad { color: #ff8b7d; } .bad.dot { background: #ff8b7d; }
  .warn { color: #e8b45c; } .warn.dot { background: #e8b45c; }
  .dim { color: #8a94a6; } .dim.dot { background: #5b6472; }
  .empty { padding: 14px 10px; color: #8a94a6; }
  #detail { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; border-top: 1px solid #2b2f36; color: #cfd6df; }
</style>
<div id="panel">
  <header>
    <b>Memory Detective</b>
    <span class="spacer"></span>
    <button id="clear">Clear</button>
    <button id="close">×</button>
  </header>
  <div id="summary"></div>
  <div id="list"></div>
  <pre id="detail">Select a finding to see the evidence.</pre>
</div>
`;
