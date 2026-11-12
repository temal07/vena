import { test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import { analyse } from '../scripts/analyse';
import {
    parseArgs,
    resolveTarget,
    indexGraph,
    traverse,
    where,
    formatTrace,
    DEFAULT_DEPTH,
    DEFAULT_MAX,
    type Graph,
    type GraphNode,
} from '../scripts/query';

/* -------------------------------------------------------------- fixtures */

/**
 * A hand-built graph, not one produced by `analyse`. The traversal is a pure
 * consumer of the serialized shape, so testing it against a literal keeps these
 * tests about traversal rather than about whatever the engine happens to emit.
 *
 *   /p/a.ts:  x@1 -> y@2 -> shared@3
 *   /p/b.ts:  shared@3 (same name, different file — the collision case)
 *
 * The function node lives in a separate graph below, so that a direct-flow test
 * asserting on an exact node sequence is not silently also testing the
 * interprocedural hop.
 */
const NODES: GraphNode[] = [
    { id: "/p/a.ts:0", name: "x", kind: "variable", file: "/p/a.ts", line: 1, start: 0 } as GraphNode,
    { id: "/p/a.ts:10", name: "y", kind: "variable", file: "/p/a.ts", line: 2, start: 10 } as GraphNode,
    { id: "/p/a.ts:20", name: "shared", kind: "variable", file: "/p/a.ts", line: 3, start: 20 } as GraphNode,
    { id: "/p/b.ts:0", name: "shared", kind: "variable", file: "/p/b.ts", line: 3, start: 0 } as GraphNode,
];

const occ = (code: string) => [{ file: "/p/a.ts", line: 1, code }];

const GRAPH: Graph = {
    root: "/p",
    nodes: NODES,
    edges: [
        { source: "/p/a.ts:0", target: "/p/a.ts:10", occurrences: occ("const y = x") },
        { source: "/p/a.ts:10", target: "/p/a.ts:20", occurrences: occ("const shared = y") },
    ],
};

/** `GRAPH` with the `y -> shared` hop marked inferred (gap 18). */
const GRAPH_INF: Graph = {
    ...GRAPH,
    edges: [
        { source: "/p/a.ts:0", target: "/p/a.ts:10", occurrences: occ("const y = x") },
        { source: "/p/a.ts:10", target: "/p/a.ts:20", occurrences: occ("shared = y.slice(1)"), inferred: true },
    ],
};

/** `GRAPH` plus `f@10`, a function returning `y@2`. */
const GRAPH_FN: Graph = {
    ...GRAPH,
    nodes: [
        ...NODES,
        {
            id: "/p/a.ts:99", name: "f", kind: "function", file: "/p/a.ts", line: 10, start: 99,
            returns: [{ name: "y", file: "/p/a.ts", start: 10 }],
        } as GraphNode,
    ],
};

const names = (graph: Graph, steps: { node: GraphNode }[]) => steps.map((s) => s.node.name);

/* ------------------------------------------------------------- parseArgs */

test("parseArgs: bare target takes the default graph path and direction", () => {
    const args = parseArgs(["res"]);
    expect(args.positionals).toEqual(["res"]);
    expect(args.direction).toBe("forward");
    expect(args.maxDepth).toBe(DEFAULT_DEPTH);
    expect(args.maxNodes).toBe(DEFAULT_MAX);
});

test("parseArgs: a flag does not get eaten as the graph path", () => {
    // The bug this replaced: `--back` landed in argv[3] and became the filename.
    const args = parseArgs(["res", "--back"]);
    expect(args.positionals).toEqual(["res"]);
    expect(args.direction).toBe("backward");
});

test("parseArgs: flags may precede positionals and order is preserved", () => {
    const args = parseArgs(["--back", "--depth", "3", "res", "g.json"]);
    expect(args.positionals).toEqual(["res", "g.json"]);
    expect(args.direction).toBe("backward");
    expect(args.maxDepth).toBe(3);
});

test("parseArgs: every flag after the first is honoured", () => {
    // The old parse read argv[4] only, so trailing flags vanished silently.
    const args = parseArgs(["res", "g.json", "--back", "--depth", "3", "--max", "7"]);
    expect(args.direction).toBe("backward");
    expect(args.maxDepth).toBe(3);
    expect(args.maxNodes).toBe(7);
});

test("parseArgs: short forms match the long ones", () => {
    const args = parseArgs(["res", "-b", "-d", "2", "-m", "5"]);
    expect(args.direction).toBe("backward");
    expect(args.maxDepth).toBe(2);
    expect(args.maxNodes).toBe(5);
});

test("parseArgs: --strict is its own flag and does not imply --back", () => {
    // Both are boolean flags; sharing one branch would make either set both.
    const args = parseArgs(["res", "--strict"]);
    expect(args.strict).toBe(true);
    expect(args.direction).toBe("forward");
});

test("parseArgs: --back does not imply --strict", () => {
    const args = parseArgs(["res", "--back"]);
    expect(args.direction).toBe("backward");
    expect(args.strict).toBe(false);
});

test("parseArgs: --strict and --back compose", () => {
    const args = parseArgs(["res", "-s", "-b"]);
    expect(args.strict).toBe(true);
    expect(args.direction).toBe("backward");
});

test("parseArgs: a value flag with no value is an error, not a silent NaN", () => {
    expect(() => parseArgs(["res", "--depth"])).toThrow("--depth needs a number");
});

test("parseArgs: a value flag does not swallow the next flag", () => {
    expect(() => parseArgs(["res", "--depth", "--back"])).toThrow("positive integer");
});

test("parseArgs: non-numeric and zero values are rejected", () => {
    expect(() => parseArgs(["res", "--depth", "abc"])).toThrow("positive integer");
    expect(() => parseArgs(["res", "--max", "0"])).toThrow("positive integer");
});

test("parseArgs: unknown flags are rejected rather than ignored", () => {
    expect(() => parseArgs(["res", "--bogus"])).toThrow("unknown option --bogus");
});

/* ---------------------------------------------------------- resolveTarget */

test("resolveTarget: a bare name matches every node with that name", () => {
    expect(resolveTarget(GRAPH, "shared")).toHaveLength(2);
});

test("resolveTarget: file:line picks exactly one of two same-named nodes", () => {
    const found = resolveTarget(GRAPH, "b.ts:3");
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe("/p/b.ts");
});

test("resolveTarget: file:name picks exactly one of two same-named nodes", () => {
    const found = resolveTarget(GRAPH, "a.ts:shared");
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe("/p/a.ts");
});

test("resolveTarget: a partial filename does not match on a non-segment boundary", () => {
    // `.ts` and `ts` are suffixes of both files but not whole trailing segments.
    expect(resolveTarget(GRAPH, ".ts:3")).toHaveLength(0);
    expect(resolveTarget(GRAPH, "ts:shared")).toHaveLength(0);
});

test("resolveTarget: an absolute path works as well as a relative one", () => {
    expect(resolveTarget(GRAPH, "/p/b.ts:3")).toHaveLength(1);
});

test("resolveTarget: no match returns empty rather than throwing", () => {
    expect(resolveTarget(GRAPH, "nope")).toHaveLength(0);
    expect(resolveTarget(GRAPH, "a.ts:999")).toHaveLength(0);
});

test("where: prints the address resolveTarget accepts, so output round-trips", () => {
    const node = resolveTarget(GRAPH, "b.ts:3")[0]!;
    const printed = where(GRAPH, node);
    expect(printed).toBe("b.ts:3");
    expect(resolveTarget(GRAPH, printed)).toEqual([node]);
});

/* -------------------------------------------------------------- traversal */

test("traverse: forward follows outgoing edges downstream", () => {
    const start = resolveTarget(GRAPH, "a.ts:x")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start);
    expect(names(GRAPH, result.steps)).toEqual(["x", "y", "shared"]);
});

test("traverse: backward follows the same edges upstream", () => {
    const start = resolveTarget(GRAPH, "a.ts:shared")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start, { direction: "backward" });
    expect(names(GRAPH, result.steps)).toEqual(["shared", "y", "x"]);
});

test("traverse: backward from an isolated node returns only itself", () => {
    const start = resolveTarget(GRAPH, "b.ts:shared")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start, { direction: "backward" });
    expect(names(GRAPH, result.steps)).toEqual(["shared"]);
});

test("traverse: forward hops to functions that return the node", () => {
    const start = resolveTarget(GRAPH_FN, "a.ts:y")[0]!;
    const result = traverse(GRAPH_FN, indexGraph(GRAPH_FN), start);
    expect(names(GRAPH_FN, result.steps)).toContain("f");
});

test("traverse: backward from a function steps into what it returns", () => {
    // The mirror of the hop above, and it reads `returns` off the node rather
    // than needing the inverted map forward uses.
    const start = resolveTarget(GRAPH_FN, "a.ts:f")[0]!;
    const result = traverse(GRAPH_FN, indexGraph(GRAPH_FN), start, { direction: "backward" });
    expect(names(GRAPH_FN, result.steps)).toEqual(["f", "y", "x"]);
});

test("traverse: maxDepth bounds the walk and says so", () => {
    const start = resolveTarget(GRAPH, "a.ts:x")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start, { maxDepth: 1 });
    expect(names(GRAPH, result.steps)).toEqual(["x", "y"]);
    expect(result.depthLimited).toBe(true);
});

test("traverse: maxNodes caps lines emitted and sets truncated", () => {
    const start = resolveTarget(GRAPH, "a.ts:x")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start, { maxNodes: 2 });
    expect(result.steps).toHaveLength(2);
    expect(result.truncated).toBe(true);
});

test("traverse: an unbounded walk reports neither limit", () => {
    const start = resolveTarget(GRAPH, "a.ts:x")[0]!;
    const result = traverse(GRAPH, indexGraph(GRAPH), start);
    expect(result.truncated).toBe(false);
    expect(result.depthLimited).toBe(false);
});

test("traverse: inferred edges are followed by default and flagged on the step", () => {
    const start = resolveTarget(GRAPH_INF, "a.ts:x")[0]!;
    const result = traverse(GRAPH_INF, indexGraph(GRAPH_INF), start);
    expect(names(GRAPH_INF, result.steps)).toEqual(["x", "y", "shared"]);
    // The flag describes the hop taken, so it lands on the step it produced.
    expect(result.steps.map((s) => s.inferred === true)).toEqual([false, false, true]);
});

test("traverse: --strict stops at an inferred edge", () => {
    const start = resolveTarget(GRAPH_INF, "a.ts:x")[0]!;
    const result = traverse(GRAPH_INF, indexGraph(GRAPH_INF), start, { strict: true });
    expect(names(GRAPH_INF, result.steps)).toEqual(["x", "y"]);
});

test("traverse: --strict applies backward too", () => {
    const start = resolveTarget(GRAPH_INF, "a.ts:shared")[0]!;
    expect(names(GRAPH_INF, traverse(GRAPH_INF, indexGraph(GRAPH_INF), start, {
        direction: "backward",
    }).steps)).toEqual(["shared", "y", "x"]);
    expect(names(GRAPH_INF, traverse(GRAPH_INF, indexGraph(GRAPH_INF), start, {
        direction: "backward", strict: true,
    }).steps)).toEqual(["shared"]);
});

test("formatTrace: marks inferred hops and leaves proven ones unmarked", () => {
    const start = resolveTarget(GRAPH_INF, "a.ts:x")[0]!;
    const lines = formatTrace(GRAPH_INF, traverse(GRAPH_INF, indexGraph(GRAPH_INF), start));
    expect(lines[1]).not.toContain("~inferred");
    expect(lines[2]).toContain("~inferred");
});

test("traverse: a cycle terminates and is marked as revisited", () => {
    const cyclic: Graph = {
        ...GRAPH,
        edges: [
            { source: "/p/a.ts:0", target: "/p/a.ts:10", occurrences: occ("const y = x") },
            { source: "/p/a.ts:10", target: "/p/a.ts:0", occurrences: occ("x = y") },
        ],
    };
    const start = resolveTarget(cyclic, "a.ts:x")[0]!;
    const result = traverse(cyclic, indexGraph(cyclic), start);
    expect(names(cyclic, result.steps)).toEqual(["x", "y", "x"]);
    expect(result.steps.at(-1)!.revisited).toBe(true);
});

/* ------------------------------------------------------------- end to end */

async function fixtureDir(files: Record<string, string>): Promise<string> {
    const dir = `${tmpdir()}/vena-query-${crypto.randomUUID()}`;
    for (const [name, body] of Object.entries(files)) {
        await Bun.write(`${dir}/${name}`, body);
    }
    return dir;
}

test("end to end: backward trace finds every source that feeds one variable", async () => {
    // The shape that motivated this change — compose.ts's `res`, assigned from
    // three different calls. Forward from `res` finds nothing; the answer is
    // entirely upstream.
    const dir = await fixtureDir({
        "m.ts": `
            export function pick(a, b, c) {
                let res;
                res = a;
                res = b;
                res = c;
                return res;
            }
        `,
    });
    const { graph } = await analyse(dir);
    const start = resolveTarget(graph as Graph, "m.ts:res");

    expect(start).toHaveLength(1);
    const result = traverse(graph as Graph, indexGraph(graph as Graph), start[0]!, { direction: "backward" });
    expect(names(graph as Graph, result.steps).sort()).toEqual(["a", "b", "c", "res"]);

    await rm(dir, { recursive: true, force: true });
});

test("end to end: an address printed by where() resolves on a real graph", async () => {
    const dir = await fixtureDir({ "one.ts": `const a = 1; const b = a;` });
    const { graph } = await analyse(dir);

    const [node] = resolveTarget(graph as Graph, "one.ts:b");
    expect(node).toBeDefined();
    expect(resolveTarget(graph as Graph, where(graph as Graph, node!))).toContain(node!);

    await rm(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------- call matching */

// A value that enters a function through one call can only leave through that
// call. Without matching, `sha1(data)` traced into `createHash` and back out to
// `sha256`'s result, because both call it — Hono benchmark Q17, a negative
// control that broke once gap 19 gave `createHash` its incoming arguments.

/** Every node a trace reaches, as `name@line`, sorted and de-duplicated. */
async function reach(
    source: string,
    address: string,
    direction: "forward" | "backward",
    strict = false,
): Promise<string[]> {
    const dir = await fixtureDir({ "m.ts": source });
    const { graph } = await analyse(dir);
    await rm(dir, { recursive: true, force: true });
    const [start] = resolveTarget(graph as Graph, address);
    expect(start).toBeDefined();
    const result = traverse(graph as Graph, indexGraph(graph as Graph), start!, { direction, strict, maxDepth: 30, maxNodes: 1000 });
    return [...new Set(result.steps.map((s) => `${s.node.name}@${s.node.line}`))].sort();
}

const TWO_CALLERS = [
    "function id(v) { return v }",   // 1
    "const a = 1;",                   // 2
    "const b = 2;",                   // 3
    "const fromA = id(a);",           // 4
    "const fromB = id(b);",           // 5
].join("\n");

test("call matching: forward returns only to the call the value went in through", async () => {
    expect(await reach(TWO_CALLERS, "m.ts:a", "forward"))
        .toEqual(["a@2", "fromA@4", "id@1", "v@1"]);
});

test("call matching: backward takes only the arguments at the call it came from", async () => {
    expect(await reach(TWO_CALLERS, "m.ts:fromA", "backward"))
        .toEqual(["a@2", "fromA@4", "id@1", "v@1"]);
});

// Starting inside the function there is no call to return to, so every caller
// is a real way out — and every argument a real way in.
test("call matching: forward from inside the function reaches every caller", async () => {
    expect(await reach(TWO_CALLERS, "m.ts:v", "forward"))
        .toEqual(["fromA@4", "fromB@5", "id@1", "v@1"]);
});

test("call matching: backward from a parameter reaches every argument", async () => {
    expect(await reach(TWO_CALLERS, "m.ts:v", "backward"))
        .toEqual(["a@2", "b@3", "v@1"]);
});

// A write inside the body is not an argument. It must be followed without
// leaving the call — dropping it would lose `d`, and treating it as a call
// site would make it the only match and lose `a`.
test("call matching: a write to a parameter inside the body is still followed", async () => {
    const source = [
        "function f(v) {",                // 1
        "  const d = 0;",                 // 2
        "  if (!v) v = d;",               // 3
        "  return v;",                    // 4
        "}",                              // 5
        "const a = 1;",                   // 6
        "const b = 2;",                   // 7
        "const fromA = f(a);",            // 8
        "const fromB = f(b);",            // 9
    ].join("\n");
    expect(await reach(source, "m.ts:fromA", "backward"))
        .toEqual(["a@6", "d@2", "f@1", "fromA@8", "v@1"]);
});

// Two levels: the value has to come back out of `inner` into `outer`'s body,
// and out of `outer` to `x` — not to `y` (another call to outer) or `z`
// (another call to inner).
test("call matching: nested calls each return to their own call site", async () => {
    const source = [
        "function inner(q) { return q }",     // 1
        "function outer(p) { return inner(p) }", // 2
        "const a = 1;",                       // 3
        "const b = 2;",                       // 4
        "const c = 3;",                       // 5
        "const x = outer(a);",                // 6
        "const y = outer(b);",                // 7
        "const z = inner(c);",                // 8
    ].join("\n");
    const reached = await reach(source, "m.ts:a", "forward");
    expect(reached).toContain("x@6");
    expect(reached).not.toContain("y@7");
    expect(reached).not.toContain("z@8");
});

// Calls are matched by the call expression's offset, not by line, so one split
// across lines — the argument and the callee on different lines — still returns
// only to its own caller.
test("call matching: a call split across lines still returns only to its caller", async () => {
    const source = [
        "function id(v) { return v }",   // 1
        "const a = 1;",                   // 2
        "const b = 2;",                   // 3
        "const fromA = id(",              // 4
        "  a);",                          // 5
        "const fromB = id(b);",           // 6
    ].join("\n");
    const reached = await reach(source, "m.ts:a", "forward");
    expect(reached).toContain("fromA@4");
    expect(reached).not.toContain("fromB@6");
});

// The same edge can leave one call and enter another: in `outer(inner(a))`, the
// `inner -> p` edge is inner's result *and* outer's argument.
test("call matching: a result passed straight into another call keeps both calls", async () => {
    const source = [
        "function inner(q) { return q }",     // 1
        "function outer(p) { return p }",     // 2
        "const a = 1;",                       // 3
        "const b = 2;",                       // 4
        "const x = outer(inner(a));",         // 5
        "const y = outer(b);",                // 6
        "const z = inner(b);",                // 7
    ].join("\n");
    const reached = await reach(source, "m.ts:a", "forward");
    expect(reached).toContain("x@5");
    expect(reached).not.toContain("y@6");
    expect(reached).not.toContain("z@7");
});

// Two nested calls share the `inner -> p` edge, one occurrence per pair. Each
// inner result must stay paired with its own outer call: `a` reaches only `x`,
// and `x` comes back only from `a`.
const TWO_NESTED = [
    "function inner(q) { return q }",     // 1
    "function outer(p) { return p }",     // 2
    "const a = 1;",                       // 3
    "const b = 2;",                       // 4
    "const x = outer(inner(a));",         // 5
    "const y = outer(inner(b));",         // 6
].join("\n");

test("call matching: nested calls sharing an edge keep each inner result with its outer call", async () => {
    for (const strict of [false, true]) {
        const forward = await reach(TWO_NESTED, "m.ts:a", "forward", strict);
        expect(forward).toContain("x@5");
        expect(forward).not.toContain("y@6");
        const backward = await reach(TWO_NESTED, "m.ts:x", "backward", strict);
        expect(backward).toContain("a@3");
        expect(backward).not.toContain("b@4");
    }
});

// A function reached by aliasing rather than calling (`const g = id`) is not
// inside any call, so its returns lead back to every argument, as before.
test("call matching: backward through an alias of a function is not call-restricted", async () => {
    const source = TWO_CALLERS + "\nconst g = id;";   // line 6
    expect(await reach(source, "m.ts:g", "backward"))
        .toEqual(["a@2", "b@3", "g@6", "id@1", "v@1"]);
});

// A graph written before call offsets existed has neither field, so nothing is
// ever entered or left and the trace behaves exactly as it did then.
test("call matching: a graph without call offsets traces as it always did", () => {
    const steps = traverse(GRAPH_FN, indexGraph(GRAPH_FN), resolveTarget(GRAPH_FN, "a.ts:x")[0]!).steps;
    expect(names(GRAPH_FN, steps)).toContain("f");
});

// Recursion re-enters the same call every pass. Pushing it each time made every
// pass a new context, so the walk never terminated short of the depth limit.
test("call matching: recursion terminates without a depth limit", async () => {
    const source = [
        "function down(n) { return n ? down(n - 1) : n }",   // 1
        "const start = 5;",                                   // 2
        "const out = down(start);",                           // 3
        "const other = down(9);",                             // 4
    ].join("\n");
    const dir = await fixtureDir({ "m.ts": source });
    const { graph } = await analyse(dir);
    await rm(dir, { recursive: true, force: true });
    const [start] = resolveTarget(graph as Graph, "m.ts:start");
    const result = traverse(graph as Graph, indexGraph(graph as Graph), start!, { maxDepth: 100_000, maxNodes: 100_000 });
    const reached = result.steps.map((s) => `${s.node.name}@${s.node.line}`);
    expect(reached).toContain("out@3");
    expect(reached).not.toContain("other@4");
});

test("call matching: leaving a function started inside follows a caller's `return inner()`", async () => {
    const source = [
        "function inner(p) { const q = p; return q }",   // 1
        "function wrap() { return inner(1) }",           // 2
        "const out = wrap();",                           // 3
    ].join("\n");
    expect(await reach(source, "m.ts:q", "forward")).toEqual(["inner@1", "out@3", "q@1", "wrap@2"]);
});
