#!/usr/bin/env bun
/**
 * query.ts — traversal over a graph.json emitted by flow.ts.
 *
 * Usage: `vena-trace <target> [graph.json] [--back] [--strict] [--depth N] [--max N]`
 *
 * Reads the graph off disk rather than re-running the analysis, so querying
 * is decoupled from the analysis pipeline: `vena` produces the graph
 * once (see its step 5), everything here is a pure consumer of that file.
 *
 * Two questions, one traversal:
 *
 *   - Forward (default) answers "where does this value end up?"
 *       - Direct flow: an edge A -> B means some use of A fed B (a variable
 *         initializer or a call argument matched to a parameter). Following
 *         outgoing edges walks the value downstream.
 *       - Interprocedural: if a function returns the declaration we're standing
 *         on, the value escapes through that function's call sites, so we hop to
 *         the function node and keep following *its* outgoing edges.
 *   - Backward (`--back`) answers "where did this value come from?"
 *       - Direct flow: the same edges read the other way, incoming instead of
 *         outgoing.
 *       - Interprocedural: standing on a *function*, what fed it is whatever it
 *         hands back, so we step into its `returns`. That needs no reverse index
 *         — `returns` is already on the node, stamped there by engine.ts.
 *
 * The two directions are not mirror images in the code: forward needs the
 * inverted `returns` map (declaration -> functions returning it) because it
 * arrives holding a declaration, while backward arrives holding the function and
 * can read the field directly.
 *
 * Targets are addressed the same way results are printed — `file:line`, e.g.
 * `compose.ts:38`. A bare name still works, but names collide heavily in real
 * code (46 declarations named `res` in Hono), and the colliding ones are the
 * well-connected ones, so a name alone cannot reach most of the graph.
 *
 * A visited set keyed by node id keeps cycles (recursion, reassignment loops)
 * from running forever, and `--depth`/`--max` bound the output — this is meant
 * to be callable by an agent, and an unbounded trace off a hub node would fill a
 * context window on its own.
 *
 * Hops marked `~inferred` passed through a call whose callee never resolved, so
 * the flow is assumed rather than proven (gap 18). `--strict` drops them, which
 * turns the answer into a guaranteed subset of the truth instead of a guess.
 */

import type { Binding } from "./types";
import { relative } from "path";

// Mirrors the shapes flow.ts serializes — kept local because they describe
// the on-disk artifact, not the in-memory analysis model in types.ts.
export type GraphNode = Binding & { id: string };
export type Occurrence = { file: string; line: number; code: string; argOf?: number; resultOf?: number };
export type GraphEdge = { source: string; target: string; occurrences: Occurrence[]; inferred?: boolean };
export type Graph = { root: string; nodes: GraphNode[]; edges: GraphEdge[] };

export type Direction = "forward" | "backward";

/** Defaults chosen for an agent-sized answer, not an exhaustive one. */
export const DEFAULT_DEPTH = 8;
export const DEFAULT_MAX = 200;
/** Calls a trace remembers being inside before it forgets the outermost. */
export const MAX_CALL_DEPTH = 8;

/**
 * One line of a trace. Flat rather than a tree: `depth` carries the shape, and a
 * flat list is what both the printer and a future MCP wrapper want to hand back.
 */
export type TraceStep = {
    node: GraphNode;
    depth: number;
    /** How we arrived — the source line for a direct edge, or the return hop. */
    note: string;
    /** Seen earlier in this traversal; not expanded again. */
    revisited: boolean;
    /** The edge we arrived by was inferred — the value passed through a call
     *  whose callee never resolved, so this hop is assumed, not proven. Gap 18. */
    inferred?: boolean;
};

export type TraceResult = {
    steps: TraceStep[];
    /** Hit `maxNodes` and stopped early. */
    truncated: boolean;
    /** Some branch stopped at `maxDepth` rather than running out of edges. */
    depthLimited: boolean;
};

/* ---------------------------------------------------------------- indexing */

export type GraphIndex = {
    byId: Map<string, GraphNode>;
    /** id -> edges leaving it. */
    outgoing: Map<string, GraphEdge[]>;
    /** id -> edges arriving at it. The mirror that makes `--back` possible. */
    incoming: Map<string, GraphEdge[]>;
    /**
     * Inverse of `returns`: declaration id -> functions that hand it back.
     * Precomputed so a forward visit is a lookup instead of a scan over every
     * function node in the graph.
     */
    returnedBy: Map<string, { fn: GraphNode; returned: Returned }[]>;
    /** Parameter id -> the function that declares it. */
    ownerOf: Map<string, GraphNode>;
};

type Returned = NonNullable<GraphNode["returns"]>[number];

/** The calls whose result a function returns, as `file:offset` sites. The call
 *  sits inside the returning function, so its file is that function's file. */
function returnedCalls(fn: GraphNode, returned: Returned): CallSites {
    return new Set((returned.calls ?? []).map((call) => `${fn.file}:${call}`));
}

/** A graph written before `returns` said how a name was returned. */
function untold(returned: Returned): boolean {
    return returned.direct === undefined && returned.calls === undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
}

export function indexGraph(graph: Graph): GraphIndex {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, GraphEdge[]>();
    const incoming = new Map<string, GraphEdge[]>();

    for (const edge of graph.edges) {
        push(outgoing, edge.source, edge);
        push(incoming, edge.target, edge);
    }

    const returnedBy = new Map<string, { fn: GraphNode; returned: Returned }[]>();
    const ownerOf = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
        if (node.kind !== "function") continue;
        for (const returned of node.returns ?? []) {
            push(returnedBy, `${returned.file}:${returned.start}`, { fn: node, returned });
        }
        for (const param of node.params ?? []) {
            ownerOf.set(`${param.file}:${param.start}`, node);
        }
    }

    return { byId, outgoing, incoming, returnedBy, ownerOf };
}

/* ------------------------------------------------------------- call matching */

/**
 * Call sites, each as `file:offset` of the call expression. engine.ts stamps the
 * offset on two kinds of use — an argument (`argOf`) and a callee (`resultOf`) —
 * and analyse.ts carries them onto the edge's occurrences. A set, because one
 * edge can gather the same argument → parameter pair from several calls.
 */
type CallSites = Set<string>;

function sitesOf(edge: GraphEdge, role: "argOf" | "resultOf"): CallSites {
    const sites: CallSites = new Set();
    for (const o of edge.occurrences) {
        if (o[role] !== undefined) sites.add(`${o.file}:${o[role]}`);
    }
    return sites;
}

/** The edge with only the occurrences `keep` accepts, or undefined if none
 *  do. One edge can gather several calls — `outer(inner(a))` and
 *  `outer(inner(b))` share `inner -> p` — and each occurrence pairs one
 *  inner call with one outer call. Matching one end of an edge has to carry
 *  only the occurrences it matched, or the other end gets every call. */
function narrowed(edge: GraphEdge, keep: (o: Occurrence) => boolean): GraphEdge | undefined {
    const occurrences = edge.occurrences.filter(keep);
    return occurrences.length > 0 ? { ...edge, occurrences } : undefined;
}

const atSite = (role: "argOf" | "resultOf", sites: CallSites) => (o: Occurrence) =>
    o[role] !== undefined && sites.has(`${o.file}:${o[role]}`);

/** Some use behind this edge is *not* an argument — a write inside the body
 *  such as `p = normalise(p)` — so it stays within whatever call we are in. */
function hasNonArgument(edge: GraphEdge): boolean {
    return edge.occurrences.some((o) => o.argOf === undefined);
}

/* --------------------------------------------------------------- addressing */

/** `file:line` relative to the analyzed project root. Also the address format
 *  `resolveTarget` accepts, so anything printed can be pasted straight back. */
export function where(graph: Graph, node: GraphNode): string {
    return `${relative(graph.root, node.file)}:${node.line}`;
}

/**
 * True when `spec` names this node's file. Matches the whole relative path or
 * any trailing run of *complete* segments, so `compose.ts` finds `compose.ts`
 * but not `foo-compose.ts` — a bare `endsWith` would silently match the wrong
 * file and there is no way to notice from the output.
 */
function fileMatches(graph: Graph, node: GraphNode, spec: string): boolean {
    if (node.file === spec) return true;
    const rel = relative(graph.root, node.file);
    return rel === spec || rel.endsWith(`/${spec}`);
}

/**
 * Find the nodes an address refers to. Three forms:
 *
 *   res              — any node named `res` (convenient, often ambiguous)
 *   compose.ts:38    — the node at that file and line
 *   compose.ts:res   — the node named `res` in that file
 *
 * Split on the *last* colon so paths keep working, then let the right-hand side
 * decide: all digits means a line number, anything else means a name.
 *
 * Note the address uses `line`, while `node.id` uses `start` (a byte offset).
 * They are different numbers for the same node, so an address can't be turned
 * into an id arithmetically — resolution is a scan.
 */
export function resolveTarget(graph: Graph, address: string): GraphNode[] {
    const colon = address.lastIndexOf(":");
    if (colon === -1) return graph.nodes.filter((node) => node.name === address);

    const filePart = address.slice(0, colon);
    const rest = address.slice(colon + 1);

    if (/^\d+$/.test(rest)) {
        const line = Number(rest);
        return graph.nodes.filter((node) => node.line === line && fileMatches(graph, node, filePart));
    }
    return graph.nodes.filter((node) => node.name === rest && fileMatches(graph, node, filePart));
}

/* ---------------------------------------------------------------- traversal */

export type TraverseOptions = {
    direction?: Direction;
    maxDepth?: number;
    maxNodes?: number;
    /** Follow only proven edges, dropping the inferred ones from gap 18. The
     *  answer becomes a guaranteed subset of the truth rather than a guess. */
    strict?: boolean;
};

export function traverse(
    graph: Graph,
    index: GraphIndex,
    start: GraphNode,
    options: TraverseOptions = {},
): TraceResult {
    const direction = options.direction ?? "forward";
    const maxDepth = options.maxDepth ?? DEFAULT_DEPTH;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX;

    const strict = options.strict ?? false;

    const result: TraceResult = { steps: [], truncated: false, depthLimited: false };
    const visited = new Set<string>();
    const arrow = direction === "forward" ? "->" : "<-";

    /**
     * Calls the trace is currently inside, innermost last. A value that went
     * into a function through one call can only come back out through that
     * same call — without this, `sha1(data)` would trace into `createHash` and
     * back out to `sha256`'s result, because both call it. Entering a call
     * pushes; leaving it pops. An empty stack means the trace started inside
     * the function, so every caller is a real way out.
     *
     *   forward:  argument -> parameter pushes; `returned by` pops, and keeps
     *             only the function's edges at that call.
     *   backward: function -> its `returns` pushes the call we reached the
     *             function through; parameter <- argument pops, and keeps only
     *             the arguments at that call.
     */
    type Context = { fn: string; sites: CallSites }[];

    const keyOf = (sites: CallSites) => [...sites].sort().join(",");

    /**
     * Step into a call. Bounded two ways, because without a bound a recursive
     * function makes every pass a new context and the walk never revisits
     * anything — only the depth limit stopped it, and a large `--depth`
     * overflowed the stack. Re-entering a call already on the stack is
     * recursion and doesn't push again; past MAX_CALL_DEPTH the oldest call is
     * forgotten, so returning that far out falls back to every caller.
     */
    const enter = (context: Context, fn: string, sites: CallSites): Context => {
        const key = keyOf(sites);
        if (context.some((entry) => entry.fn === fn && keyOf(entry.sites) === key)) return context;
        const next = [...context, { fn, sites }];
        return next.length > MAX_CALL_DEPTH ? next.slice(1) : next;
    };
    /** The innermost call, if it is a call to `fn`. A different function's
     *  return or parameters say nothing about the call we are inside. */
    const innermostCallTo = (context: Context, fn: GraphNode | undefined) => {
        const top = context.at(-1);
        return fn && top?.fn === fn.id ? top.sites : undefined;
    };

    function walk(
        node: GraphNode,
        depth: number,
        note: string,
        inferred: boolean,
        context: Context,
        /** Forward: arrived at this function through its return — leave only by
         *  these calls, or by any of them (`"any"`) when no call was entered. */
        returnTo?: CallSites | "any",
        /** Backward: holding this function's result at these calls. */
        enteredBy?: CallSites,
    ): void {
        // Checked before emitting rather than after, so `maxNodes` is a hard cap
        // on lines produced and not merely on lines expanded.
        if (result.steps.length >= maxNodes) {
            result.truncated = true;
            return;
        }

        // The same node reached inside a different call is a different question,
        // so the context is part of what counts as visited.
        const key = [
            node.id,
            context.map((entry) => `${entry.fn}@${keyOf(entry.sites)}`).join(";"),
            returnTo === "any" ? "*" : returnTo ? keyOf(returnTo) : "",
            enteredBy ? keyOf(enteredBy) : "",
        ].join("|");
        if (visited.has(key)) {
            result.steps.push({ node, depth, note, revisited: true, inferred });
            return;
        }
        visited.add(key);
        result.steps.push({ node, depth, note, revisited: false, inferred });

        if (depth >= maxDepth) {
            result.depthLimited = true;
            return;
        }

        const follow = (edge: GraphEdge, nextContext: Context) => {
            if (strict && edge.inferred) return;
            const next = index.byId.get(direction === "forward" ? edge.target : edge.source);
            if (!next) return;
            const at = edge.occurrences[0];
            const label = at ? `${arrow} via \`${at.code}\` ` : `${arrow} `;
            if (direction === "forward") {
                // An argument entering a parameter enters that call. The same
                // edge can also hold a write inside the body, which doesn't.
                const owner = next.kind === "param" ? index.ownerOf.get(next.id) : undefined;
                const entering = owner ? sitesOf(edge, "argOf") : new Set<string>();
                if (owner && entering.size > 0) {
                    walk(next, depth + 1, label, edge.inferred === true, enter(nextContext, owner.id, entering));
                }
                if (entering.size === 0 || hasNonArgument(edge)) {
                    walk(next, depth + 1, label, edge.inferred === true, nextContext);
                }
            } else {
                const results = next.kind === "function" ? sitesOf(edge, "resultOf") : undefined;
                walk(next, depth + 1, label, edge.inferred === true, nextContext,
                    undefined, results && results.size > 0 ? results : undefined);
            }
        };

        // Direct flow: the same edge set read from whichever end we are walking.
        if (direction === "forward") {
            const edges = index.outgoing.get(node.id) ?? [];
            for (const edge of edges) {
                // Back out of a call: only the result of the call we went in
                // through, and only the uses of that result — not the outer
                // calls other results on the same edge were passed to.
                const kept = returnTo && returnTo !== "any" ? narrowed(edge, atSite("resultOf", returnTo)) : edge;
                if (kept) follow(kept, context);
            }
        } else {
            const edges = index.incoming.get(node.id) ?? [];
            const inCall = node.kind === "param" ? innermostCallTo(context, index.ownerOf.get(node.id)) : undefined;
            if (inCall) {
                // Writes inside the body stay in this call; arguments leave it,
                // and only the ones at the call we came in through are real.
                // Each path carries only its own occurrences, so a matched
                // argument doesn't bring along the inner calls of the others.
                for (const edge of edges) {
                    const body = narrowed(edge, (o) => o.argOf === undefined);
                    if (body) follow(body, context);
                    const argument = narrowed(edge, atSite("argOf", inCall));
                    if (argument) follow(argument, context.slice(0, -1));
                }
            } else {
                for (const edge of edges) follow(edge, context);
            }
        }

        // Interprocedural flow. Forward: the value leaves through the return of
        // any function that hands it back, so continue from that function's own
        // outgoing edges. Backward: we are standing on a function, so what fed it
        // is whatever it returns — read straight off the node.
        //
        // What we hold decides which returns apply. `return v` hands back `v`;
        // `return f(x)` hands back the result of that one call, not `f`. Holding
        // a call's result (we just left it), only a return of that call counts —
        // without this, `return down(n - 1)` let a value leave the outer call
        // and then leave again, to every caller. Starting on a function means
        // "where do its results go", so every return of it counts there.
        // Leaving a function the trace started inside (no call to match) means
        // holding its result from every call, so a return of any call counts —
        // but not `return f`, which hands back the function, not a result.
        if (direction === "forward") {
            for (const { fn, returned } of index.returnedBy.get(node.id) ?? []) {
                const applies =
                    untold(returned) ? true :
                    returnTo === "any" ? returnedCalls(fn, returned).size > 0 :
                    returnTo ? [...returnTo].some((site) => returnedCalls(fn, returned).has(site)) :
                    depth === 0 && node.kind === "function" ? true :
                    returned.direct === true;
                if (!applies) continue;
                const inCall = innermostCallTo(context, fn);
                walk(fn, depth + 1, "-> returned by ", false, inCall ? context.slice(0, -1) : context, inCall ?? "any");
            }
        } else if (node.kind === "function" && node.returns) {
            // Reached through a call's result: its returns are inside that call.
            // Reached any other way (`const g = fn`), there is no call to be in.
            const inner = enteredBy ? enter(context, node.id, enteredBy) : context;
            for (const returned of node.returns) {
                const next = index.byId.get(`${returned.file}:${returned.start}`);
                if (!next) continue;
                // `return f(x)`: what came back is f's result at that call, so f
                // is entered through it. `return v` (or an older graph): v itself.
                const calls = returnedCalls(node, returned);
                if (calls.size > 0) walk(next, depth + 1, "<- returns ", false, inner, undefined, calls);
                if (calls.size === 0 || returned.direct || untold(returned)) walk(next, depth + 1, "<- returns ", false, inner);
            }
        }
    }

    walk(start, 0, "", false, []);
    return result;
}

export function formatTrace(graph: Graph, result: TraceResult): string[] {
    const lines = result.steps.map((step) => {
        const indent = "  ".repeat(step.depth);
        const at = where(graph, step.node);
        // Marked on the line the hop produced, because "inferred" describes the
        // edge we arrived by, not the node we arrived at — the same node can be
        // reached by a proven edge elsewhere in the same trace.
        const mark = step.inferred ? " ~inferred" : "";
        return step.revisited
            ? `${indent}${step.note}${step.node.name} (${at}) — already visited${mark}`
            : `${indent}${step.note}${step.node.name} [${step.node.kind}] (${at})${mark}`;
    });
    if (result.depthLimited) lines.push(`vena-trace: some branches stopped at the depth limit — raise it with --depth N`);
    if (result.truncated) lines.push(`vena-trace: output truncated at ${result.steps.length} nodes — raise it with --max N`);
    return lines;
}

/* ---------------------------------------------------------------------- CLI */

const USAGE =
    "vena-trace — follow one value through a graph built by `vena`.\n" +
    "\n" +
    "Usage: vena-trace <target> [graph.json] [--back] [--strict] [--depth N] [--max N]\n" +
    "  <target>      what to trace: file:line (`compose.ts:38`), file:name\n" +
    "                (`compose.ts:res`), or a bare name (`res`). Ambiguous input\n" +
    "                lists the matches with addresses you can paste back.\n" +
    "  [graph.json]  graph to read (default: ./graph.json, written by `vena`)\n" +
    "  --back        where did this value come from? (default: where does it go?)\n" +
    "  --strict      proven edges only — drop flow assumed through unresolved calls\n" +
    `  --depth N     maximum hops (default ${DEFAULT_DEPTH})\n` +
    `  --max N       maximum nodes printed (default ${DEFAULT_MAX})\n` +
    "\n" +
    "Output marked `~inferred` passed through a call vena could not resolve, so the\n" +
    "hop is assumed rather than proven. `--strict` omits those.";

/** Flags carry a value or they don't; one set can't drive both cases. */
const BOOL_FLAGS = new Set(["--back", "-b", "--strict", "-s"]);
const VALUE_FLAGS = new Set(["--depth", "-d", "--max", "-m"]);

export type ParsedArgs = {
    positionals: string[];
    direction: Direction;
    maxDepth: number;
    maxNodes: number;
    strict: boolean;
};

/**
 * Sort argv into flags and positionals in a single pass. A flag is recognised by
 * its leading `-`, never by its index, so `--back` works whether or not a graph
 * path is given and whichever side of the target it lands on. Value-taking flags
 * consume the following item and skip past it.
 */
export function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    let direction: Direction = "forward";
    let maxDepth = DEFAULT_DEPTH;
    let maxNodes = DEFAULT_MAX;
    let strict = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        // push positionals into a separate list to avoid them from flags and numbers
        if (!arg.startsWith("-")) {
            positionals.push(arg);
            continue;
        }

        if (BOOL_FLAGS.has(arg)) {
            if (arg === "--back" || arg === "-b") direction = "backward";
            else strict = true;
            continue;
        }

        if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown option ${arg}`);

        // Read the value before advancing, and reject anything that isn't a
        // positive integer — otherwise `--depth --back` silently eats the next
        // flag and `--depth` alone silently means NaN.
        const raw = argv[i + 1];
        if (raw === undefined) throw new Error(`${arg} needs a number`);
        if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${arg} needs a positive integer, got ${raw}`);
        if (arg === "--depth" || arg === "-d") maxDepth = Number(raw);
        else maxNodes = Number(raw);
        i++;
    }

    return { positionals, direction, maxDepth, maxNodes, strict };
}

async function main(): Promise<void> {
    // Before parseArgs, so help is a success rather than an "unknown option"
    // error on stderr with exit 1.
    if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
        console.log(USAGE);
        process.exit(0);
    }

    let args: ParsedArgs;
    try {
        args = parseArgs(Bun.argv.slice(2));
    } catch (error) {
        console.error(`vena-trace: ${(error as Error).message}\n${USAGE}`);
        process.exit(1);
    }

    const target = args.positionals[0];
    const graphPath = args.positionals[1] ?? "graph.json";

    if (!target) {
        console.error(USAGE);
        process.exit(1);
    }

    const file = Bun.file(graphPath);
    if (!(await file.exists())) {
        console.error(`vena-trace: no graph at ${graphPath} — run \`vena\` first`);
        process.exit(1);
    }

    const graph: Graph = await file.json();

    if (!Array.isArray(graph.edges)) {
        console.error(`vena-trace: ${graphPath} has no edges — it predates the current flow.ts output; regenerate it`);
        process.exit(1);
    }

    const starts = resolveTarget(graph, target);

    if (starts.length === 0) {
        console.log(`vena-trace: nothing matching ${target} in ${graphPath}`);
        process.exit(1);
    }

    if (starts.length > 1) {
        // Every line here is a valid target, which is the point: the ambiguity
        // message hands back addresses that can be pasted straight into a rerun.
        console.log(`vena-trace: ${starts.length} declarations match ${target}; tracing the first.`);
        console.log(`vena-trace: re-run with one of these to pick another:`);
        for (const start of starts) console.log(`  ${where(graph, start)} [${start.kind}] ${start.name}`);
        console.log("");
    }

    const index = indexGraph(graph);
    const result = traverse(graph, index, starts[0]!, {
        direction: args.direction,
        maxDepth: args.maxDepth,
        maxNodes: args.maxNodes,
        strict: args.strict,
    });

    for (const line of formatTrace(graph, result)) console.log(line);
}

if (import.meta.main) await main();
