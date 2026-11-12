#!/usr/bin/env bun
/**
 * Benchmark #5: write the task prompt for each seed, for the agent arms.
 *
 *   A — agent alone: Read, Grep, Bash.
 *   C — the same prompt, plus one paragraph on `vena-trace`, run from a
 *       standalone copy (query.ts + types.ts + the graph) outside the vena
 *       repo, as #3 did, so it can't reach this benchmark's answer key.
 *
 * Arm B is vena by itself (vena-arm.ts) and needs no prompt.
 *
 * Usage: bun prompts.ts <repo-dir> <seeds.json> <out-dir> [vena-trace-dir]
 */
import { mkdir } from "fs/promises";

const [repo, seedsPath, outDir, traceDir] = Bun.argv.slice(2);
if (!repo || !seedsPath || !outDir) { console.error("usage: bun prompts.ts <repo-dir> <seeds.json> <out-dir> [vena-trace-dir]"); process.exit(1); }
const { seeds } = await Bun.file(seedsPath).json();
await mkdir(outDir, { recursive: true });

const RULES = `## What counts

A **destination** is a variable, a parameter, a class or object field, or a function's return that the value lands in. Follow the value for **up to 3 hops**. One hop is any one of:

1. **Assignment or initialisation**, also when the value is only part of the expression: \`const y = x\`, \`y = x\`, \`const y = x * 2\`, \`const y = { a: x }\`, \`const y = c ? x : z\` — each makes \`y\` a destination.
2. **Argument to parameter:** \`f(x)\` makes \`f\`'s parameter a destination. A JSX prop \`<C p={x} />\` reaching \`C\`'s props counts the same way.
3. **Return:** \`return x\` inside \`f\` makes "the return of \`f\`" a destination.
4. **Call result:** \`const y = f(...)\`, where \`f\` returns the value, makes \`y\` a destination.
5. **Field write:** \`this.p = x\` or \`o.p = x\` makes the field \`p\` a destination.

Hop 1 is where the value goes first; keep following from each destination until 3 hops. List every destination within that bound, including the ones in between.

**Out of scope:** test files — \`*.test.ts(x)\`, \`*.spec.ts(x)\`, anything under \`tests/\`, \`__tests__/\` or \`fixtures/\`, and \`setupTests.ts\`.

**Missing a real destination and listing a false one both count against you.** Search properly: find every use of the name, follow imports and re-exports, and read the functions the value passes into. Work only inside the repo directory; don't read files outside it.

## Answer format

Cite each destination by the file (relative to the repo root), the line where it is **declared**, its name, and its kind:

- variable / param: the line of its declaration
- field: the line of the class field, or of its first write if it has no declaration
- return: the line where the function is declared, with the function's name

End your reply with exactly this block, one destination per line, nothing after it:

\`\`\`
FINAL ANSWER
<file>:<line> <name> <variable|param|field|return>
\`\`\``;

const VENA = (traceDir: string) => `## A tool you can use

\`vena-trace\` follows data flow through this codebase from a prebuilt graph. Its hops are the same as the ones defined above. Running this command is the one exception to working only inside the repo.

\`\`\`
bun ${traceDir}/query.ts <file>:<name> ${traceDir}/graph.json --depth 3 --max 500
\`\`\`

\`<file>:<name>\` can also be \`<file>:<line>\`; when several declarations match, it lists them with addresses to paste back. Each output line is one hop and names the destination's file and line. A hop marked \`~inferred\` is assumed, not proven — it passed through a call vena couldn't resolve — so check it before listing it. The graph does not follow every kind of flow (for example, fields on objects other than \`this\`), so treat its output as a starting point, not the full answer.`;

for (const seed of seeds) {
    const subject = seed.kind === "V"
        ? `the value of \`${seed.name}\`, declared at \`${seed.file}:${seed.line}\``
        : `the values **returned by** the function \`${seed.name}\`, declared at \`${seed.file}:${seed.line}\`. Start from every call of \`${seed.name}\` whose result is used — \`const y = ${seed.name}(…)\` makes \`y\` hop 1, \`g(${seed.name}(…))\` makes \`g\`'s parameter hop 1, \`return ${seed.name}(…)\` makes the enclosing function's return hop 1`;
    const head = `You are working in a TypeScript codebase at \`${repo}\`.\n\n**Task:** find every destination of ${subject}.\n\n${RULES}`;
    await Bun.write(`${outDir}/${seed.id}-A.md`, head + "\n");
    if (traceDir) await Bun.write(`${outDir}/${seed.id}-C.md`, `${head}\n\n${VENA(traceDir)}\n`);
}
console.log(`wrote ${seeds.length} prompts per arm to ${outDir}`);
