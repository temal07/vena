# `src/scripts/` — the vena analysis engine

This folder is the whole of vena's static-analysis core: parse
TypeScript/JavaScript source into an AST, walk it once to find every
declaration and every reference to it, link references across files, and
trace which declarations feed data into which other declarations. The
result is a small dependency graph you can browse in [`src/viewer/`](../viewer).

If you're new to this codebase, read the files in this order:

| Order | File | What it is |
| --- | --- | --- |
| 1 | [`types.ts`](./types.ts) | The data model (`Binding`, `Use`, `Scope`, `Results`). Read this first — everything else is built on it. |
| 2 | [`engine.ts`](./engine.ts) | The AST walker. One file in, one `Results` out. This is where the actual analysis happens. |
| 3 | [`analyse.ts`](./analyse.ts) | The project-wide pipeline: walk every file, link imports across files, flatten to nodes, turn `feeds` into edges. A directory path in, a `Graph` out — no I/O beyond reading source. |
| 4 | [`flow.ts`](./flow.ts) | The `flow` CLI — parses argv, calls `analyse()`, writes `graph.json`, serves the viewer and opens it. |
| — | [`tree.ts`](./tree.ts) | Dev utility: dumps the raw parser AST for a fixture file. Useful when adding a new node-type case to `engine.ts`. |
| — | [`trace.ts`](./trace.ts) | Dev utility: prints what `engine.ts` *did* while walking a snippet — every name declared, every name resolved, every scope opened and closed. Reach for it when the engine's behaviour stops matching your mental model. |
| — | [`debug.ts`](./debug.ts) | Dev utility: runs `analyse()` against `src/tests` and dumps the graph as JSON, no CLI/server/viewer. For quick inspection while iterating on `engine.ts`. |

## Mental model

```
                 ┌────────────────────────┐
 file.ts  ──────►│ typescript-estree parse │──────► AST (TSESTree.Node)
                 └────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────┐
                 │  engine.collectVariables │  (one call per file)
                 └────────────────────────┘
                              │
                              ▼
                     Results { declarations: Binding[] }
                              │
            (analyse.ts, across every file in the project)
                              │
        ┌─────────────────────┼─────────────────────────┐
        ▼                     ▼                          ▼
  resolve imports      flatten to graph.nodes     turn Use.feeds into
  onto real decls      (skip imports/uses)         graph.edges
        │                     │                          │
        └─────────────────────┴─────────────────────────┘
                              │
                              ▼
                  { root, nodes, edges }  ──served as /graph.json──►  viewer
```

### The data model, in one paragraph

A **`Binding`** is a declaration site — a function, variable, param, class,
type, import, or catch param — identified uniquely by `{file, start}`
(`start` being its byte offset). Every `Binding` carries a `uses: Use[]`
array: every place in the code that *references* that declaration. A
**`Use`** may additionally carry a `feeds` pointer, naming the `{file,
start}` of another declaration that the value flows into — e.g. in
`const a = foo()`, the use of `foo` feeds `a`.

### The two things `engine.ts` is doing at once

1. **Scope-correct name resolution.** A stack of `Scope`s (global →
   function → block, pushed/popped as the walk enters/exits them) means
   `Identifier` references resolve to the right declaration even when
   names shadow each other across nested scopes.
2. **Data-flow tracking ("feeds").** A module-level `currentFeedTarget`
   marks "whatever gets used next flows into *this* declaration." It's set
   before walking a variable's initializer, and before walking each call
   argument (pointed at the matching declared parameter — see
   `Binding.params`), then restored afterwards. This save/restore
   discipline is what keeps nested initializers (`const a = () => { const
   b = x }`) from misattributing `x`'s flow to `a` instead of `b`.

See the doc comment at the top of [`engine.ts`](./engine.ts) for the full
per-node-type walkthrough, and [`NOTES.md`](../mds/NOTES.md) for
current status and known limitations (intraprocedural-only flow,
destructuring-target heuristics, JS-only cross-file linking gap, etc).

## Running things

```bash
# Analyze the current directory and open the graph viewer in your browser
bun run src/scripts/flow.ts

# or, once linked as a bin (see package.json's "bin" field):
vena

# Dump the raw AST for src/tests/example.ts (for engine.ts development)
bun run src/scripts/tree.ts

# Watch the engine walk a snippet, step by step
bun run src/scripts/trace.ts 'const a = b; const b = 2;'

# Run the parse+link pipeline against src/tests without the CLI/viewer
bun run src/scripts/debug.ts
```

## Extending the engine

Adding support for a new syntax form generally means adding one more
`if (node.type === "...")` branch to `walkVariables` in `engine.ts`. Two
things to get right:

- **Declare vs. resolve.** If the branch introduces a new binding, push it
  onto `stack[stack.length - 1]!.declarations` (or, for the few node types
  that bypass the scope stack today — `CatchClause`, `ClassDeclaration`,
  `MethodDefinition`, the `TS*Declaration`s — straight onto
  `results.declarations`; see the note in `engine.ts` about that
  asymmetry).
- **Early return vs. fall-through.** If your branch manually recurses into
  some of the node's children (like `VariableDeclarator` and
  `CallExpression` do, to manage `currentFeedTarget` around specific
  children), `return` at the end so the generic fallback doesn't walk them
  a second time. If it only needs to register something and the node's
  children should still be visited normally, don't return — let control
  fall through to the generic `Object.values(node)` recursion at the
  bottom.

Use `tree.ts` to inspect the exact AST shape TSESTree produces for the
construct you're adding before writing the branch.
