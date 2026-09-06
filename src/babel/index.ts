/**
 * Babel plugin: attribute every effect's resources to the component that owns
 * them, with no changes to application code.
 *
 * Without it, `useMemoryTracking` records a component's lifecycle but a socket
 * opened in a plain `useEffect` has no owner, so it is never reported. Asking
 * developers to wrap each resource by hand only works for the component they
 * already suspect, which is the opposite of what a detector is for.
 *
 * Build-time only, and inert in production.
 */
import type { NodePath, PluginObject, PluginPass, types as BabelTypes } from "@babel/core";

/*
 * The public signature deliberately avoids @babel/core's types. They are used
 * throughout the implementation, but a declaration file that references them
 * would force every consumer to install `@types/babel__core` just to type-check
 * their own app — including consumers who only ever import the Vite plugin.
 * Babel is the only caller of the exported function, so a narrow surface costs
 * nothing.
 */
export interface BabelApi {
  types: unknown;
  assertVersion?: (version: number | string) => void;
}

export interface BabelPlugin {
  name: string;
  pre?: (file: unknown) => void;
  visitor: Record<string, unknown>;
}

export interface MemoryDetectivePluginOptions {
  /** Defaults to `NODE_ENV !== "production"`. */
  enabled?: boolean;
  include?: Array<string | RegExp>;
  /** Base for relative paths. Defaults to `process.cwd()`. */
  root?: string;
  exclude?: Array<string | RegExp>;
  /** Import specifier for the runtime. Overridable for testing and monorepos. */
  importSource?: string;
}

interface State extends PluginPass {
  opts: MemoryDetectivePluginOptions;
  rmdTrackLocal?: BabelTypes.Identifier;
  rmdOwnLocal?: BabelTypes.Identifier;
  rmdRelativePath?: string;
}

const DEFAULT_IMPORT_SOURCE = "react-memory-detective";
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
/** Never instrument this package's own runtime: it would recurse. */
const SELF = /[/\\]react-memory-detective[/\\](src|dist)[/\\]/;

export default function memoryDetectiveBabelPlugin(api: BabelApi): BabelPlugin {
  const t = api.types as typeof BabelTypes;
  api.assertVersion?.("^7.0.0-0 || ^8.0.0-0");
  const processed = new WeakSet<BabelTypes.Node>();

  const isComponentName = (name: string | undefined | null): boolean => !!name && /^[A-Z]/.test(name);

  function containsJsx(node: BabelTypes.Node | null | undefined): boolean {
    if (!node) return false;
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    if (t.isConditionalExpression(node)) return containsJsx(node.consequent) || containsJsx(node.alternate);
    if (t.isLogicalExpression(node)) return containsJsx(node.left) || containsJsx(node.right);
    if (t.isCallExpression(node)) return node.arguments.some((a) => containsJsx(a as BabelTypes.Node));
    return false;
  }

  function returnsJsx(path: NodePath<BabelTypes.Function>): boolean {
    const body = path.get("body");
    if (!Array.isArray(body) && !body.isBlockStatement()) return containsJsx((body as NodePath).node);
    let found = false;
    path.traverse({
      Function(inner) {
        inner.skip();
      },
      ReturnStatement(ret) {
        if (ret.node.argument && containsJsx(ret.node.argument)) found = true;
      },
    });
    return found;
  }

  function importOnce(path: NodePath, state: State, exported: string, key: "rmdTrackLocal" | "rmdOwnLocal"): BabelTypes.Identifier {
    const existing = state[key];
    if (existing) return existing;
    const program = path.findParent((p) => p.isProgram()) as NodePath<BabelTypes.Program>;
    const local = program.scope.generateUidIdentifier(exported);
    program.unshiftContainer(
      "body",
      t.importDeclaration(
        [t.importSpecifier(local, t.identifier(exported))],
        t.stringLiteral(state.opts.importSource ?? DEFAULT_IMPORT_SOURCE),
      ),
    );
    state[key] = local;
    return local;
  }

  /** Injects `const _self = useMemoryTracking("Name")` and returns its identifier. */
  function ensureSelf(fn: NodePath<BabelTypes.Function>, name: string, state: State): BabelTypes.Identifier | undefined {
    const body = fn.get("body");
    if (Array.isArray(body) || !body.isBlockStatement()) return undefined;

    const existing = (fn.node as { _rmdSelf?: BabelTypes.Identifier })._rmdSelf;
    if (existing) return existing;

    // Reuse a hand-written `const self = useMemoryTracking(...)` rather than
    // injecting a second one, which would count every mount twice.
    const manual = findManualTracking(body, t);
    if (manual) {
      (fn.node as { _rmdSelf?: BabelTypes.Identifier })._rmdSelf = manual;
      return manual;
    }

    const self = fn.scope.generateUidIdentifier("rmdSelf");
    const track = importOnce(fn, state, "useMemoryTracking", "rmdTrackLocal");
    body.unshiftContainer(
      "body",
      t.variableDeclaration("const", [
        t.variableDeclarator(self, t.callExpression(track, [t.stringLiteral(name)])),
      ]),
    );
    (fn.node as { _rmdSelf?: BabelTypes.Identifier })._rmdSelf = self;
    return self;
  }

  /**
   * Real components are frequently wrapped: `memo(function X(){})`,
   * `forwardRef((props, ref) => {})`, and the two nested. Measured against a
   * real codebase (Excalidraw), these wrappers account for 14% of all effect
   * call sites — skipping them would leave one component in seven silently
   * unattributed, which looks exactly like "the tool found nothing".
   */
  const WRAPPERS = new Set(["memo", "forwardRef", "observer"]);

  function isWrapperCall(path: NodePath | null | undefined): boolean {
    if (!path?.isCallExpression()) return false;
    const callee = path.node.callee;
    const name = t.isIdentifier(callee)
      ? callee.name
      : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
        ? callee.property.name
        : undefined;
    return !!name && WRAPPERS.has(name);
  }

  function componentNameOf(fn: NodePath<BabelTypes.Function>): string | undefined {
    const node = fn.node as { id?: BabelTypes.Identifier | null };
    if (node.id?.name && isComponentName(node.id.name)) return node.id.name;

    // Walk out through any number of wrapper calls to the name they are assigned to.
    let path: NodePath | null | undefined = fn.parentPath;
    while (isWrapperCall(path)) path = path?.parentPath;

    if (path?.isVariableDeclarator() && t.isIdentifier(path.node.id) && isComponentName(path.node.id.name)) {
      return path.node.id.name;
    }
    // `export default memo(function Panel() {…})` — named, but not assigned.
    if (path?.isExportDefaultDeclaration() && node.id?.name && isComponentName(node.id.name)) return node.id.name;
    return undefined;
  }

  const plugin: PluginObject = {
    name: "react-memory-detective",

    pre(file) {
      const state = this as State;
      const filename = file.opts.filename ?? "";
      const root = state.opts.root ?? file.opts.root ?? process.cwd();
      state.rmdRelativePath = filename.startsWith(root) ? filename.slice(root.length).replace(/^[/\\]/, "") : filename;
    },

    visitor: {
      Program: {
        enter(path: NodePath<BabelTypes.Program>, state: State) {
          const enabled = state.opts.enabled ?? process.env.NODE_ENV !== "production";
          const filename = state.file.opts.filename ?? "";
          const skip =
            !enabled ||
            !filename ||
            /node_modules/.test(filename) ||
            SELF.test(filename) ||
            !matches(filename, state.opts.include, true) ||
            matches(filename, state.opts.exclude, false);
          if (skip) path.skip();
        },
      },

      /**
       * `useEffect(fn, deps)` → `useEffect(_rmdOwn(_self, fn), deps)`
       *
       * The component's own tracking hook is injected on demand, so a component
       * with no effects costs nothing.
       */
      CallExpression(path: NodePath<BabelTypes.CallExpression>, state: State) {
        if (processed.has(path.node)) return;
        const callee = path.node.callee;
        const name = t.isIdentifier(callee)
          ? callee.name
          : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
            ? callee.property.name
            : undefined;
        if (!name || !EFFECT_HOOKS.has(name)) return;

        const first = path.node.arguments[0];
        if (!t.isArrowFunctionExpression(first) && !t.isFunctionExpression(first)) return;

        const fn = path.getFunctionParent();
        if (!fn) return;
        const componentName = componentNameOf(fn);
        if (!componentName || !returnsJsx(fn)) return;

        const self = ensureSelf(fn, componentName, state);
        if (!self) return;

        processed.add(path.node);
        const own = importOnce(path, state, "ownEffect", "rmdOwnLocal");
        path.node.arguments[0] = t.callExpression(own, [t.cloneNode(self), first]);
      },
    },
  };

  return plugin as unknown as BabelPlugin;
}

/** Finds `const x = useMemoryTracking(...)` at the top level of a component body. */
function findManualTracking(
  body: NodePath<BabelTypes.BlockStatement>,
  t: typeof BabelTypes,
): BabelTypes.Identifier | undefined {
  for (const statement of body.node.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const init = declarator.init;
      if (
        t.isIdentifier(declarator.id) &&
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee) &&
        init.callee.name === "useMemoryTracking"
      ) {
        return declarator.id;
      }
    }
  }
  return undefined;
}

function matches(filename: string, patterns: Array<string | RegExp> | undefined, whenEmpty: boolean): boolean {
  if (!patterns || patterns.length === 0) return whenEmpty;
  return patterns.some((p) => (typeof p === "string" ? filename.includes(p) : p.test(filename)));
}
