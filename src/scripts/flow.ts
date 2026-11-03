#!/usr/bin/env bun
/**
 * flow.ts — the `vena` CLI.
 *
 * Usage: `vena [output.json]`
 *
 * This file is the "productionized" counterpart to debug.ts: same pipeline,
 * but as a real CLI (argv parsing, process.exit, reporting what it could not
 * analyse) instead of a programmatic entry point.
 */
import { resolve } from "path";
import { analyse } from "./analyse";

const USAGE =
    "vena — map how data flows through a TypeScript/JavaScript project.\n" +
    "\n" +
    "Analyses every source file in the current directory, links uses to declarations\n" +
    "across files, and writes the graph to disk.\n" +
    "\n" +
    "Usage: vena [output.json]\n" +
    "  scans .ts .tsx .js .jsx .mjs .cjs in the working directory\n" +
    "  [output.json]  where to write the graph (default: ./graph.json)\n" +
    "\n" +
    "Then trace individual values with `vena-trace <target> [graph.json] --back`.";

const outArg = Bun.argv[2];

// `--help` used to fall through to `resolve()` and die on an ENOENT stack
// trace, which is the first thing a new user types.
if (outArg === "--help" || outArg === "-h") {
    console.log(USAGE);
    process.exit(0);
}

const projectDir = process.cwd();

const { graph, filesAnalysed, skipped, unlinkedImports } = await analyse(projectDir);
// Left compact deliberately — indenting this graph costs ~45% more bytes
// (16.2MB vs 11.2MB on this repo), and nothing reads it by eye. Use `jq . graph.json` when you do need to.
const graphJson = JSON.stringify(graph);

// Write the graph to a JSON file.
const outPath = resolve(process.cwd(), outArg ?? "graph.json");
await Bun.write(outPath, graphJson);
console.log(`vena: analysed ${filesAnalysed} files.`);
// Every skipped file is a hole in the graph. Saying so here is the whole point
// of collecting them — a graph that is quietly missing a file looks exactly
// like a graph where that file had nothing to contribute. First few only, since
// a broken directory can produce hundreds and the pattern shows in the first
// three.
if (skipped.length > 0) {
    console.log(`vena: skipped ${skipped.length} file(s) that failed to parse:`);
    for (const { file, reason } of skipped.slice(0, 3)) {
        console.log(`  ${file.replace(projectDir + "/", "")} — ${reason}`);
    }
    if (skipped.length > 3) console.log(`  ...and ${skipped.length - 3} more`);
}

// The same argument as the skipped block above, one level down: a missing
// cross-file edge is indistinguishable from two things that genuinely never
// touched. Counted per specifier, and only local imports — `from "zod"` is
// outside the project and skipping it is correct, so it is not in this number.
if (unlinkedImports > 0) {
    console.log(`vena: ${unlinkedImports} import specifier(s) point inside the project ` +
        `but could not be linked — those edges are missing from the graph.`);
}

// Gap 18: the inferred share is the one number here that bounds how wrong the
// graph can be. Every other edge is proven; these passed through a call whose
// callee never resolved, so they are assumed. Said out loud rather than left in
// the JSON, because a graph that silently mixes the two is a graph you can't
// cite. `vena-trace --strict` traverses without them.
const inferredEdges = graph.edges.filter((e) => e.inferred).length;
if (inferredEdges > 0) {
    const share = ((inferredEdges / graph.edges.length) * 100).toFixed(1);
    console.log(`vena: ${graph.edges.length} edges — ${graph.edges.length - inferredEdges} proven, ` +
        `${inferredEdges} inferred (${share}%) through unresolved calls.`);
}

console.log(`vena: wrote graph to ${outPath}`);

