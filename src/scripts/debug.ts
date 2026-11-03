/**
 * debug.ts — no-CLI runner for the analysis pipeline, for local iteration.
 *
 * Runs the same `analyse()` (analyse.ts) that the `vena` CLI runs and dumps
 * the result as JSON, with everything CLI/server-shaped left out — no argv
 * parsing, no `process.exit`, no file written.
 * Exists so a new engine.ts feature can be exercised against `../tests` (or
 * any directory — change `dirToAnalyse`) with a plain `bun run`, without
 * going through the CLI.
 *
 * This file used to carry its own hand-copied duplicate of steps 1-3 of the
 * pipeline, written before analyse.ts was extracted out of flow.ts. It
 * delegates now, so an engine.ts change can't show up here and in `flow`
 * differently — which was the whole reason to reach for this script.
 *
 * Kept deliberately out of the `flow` CLI's path (see `bin` in
 * package.json) so changes here can't affect the shipped command.
 */

import { analyse } from "./analyse";
import { resolve } from "path";

// The directory debug.ts is gonna work in. Anchored to this file rather than
// written relative ("../tests"), because a bare relative path resolves against
// the process cwd — so it only worked when run from inside src/scripts, and
// died with ENOENT from the repo root, which is how the README invokes it.
// Same `import.meta.dir` approach as tree.ts.
const dirToAnalyse: string = resolve(import.meta.dir, "../tests");
// const dirToAnalyse: string = resolve(import.meta.dir, "../../../resurface/src/utils");

const { graph, filesAnalysed } = await analyse(dirToAnalyse);

// Indented on purpose, unlike the graph.json flow.ts writes: this dump exists
// to be read by eye in a terminal, and it's one fixture directory, not a whole
// project's worth of nodes.
console.log(JSON.stringify({ filesAnalysed, ...graph }, null, 2));
