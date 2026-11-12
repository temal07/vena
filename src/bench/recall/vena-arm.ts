#!/usr/bin/env bun
/**
 * Benchmark #5, arm B: vena's own answer, no agent involved — every
 * destination a forward trace reaches from each seed.
 *
 * A destination is anything the value lands in: a variable, a parameter, a
 * field, or a function's return (the value leaves through `f`). Test files are
 * out of scope for every arm. Each destination says whether vena reached it
 * through proven edges only, so the report can score `--strict` as well.
 *
 * Bounded to MAX_HOPS, the same bound every arm is given: one hop is an
 * assignment, an argument reaching a parameter, a `return`, or a call's result
 * reaching the variable it lands in — exactly one step of a vena trace.
 * Unbounded, a numeric constant reaches 40 hops of layout arithmetic, which
 * nobody means by "where does this value end up".
 *
 * Usage: bun vena-arm.ts <repo-dir> <seeds.json> <out.json> [max-hops]
 */
import { relative } from "path";
import { analyse } from "../../scripts/analyse";
import { indexGraph, resolveTarget, traverse } from "../../scripts/query";
import type { Graph, GraphNode } from "../../scripts/types";
import { isTestFile } from "./select-shared";

const [repo, seedsPath, out, hops = "3"] = Bun.argv.slice(2);
const MAX_HOPS = Number(hops);
if (!repo || !seedsPath || !out) { console.error("usage: bun vena-arm.ts <repo-dir> <seeds.json> <out.json>"); process.exit(1); }

const { seeds } = await Bun.file(seedsPath).json();
const t0 = performance.now();
const { graph } = await analyse(repo) as { graph: Graph };
const buildMs = Math.round(performance.now() - t0);
const index = indexGraph(graph);

export type Destination = { file: string; line: number; name: string; kind: string };
const kindOf = (n: GraphNode) => (n.kind === "function" ? "return" : n.kind === "catch" ? "variable" : n.kind);

const answers: Record<string, { destinations: (Destination & { proven: boolean })[]; truncated: boolean; ms: number }> = {};
for (const seed of seeds) {
    const t = performance.now();
    const start = resolveTarget(graph, `${seed.file}:${seed.line}`).find((n) => n.name === seed.name);
    if (!start) { console.error(`${seed.id}: ${seed.name} not found in the graph`); continue; }
    const run = (strict: boolean) =>
        traverse(graph, index, start, { direction: "forward", strict, maxDepth: MAX_HOPS, maxNodes: 100_000 });
    const all = run(false), proven = run(true);
    const provenIds = new Set(proven.steps.map((s) => s.node.id));
    const seen = new Set<string>([start.id]);
    const destinations: (Destination & { proven: boolean })[] = [];
    for (const { node } of all.steps) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const file = relative(repo, node.file);
        if (isTestFile(file)) continue;
        destinations.push({ file, line: node.line, name: node.name, kind: kindOf(node), proven: provenIds.has(node.id) });
    }
    answers[seed.id] = { destinations, truncated: all.truncated, ms: Math.round(performance.now() - t) };
    console.log(`${seed.id} ${seed.name}: ${destinations.length} destinations (${destinations.filter((d) => d.proven).length} proven)${answers[seed.id]!.truncated ? " — TRUNCATED" : ""}`);
}
await Bun.write(out, JSON.stringify({ maxHops: MAX_HOPS, buildMs, answers }, null, 2));
console.log(`graph built in ${(buildMs / 1000).toFixed(1)}s; wrote ${out}`);
