/**
 * types.ts — the data model shared by every script in this folder.
 *
 * `engine.ts` produces these shapes while walking a single file's AST;
 * `flow.ts` (and `debug.ts`) consume them across every file in a project
 * to build the final dependency graph.
 */

/**
 * The category of a `Binding`. Roughly "what kind of thing was declared":
 *
 * - `"function"`  — function declarations, function expressions, arrow
 *                   functions (including `const foo = () => {}`, which is
 *                   classified as a function, not a variable).
 * - `"param"`     — a function parameter (or a leaf name inside a
 *                   destructured/defaulted/rest parameter).
 * - `"class"`     — a `class` declaration's name.
 * - `"variable"`  — a `var`/`let`/`const` binding whose initializer is not
 *                   a function.
 * - `"type"`      — a TS `type`, `interface`, or `enum` declaration.
 * - `"conditional"` — reserved; not currently produced anywhere in engine.ts.
 * - `"catch"`     — a `catch (err)` parameter.
 * - `"import"`    — a local name bound by an `import` specifier. flow.ts
 *                   later resolves these to the real declaration in the
 *                   imported file and merges the uses onto it, so "import"
 *                   bindings never make it into the final graph themselves.
 */
export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "conditional" |
    "catch" |
    "import"
;

/**
 * A single declaration site — a name introduced into scope somewhere in
 * the source — together with every reference (`uses`) to it that the walk
 * found.
 *
 * `file` + `start` together are a stable, unique identity for a
 * declaration (see `nodeId` in flow.ts), since a byte offset is unique
 * within a file.
 */
export interface Binding {
    /** For `kind: "import"` only: the module specifier the import came from
     *  (e.g. `"./engine"` or `"acorn"`), rewritten to an absolute path for
     *  relative imports so it can be looked up in the project's per-file
     *  results — see the ImportDeclaration handling in engine.ts. */
    source?: string;
    /** For `kind: "import"` only: the name as the *source module* knows it,
     *  which is not always the local name. `import { a as b }` binds `b` here
     *  but must be looked up as `a` in the module it came from, and before this
     *  existed the linker searched the source file for `b` and found nothing —
     *  so every renaming import silently failed to link. `"default"` for
     *  `import x from`, `"*"` for `import * as ns from`. */
    imported?: string;
    /** For `kind: "import"` only: this specifier is `import type` / `{ type X }`.
     *  Type-only imports carry no value at runtime, so they can never produce a
     *  data-flow edge; flagged rather than dropped so the import statistics can
     *  exclude them and report a linkage rate over the specifiers that could
     *  actually have linked. */
    typeOnly?: boolean;
    /** The identifier's text, e.g. `"foo"`. */
    name: string;
    /** 1-based source line of the declaration (from `loc`, not `range`). */
    line: number;
    /** The `var` / `let` / `const` keyword for variable declarations;
     *  `""` or `"N/A"` for kinds where a declaration keyword doesn't apply
     *  (params, functions, classes, types, catch params). */
    varType: string;
    /** Absolute path of the file this declaration lives in. */
    file: string;
    kind: Kind;
    /** For `kind: "function"` only: this function's declared parameters,
     *  in positional order, so call arguments can be matched to them by
     *  index (see the CallExpression handling in engine.ts). Populated for
     *  both named functions and anonymous functions assigned to a variable
     *  (`const foo = () => {}`). */
    params?: Binding[];
    /** For methods only: the class the method belongs to, as the start offset
     *  of the class's name (or of the class itself when it has none), in the
     *  same file. A method's name lives in the scope around its class, so this
     *  is what keeps a bare `score()` from resolving to it and lets `this.m()`
     *  pick the enclosing class's `m` (gap 1). */
    methodOf?: number;
    /** Never on a declaration. Set only on the per-call copy of a parameter
     *  that engine.ts uses as a feed target while walking that call's
     *  arguments: the call's start offset, carried into every feed stamped
     *  against it. See `Use.call`. */
    call?: number;
    /** For `kind: "function"` only: every declaration a `return` in this
     *  function reads. `direct` when the name itself is returned (`return v`);
     *  `calls` with the start offset of each call it is the callee of
     *  (`return f(x)` returns that call's result, not `f`). query.ts needs the
     *  difference to keep a value inside the call it belongs to. */
    returns?: { name: string, file: string, start: number, direct?: boolean, calls?: number[] }[];
    /** 0-based byte offset of the declaration's identifier (from `range`).
     *  Combined with `file`, this is the declaration's stable node id. */
    start: number;
    /** Always `"declaration"` for entries in `Results.declarations` —
     *  distinguishes a `Binding` from the `Use` entries nested under it. */
    role: "declaration" | "use";
    /** Every reference to this binding found during the walk. */
    uses: Use[];
}

/**
 * A single reference to a `Binding` — an `Identifier` node whose name
 * resolved to a declaration already on the scope stack.
 */
export interface Use {
    name: string;
    file: string;
    line: number;
    /** 0-based byte offset of this reference (its own position, not the
     *  declaration's). */
    start: number;
    /** Set when this use occurs somewhere a value flows onward from —  a
     *  variable initializer or a call argument. Each entry is the `{file,
     *  start}` identity of a declaration the value flows *into* (the
     *  declared variable, or the matching function parameter). Absent when
     *  the use isn't inside a flow-carrying position. See the "feeds
     *  mechanism" doc comment at the top of engine.ts.
     *
     *  It's a list because one use can feed several declarations at once:
     *  `const { a, b } = foo()` reads `foo` a single time, and that value
     *  flows into both `a` and `b`. Recording it as one use with two targets
     *  keeps `uses` an honest count of source occurrences — the alternative,
     *  one duplicated use per target, is the bug fixed in gap 6.
     *
     *  `inferred` marks a feed the walker could not prove — the value passed
     *  through a call whose callee never resolved (`x = y.replace(z)`), so `z`
     *  is *assumed* to reach `x` because unknown calls are treated as
     *  transparent. See gap 18: it recovers real flow through built-ins, but an
     *  opaque callee may ignore its argument entirely (`n = arr.push(y)`), so
     *  these are the one class of edge in the graph that can be wrong. Kept
     *  separable rather than blended in, so the strict subgraph stays provable. */
    feeds?: {
        name: string; file: string; line: number; start: number; inferred?: boolean;
        /** This use is an argument and the target is the parameter it lands
         *  in: the start offset of that call. */
        call?: number;
    }[];
    /** This use is the callee of a call (`foo` in `foo(x)`, `m` in `o.m(x)`):
     *  the start offset of that call. With `feeds[].call` it identifies one call
     *  site exactly, which line numbers can't when a call spans lines. */
    call?: number;
}

/**
 * One level of lexical scope while walking (global, a function body, or a
 * `{ }` block). `engine.ts` keeps a stack of these so an `Identifier` can
 * be resolved against the innermost scope outward, and so declarations
 * introduced in a scope can be flushed into the file's `Results` once that
 * scope is fully walked (see the pop-phase handling of FunctionDeclaration
 * / FunctionExpression / ArrowFunctionExpression / BlockStatement in
 * engine.ts).
 */
export type Scope = {
    name: string;
    declarations: Binding[];
    /** The `currentFeedTargets` that were active just before entering this
     *  scope, restored when the scope is popped so flow tracking doesn't
     *  leak into or out of the scope it doesn't belong to. */
    savedFeedTargets: Binding[];
    /** The `currentFeedsInferred` flag that travelled with `savedFeedTargets`.
     *  Saved and restored as a pair — the flag qualifies those targets, so
     *  restoring one without the other silently mislabels edges. */
    savedFeedsInferred?: boolean;
    /** The `currentFunction` that was active just before entering this
     *  scope, restored when the scope is popped so flow tracking doesn't
     *  leak into or out of the scope it doesn't belong to. */
    /* 
        Only works for function scopes
    */
    savedFunction: Binding | null;
    /** Function scopes only: the class `this` referred to before entering. */
    savedThisClass?: number | null;
}

/**
 * One `export ... from` statement — a name this module publishes that it does
 * not declare (gap 21).
 *
 * `export { x } from "./y"` reads like `import { x } from "./y"` followed by
 * `export { x }`, but it is not: it creates **no local binding at all**. The
 * name is a forwarding address, and referencing it inside the re-exporting
 * module is a ReferenceError. That is why the linker's "find a declaration
 * called `x` in the source file" step could never work through a barrel — the
 * language guarantees there is nothing there to find. The chain has to be
 * recorded here so `analyse` can walk to the module that really declares it.
 */
export interface ReExport {
    /** The name this module publishes. `undefined` for a bare `export * from`,
     *  which republishes the source's names unchanged and so names nothing. */
    exported?: string;
    /** The name to ask the source module for. Note the direction: on a
     *  re-export specifier the parser's `local` is the name in the *source*
     *  file and `exported` is what this file publishes — the opposite way round
     *  from an import specifier, where `local` is the name in the importing
     *  file. `undefined` for `export * from`. */
    local?: string;
    /** The module specifier, rewritten to an absolute path when it points
     *  inside the project — same treatment, and same resolver, as an import's
     *  `source`. */
    source: string;
    /** `export * from "./y"`. Resolution through one of these is a search
     *  rather than a lookup: the star names nothing, so a name that isn't found
     *  locally has to be tried against every star source in turn. */
    star?: boolean;
    /** For `export * as ns from "./y"` — the namespace this file publishes.
     *  Recorded so it is not mistaken for a bare star: a namespace re-export
     *  does *not* republish the source's names at the top level, so searching
     *  through it for an arbitrary name would invent a link that isn't there. */
    namespace?: string;
    /** `export type { X } from` — no value crosses, same reasoning as
     *  `Binding.typeOnly`. */
    typeOnly?: boolean;
}

/** The output of walking one file: every declaration found in it, each
 *  with its uses already attached. Produced by `collectVariables`. */
export interface Results {
    declarations: Binding[];
    /** Every name this module publishes from its own declarations, mapped to
     *  the local name that backs it — `export { beta as b }` records `b -> beta`,
     *  and the common `export const alpha` records `alpha -> alpha`. `default`
     *  is a key like any other, pointing at whatever `export default` named.
     *
     *  Needed because "is this name exported?" and "is this name declared?" are
     *  different questions, and only the first one is the right one to ask when
     *  following a chain into a module. The linker still falls back to matching
     *  any declaration by name, so this table only ever adds links. */
    exports: Map<string, string>;
    /** Every `export ... from` in the file, in source order — the forwarding
     *  table a barrel file consists of. Empty for the overwhelming majority of
     *  files, which declare what they export. */
    reExports: ReExport[];
    /** How the walk's identifier lookups ended up. Kept per file so the
     *  resolution rate is a number the tests and `analyse` can read directly,
     *  rather than something only reconstructable through the trace hook.
     *
     *  The `external` bucket is the point: a use of `console` is not a failure
     *  of this engine, it's a name that was never going to be in the source.
     *  Counting it as unresolved put a permanent floor under the rate and hid
     *  real regressions behind it. */
    lookups: {
        /** Matched a declaration — immediately, or on the deferred retry. */
        resolved: number;
        /** Matched nothing, and the name isn't a known global: a genuine miss. */
        unresolved: number;
        /** Matched nothing because it names a runtime global or built-in
         *  method (`console`, `Bun`, `push`) that this project never declares. */
        external: number;
    };
    /**
     * Call sites whose callee (e.g. greet(name)) was an import, so the 
     * params to feed weren't knowable during walk-time. Resolved in step 2
     * of analyse.ts, once the import's been linked to the file that actually 
     * declares the function.
     *
     * `fallback` is where the argument goes if that never happens — a package
     * import, or no parameter at `argIndex`: gap 18's pass-through to the
     * enclosing targets, already expanded within the file and all inferred.
     */
    deferredCallFeeds: { callee: Binding; argIndex: number; id: number; fallback: NonNullable<Use["feeds"]> }[];
}

/**
 * The serialized graph — flow.ts's final output, written to `graph.json`
 * and served to the viewer. Distinct from the shapes above: those describe
 * the in-memory analysis, these describe the on-disk artifact that
 * consumers (the viewer, query.ts, external tooling) read back.
 */

/** A declaration promoted to a graph vertex, with a stable id attached.
 *  Imports and `role: "use"` entries never become nodes — flow.ts resolves
 *  imports onto their real declaration first. */
export type GraphNode = Binding & {
    /** `${file}:${start}` — unique, since a byte offset is unique per file. */
    id: string;
};

/** One use site that contributed to an edge, kept so the viewer can show
 *  the actual source line when an edge is clicked. */
export type Occurrence = {
    file: string;
    line: number;
    /** The trimmed source line at `file:line`. */
    code: string;
    /** The use is an argument at the call starting at this offset in `file`,
     *  and the edge carries it into that call's parameter. */
    argOf?: number;
    /** The use is the callee of the call starting at this offset in `file`, and
     *  the edge carries that call's result out. query.ts pairs the two, so a
     *  value that went in through one call comes back out only through it. */
    resultOf?: number;
};

/** A data-flow edge: some use of `source` fed `target` (a variable
 *  initializer or a call argument matched to a parameter). Deduped by
 *  (source, target); every contributing use site lands in `occurrences`. */
export type GraphEdge = {
    /** The `GraphNode.id` of the declaration being used. */
    source: string;
    /** The `GraphNode.id` of the declaration the value flows into. */
    target: string;
    occurrences: Occurrence[];
    /** Set only when *every* use behind this edge was an inferred feed — the
     *  value passed through an unresolved callee. Absent means the edge is
     *  backed by at least one proven flow. See gap 18. */
    inferred?: boolean;
};

export type Graph = {
    /** Absolute path of the analyzed directory, for rendering paths relative to it. */
    root: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
};
