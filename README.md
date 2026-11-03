# vena

Formerly named 'flowdata', it traces how data flows through a TypeScript/JavaScript codebase, and lets you trace any value forward or backward from the terminal.

Run it in a project and vena parses every file, resolves scope, links uses to declarations across files (following re-exports and tsconfig `paths` aliases), and follows values as they flow from one variable into another. Then ask where any value came from, or where it ends up.

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

### Build the graph

```bash
vena [output.json]
```

Run from the project directory. vena scans for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files, analyzes them, and writes the graph to `graph.json` (or the path you pass). It reports any files it couldn't parse, any in-project imports it couldn't link, and how many edges are proven versus inferred.

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
| [`src/tests/`](src/tests) | The `bun test` suite — engine and query tests, including end-to-end runs of `analyse` on temporary projects — plus a small fixture for the dev utilities. |
| [`src/mds/`](src/mds) | Project docs: [`NOTES.md`](src/mds/NOTES.md) (living dev notes — feature status, known limitations, deferred issues), [`ARCHITECTURE.md`](src/mds/ARCHITECTURE.md), and [`CLAUDE.md`](src/mds/CLAUDE.md). |

## Testing

```bash
bun test
```

## Status

Early and under active development.

**Works today:** multi-file extraction (including JSX), scope resolution with forward references, cross-file import linking through re-export chains and tsconfig `paths` aliases, data-flow edges within and across functions (argument → parameter → return → call site), name-based method-call resolution, and forward/backward tracing with `vena-trace`.

**Coming:** calls to functions declared later in the same file, flow through object fields (`this.x = y`), and an MCP server for agents. See [`NOTES.md`](src/mds/NOTES.md) for every known gap.

## Internals

See [ARCHITECTURE.md](./src/mds/ARCHITECTURE.md) for the project-level architecture — what has been shipped, what is currently being worked on, and future plans — and [`src/scripts/README.md`](src/scripts/README.md) for a code-level deep dive into the engine itself.

## License

MIT
