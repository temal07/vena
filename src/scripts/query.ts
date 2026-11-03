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
export type Occurrence = { file: string; line: number; code: string };
export type GraphEdge = { source: string; target: string; occurrences: Occurrence[]; inferred?: boolean };
export type Graph = { root: string; nodes: GraphNode[]; edges: GraphEdge[] };

export type Direction = "forward" | "backward";

/** Defaults chosen for an agent-sized answer, not an exhaustive one. */
export const DEFAULT_DEPTH = 8;
export const DEFAULT_MAX = 200;

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
    returnedBy: Map<string, GraphNode[]>;
};

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

    const returnedBy = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
        if (node.kind !== "function" || !node.returns) continue;
        for (const returned of node.returns) {
            push(returnedBy, `${returned.file}:${returned.start}`, node);
        }
    }

    return { byId, outgoing, incoming, returnedBy };
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

    function walk(node: GraphNode, depth: number, note: string, inferred = false): void {
        // Checked before emitting rather than after, so `maxNodes` is a hard cap
        // on lines produced and not merely on lines expanded.
        if (result.steps.length >= maxNodes) {
            result.truncated = true;
            return;
        }

        if (visited.has(node.id)) {
            result.steps.push({ node, depth, note, revisited: true, inferred });
            return;
        }
        visited.add(node.id);
        result.steps.push({ node, depth, note, revisited: false, inferred });

        if (depth >= maxDepth) {
            result.depthLimited = true;
            return;
        }

        // Direct flow: the same edge set read from whichever end we are walking.
        const edges = (direction === "forward" ? index.outgoing : index.incoming).get(node.id) ?? [];
        for (const edge of edges) {
            if (strict && edge.inferred) continue;
            const next = index.byId.get(direction === "forward" ? edge.target : edge.source);
            if (!next) continue;
            const at = edge.occurrences[0];
            walk(next, depth + 1, at ? `${arrow} via \`${at.code}\` ` : `${arrow} `, edge.inferred === true);
        }

        // Interprocedural flow. Forward: the value leaves through the return of
        // any function that hands it back, so continue from that function's own
        // outgoing edges. Backward: we are standing on a function, so what fed it
        // is whatever it returns — read straight off the node.
        if (direction === "forward") {
            for (const fn of index.returnedBy.get(node.id) ?? []) {
                walk(fn, depth + 1, "-> returned by ");
            }
        } else if (node.kind === "function" && node.returns) {
            for (const returned of node.returns) {
                const next = index.byId.get(`${returned.file}:${returned.start}`);
                if (!next) continue;
                walk(next, depth + 1, "<- returns ");
            }
        }
    }

    walk(start, 0, "");
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
