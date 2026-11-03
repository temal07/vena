# vena

Formerly named 'flowdata', it traces how data flows through a TypeScript/JavaScript codebase, rendered as an interactive graph.

Point it at a project and vena parses every file, resolves scope, links uses to declarations across files, and follows values as they flow from one variable into another. Click any symbol to see where it's declared, where it's used, and what it feeds into.

Pain point it solves: As the codebase for my project, Resurface, grew, it eventually became harder for me to create a mental map in my head of all the input/output data. So, I started this project and am actively working on it. 

<!-- ![vena graph](./docs/demo.png) -->

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/temal07/vena
cd vena
bun install
```

## Usage

### Build the graph and open the viewer

```bash
vena
```

From the project directory, vena scans for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files, analyzes them, writes `graph.json`, and opens a local graph viewer. Search for a symbol to reveal it and its connections; click a node for its declaration site and every use.

### Trace a value from the terminal

```bash
vena-trace <target> [graph.json] [--back] [--strict] [--depth N] [--max N]
```

`<target>` is `file:line` (`compose.ts:38`) or `file:name` (`compose.ts:res`). A bare name works too, but names collide — if several match, vena lists them with addresses you can paste straight back.

```bash
# where does this value end up?
vena-trace utils/filepath.ts:14 graph.json

# where did it come from?
vena-trace compose.ts:38 graph.json --back
```

```
res [variable] (compose.ts:38)
  <- via `res = await onError(err, context)` err [catch] (compose.ts:52) ~inferred
  <- via `res = await handler(context, () => dispatch(i + 1))` handler [variable] (compose.ts:40)
  <- via `res = await onNotFound(context)` context [param] (compose.ts:20) ~inferred
  <- via `res = await onError(err, context)` onError [param] (compose.ts:17)
  <- via `res = await onNotFound(context)` onNotFound [param] (compose.ts:18)
```

Hops marked `~inferred` are assumed rather than proven — the value passed through a call vena could not resolve, so it treats that call as transparent. `--strict` drops them and traces only proven edges. `--depth` and `--max` bound the output, and say so when they fire.

## Where things live

| Path | What's there |
| --- | --- |
| [`src/scripts/`](src/scripts/README.md) | The analysis engine itself — AST walker, CLI, dev utilities. **Start with [`src/scripts/README.md`](src/scripts/README.md)** for a guided tour. |
| [`src/viewer/`](src/viewer) | The static, dependency-free graph viewer (Cytoscape.js) that `flow.ts` serves the graph JSON to. |
| [`src/tests/`](src/tests) | Small fixture files used by the engine's dev utilities (`tree.ts`, `debug.ts`). |
| [`src/mds/`](src/mds) | Project docs: [`NOTES.md`](src/mds/NOTES.md) (living dev notes — feature status, known limitations, deferred issues), [`ARCHITECTURE.md`](src/mds/ARCHITECTURE.md), and [`CLAUDE.md`](src/mds/CLAUDE.md). |

## Testing

```bash
bun test
```

## Status

Early and under active development.

**Works today:** multi-file extraction, scope resolution, cross-file import linking, intraprocedural data-flow edges, and argument → parameter flow across function calls.

**Coming:** return-value flow back to call sites (full interprocedural), method-call resolution (`obj.method()`), use-before-declaration support, and an MCP server for agents.

## Internals

See [ARCHITECTURE.md](./src/mds/ARCHITECTURE.md) for the project-level architecture — what has been shipped, what is currently being worked on, and future plans — and [`src/scripts/README.md`](src/scripts/README.md) for a code-level deep dive into the engine itself.

## License

MIT
