# vena — dev notes

Static analysis engine for TypeScript/JavaScript. Parses source into an AST, resolves scope, extracts declarations and uses, links them across files, and traces data flow.

---

## Status


States are judged against *arbitrary* input, not against this repo — the Hono case study is what that distinction cost. A row reading ✅ means it holds up on code nobody here wrote.

| Feature                                      | State                                     |
| -------------------------------------------- | ----------------------------------------- |
| Per-file extraction (declarations + uses)    | ✅ Done                                    |
| Scope resolution (functions, arrows, blocks) | ✅ Done                                    |
| Intraprocedural `feeds` edges (v1.1)         | ✅ Done                                    |
| Argument → parameter flow (v1.2)             | ⚠️ 26.6% of call sites wire — see gap 16   |
| Argument flow through an unknown callee      | ✅ Passes through, marked `inferred` — gap 18 |
| Return capture (`returns` on function nodes) | ✅ Done                                    |
| Object field flow (`this.x = y`)             | ❌ Not tracked at all — see gap 20         |
| Graph output + local viewer (`flow <dir>`)   | ✅ Done                                    |
| Query/traversal layer (`query <target>`)     | ✅ Forward + backward, addressable, bounded |
| Forward references                           | ✅ For uses (gap 2) — ❌ for callees (gap 19) |
| Reassignment (`x = foo()`)                   | ✅ Done — not destructuring, see gap 5     |
| Method-call resolution                       | ⚠️ Name-only — 0.4% ambiguous live, gap 1  |
| Resolution reporting (`Results.lookups`)     | ⚠️ Counts, but globals list is thin        |
| Cross-file linking (imports → declarations)  | ⚠️ 80% of value imports on Hono, **44%** on a monorepo — gaps 21, 22 |
| Runs on an arbitrary repo                    | ✅ Survives bad files, reports them        |
| Runs on a *large* repo                       | ✅ 8,144 files, 0 parse failures, 23 s — but 1.2 GB graph |
| Answer size at scale                         | ✅ p90 = 10 nodes, flat from 309 to 8,144 files |
| JSX / `.tsx` support                         | ✅ Done — `.ts` stays non-JSX, see gap 13  |
| Automated tests                              | ⏳ Partial — 105 tests across 2 files      |
| Answers real questions end to end            | ⚠️ 15/20 on Hono, **0 wrong** — degrades on modular repos, BENCHMARK.md |
| MCP wrapper                                  | ⏳ Planned — see item 3 in Next up         |


---

## What works

Most of these are guarded by `bun test` (89 tests across `src/tests/engine.test.ts` and `src/tests/query.test.ts`); the rest were checked by reading `collectVariables` output.

**Scope and shadowing.** `const x = 1; function f() { const x = 2; const y = x }` — the inner `x` feeds `y`; the outer `x` is untouched.

**Feed targets nest correctly.** Save/restore around each declarator means `const a = () => { const b = x }` gives `x` feeds `b`, not `a`. Multiple uses in one init (`const c = x + y`) resolve to the right target.

**Every declarator feeds its own names.** `const a = f(), b = 9, c = g()` gives `f` feeds `a` and `g` feeds `c`; `const { a, b } = foo()` feeds both. (The earlier claim here that multiple declarators already worked was wrong — see gap 4.)

**Imports link across files.** `import { greet } from "./util"` finds `util/index.ts`, `util.ts`, or `util.js` — whichever the project actually has — and moves the uses recorded against the local import binding onto the real declaration, so the edge crosses the file boundary. Local imports that don't link are counted rather than dropped. See gap 7.

**Full interprocedural chain, across files.** `function foo(p) { return p } const z = 2; const a = foo(z)` produces `z` feeds `p`, `foo.returns = [p]`, and `foo` feeds `a`. `query.ts` stitches these into one path — this is the v1.2 goal, and it is done. (The old note saying flow is "intraprocedural only" was stale.) Imported functions carry flow too, as of gap 16 — `greet(who)` reaches `greet`'s parameter in the file that declares it.

**Nested calls chain.** `const a = wrap(id(z))` gives `z` feeds `p` (id's param), `id` feeds `q` (wrap's param), `wrap` feeds `a`. The argument walk recurses properly.

**Both directions are queryable, by address.** `query compose.ts:38 --back` answers "where did this come from?" and returns every source that feeds it; the forward form answers "where does it end up?". Nodes are addressed as `file:line` or `file:name`, which is the same string the output prints. On Hono this correctly recovers all three assignments into `compose.ts`'s `res` and follows cross-file provenance into `hono-base.ts` and `middleware/combine`. See gap 17.

**Method calls reach parameters.** `class R { score(p) { return p } } const r = new R(); const out = r.score(z)` gives `z` feeds `p`. Works for `this.m(x)` and private `this.#m(x)` too. See the caveats in gap 1 below.

**Classes and catch params resolve.** `class R {} const r = R` gives `R` feeds `r`; `try {} catch (err) { const e = err }` gives `err` feeds `e`.

**Property keys aren't mistaken for references.** `const o = { a: b }` records a use of `b` only; the key `a` is a label, even when a variable named `a` is in scope. `{ z }` records one use, not two. Computed keys still resolve: `{ [k]: v }` records both `k` and `v`.

**Forward references resolve.** `const a = b; const b = 2` gives `b` feeds `a`, and `foo(); function foo(p) {}` records the call as a use of `foo`. A use that can't resolve when the walk reaches it is retried after the walk instead of being dropped — see gap 2. Still correctly scoped: `{ const y = 1; } const z = y` produces nothing, because the block had closed.

**Loop bodies see the loop variable.** `for (let i = 0; i < 3; i++) { const b = i }` gives `i` feeds `b`. This looked like a hoisting problem and wasn't — see the first bullet under gap 2.

**Reassignment produces edges.** `let x; x = foo()` gives `foo` feeds `x`, and so does `x += foo()`. Assignments nested in an expression restore the enclosing target rather than clearing it, so `const a = (x = foo()) + bar()` still gets `bar` feeds `a`. Destructuring assignment is the exception — see gap 5.

---

## Known gaps

Ordered by how much they cost on real code. Each has a snippet that reproduces it. **Numbering is stable** — resolved entries stay in place rather than being renumbered, because `src/tests/engine.test.ts` refers to them by number.

### 1. Method calls don't reach parameters — ✅ RESOLVED

The call-site branch used to be gated on `node.callee.type === "Identifier"`, so `obj.m(x)` was skipped entirely. It now also accepts a non-computed `MemberExpression` callee and reads the name from `callee.property.name`. Methods additionally get their `params` and `returns` populated: `MethodDefinition` points `currentFeedTarget` at the method's binding before walking its (always anonymous) `FunctionExpression`, which is how `const f = () => {}` has always worked.

Three things this deliberately does **not** do:

- **The receiver is ignored.** Resolution is by method name only — `b.score(z)` never checks what `b` is. With two same-named methods in scope, `.find()` takes the first, which can be the wrong class. Decided (August 9, 2026) to keep it: the alternative is real type inference, and without name-only matching there are no method edges at all. Revisit if measurement says the collision rate is high.

  **August 15 2026 — the measurement is starting to arrive, and it's worse than "two same-named methods."** The name-only match is against *the whole scope chain*, not against methods, so a built-in call can bind to any local declaration that happens to share its name:

  ```ts
  function file(n){ return n }
  const p = "x";
  const out = Bun.file(p);      // edges: file -> out, p -> n  — both fabricated
  ```

  `Bun.file` has nothing to do with the local `file`, and `p` never reaches `n`. This was always true but was buried under gap 9's noise; with reads fixed, unresolved method names (`push` 22, `log` 17, `map` 7 on this repo) are the dominant remaining phantom source. Unlike a missing edge, this one actively misleads `query.ts`. Two cheap mitigations short of type inference: require the match to be `kind === "function"` *and* declared as a method, or keep a known-globals set (gap 11) so `Bun`/`console` receivers are recognised as external and their calls left unresolved.

  **The collision rate is measured, and it is high — the question above is closed.** On Hono (see the case study), **49 of 612 function names collide within a single file: 8.0%**, across 34 of 134 files, with 84 extra declarations. Including test files, 133 of 902 — **14.7%**. Roughly one method name in twelve is ambiguous under name-only resolution, so `.find()` taking the first match is picking wrong at a rate that shows up in real graphs rather than only in contrived snippets. This is now the only known source of wrong edges outstanding; everything else open is a missing edge.
- **Computed forms are skipped.** `r[k](z)` and `class R { [name]() {} }` have no statically-known name — the identifier there names a *variable holding* the name, so reading it would silently produce a wrong answer. Both bail out on `computed === true`.
- **Unresolvable member calls now emit no argument edge.** Previously `a.b.c(z)` fell through and `z` picked up the ambient feed target, giving a coarse `z → out`. Now the branch fires, finds nothing, and sets the target to null. This matches how unresolved *plain* calls have always behaved, but it does drop argument edges for object-literal methods and built-ins (`arr.map(fn)`, `str.split(sep)`).

### 2. Uses before their declaration are dropped — ✅ RESOLVED, except under shadowing

A single walk in source order meant a declaration had to be visited before any use of it. When it wasn't, the identifier resolved to nothing and **the use was silently discarded** — no node, no edge, no warning.

```ts
foo(); function foo(p) {}       // `foo` ended up with zero uses
const a = b; const b = 2;       // `b` ended up with zero uses
```

The fix filed here was two-pass resolution — pass 1 collects declarations, pass 2 resolves uses against complete scopes. **That was abandoned.** Its hard part (rebuilding the scope stack on the second walk and giving scopes stable identity across both) turned out to be avoidable entirely.

What shipped instead is a **deferred lookup**. When an identifier doesn't resolve, `walkVariables` files a `PendingUse` — the `Use` itself, a snapshot of the scope chain, and the `inReturnStatement` / `currentFunction` values live at that moment — and keeps walking. `collectVariables` retries every pending lookup once the walk is over, by which point every declaration exists. No second walk, no pre-pass.

The snapshot is the whole trick, and it is deliberately **shallow**. `[...stack]` copies the array, so later pushes and pops can't disturb it — the record of *which* scopes were visible is frozen. But the `Scope` objects inside are the live ones, so their `declarations` keep filling as the walk continues and are complete by retry time. **Freeze which scopes; don't freeze what's in them.**

Correct scoping falls out of that for free, in both directions:

```ts
const a = b; const b = 2;       // resolves — both share the one live global Scope
{ const y = 1; } const z = y;   // does NOT resolve — the block had already popped
                                // when `z` was walked, so it was never on the chain
```

`lookup` and `attachUse` were extracted from the identifier branch so the deferred path behaves identically to the immediate one — in particular a forward reference inside a `return` still stamps `returns` on the enclosing function, which is why the note carries `inReturnStatement`/`fn` rather than reading the module variables (both are back to `false`/`null` by retry time).

Four things worth knowing:

- **The third example originally filed here was misfiled.** `for (let i = 0; i < 3; i++) { const b = i }` was never a hoisting problem. The generic recursion iterates `Object.values(node)` and typescript-estree emits properties alphabetically, so `body` came before `init`/`left`/`test`/`update` and the walker reached the body before the loop variable. Nothing there is used before it is *declared*, only before the walker happened to *arrive*. Fixed separately, by naming loop children in source order the way `VariableDeclaration` and `MethodDefinition` already do.
- **Shadowing is still wrong** — see gap 8, which is where the measurement and the fix live. The short version: the retry fires on lookup *failure*, and shadowing is a lookup *success with the wrong answer*, so no note is ever written.
- **TDZ is ignored on purpose.** `const a = b; const b = 2` is a `ReferenceError` at runtime. The edge is drawn anyway — this is a graph of where values *would* flow, not a soundness checker.
- **One dead name must not take the others down with it.** The retry loop's failure branch has to `continue`, not `break`; an early `break` dropped every note queued behind the first unresolvable one. Guarded by a test.

To check any of this: `bun run src/scripts/trace.ts <file>`. The closing line reports how many uses stayed unresolved after the retry.

### 3. Classes, methods, types, and catch params are never resolvable — ✅ RESOLVED for classes/methods/catch

These four used to push straight into `results.declarations` instead of onto the scope stack. They became nodes in the graph, but the identifier lookup only searches the scope stack, so no use ever resolved to them. All four now push onto the current scope like every other binding, and classes, methods, and catch params resolve.

One wrinkle worth knowing: there is no scope for a class body (`ClassBody` isn't a `BlockStatement`), so a method name lands in the scope *enclosing* the class. That isn't lexically correct — `score` is a property of `R`, not a name in the surrounding scope — but it's what makes `r.score(z)` resolve at all, and it's the same imprecision as gap 1's ignored receiver.

**Types are still open.** The walk returns early on `TSTypeAnnotation` by design, to keep annotations out of the graph, so the scope-stack change alone doesn't make `const x: Result` resolve. That needs a separate decision about whether type references belong in a data-flow graph at all.

```ts
type Result = {...}; const x: Result   // Result: still 0 uses
```

Related, fixed alongside: `makeBinding` used to read `idNode.name` unconditionally, producing a nameless binding for literal keys like `class R { "my-method"() {} }`. It now falls back to `String(idNode.value)`, matching `makeUse`.

### 4. Declarators fed the wrong target — ✅ RESOLVED

Filed as "destructuring only binds the last name," but the root cause was broader. `VariableDeclaration` pushed **every** declarator's names up front, then each `VariableDeclarator` took "the last declaration in the current scope" as its feed target. So a declarator had no idea which bindings were its own:

```ts
const { a, b } = foo();               // foo fed `b` only — `a` got nothing
const a = foo(), b = 2;               // foo fed `b` — a variable it never touches
const a = f(), b = 9, c = g();        // f and g both fed `c`
```

The second and third lines are the worse half: not a missing edge but a **wrong** one, pointing at a variable the value never reaches. This also falsified the "What works" claim about multiple declarators, which only looked right because the example happened to put the call in the last declarator.

Fix had two parts:

- **Pairing.** The `VariableDeclarator` branch is gone; declarators are now walked inside the `VariableDeclaration` branch, which slices the scope's declarations around each `collectPatternNames` call. That slice *is* the set of names the declarator introduced — one normally, several for a pattern, none for a bare `let x`. A declarator can't do this itself: it can't see `node.kind` for the var/let/const keyword either.
- **Multiple targets.** `currentFeedTarget: Binding | null` became `currentFeedTargets: Binding[]` (empty = not in a flow-carrying position), and `Use.feeds` became a list. One use genuinely can feed several declarations — `const { a, b } = foo()` reads `foo` once. Recording it as one use with two targets keeps `uses` an honest count of source occurrences; the alternative, a duplicated use per target, is the bug gap 6 removed. `flow.ts` loops over the list and emits one edge per entry.

Nested patterns and rest elements fall out for free, since `collectPatternNames` already walked them: `const { a: { c }, b } = foo()` feeds `c` and `b` (not the intermediate key `a`), and `const [a, ...rest] = foo()` feeds both.

**Behavior change worth knowing:** names are now pushed per declarator instead of all up front, so a forward reference *within one statement* — `const a = () => b, b = 2` — no longer resolves. That reading was accidental (it relied on `b` being pushed before `a`'s initializer was walked), and matches gap 2, which is where forward references belong.

### 5. Reassignment isn't tracked — ✅ RESOLVED

Only `const`/`let`/`var` initializers set a feed target, so a bare `AssignmentExpression` set nothing and `let x; x = foo()` produced no edge at all.

Worth being precise about what was broken, because the filing here was misleading: **both identifiers already resolved.** `x` found its declaration and `foo` found its function; each got a `Use` recorded. The only thing missing was the `feeds` stamp, because nothing outside a declarator's initializer ever pointed `currentFeedTargets` anywhere. So the fix belonged in the walk's feed-target bookkeeping, nowhere near `lookup`.

The new `AssignmentExpression` branch does for `x = foo()` what `VariableDeclaration` does for `const x = foo()` — save, point `currentFeedTargets` at the thing being written, walk the right-hand side, restore. Three decisions inside it, each with a test:

- **`left` is walked before the target is set.** After would stamp the write as flowing into itself, so `x = 1` would emit `x -> x`.
- **When `left` can't be named, the enclosing target passes through rather than being cleared.** `o.p = foo()` and `undeclared = foo()` are the same situation: we can't say where the *write* lands, but that says nothing about where the expression's own value goes, and `const a = (o.p = foo())` really does put foo's result in `a`. Clearing to `[]` would assert "flows nowhere", which is a stronger claim than the truth.
- **Compound operators need no special case.** `x += foo()` still lands foo's value in `x`, so the target is identical, and `x` genuinely *is* read there, which walking `left` normally already records.

Two things it does by hops rather than directly, both intentional and both tested. Chained assignment `x = y = foo()` gives `foo -> y` and `y -> x` rather than a direct `foo -> x`; and a nested assignment `const a = (x = foo())` gives `foo -> x` and `x -> a`. `query.ts` traverses transitively, so the paths are intact either way, and the hop form is arguably more honest about what the source says.

**Not fixed: destructuring assignment.** `[a, b] = foo()` and `({ a } = foo())` have `ArrayPattern`/`ObjectPattern` on the left, and the branch only names an `Identifier`, so they fall through to the pass-through case and emit no edge. `collectPatternNames` is the wrong tool — it *declares* names, and these already exist — so this needs a sibling that collects leaf identifiers and looks each one up. Rare enough in real code to leave.

The wider imprecision underneath all of this is that variables aren't versioned. `let x = expensive(); x = foo(); const a = x` records both `expensive -> x` and `foo -> x`, so a forward trace from `expensive` reaches `a` even though that value was overwritten. Fixing it means SSA-style renaming, which is a much larger change than gap 5 was.

### 6. Property keys were treated as references — ✅ RESOLVED

Originally filed as "shorthand properties produce duplicate uses," which turned out to be one symptom of a broader bug: object literals had no branch in `walkVariables`, so the generic recursion walked `key` and `value` alike. But a **non-computed key is a label, not a reference** — only `{ [k]: v }` actually reads a variable.

```ts
const z = 1;              const o = { z };        // z: 2 uses — same offset, twice
const z = 1;              const o = { z: z };     // z: 2 uses — not shorthand at all
const a = 9; const b = 2; const o = { a: b };     // a: 1 use  — pure phantom
```

The third line was the real damage: `a` is a property name, but a variable named `a` in scope absorbed a use that doesn't exist in the source — a wrong edge, not just a duplicated one. Dedupe (as originally proposed here, mirroring `returns`, commit c39c185) would have fixed the first two and left the third.

Fix was a `Property` branch that walks the key only when `computed`, then always walks the value, then returns. The key/value asymmetry is the point: right of the colon is always a value expression, left of it is a name unless bracketed. Shorthand needs no special case — the parser fills both slots with the same identifier at the same offset, so skipping the label slot leaves exactly one use.

Same computed/non-computed split as gap 1's `MemberExpression` callee and `MethodDefinition`'s key. Three instances of one rule: **when `computed` is false the identifier is a name — read it, don't resolve it; when true it's a variable — resolve it, don't read it.**

**Three instances, but there is a fourth the rule was never applied to** — reading a member expression, `o.p`, as opposed to calling one. See gap 9. Worth knowing that this entry reading as fully RESOLVED is what made that easy to miss: the rule was stated correctly here and then only enforced in three of the four places it holds.

### 7. Import resolution assumes `.ts` — FIXED August 16 2026

The resolver appended `.ts` unconditionally, so pure-JS projects extracted fine but never linked. Directory imports (`./foo` → `./foo/index.ts`) and explicit extensions (`./foo.js` → `./foo.js.ts`) also failed.

**The fix splits the job by what each side knows.** `engine.ts` has the importing file's directory, so it turns `./util` into an absolute base path — and now stops there instead of guessing an extension. `analyse.ts` has the set of files actually analysed, so it decides which real file that base names, via `resolveImport(base, files)` trying four candidate shapes in order:

1. the base as written — the specifier already carried a real extension
2. `base + ext` for each extension the glob matches
3. `base + "/index" + ext` — the directory import
4. `.js` → `.ts` (and `.jsx` → `.tsx`) — TypeScript doesn't rewrite import paths when it compiles, so an ESM source names the file that will exist at runtime

Order is load-bearing: a file beats a directory of the same name, and case 4 stays last so a project where the `.js` genuinely exists links to that. `.mjs`/`.cjs` have no case 4 — they'd map to `.mts`/`.cts`, which the glob never collects, so the candidate could never be in the set.

**Matched against `treeResults`, not the filesystem.** The question is "did we analyse this file?", not "does this path exist?" — a `.d.ts` or a `.min.js` exists but `isProjectSource` deliberately excluded it, and linking to one would point an edge at a node the graph doesn't contain. It also keeps `resolveImport` pure, so it unit-tests against a `Set` with no disk access.

**Measured on Hono, before and after, same clone and same denominator:**

| | before | after |
| --- | --- | --- |
| local specifiers failing to link | 365 / 1,505 (24.3%) | **1 / 1,505 (0.1%)** |
| distinct failing paths | 54 | 1 |
| graph edges | 6,825 | **7,444** (+619, +9.1%) |

The one remaining failure is a `.json` import (`/middleware/jwk/keys.test.json`) — genuinely not a source file, correctly unlinked. Every top entry in the before-list was a directory import the old `+ ".ts"` turned into a file that never existed: `/jsx/hooks.ts` (77×), `/jsx.ts` (54×), `/jsx/dom.ts` (30×).

Note the denominator differs from the 17.8% recorded on August 15: that measured 879 specifiers across library code only, this measures all 1,505 across 309 files including tests. Before and after were run on the identical set, so the comparison holds; the two percentages are just not the same population.

`lookups` did not move at all (36,309 / 24,101 both runs), which is the reassuring part — that counter measures within-file resolution in `collectVariables`, and linking happens later in `analyse` step 2. The change is isolated to cross-file edges.

**And it used to fail silently**, which was the worse half. `analyse` does `if (sourceResults === undefined) continue` — a deliberate skip for package imports, which is right, but it also swallowed local imports that simply weren't resolved. Nothing distinguished "points outside the project" from "points inside and the resolver couldn't find it". Now `analyse` returns `unlinkedImports` (counted per **specifier**, so `import { a, b } from "./x"` contributes 2) and `flow.ts` prints it whenever it is non-zero. Only local imports count: the discriminator is `isAbsolute(binding.source)`, which is free because the engine makes local sources absolute and leaves package specifiers bare.

The counter is deliberately incremented at the resolve step rather than at the `sourceResults === undefined` skip. They are not the same set — an import can resolve to a real file and still fail to find the declaration inside it (`if (!realDec) continue`), which is a different bug and not this one.

**Still not handled:** `tsconfig` `paths` aliases, `export * from`, and non-relative imports that are nonetheless local. None have been measured; all would show up as `unlinkedImports` climbing rather than as silence, which was the point.

### 8. A use resolves to an outer declaration that a later inner one shadows

The residue of gap 2. A use is resolved against the scopes as they stand *at that moment*, so a declaration that appears later in an inner scope never gets the chance to shadow.

```ts
const x = 1; function f() { const y = x; const x = 2 }
//                                    ↑ resolves to x@6 (outer); should be x@47

function foo() { return 1 }
function f() { const a = foo(); function foo() { return 2 } }
//                        ↑ resolves to foo@9 (outer); should be foo@69
```

The second is the one that matters. The `const` version is a TDZ `ReferenceError` — already-broken code — but an inner `function` declaration really is hoisted and really does shadow, so that call returns 2 and the graph says otherwise.

Gap 2's retry cannot reach this: it fires on lookup *failure*, and this is a lookup *success with the wrong answer*. Nothing distinguishes it from a correct resolution at the moment it happens, so no `PendingUse` is ever filed.

**Measured, August 15 2026.** Deferring *every* identifier rather than only the failures — a one-line change, `walkVariables` never resolving inline — fixes both cases: the retry's `chain` holds the lexically enclosing scopes, and by retry time each holds all of its declarations, so `lookup` finds the genuinely innermost one. All 19 engine tests still pass, and it is not slower (0.70 vs 0.73 ms per walk over a 600-line file — the eager lookup is traded for a deferred one, not added to).

**What blocks it is not cost, it's the call-site lookup.** `CallExpression` does its own separate resolution to reach `calledFunc.params`, and that one genuinely *can't* be deferred — it needs the callee's parameters *during* the walk, to set the feed target before the arguments are walked. Deferring only the identifiers splits the graph's story in two:

```ts
function foo(p) { return 1 }
function f(z) { const a = foo(z); function foo(q) { return 2 } }
// use of `foo` → inner foo@72   (fixed)
// z -> p       → OUTER foo's param@13   (not fixed; should be q@76)
```

The graph would then assert both "this call is the inner `foo`" and "its argument flows into the outer `foo`'s parameter," and `query.ts` — which traverses `feeds` — would walk into a body the graph says was never called. Being *consistently* wrong is more tractable than being *inconsistently* wrong, and it matches how gap 1's ignored receiver already behaves.

So: do the two together, as one change, or not at all. Worth measuring the frequency of inner-hoisted-function shadowing on a real repo first — if it's rare, this stays cheap to ignore.

### 9. Member expression properties are treated as references — ✅ RESOLVED

**This is gap 6, only half-fixed.** That entry established the rule — *when `computed` is false the identifier is a name; read it, don't resolve it* — and applied it to object literal keys, a `MemberExpression` **callee**, and a `MethodDefinition` key. It was never applied to the ordinary case of *reading* a member expression, which has no branch at all and so falls through to the generic recursion. `o.p` therefore looks up `p` as if it were a variable.

```ts
const declarations = 9;
const node = { declarations: 1 };
const x = node.declarations;     // edges: declarations -> x, node -> x
//             ^ the property is a label; `declarations -> x` is invented
```

Same damage as gap 6's third case (`const o = { a: b }` inventing a use of `a`), and more common, because member access is everywhere while shadowing object keys are rare.

**Measured on this repo, August 15 2026.** Across `src/scripts` (8 files, 215 nodes, 148 edges) only **56.8%** of uses resolved — 551 deferred lookups over 109 distinct names. Ranked, they are almost entirely property names:

```
  31  name        23  declarations    17  start
  31  type        22  push            13  kind
  26  length      21  console         12  file
```

`console` and `Bun` are real globals (gap 11). Everything else is `node.type`, `arr.push`, `binding.declarations`. And note what those names are: `name`, `type`, `start`, `kind`, `file`, `declarations` are all variables in `engine.ts` itself, so the graph of this repo almost certainly contains phantom edges today.

Fixed with a `MemberExpression` branch shaped exactly like the existing `Property` one: always walk `object`, walk `property` only when `computed`, return. Unlike most entries here it *removes* wrong edges rather than adding missing ones.

**The five-line version is a trap, and it passes the whole suite.** A method call's edge comes from resolving the callee's *property* — `score` in `r.score(z)` — which is precisely what the new branch skips. `CallExpression` used to end by handing `node.callee` to the generic walk, and that walk is what produced `score -> out`. Adding the branch alone deletes that edge:

```ts
const out = r.score(z);
// before: R -> r, r -> out, score -> out, z -> q
// naive:  R -> r, r -> out,               z -> q     ← gone, 26/26 tests still green
```

So the fix is two parts: the branch, plus `CallExpression` walking `callee.object` and `callee.property` itself instead of delegating. Walking the property directly bypasses the new branch and lands in the Identifier branch, which is what records the use. The computed-callee case (`r[k](z)`) needs nothing — `calleeName` stays undefined, so the branch never fires and the generic loop hands the member expression to the new branch, which walks both children because `computed` is true.

**The resulting asymmetry is deliberate.** `o.p` read → the property is not resolved, because there is nothing to resolve *to*: the engine never declares object properties or class fields, so any match would be coincidence. `o.m()` call → the property *is* resolved by name, because gap 1 decided exactly that, and without it there are no method edges at all. Same syntax, two treatments, both on purpose.

**Measured after the fix, August 15 2026**, same command as before, on `src/scripts`:

| | before | after |
| --- | --- | --- |
| unresolved lookups | 551 | **257** |
| resolution rate | 56.8% | **73.6%** |
| edges | 148 | **144** |

The four vanished edges are the phantoms. What survives in the unresolved pile splits cleanly in two, and neither is a walker bug: real globals (`console` 21, `Bun` 13, `process` 12 — that's gap 11), and built-in *method* names (`push` 22, `log` 17, `map` 7) which are looked up on purpose under gap 1's name-only rule and simply don't exist in the project.

### 10. Vendored and minified files aren't excluded — ✅ RESOLVED

`IGNORED_DIRS` covers `node_modules`, `dist`, `vendor` and friends, but `src/viewer/lib/cytoscape.min.js` sits under none of them. So a full run on this repo produced **8,876 nodes of which 8,621 came from that one file** — 97% of the graph is a dependency nobody wants to trace, and it swamps every measurement taken from the whole project (the 42 same-name function collisions counted in the first run were all inside it).

Filtering on directory name won't generalise — `lib/` is a normal source directory in plenty of projects. The property that actually matters is that the file is minified, so the rule added to `isProjectSource` is `/\.min\.[cm]?js$/`, mirroring how `.d.ts` is already excluded for having no runtime values. A maximum line length is the more general version of the same test, but it needs the file's contents rather than its path, so it can wait for a case the extension rule misses.

`isProjectSource` is exported now purely so this is testable — it's the one piece of `analyse.ts` that's a pure function, and testing it needs no fixture directory. Everything else in there still waits on the cross-file harness.

Whole-repo effect: **13 files / 8,876 nodes → 12 files / 311 nodes.** Every number taken from the whole project before August 15 2026 should be read as being about cytoscape.

### 11. Unresolvable globals are counted as resolution failures — ✅ RESOLVED

`console`, `Bun`, `process`, `JSON`, `Math` and friends are never declared in the source, so every use of them defers, fails the retry, and lands in the same bucket as a genuine engine failure. In the measurement above `console` alone accounts for 21 of 551, and `Bun` 13.

That makes the resolution rate read worse than it is and, more importantly, hides the real failures behind a floor of permanent ones.

Fixed with `KNOWN_GLOBALS` in `engine.ts` — runtime objects (`console`, `Bun`, `process`), language built-ins (`Object`, `JSON`, `Promise`), and built-in *method* names (`push`, `map`, `log`), which reach the lookup because gap 1 resolves method calls by name and no project declares `push`. `Results.lookups` now carries `{ resolved, unresolved, external }`, and `analyse` sums it across files, so the number is readable without attaching a trace hook and scraping the phase line.

Two properties worth keeping:

- **The set is consulted only after the scope chain has already come up empty**, so a real declaration always shadows it. `function map(f){...}` in the source means `map` resolves normally and never counts as external. Guarded by a test.
- **A name missing from the set counts as unresolved**, which is the safe error — an incomplete list understates coverage rather than inventing it. The set is a reporting aid, not a correctness mechanism, and nothing in the graph depends on it.

**Measured after gaps 10 and 11, August 15 2026**, on `src/scripts`:

| | before gap 9 | after gap 9 | after gaps 10+11 |
| --- | --- | --- | --- |
| resolved | 712 | 715 | 743 |
| unresolved | 551 | 257 | **75** |
| external | — | — | 188 |
| rate, excluding external | — | — | **90.8%** |

The headline is that real coverage was never 56.8% — it was around 80% with a floor of permanent failures sitting on top of it, and the remaining 75 misses are now a small enough number to read by name. Which is how gap 12 turned up.

### 12. Interface and type-alias members are treated as references — ✅ RESOLVED

The same rule as gaps 6 and 9, a fifth time. `TSInterfaceDeclaration` pushes the interface's name and then falls through to the generic recursion, which walks the body — so each `TSPropertySignature`'s key is looked up as if it were a variable.

```ts
const name = "x";
interface R { name: string; line: number }
//            ^ resolves to the const above — a phantom use
//                            ^ deferred, then counted as unresolved
```

Reading the 75 remaining misses on this repo is what surfaced it: `line`, `source`, `kind`, `start`, `declarations`, `id`, `code`, `target`, `occurrences`, `root`, `nodes`, `edges` are all field names in `types.ts`. It is self-inflicted here — a project that declares fewer interfaces would see less of it — but the phantom-use half is a wrong edge wherever it happens.

**The fix is not the same shape as the others, and that's the thing to remember.** `TSEnumDeclaration`, `TSInterfaceDeclaration` and `TSTypeAliasDeclaration` shared one branch, and they are not the same kind of thing:

- **Interface and type-alias bodies are pure type space.** No member of them is ever a runtime value — not the keys, not the annotations, not an index signature's parameter. So they push their name and `return` outright, extending the decision `TSTypeAnnotation` already makes at the top of the walk.
- **Enum bodies are half value space.** `enum E { A = SIZE }` reads a real variable. A blanket `return` would have silently dropped it, so enums keep walking — but only the members' `initializer`s, never their `id`s.

That split is the whole subtlety, and getting it backwards is easy: `TSEnumMember` stores the label on `id` and the value on `initializer`, so walking `member.id` skips the reference and looks up the label — precisely inverting the fix. That version passed all 35 tests then in the suite and a clean `tsc`. The two enum tests added alongside this fail on it, and were checked to fail on it.

**Measured after the fix, August 15 2026**, on `src/scripts`:

| | after gaps 10+11 | after gap 12 |
| --- | --- | --- |
| resolved | 743 | 748 |
| unresolved | **75** | **28** |
| external | 188 | 189 |
| rate, excluding external | 90.8% | **96.4%** |

Whole repo, 12 files: 1061 resolved, 127 unresolved, 89.3%.

What's left of the residue is fully accounted for, with nothing unexplained: `import.meta` (a `MetaProperty`, not an ordinary member expression) and built-in methods missing from `KNOWN_GLOBALS` — `isArray`, `text`, `cwd`, `write`, `serve`, `scan`, `json`. Both cosmetic; neither produces a wrong edge. Adding the missing names is a one-line change whenever the number starts to matter.

### 13. `.tsx` and `.jsx` files can't be parsed — ✅ RESOLVED

`analyse`'s glob matches `**/*.{ts,tsx,js,jsx,mjs,cjs}`, but the parse call is `parse(code, { loc: true, range: true })` — no `jsx` option. Every file containing JSX therefore fails, with errors that don't obviously point at the cause, because `<div>` is being read as a less-than:

```
jsx/base.test.tsx        '>' expected.
jsx/streaming.test.tsx   Expression expected.
jsx/index.test.tsx       Unterminated regular expression literal.
```

On Hono this was 21 of 309 files, and **every single parse failure was a `.tsx`** — nothing else in the repo failed.

Fixed with `allowsJsx(path)`, which is `true` for every extension the glob matches except `.ts`. That one exception is the whole subtlety: in a `.ts` file `<T>expr` is a type assertion, so enabling JSX there would reinterpret it as an unclosed element and break files that parse today. The `.ts`/`.tsx` split exists in TypeScript for exactly this reason, and the fix just respects it. `.js` files routinely carry JSX and have no type-assertion syntax to lose, so they get it too.

Invisible from self-analysis: this repo contains no JSX, so the glob has been matching a file type the parser was never configured for since the day it was written.

### 14. A single parse failure aborts the whole analysis — ✅ RESOLVED

The per-file `parse` in `analyse` has no error handling, so one unparseable file anywhere in the tree throws out of the loop and the run produces nothing at all. Not a degraded graph — a stack trace and no output.

```
TSError: Unterminated regular expression literal.
    at analyse (src/scripts/analyse.ts:105:18)
```

This was the most serious item on the list, and worse than it looks. The premise of the tool is being pointed at code you didn't write, and the failure mode was total: 308 perfectly good files produced nothing because of the 309th. It also masked gap 13 — the first symptom was a crash, not "21 files skipped."

Fixed with a `try`/`continue` that records `{ file, reason }` into a `skipped` array, now returned from `analyse` alongside `lookups`, and printed by the `flow` CLI when non-empty. Same reasoning as gap 11: a thing the engine could not do should be **visible**, not absent. A graph quietly missing a file is indistinguishable from a graph where that file had nothing to contribute, and only one of those is true.

The parser's first line of complaint is kept, not just the path — that is what would have identified gap 13 in seconds rather than after a bisect ("Unterminated regular expression literal" on a `.tsx` names the cause once you see it beside the filename).

**Verified on Hono, August 15 2026:** 309 files, **0 skipped**, 15,264 nodes, 6,997 edges. It ran to completion on a foreign repo for the first time.

### 15. Type parameters leak into value lookups — ✅ RESOLVED

`TSTypeAnnotation` returns early to keep annotations out of the graph, but type parameters aren't annotations and have no such branch. So `<T>` is walked as an ordinary identifier and looked up in the value scope chain:

```ts
const T = 9;
function f<T>(x: T): T { return x }
//         ^ resolves to the const T above — a phantom use
const x = { a: 1 } as const;
//                     ^ a lookup for a "variable" called `const`
```

Same family as gaps 6, 9 and 12 — type space bleeding into value space — and the phantom-use half is a wrong edge, not just noise.

**`T` was the single most unresolved name in Hono's library code** (120 occurrences), with `E` (40), `P` (17), `S` (14), `BasePath` (15) and `JSX` (14) behind it. This repo barely uses type parameters, which is why twelve gaps went by without it surfacing; Hono is generic-heavy and it went straight to the top of the ranking.

Distinct from gap 3's remainder, which asks whether type *references* should resolve at all — this is about type space creating uses in value space, which is wrong under either answer to that question.

### 16. Arguments to an imported function flow nowhere — ✅ RESOLVED

Found and fixed August 16 2026, while measuring the call-site resolution rate — which is the reason that measurement was worth doing.

`CallExpression` resolves the callee against the scope stack and feeds each argument into the matching parameter:

```ts
const param = calledFunc?.params?.[argIndex];
currentFeedTargets = param ? [param] : [];
```

When the callee is imported, `calledFunc` is the local **import binding**. An import binding has no `params` — the real function is in another file — so `currentFeedTargets` becomes `[]` and every argument flows nowhere.

```ts
// util.ts
export function greet(name) { return name }
// main.ts
import { greet } from "./util";
const who = "ada";
greet(who);          // no `who -> name` edge. The chain stops at the file boundary.
```

**Gap 7 did not fix this, and can't.** Gap 7 moves *uses* onto the real declaration in `analyse` step 2, which runs after every file has been walked. But `calledFunc.params` is read *during* the walk, when the other file may not be parsed yet. Imported values link; imported functions don't carry flow.

**Measured on Hono library code (tests excluded), August 16 2026.** Of 2,549 call sites passing at least one argument:

| outcome | count | share |
| --- | --- | --- |
| arguments actually flow into parameters | **405** | 15.9% |
| callee found but it had no params to feed | 434 | 17.0% |
| callee name not found at all | 1,710 | 67.1% |

Of the 434 with nothing to feed, **272 are import bindings** — by far the largest single cause. (The rest: 80 `param`, 77 `variable`, 4 `catch`, 1 `function` — calling something whose definition the engine never sees as a function.)

The 67.1% overstates the gap: 1,129 of those 1,710 (66.0%) are `KNOWN_GLOBALS` built-ins — `push`, `forEach`, `replace`, `charCodeAt` — where there was never anything to find. Excluding them the addressable population is 1,420, of which 405 wire: **28.5%**.

**The fix reuses gap 2's deferral**, with one architectural wrinkle that cost a wrong first attempt. The call site can't be resolved during the walk, so it's recorded and resolved once every file is parsed — but *what* you record matters:

> **`use.feeds` holds flat copies, not references.** The Identifier branch does `use.feeds = currentFeedTargets.map(t => ({ name, file, line, start }))`. The copy is taken at stamp time, so handing the walk a placeholder `Binding` and mutating it later changes nothing — the copies were already made.

So the deferral travels in the placeholder's *fields* rather than by object identity. A placeholder gets a **negative `start`**, which no real declaration can have (starts are byte offsets), plus the importing file's path. `file + start` is already the graph's node id, so this is a node id that can only mean "not resolved yet". `analyse` then:

1. **step 2** — when an import links, records `nodeId(file, id) → the real parameter` in a map
2. **step 2b** — one pass over every use, rewriting any feed entry whose `start` is negative

One pass over all uses rather than a scan per deferral: there are far more uses than deferrals, so the cost is paid once.

**The failure mode is a missing edge, never a wrong one.** An unresolved placeholder keeps its negative start, which can't match any node id, so step 4's existing `if (!nodeIds.has(target)) continue` drops it and the call site produces nothing — exactly the behaviour before the fix. That guard is what makes the design safe rather than merely clever.

**Result on Hono:** graph edges **7,444 → 8,471 (+1,027, +13.8%)** over all 309 files. On library code, the 272 import call sites that dropped their arguments now defer instead, taking the share of arg-passing call sites with a parameter to feed from **15.9% to 26.6%**. (Two populations again — the edge count is all files, the call-site rate excludes tests.)

Six tests cover it in `engine.test.ts`, five of which fail without the fix. The sixth — an import that resolves to nothing produces no edge — passes either way by construction; it guards the safety property rather than proving the feature.

**Still open:** default and namespace imports where the local name differs from the exported one (`import foo from "./x"` against `export default function bar`). Step 2 matches on `param.name === binding.name`, so those never link, and this gap inherits that limitation from gap 7.

**This reorders the call-site work.** Gap 1's receiver problem was prioritised on an 8.0% collision rate, but that measured names colliding anywhere within a file. Measured at live call sites, ambiguity is **9 of 2,549 — 0.4%**, because the open scope chain holds far fewer declarations than the whole file does. That is a lower bound (the counter reads the stack at walk time, so declarations the walk hasn't reached yet aren't counted), but it is 30× smaller than this gap either way. Fix the imports first: it adds correct edges, where the receiver work rewrites resolution and can produce wrong ones.

**The fix is three node types, and the interesting part is what it must *not* skip.** Mapping every identifier that survives the existing `TSTypeAnnotation` early-return showed the leaks all sit under `TSTypeParameter` (the `<T>` declaration), `TSTypeReference` (every use of a type name — `as Foo`, `as const`, `new Map<string, Foo>()`), and `TSClassImplements`. Those three now return alongside `TSTypeAnnotation`.

Against that, the value-carrying identifiers live on separate nodes and are untouched:

```ts
class D extends B implements I {}
//              ^ B is a real runtime value — keeps its use
//                          ^ I is type-only — correctly loses it
const y = z as Foo;   // `z` keeps its use, `Foo` loses it
const q = z!.a;       // TSNonNullExpression holds the value on its own node
```

A broader skip — anything named `TS*`, say — would have taken the superclass with it, along with the left-hand side of `as`, `satisfies` and `!`. Guarded by a test asserting `extends` and `implements` behave differently on the same class.

Worth knowing: call type arguments (`foo<Bar>(1)`) never leaked, because the `CallExpression` branch returns before the generic loop reaches `typeArguments`. `new Map<string, Foo>()` did leak, since `NewExpression` has no such branch — which is why the test uses the constructor form.

Still unhandled, and rare enough to leave: `x as typeof y` reaches a `TSTypeQuery` rather than a `TSTypeReference`, so `y` is still looked up. Arguably it should be, since `typeof y` really does name a value.

**Measured on Hono, August 15 2026**, library code (186 files, tests excluded):

| | before gap 15 | after |
| --- | --- | --- |
| resolved | 10,897 | 10,536 |
| unresolved | **1,346** | **1,017** |
| edges | 2,359 | **2,253** |
| rate excluding external | 89.0% | **91.2%** |

The edge count *falling* is the point — 106 phantom edges removed, the same shape as gaps 9 and 12. Resolved falls too, because a chunk of what it was counting were phantom resolutions.

---

### 17. The query layer can't address most of the graph — ✅ RESOLVED August 17 2026

`query.ts` took a **name** and traced the first match. On Hono that meant 46 declarations called `res`, and no way to say which one — the tool printed `compose.ts:38` in its own disambiguation list and would not accept it back.

Measured before the fix, on 4,702 nodes:

| | count | share |
| --- | --- | --- |
| names that are unique | 1,733 | 77.8% of names |
| names that collide | 495 | 22.2% of names |
| **nodes not addressable at all** | **2,969** | **63.1% of nodes** |

77.8% of names being unique sounds survivable until you notice which ones collide: `c` (113), `value` (83), `key` (83), `options` (74), `path` (63), `i` (62), `res` (46). And the correlation runs the wrong way:

| | mean edges touching it | isolated (0 edges) |
| --- | --- | --- |
| addressable (unique name) | 0.77 | **57.3%** |
| unaddressable (colliding name) | 1.27 | 39.4% |

**73.8% of all edge endpoints land on nodes that could not be named.** The addressable nodes were mostly dead ends — over half had no edges, so tracing them was always going to print one line. The addressing scheme failed hardest exactly where the graph had something to say.

Second defect, independent: traversal followed `outgoing` only. `res` in `compose.ts` has three incoming edges and zero outgoing, so *"where did this come from?"* — probably the more common question — was unanswerable for every node in the graph.

**Fixed.** Addresses are now `file:line` (`compose.ts:38`) or `file:name` (`compose.ts:res`), with the bare name kept as a convenience; `where()` prints exactly what `resolveTarget` accepts, so the ambiguity list is paste-able. An `incoming` index mirrors `outgoing`, and `--back` walks it. The interprocedural hop is deliberately *not* symmetric — forward needs the inverted `returns` map because it arrives holding a declaration, backward arrives holding the function and reads `returns` off the node. `--depth` and `--max` bound the output, each reporting when it fired so a truncated answer can't pass for a complete one.

The file was also split into exported pure functions with the CLI behind `import.meta.main`. It was a script before, which is why it had no tests; there are now 27 in `src/tests/query.test.ts`, and the same functions are what an MCP wrapper will call.

**Rough edge, unfixed:** `file:line` is not always unique — `utils/crypto.ts:33` matches `data`, `algorithm` and `createHash`, all declared on that line. `file:name` disambiguates and the candidate list is paste-able, so it is recoverable rather than blocking.

---

### 18. Arguments to an unknown callee lose their flow — ✅ RESOLVED August 17 2026

When `CallExpression` can't resolve the callee, `engine.ts` sets `currentFeedTargets = []` for the arguments, so they feed nothing. But the callee — including the **receiver** of a method call — is walked *outside* that loop, with the enclosing target already restored. Same expression, one side flows and the other doesn't:

```ts
// utils/filepath.ts:21
filename = filename.concat('/' + defaultDocument)
```

The graph contains `filename -> filename` (the receiver) and **not** `defaultDocument -> filename` (the argument). No rule justifies the difference; it falls out of where the loop ends.

**Measured on Hono library code**, 3,693 arguments:

| | count | share |
| --- | --- | --- |
| wired to a real parameter | 1,250 | 33.8% |
| **dropped — callee unresolved, but an enclosing feed target existed** | **719** | **19.5%** |
| no enclosing target (nothing lost) | 1,724 | 46.7% |

The callees losing the most flow are pure transforms where the argument plainly influences the result: `replace` (62), `get` (48), `indexOf` (42), `slice` (41), `split` (34), `map` (26), `join` (26), `charCodeAt` (23).

**The fix is one word, and marking it is the rest of the change.** `currentFeedTargets = target ? [target] : save` — treat an unknown call as transparent, which is what already happens to the receiver. **2,549 → 2,924 edges (+375, +14.7%).**

Transparency is the standard conservative choice in taint analysis, but it can add edges that aren't real — `n = arr.push(y)` returns a length, not `y`. That cuts against the "missing edges, never wrong ones" posture, which BENCHMARK.md had just confirmed holds perfectly. **So the added edges are labelled instead of blended in:**

- a new walk-state flag `currentFeedsInferred` travels beside `currentFeedTargets`, saved and restored at all six sites and carried on the two scope frames — the flag qualifies those targets, so restoring one without the other mislabels edges
- `use.feeds[].inferred` is set only when true, so a proven feed keeps the exact shape it always had
- an edge is inferred only if **every** use behind it was — one proven use makes the edge real, so `analyse` ANDs rather than ORs
- `query --strict` traverses proven edges only; the printer marks inferred hops `~inferred`
- `flow` prints the proven/inferred split, because a graph that silently mixes the two is a graph you can't cite

A resolved parameter is proven even inside an unresolved call: in `unknown(known(x))` the inner `x -> p` is real regardless of the outer call, so it must not inherit the enclosing flag. That is the one subtlety in the whole change, and it has its own test.

**The verification that matters.** The proven subgraph is **set-identical** to the pre-change graph — 2,549 edges, zero added, zero removed, and no inferred edge duplicates a proven one. The change is purely additive and perfectly separable.

**Result on BENCHMARK.md:** four questions moved ❌ → ✅ (Q3, Q4, Q6, Q8), taking the score from 11/20 to **15/20**. All three negative controls held. Q3 now resolves the full taint chain — the `Request` parameter reaches the parsed credentials across two files and five hops.

Q1 now returns a *superset* of its hand-derived answer, adding `err` and `context` because `onError`/`onNotFound` are parameters holding functions, so their call sites don't resolve. Both additions are defensible on inspection, so this reads as the ground truth having been incomplete rather than the tool being wrong — and `--strict` returns the original three exactly. This is the over-approximation behaving precisely as predicted, which is the argument for having made it visible.

Nine tests in `engine.test.ts`, four of which fail without the fix. The other five are guards — the receiver still feeds, statement position still feeds nothing, resolved params stay proven — and pass either way by construction. Seven more in `query.test.ts` cover `--strict` and the marker.

---

### 19. Callee lookup can't see declarations that come later in the file

Distinct from gap 2, which fixed forward references for **uses** by retrying unresolved lookups after the walk. `CallExpression` still resolves its callee **eagerly**, off the scope stack, at the moment it is walked. A module-level `const` declared further down the file is not on that stack yet, so `calledFunc` is `undefined` and the arguments never wire to the parameters.

```ts
// utils/filepath.ts:24 — calls it
const path = getFilePathWithoutDefaultDocument({ root: options.root, filename })
// utils/filepath.ts:32 — declares it
export const getFilePathWithoutDefaultDocument = (options) => { … }
```

`params` is recorded correctly (604 of 693 function nodes have them), and `analyse` later resolves the *identifier* — the edge `getFilePathWithoutDefaultDocument -> path` exists. Only the argument→parameter wiring is lost.

**Size: at most 148 of the 719 in gap 18 (20.6%), and that is a loose upper bound.** It counts any unresolved callee whose name the same file also declares, which sweeps in coincidental collisions — a local named `map` in a file that calls `arr.map`. The clean cases are `getFilePathWithoutDefaultDocument`, `classNameSlug`, `getContent`, `getCSPDirectives`, `jsxFn`. The true number is smaller and unmeasured.

**Measured directly on three repos (BENCHMARK.md #2, August 19 2026) — module-level `const f = () => {}` whose name is called earlier in the same file:**

| repo | arrow call sites | called before declared | share | files affected |
| --- | --- | --- | --- | --- |
| hono `src` | 381 | 99 | **26%** | 35 |
| excalidraw `packages` | 717 | 115 | **16%** | 31 |
| vena `src` | 3 | 0 | **0%** | 0 |

Regex-derived, so approximate in both directions; it is here to rank the cause, not to claim a precision. The 0% row is the one that matters: **this repo has three arrow-function call sites in total and declares before use everywhere, so it had no chance of surfacing this gap from the inside.** Same lesson as gaps 13/14 in case study #1, arriving a third time.

Live example on excalidraw: `avoidRectangularCorner` is called at `binding.ts:1500` and declared at `binding.ts:1616`. `vena-trace element/src/binding.ts:1618 --back` returns the header line and nothing else; `grep` finds the call site in 0.03 s.

Accounts for Q5, Q14 and Q18 in BENCHMARK.md. Likely fix: a hoisting pre-pass collecting module-level declarations before the walk, or deferring callee resolution the way gap 2 defers uses.

---

### 20. Object fields carry no flow

`this.x = y` produces no edge, and neither does a read of `this.x`. Nothing in the walker treats a member expression as a flow target.

```ts
// http-exception.ts
constructor(status = 500, options?) { this.status = status }   // line 58
getResponse() { return new Response(this.message, { status: this.status }) }   // line 75
```

The constructor argument demonstrably reaches `getResponse`, and the graph says `status` reaches nothing (BENCHMARK.md Q9). The same shape is why `res` in `compose.ts` has zero outgoing edges — it feeds `context.res` at line 68.

Only one of twenty benchmark questions, so it ranks below gaps 18 and 19. But it is a bigger design question than either: fields need somewhere to live as nodes, and `obj.x` across two unrelated objects is the same name-collision problem gap 1 has with methods. Worth deciding deliberately rather than drifting into.

**"One of twenty" was a hono-shaped number.** BENCHMARK.md #2 counted `this.x =` assignments across three repos:

| repo | `this.x =` assignments | class declarations |
| --- | --- | --- |
| hono `src` | 59 | 54 |
| excalidraw `packages` | 249 | 77 |
| vscode `src` | **25,445** | **10,764** |

Every one of those 25,445 is a missing edge. Tracing `path` in `vs/base/common/uri.ts` returns four within-file edges and stops, because the value goes into `this.path` and there is no node for it. On a DI/class-structured codebase this is not an item ranked below gaps 18 and 19 — it is the difference between a graph and no graph. The design question is unchanged; what changed is that the answer now decides whether whole categories of repo are in scope at all.

---

### 21. Re-export chains are not followed

`analyse.ts:244` links an import by looking for a **declaration** in the resolved file whose name matches the specifier. A barrel file has no such declaration — it has a re-export:

```ts
// packages/element/src/index.ts
export * from "./cropElement";          // vena: no declaration named `cropElement` here
// packages/excalidraw/components/App.tsx
import { cropElement } from "@excalidraw/element";   // → resolves to index.ts → finds nothing → dropped
```

`export { x } from "./y"` fails the same way, and neither is counted anywhere: `unlinkedImports` only fires when no *file* resolves, and here the file resolves fine.

**Size: 2,459 of excalidraw's 5,892 value import specifiers — 42%.** That is the largest single measured hole in the project. On hono it is 139 of 963 (14%), which is why case study #1 never ranked it — hono re-exports far less, and the note there to try "a repo with `export *`" was the right instinct.

Likely fix: when the resolved file has no matching declaration, check its re-exports and recurse, with a visited set for cycles. `export * from` needs the target's exported names; `export { x } from` and `export { x as y } from` need the rename handled.

**Ship with gap 22.** Alone, on a monorepo, this leaves the barrel unreachable behind an unresolved alias.

---

### 22. tsconfig `paths` aliases are treated as third-party — and not counted

`engine.ts:284` only rewrites an import source to an absolute path when it starts with `"."`. A tsconfig path alias does not, so it falls through to `resolveImport`, misses, and is skipped as an external package.

```jsonc
// excalidraw tsconfig.json
"paths": { "@excalidraw/element": ["./packages/element/src/index.ts"], "@excalidraw/element/*": ["./packages/element/src/*"] }
```

**1,209 of excalidraw's ~3,700 in-project import statements are `@excalidraw/*`.**

The second half is worse than the first. `analyse.ts:235` guards the `unlinkedImports` counter on `isAbsolute(binding.source)` — and an unrewritten alias is not absolute, so it is not even counted. The run reports 234 unlinked while roughly 1,200 are missing. **The one metric whose job is to make missing edges visible is blind to the largest source of them**, which is a sharper version of the same failure gap 7 had before it was measured. Whatever fix lands here, the counter needs to move to "any specifier that did not link", regardless of how its source looked.

Fix: read `compilerOptions.paths` and `baseUrl` from the nearest tsconfig at analysis start, and apply the mapping in the same place `"."` is handled today. Mechanical.

**On its own it is worth 2.5%** — patching the alias map by hand on excalidraw took the graph from 23,250 to 23,829 edges, because the aliases point at barrels and gap 21 then drops them. The two gaps are one fix in two parts.

---

## Benchmark

### #1 — twenty questions over Hono

`src/mds/BENCHMARK.md`, August 17 2026 — twenty data-flow questions over Hono, ground truth hand-derived from source *before* any query was run.

**Run 1: 11 ✅ / 3 ⚠️ / 6 ❌. Run 2, after gap 18: 15 ✅ / 3 ⚠️ / 2 ❌ — and 0 wrong in both.** No answer contained an edge that isn't real; all three negative controls held; every ⚠️ is a strict subset of the truth. Every failure is a missing edge.

Nine of the ten imperfect answers attribute to three causes — gap 18 (five), gap 19 (three), gap 20 (one). None of them is visible in any internal metric: `unlinkedImports` is 0, `skipped` is 0, resolution is 91.2%.

**Method note worth keeping.** This is the same discipline as reading unresolved names by rank, moved one level up: ask questions the engine wasn't built around, derive the answers by hand first, and let the failures rank themselves. It took about two hours and reordered the whole backlog.

### #2 — does it hold up as repos get larger?

August 19 2026 — four repos, 13 → 8,144 files (vena, hono, excalidraw, vscode), plus head-to-head against `grep`.

| | |
| --- | --- |
| Runs on a large repo at all | ✅ 8,144 files, 0 parse failures, 23 s |
| Answer size stays bounded | ✅ forward reachability p90 = 10 nodes, **flat across all four** |
| Cross-file linkage holds up | ❌ 80% of value imports on hono → **44%** on excalidraw |
| Beats grep on cross-file provenance | ✅ 23 of 25 call sites *with the bound variable named*, 0.2 s |
| Beats grep within a file | ❌ reading the function is cheaper and more complete |
| Still no wrong edges | ✅ four repos, every failure was silence |

Two results reordered the backlog again:

**The bounded-answer property survives scale, and it wasn't designed for.** vscode's graph has one weakly-connected component holding 40% of its 544,862 nodes, which looks like a hairball — but flow *direction* cuts it into small pieces, and a trace returns tens of nodes at 8,144 files exactly as it does at 309. This is what makes the tool usable by an agent at all.

**Linking is now the binding constraint, not coverage.** Benchmark #1 concluded the reverse, and that was right for one flat 309-file repo. Gaps 21 and 22 halve cross-file linkage on a repo with aliases and barrels — and both get *more* common as a codebase grows, which inverts the premise: the graph is weakest exactly where "I can no longer hold this in my head" is most true.

The uncomfortable result kept on purpose: **grep wins within a file.** Those are the engine's most reliable edges and the ones an agent needs least. The 25–33% that cross a file boundary are the whole value proposition.

Priorities out of it: gap 21, then 22 (together, not separately), then gap 19, then MCP over an index rather than a 1.2 GB JSON reload per query, then decide gap 20.

---

## Launch

**Decision, August 17 2026: ship at 15/20 rather than chase 20/20.** The reasoning is that the accuracy claim is already stronger than most dev tools launch with — measured on a foreign codebase, with zero wrong answers, and with the guesses labelled as guesses. Everything left on *Next up* is a refinement to a tool that already answers three-quarters of real data-flow questions correctly. Real usage ranks the remaining gaps better than more self-analysis will.

### Timing — measured August 17 2026

| repo | files | `analyse()` | graph.json |
| --- | --- | --- | --- |
| vena `src/scripts` | 9 | 46ms | 0.4MB |
| Hono library only | 186 | 304ms | 7.3MB |
| Hono, everything | 309 | **1.0s** | 21.8MB |

**One second for 310 files kills the hardest MCP design problem before it arrives.** No incremental analysis, no watch mode, no clever invalidation — check mtimes, rebuild if anything moved, cache under `.vena/`. Assume this holds to a few thousand files and re-measure past that.

The 21.8MB figure is the other half of the argument: the graph can never be handed over whole. The surface has to be bounded traversals, which `query.ts` now is.

### Re-measured past a few thousand files — August 19 2026

That last line asked for it, so BENCHMARK.md #2 did it:

| repo | files | `analyse()` | graph.json | peak RSS |
| --- | --- | --- | --- | --- |
| excalidraw `packages` | 572 | 1.3s | 63MB | 0.8GB |
| vscode `src` | 8,144 | **23s** | **1.21GB** | **5.3GB** |

**The first half of the bet held; the second half did not.** 23 seconds for 8,144 files with zero parse failures means rebuild-on-mtime-change is still the right call and incremental analysis is still not needed.

But *"cache under `.vena/`"* assumed the cache is a file you read back. At 1.21GB it is not. `query.ts` re-parses the whole graph per invocation — **2.7s and 4.1GB RSS for one trace on vscode**, to produce an answer of a few hundred bytes. Ten traces in an agent loop is 27s and ~40GB of allocation churn.

So the MCP item is no longer "wrap `query.ts`". It is **an on-disk index keyed by node id** — edges queryable without materialising the graph (`bun:sqlite` is already the house tool) — with `resolveTarget`/`traverse` running against that. The bounded-traversal surface argued for above is unchanged and is still right; what changed is that it now has to sit on storage rather than on `JSON.parse`.

### What blocks a v0

None of it is engine accuracy.

1. **Staleness contract.** An agent edits a file and then asks a question. A stale graph gives a *confidently wrong* answer, which is worse than no tool. Cheap to solve at 1s rebuild, but it has to be decided rather than left implicit.
2. **Two tools, not more.** `trace(target, direction, depth)` and `find(name) → addresses`. Small surfaces get used correctly.
3. **`file:line` is not always unique** — `utils/crypto.ts:33` matches three declarations. A human reads the candidate list and picks; an agent may loop. Small fix, worth doing first.
4. **Errors that suggest a next action.** "nothing matching X" should offer near-misses.
5. **Packaging** — how a stranger runs it.

### Explicitly not blocking

Gaps 19 and 20, call-site resolution, extending `KNOWN_GLOBALS`, splitting `engine.ts`, reaching 20/20.

If exactly one accuracy fix goes in first, make it **gap 19**: cheapest remaining, adds only correct edges, and BENCHMARK.md predicts 15/20 → 19/20.

---

## Benchmark #2 — does an agent do *better* with vena?

**Not yet run.** This is the claim that actually matters and the one nothing here has measured. BENCHMARK.md establishes that the graph *contains* the answers. It says nothing about whether an agent holding it performs better than one with `grep` and `Read`. Those are different claims and only the second one is why anyone would install this.

### It does not need the MCP

`query.ts` is a CLI. An agent with shell access can already run it. **The MCP is packaging, not capability** — so this experiment is runnable now, and its result should decide how much effort the wrapper deserves rather than the other way round.

### Design

- **Tasks:** the twenty in BENCHMARK.md. The answer key exists, ground truth was derived by hand, and they are already data-flow questions. Weight reporting toward the multi-hop and cross-file ones (Q1, Q3, Q12, Q13) — the single-file ones are honestly greppable.
- **Arm A:** agent with `Read`/`Grep`/`Bash` on a Hono checkout.
- **Arm B:** same agent, same task, plus the `query.ts` CLI and one paragraph on how to use it.
- **Controls:** same model, fresh context per task, identical task wording. Arm A gets an equally detailed prompt about searching well, so the comparison isn't "a hint versus no hint."
- **Measure:** correct / incorrect against the existing key, **plus tool calls, tokens, and wall time.**

### Prediction, recorded before running

Writing this down first, the same discipline that makes gap 19's prediction worth checking.

**Correctness will be close.** Models read code well, and on a 60-line file `grep` is enough. **The difference will show up in cost** — Q3's chain crosses two files and five hops, which is many searches for an agent and one command for vena.

So the hypothesis under test is *"fewer tool calls for the same answer"*, not *"answers otherwise unreachable."* If cost is also a wash, that is a real result and the honest conclusion is that the graph does not earn its place — better to learn that from twenty tasks than after building a server.

### Threats to validity, to state in the writeup

- The same author wrote the questions and the tool. Include tasks where `grep` should win and report them.
- Twenty tasks is small. Expect noise; do not quote a percentage that will not survive a second run.
- Arm B's prompt mentions data flow, which is itself a hint that data flow matters.

---

## Next up

**Reordered August 19 2026 by BENCHMARK.md #2.** The previous ordering was ranked by "which of twenty questions does it get wrong" on one 309-file repo. Scaling to four repos put two gaps at the top that did not exist on the list a day ago, and both are *linking*, not analysis.

The lesson worth carrying, third version: ranked by resolution rate → call-site resolution was first. Ranked by benchmark failures → it fell to third. Ranked across repo *shapes* → the top two items are gaps 21 and 22, which cost nothing at all on hono and half the cross-file graph on a monorepo. **Each reranking came from widening what was being measured, never from measuring the same thing harder.**

Gap 18 came off this list on August 17, the same day it was filed — it was item 1, and the benchmark re-score took 11/20 to 15/20.

1. **Gaps 21 + 22 — re-exports and tsconfig `paths`, as one change.** 2,459 and ~1,200 import specifiers on excalidraw; 44% of value imports link where hono gets 80%. Ship together: aliases alone bought 2.5% when measured, because they land on barrels. Fixing these is what makes the cross-file edges — the only ones worth having, per #2's grep head-to-head — actually exist on a repo with module boundaries. Gap 22 also has to move the `unlinkedImports` counter off `isAbsolute`, so the metric stops being blind to its own largest miss.
2. **Gap 19 — callee lookup can't see later declarations.** Now the whole of the remaining benchmark shortfall except one question: Q5, Q7, Q14 (⚠️) and Q18 (❌). A hoisting pre-pass over module-level declarations, or defer callee resolution the way gap 2 defers uses. Only adds correct edges, so unlike gap 18 there is no soundness question to settle first. BENCHMARK.md predicts it moves four answers — worth checking that prediction against the result, since a prediction that misses says the model of the gap is wrong.
3. **Call-site resolution** — gap 1's ignored receiver and gap 8's shadowing, as one change. Demoted twice now: first below gap 16 (measured ambiguity at live call sites is 0.4%, not the 8.0% within-file collision rate it was prioritised on), then below gaps 18 and 19, which cost eight benchmark answers where this costs none that have been observed. Still the **only known source of wrong edges** — but the benchmark found zero wrong answers in twenty, which is evidence the 0.4% rarely bites in practice. Gap 8's entry explains why the two can't be separated. Cheaper than type inference: restrict the name-only match to method declarations, and use `KNOWN_GLOBALS` so a global receiver marks the call external rather than binding `Bun.file()` to a local `file`.
4. **MCP wrapper** — unblocked as of gap 17. `query.ts` now has backward traversal, addressable nodes, bounded output, and exported pure functions (`resolveTarget`, `traverse`) that a server can call directly instead of shelling out. What is left is the server itself and a decision about what the tool surface should be — bounded traversals, not "here is the graph." Worth doing before items 5+: BENCHMARK.md measures whether the graph *contains* the answers, and the wrapper is what would let something measure whether an agent gets *better* with them. **Two things #2 adds to this item:** it must sit on an on-disk index rather than `JSON.parse` (see the re-measured Launch timing — 2.7s and 4.1GB per query on vscode), and the tool surface should be scoped to cross-file provenance, because #2's head-to-head says an agent reading the function beats a within-file trace.
5. **Extend `KNOWN_GLOBALS`** — the cheapest coverage left, and the residue analysis is what surfaced it. Of Hono's 1,017 unresolved lookups, roughly half are names nothing in the project declares (`isArray` 53, `charCodeAt` 40, `create` 31, `at` 29, `Uint8Array` 15) — a thin globals list, not a walker failure. Editing a list would take the rate to about 95%. Note gap 18 already changed what this is worth: those 719 dropped arguments are now passed through, so extending the globals list no longer recovers edges — it converts `inferred` edges into proven ones, which is a different and arguably better payoff.
6. **Gap 20 — object field flow.** Still the largest design question of the three gaps filed on August 17 — fields need somewhere to live as nodes, and `obj.x` across unrelated objects is the same collision problem gap 1 has with methods. What #2 changed is the stakes, not the design: 25,445 `this.x =` assignments across 10,764 classes on vscode. On class-structured code this is not a ranked refinement, it is whether there is a graph at all — so the decision also decides which repo shapes are in scope.
7. **Cross-file test harness** — mostly done as of gap 7. Gaps 13/14 added the first `analyse`-on-a-temp-dir tests; gap 7 added `fixtureDir` fixtures with real directory structure and the first assertions on cross-file edges. What's left is breadth: re-export chains, default exports, and `export * from`, none of which is exercised — and gap 21 is now item 1, so these fixtures are a prerequisite rather than a nice-to-have.
8. **Types decision** (remainder of gap 3) — do type references belong in a data-flow graph at all? Gap 12 settled that type *bodies* are skipped; this is the separate question of whether `const x: Result` should record a use of `Result`.
9. **Destructuring assignment** (remainder of gap 5) — `[a, b] = foo()` needs a lookup-per-leaf sibling to `collectPatternNames`. Small, but rare enough to wait for evidence.

**Measured August 15 2026** by calling `analyse()` directly and reading `lookups`. On `src/scripts`, 8 files: **748 resolved, 28 unresolved, 189 external — 96.4%** excluding externals. Whole repo, 12 files, 316 nodes: 89.3%. The progression over one day, same target, as each gap closed:

| | start | gap 9 | gaps 10+11 | gap 12 |
| --- | --- | --- | --- | --- |
| unresolved | 551 | 257 | 75 | **28** |
| rate | 56.8% | 73.6% | 90.8% | **96.4%** |

Most of that was never a coverage problem: gap 11 showed a permanent floor of globals was hiding the real number, and gaps 9 and 12 were one rule — *a non-computed key is a label* — unenforced in two more places. What remains is `import.meta` and a handful of built-in method names, neither of which produces a wrong edge.

**The method that produced all of it is worth keeping.** Run the analysis, then read the unresolved names *by name*. Gap 9 came from reading that list, and so did gap 12 — and gap 15, on Hono. Ranked residue points at systematic bugs in a way an aggregate number never does.

That last line used to read "every number here is this repo analysing itself; the next measurement should be a codebase nobody here wrote." That happened the same day — see the case study below. It cost about twenty minutes and produced three new gaps, two closed questions, and the discovery that `analyse()` does not survive contact with a foreign repo at all. One number is still unmeasured: what fraction of *call sites* resolve.


### Tested on an external repo: Hono (https://github.com/honojs/hono) Case Study # 1

**August 15 2026.** Shallow clone, `analyse()` pointed at `src/`. 309 TypeScript files, ~78k lines, zero runtime dependencies — chosen for being pure TS, mid-sized, and written in a style nothing like this repo's: heavy generics, class hierarchies, middleware composition, JSX.

Everything before this was vena analysing vena: 8 files, one author, one month, one style. The first foreign repo found two total failures in the first thirty seconds, neither of which eight rounds of self-analysis could have surfaced.

#### It did not run

`analyse()` threw and produced nothing. One file failing to parse takes the entire run with it — see gaps 13 and 14. The numbers below come from a throwaway copy patched with `jsx: true` and a per-file `try/catch`, which is the fix those two gaps describe.

#### Numbers, library code only

Test files are excluded here — `expect` (5,874), `toBe` (3,471), `it` (2,508) and `describe` (811) are vitest globals, and including them drags the rate to 60% while saying nothing about the engine. That is a `KNOWN_GLOBALS` shortfall (gap 11's set doesn't know test frameworks), not a resolution failure.

| | vena `src/scripts` | Hono `src`, no tests |
| --- | --- | --- |
| files | 8 | 186 |
| nodes | 221 | 4,719 |
| edges | 150 | 2,359 |
| time | 31 ms | 262 ms |
| resolved / unresolved / external | 748 / 28 / 189 | 10,897 / 1,346 / 2,097 |
| rate excluding external | 96.4% | **89.0%** |

Performance is a non-issue — 186 files in 262 ms, and the graph is a manageable size. The 7-point drop in rate is the interesting part, and reading the residue explains all of it.

#### What the residue said

Ranked unresolved names on library code: `T` (120), `isArray` (53), `header` (51), `E` (40), `charCodeAt` (40), `create` (31), `at` (29), `append` (19), `Uint8Array` (18), `P` (17), `encode` (16), `const` (15), `BasePath` (15), `S` (14), `JSX` (14).

Three groups, and the first was a surprise:

- **`T`, `E`, `P`, `S`, `BasePath`, `JSX`, `const`** — type parameters and type positions leaking into value lookups. New, filed as gap 15. Hono is generic-heavy where this repo barely uses type parameters at all, which is exactly why self-analysis never showed it.
- **`isArray`, `charCodeAt`, `at`, `append`, `encode`, `substring`, `flat`, `addEventListener`, `Uint8Array`** — built-in methods and globals missing from `KNOWN_GLOBALS`. Cosmetic; no wrong edges. Typed arrays are a notable omission.
- **`header`, `getConnInfo`, `serveStatic`** — real project names, and the trail that led to the import measurement below.

#### Two open questions, now answered

**Gap 1's collision rate.** Its receiver bullet has said since August 9 to *"revisit if measurement says the collision rate is high."* On Hono: **49 of 612 function names collide within a single file — 8.0%**, across 34 of 134 files, 84 extra declarations. With tests included, 133 of 902, **14.7%**. Roughly one method name in twelve is ambiguous under name-only resolution. That is not a rounding error, and it settles the question in favour of doing the work.

**Gap 7's real cost.** The entry knew directory imports fail; it had no number. On Hono: **156 of 879 local imports fail to link — 17.8%** — across 25 distinct paths, every one of them a directory import (`./router/reg-exp-router` wanting `./router/reg-exp-router/index.ts`). Silently. Roughly a fifth of the cross-file graph is simply absent, with nothing reporting it. *(Fixed the next day — see gap 7. Measuring it is what got it prioritised ahead of call-site resolution.)*

#### What to take from this

The two failures that stopped the run (gaps 13, 14) are both about *other people's code* — a file type this repo doesn't contain, and an error path that never fires when every input is known-good. No amount of self-analysis reaches them. Neither is hard; both are invisible from inside.

The measurement method held up for the third time: run it, rank the unresolved names, read them. That found gap 9, then gap 12, and now gap 15.

Worth repeating on a second external repo once gaps 13-15 land — ideally one with decorators, namespaces, or `export *`, none of which either codebase exercises.

*Last updated: August 19, 2026*