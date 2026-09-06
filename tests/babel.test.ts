import { transformSync, type PluginTarget } from "@babel/core";
import { describe, expect, it } from "vitest";
import plugin from "../src/babel/index.js";

const transform = (code: string, opts: Record<string, unknown> = {}, filename = "/app/src/Widget.tsx"): string =>
  transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    // Narrowed public signature — see the comment on BabelApi.
    plugins: [[plugin as unknown as PluginTarget, { enabled: true, ...opts }]],
  })?.code ?? "";

describe("the build plugin", () => {
  it("wraps a component's effect so its resources get an owner", () => {
    const out = transform(`
      function Widget() {
        useEffect(() => { setInterval(() => {}, 1000); }, []);
        return <div />;
      }
    `);
    expect(out).toContain("useMemoryTracking(\"Widget\")");
    expect(out).toMatch(/ownEffect\)?\(_rmdSelf/);
    expect(out).toContain('from "react-memory-detective"');
  });

  it("reuses a hand-written tracking hook instead of counting mounts twice", () => {
    const out = transform(`
      function Widget() {
        const self = useMemoryTracking("Widget");
        useEffect(() => {}, []);
        return <div />;
      }
    `);
    expect(out.match(/useMemoryTracking\(/g)).toHaveLength(1);
    expect(out).toMatch(/ownEffect\)?\(self,/);
  });

  it("leaves arrow components and useLayoutEffect handled the same way", () => {
    const out = transform(`
      const Widget = () => {
        useLayoutEffect(() => {}, []);
        return <div />;
      };
    `);
    expect(out).toContain("useMemoryTracking(\"Widget\")");
  });

  it("ignores effects outside components, where there is nothing to attribute to", () => {
    const out = transform(`
      function useThing() {
        useEffect(() => {}, []);
        return 1;
      }
      function helper() {
        useEffect(() => {}, []);
      }
    `);
    expect(out).not.toContain("useMemoryTracking");
    expect(out).not.toContain("ownEffect");
  });

  it("injects nothing into a component with no effects", () => {
    const out = transform(`function Widget() { return <div />; }`);
    expect(out).not.toContain("useMemoryTracking");
  });

  it("does nothing in production, and nothing to node_modules", () => {
    const code = `function Widget() { useEffect(() => {}, []); return <div />; }`;
    expect(transform(code, { enabled: false })).not.toContain("ownEffect");
    expect(transform(code, {}, "/app/node_modules/x/Widget.tsx")).not.toContain("ownEffect");
  });

  it("respects include and exclude", () => {
    const code = `function Widget() { useEffect(() => {}, []); return <div />; }`;
    expect(transform(code, { include: [/nowhere/] })).not.toContain("ownEffect");
    expect(transform(code, { exclude: [/Widget/] })).not.toContain("ownEffect");
    expect(transform(code, { include: [/src/] })).toContain("ownEffect");
  });

  it("is idempotent, so a second pass does not double-wrap", () => {
    const once = transform(`function Widget() { useEffect(() => {}, []); return <div />; }`);
    const twice = transform(once);
    expect(twice.match(/ownEffect/g)?.length).toBe(once.match(/ownEffect/g)?.length);
  });
});

/**
 * Measured against Excalidraw, these wrappers are 14% of all effect call sites.
 * A component in seven going unattributed is indistinguishable, to a user, from
 * the tool being broken.
 */
describe("wrapped components", () => {
  const cases: Array<[string, string]> = [
    ["memo with a named function", `const Widget = memo(function Widget() { useEffect(() => {}, []); return <div />; });`],
    ["memo with an arrow", `const Widget = memo(() => { useEffect(() => {}, []); return <div />; });`],
    ["forwardRef", `const Widget = forwardRef((props, ref) => { useEffect(() => {}, []); return <div ref={ref} />; });`],
    ["memo(forwardRef(...))", `const Widget = memo(forwardRef((props, ref) => { useEffect(() => {}, []); return <div />; }));`],
    ["React.memo member call", `const Widget = React.memo(() => { useEffect(() => {}, []); return <div />; });`],
  ];

  for (const [label, code] of cases) {
    it(`attributes a component declared with ${label}`, () => {
      const out = transform(code);
      expect(out).toContain('useMemoryTracking("Widget")');
      expect(out).toContain("ownEffect");
    });
  }

  it("still ignores a non-component wrapped in the same way", () => {
    const out = transform(`const helper = memo(() => { useEffect(() => {}, []); return 1; });`);
    expect(out).not.toContain("useMemoryTracking");
  });
});
