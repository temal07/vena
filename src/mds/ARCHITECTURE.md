# Architecture

How vena analyzes a codebase, from source files to a data-flow graph you can trace.

This is the project-level picture. [`NOTES.md`](NOTES.md) holds the detail: every gap with a snippet that reproduces it, how each fix was chosen, and the measurements behind the priorities. [`src/scripts/README.md`](../scripts/README.md) is the code-level tour.

## Project status

### Shipped and working

- **Multi-file extraction.** vena scans the working directory for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` files and records every declaration: variables, functions, parameters, classes, methods, catch parameters, imports and TypeScript types, including destructuring patterns. JSX is parsed in every extension except `.ts`. Minified bundles, `.d.ts` files and vendored directories are excluded.
- **Survives foreign code.** A file that fails to parse is skipped and reported, and the rest of the project is still analysed.
- **Scope resolution, including forward references.** A scope stack keeps same-named bindings distinct. A use or call reached before its declaration is retried after the walk, so hoisted functions and later `const`s still resolve and still receive their arguments.
- **Data-flow edges.** These come from initializers, reassignment, argument → parameter at call sites (including methods, matched by name), and return → call site. Together they give full interprocedural chains: `z → p → return → a`.
- **Inferred flow through unknown calls.** An argument to a callee vena can't resolve is assumed to flow into the result. These edges are labelled `inferred` and kept separate from proven ones.
- **Cross-file linking.** Linking follows relative imports (extensionless, directory, `.js` → `.ts`), tsconfig `paths` aliases, and re-export chains (`export *`, `export { x } from`, renames, defaults). Arguments to imported functions reach the parameter in the declaring file.
- **Visible failure.** Skipped files, unlinked imports (bucketed by cause), unresolved lookups and the proven/inferred edge split are all reported. A missing edge is never silent.
- **Query layer.** `vena-trace` traces any node forward ("where does it end up?") or backward ("where did it come from?"). A value that enters a function through one call returns only through that call. It accepts a `file:line` or `file:name` address, with depth and size bounds, and a `--strict` mode that follows proven edges only.
- **Tests.** 157 tests run with `bun test`, covering the walker on source strings and `analyse` end to end on temporary projects.

### Next

In order, per `NOTES.md` → *Next up*:

1. **Call-site resolution (gaps 1 + 8).** Method calls ignore their receiver, and a later inner declaration doesn't shadow. These are the only known source of wrong edges.
2. **MCP server.** It exposes bounded traversals to agents. It needs an on-disk index, because a large graph is too big to `JSON.parse` per query.

### Future goals

- **Object field flow (gap 20).** `this.x = y` carries no flow. This decides whether class-heavy codebases are in scope at all.
- **Multi-language support.** Other language extractors would emit the same `Results` shape, so linking, the graph and the query layer work unchanged.

## Pipeline

```
 working directory
       │  step 0: glob, filter (isProjectSource), read tsconfig paths
       ▼
 parse each file ──► walk it (engine.ts) ──► Results per file
       │  step 1                                   │
       ▼                                           ▼
 step 2: link imports across files      step 2b: patch deferred call feeds
       │
       ▼
 step 3: flatten declarations into nodes ──► step 4: turn feeds into edges
       │
       ▼
 graph.json ──► vena-trace (query.ts)
```

`analyse.ts` runs steps 0–4 and returns the graph plus everything it couldn't do. `flow.ts` (the `vena` CLI) writes the graph to disk and prints those reports. `query.ts` (`vena-trace`) reads the graph back and never re-runs the analysis.

## Node identity

Every declaration is identified by `file:start`, its absolute path plus its character offset. That pair is unique across the project, so it is both the graph's node id and the way a feed names its target. A **negative** start means "not resolved yet" (see *Imported callees* below). No real declaration can have a negative start.

## The walk (`engine.ts`)

`collectVariables` walks one file's AST once, recursively, and produces a `Results`. That holds the file's declarations, each with its uses attached, plus the file's export table, its re-exports, lookup counts, and the call sites it had to defer.

### Scopes and lookups

A stack of scopes is pushed and popped at functions, arrow functions and blocks. A loop gets no scope of its own: its variable lands in the enclosing scope, and its body block pushes one as usual. Each binding is pushed onto the current scope. A use resolves to the nearest matching declaration, searching the stack from the top down.

When a lookup fails, the use isn't dropped. It is filed as a pending use, along with a **shallow snapshot** of the scope chain at that moment, and retried once the walk ends. The snapshot freezes *which* scopes were visible, but the scope objects stay live, so by retry time they hold every declaration. A later `const` therefore resolves, and a name from a block that had already closed correctly doesn't.

A name that still doesn't resolve is checked against `KNOWN_GLOBALS` (`globals.ts`): `console`, `JSON`, `push`, `map` and similar. It is counted as `external` rather than as a failure. The set is a reporting aid only; nothing in the graph depends on it.

### Labels versus references

One rule appears in several places: **a non-computed name is a label, not a reference.** Object keys (`{ a: b }`), member properties (`o.p`), method keys and enum member names are not looked up. Their computed forms (`{ [k]: v }`, `o[k]`) are.

Method calls are the deliberate exception. In `r.score(z)` the property *is* resolved by name, because that is the only way method calls get edges at all.

Type space is skipped entirely. That covers annotations, type parameters, type references, `implements` clauses, and interface and type-alias bodies. A type never creates a use in value space. Enum initializers are walked, because they hold real values.

### Feed targets

A `feeds` entry on a use says "this value flows into that declaration". The walker tracks the declarations that currently receive values as `currentFeedTargets`, a list, because `const { a, b } = foo()` reads `foo` once and feeds both. A flag, `currentFeedsInferred`, travels beside the list and says whether those targets are proven or assumed.

The target list is saved, changed and restored around each construct that carries a value:

- **Declarators**: `const x = …` targets `x`. Each declarator targets only the names it introduced.
- **Assignments**: `x = …` and `x += …` target `x`. The left side is walked before the target is set, so a write never feeds itself. When the left side can't be named (`o.p = …`), the enclosing target passes through unchanged.
- **Call arguments**: each argument targets the matching parameter of the resolved callee. When the callee can't be resolved, the enclosing target passes through and the flag is set to inferred. A resolved inner call stays proven even inside an unresolved outer one.
- **Function bodies**: the target is cleared, so an edge means "flows into this declaration", never "is used somewhere inside it".

A use inside a `return` statement is recorded in the enclosing function's `returns` list. That is the half of interprocedural flow the call site can't see.

### Imported callees

When the callee is an import, its parameters live in another file that may not be parsed yet. The walker therefore stamps each argument with a **placeholder** feed whose start is negative, and records the call in `deferredCallFeeds`. The placeholder is a copy rather than a reference, because `use.feeds` holds flat copies taken when the feed is stamped. Analysis step 2b replaces each placeholder once the import has linked. A placeholder that never resolves keeps its negative start, matches no node, and is dropped in step 4. **The failure mode is a missing edge, never a wrong one.**

### Later callees

A plain call whose callee isn't in scope yet gets the same treatment: each argument is stamped with a negative-start placeholder, and the call is filed with a snapshot of the scope chain and the targets the argument would otherwise have fed. After the walk the callee is looked up again. A parameter at that position replaces the placeholder (proven). No callee, or no such parameter, falls back to the saved targets (inferred), which is what the walk would have done anyway. A callee that turns out to be an import is handed to the cross-file resolution above. Method calls are not deferred, because they match by name only and a later local of the same name would be the wrong function.

### Call positions

Two kinds of use record the start offset of the call they belong to. An argument's feed into a parameter records the call it enters, and the callee identifier records the call whose result it carries. Each `returns` entry also says whether the name is returned directly (`return v`) or as a call result (`return f(x)`). The query layer uses these to keep each value inside the call it came through.

### Exports

The walker records what each file publishes:

- `exports` maps each exported name to its local name: `export const x`, `export { a as b }`, and a named `export default`.
- `reExports` lists each `export … from` and `export * from`, with its already-resolved source.

Re-export statements are not walked for uses, since their names belong to another file.

## Cross-file linking (`analyse.ts`)

### Which file an import names

**Before the walk.** `readPathsConfig` reads `baseUrl` and `paths` from `tsconfig.json` or `jsconfig.json`, following relative `extends` by the exact file each one names. The walker then gets a specifier resolver:

- A relative specifier becomes an absolute path.
- A specifier matching an alias becomes the absolute path of its first target that exists. An exact pattern beats a wildcard, and the longest prefix wins.
- Anything else stays bare, which marks it as a package.

**After the walk.** `resolveImport` turns that absolute base into a real analysed file. It tries the path as written, then each known extension, then `index.<ext>` (a directory import), then `.js` → `.ts`. It checks against the set of analysed files rather than the disk. A `.d.ts` that exists but was excluded must not become a link target.

### Which declaration an import names

`resolveExportedName` asks the target file for the name *it* knows the binding by. A renamed import (`import { a as b }`) is asked for `a`, and a default import for `default`. It answers in four steps:

1. the file's own export table, following `import { x } … export { x }` one module further on
2. a named re-export, asking the source module for its own name for the binding
3. each `export * from` source in turn (not `export * as ns`, which publishes a namespace object rather than names)
4. any declaration of that name in the file, kept as a last resort so the precise steps only ever add links

A visited set stops `export *` cycles. Once linked, the uses recorded against the local import binding move onto the real declaration, so edges cross the file boundary.

### Reporting

Every import specifier lands in exactly one bucket:

- `linked`
- `external`: a package, correctly skipped
- `noFile`: points inside the project, but no file matches. This includes an alias whose targets don't exist.
- `noDeclaration`: the file resolved, but the name didn't
- `typeOnly` and `namespace`: can't carry a value, so excluded from the rate

The cross-file linkage rate is `linked / (linked + noFile + noDeclaration)`. `unlinkedImports` is `noFile + noDeclaration`.

## Graph output

**Nodes.** Step 3 flattens every non-import declaration into a node.

**Edges.** Step 4 reads each use's feeds and draws one edge per (used declaration → fed declaration) pair. Each edge keeps every use site that contributed to it, with a code snippet. An edge is marked `inferred` only if *every* use behind it was inferred, since one proven use makes the edge real. Edges whose target isn't a node are dropped. That covers unresolved placeholders and imports.

`vena` writes the graph as compact JSON. For scale: Hono's 309 files take about 1 s and produce 22 MB, and vscode's 8,144 files take 23 s and produce 1.2 GB. The second figure is why the MCP server needs an index instead of reading the whole file.

## Query layer (`query.ts`)

`indexGraph` builds five lookups: node by id, outgoing edges, incoming edges, a reverse map of `returns` (from a declaration to the functions that return it), and the function that owns each parameter.

`traverse` walks one direction, with a visited set, depth and size bounds, and an optional proven-only mode. The interprocedural hop works differently in each direction:

- **Forward** arrives holding a declaration. It uses the reverse `returns` map to hop to each function that returns it, then follows that function's outgoing edges to its call sites.
- **Backward** arrives holding a function and reads `returns` straight off the node.

Both directions match calls. The trace keeps a stack of the calls it is inside. Forward, an argument entering a parameter pushes that call, and leaving through a return pops it and follows only that call's result. Backward mirrors this: entering a function's returns through a call's result pushes the call, and its parameters then take only the arguments at that call. An empty stack means the trace started inside the function, so every caller counts. Recursion doesn't push the same call twice, and past 8 levels the outermost call is forgotten, which falls back to every caller at that level.

`resolveTarget` accepts the same address format the output prints (`file:line`, `file:name`, or a bare name). An ambiguous address lists its candidates in a form that can be pasted straight back.

These are exported pure functions, and the CLI is a thin `main` behind `import.meta.main`. An MCP server would call the same functions.

## Known limitations

Each has a reproducing snippet in `NOTES.md`.

- **Gaps 1 + 8.** Method calls resolve by name only and ignore the receiver. A later inner declaration doesn't shadow an earlier outer one. Together these are the only known source of wrong edges.
- **Gap 20.** Object fields carry no flow: `this.x = y` and reads of `this.x` produce nothing.
- **Inferred edges over-approximate.** `n = arr.push(y)` infers `y → n`. These edges are labelled, and `--strict` excludes them.
- **No versioning.** Variables aren't versioned, so an overwritten value still appears to reach later reads.
- **Imports not yet handled.** Namespace imports (`ns.foo`) and package `extends` in tsconfig.
- **Assignments not yet handled.** Destructuring assignment (`[a, b] = foo()`).
- **Call matching is bounded.** Past 8 nested calls a trace forgets the outermost one and may return to any of its callers there.
