# Benchmark #1 — can the graph answer real data-flow questions?

**August 17 2026.** Target: Hono `src`, test files excluded — 186 files, 4,702 nodes, 2,549 edges, 0 skipped, 0 unlinked.

## Why this exists

Every number in NOTES.md so far measures the engine against itself: resolution rate, unresolved residue, edge count. Those are proxies. None of them answers the question that decides whether this project is worth continuing — **can something ask the graph a question a person would actually ask, and get the right answer?**

The rule for this file: **ground truth is derived by hand from the Hono source, before running any query.** Otherwise the questions drift toward whatever the graph happens to be good at, and the benchmark measures nothing.

Second rule: the questions have to be ones where *data flow is the answer*. If `grep` settles it, the tool isn't the variable being tested.

## Scoring

| verdict | meaning |
| --- | --- |
| ✅ | the answer set matches ground truth exactly |
| ⚠️ | a strict subset — real edges, but incomplete |
| ❌ | nothing returned, or the key relationship missing |

A wrong-answer category exists and went unused. See the headline below.

---

## The questions

### A. Backward provenance — "where did this value come from?"

**Q1. What feeds `res` in `compose.ts:38`?**
Ground truth: `handler`@40, `onError`@17, `onNotFound`@18 — the three assignments at lines 51, 55, 63.
Result: exactly those three. **✅**

**Q2. What feeds `path` in `utils/filepath.ts:52`?**
Ground truth: `root`@35 and `filename`@36, both tracing back to `options`@33.
Result: exactly that, including the self-loop from line 53. **✅**

**Q3. What feeds `userPass` in `utils/basic-auth.ts:15`?**
Ground truth: line 18 is `userPass = USER_PASS_REGEXP.exec(utf8Decoder.decode(decodeBase64(match[1])))` → `USER_PASS_REGEXP`@4, `utf8Decoder`@5, `decodeBase64` (imported), and `match`@10 — which itself comes from `req`@9.
Result: `USER_PASS_REGEXP` only. **❌**

This is the one that matters most. The question underneath it is *"does attacker-controlled input reach the parsed credentials?"* — the answer is yes, and the graph cannot say so, because `match` is an argument to an unresolved call. See gap A below.

**Q4. What feeds `binary` in `utils/encode.ts:26`?**
Ground truth: `str`@25, via `atob(str)`.
Result: nothing. **❌**

**Q5. What feeds `hash` in `utils/crypto.ts:17`?**
Ground truth: `createHash`@33, and through it `data`@15 and `algorithm`@16.
Result: `createHash` and its return, but not the arguments. **⚠️**

### B. Forward impact — "if I change this, what moves?"

**Q6. What does `defaultDocument` (`utils/filepath.ts:14`) reach?**
Ground truth: `filename`@13 (lines 18 and 21), then into the call at line 24, `options`@33 → `filename`@36 → `path`@52 → returned.
Result: nothing. **❌**

**Q7. What does `str` (`utils/encode.ts:6`) reach?**
Ground truth: `decodeBase64`'s `str`@25 → `binary`@26 → `bytes`.
Result: missed all of that, but correctly followed the return out to `jws.ts:42` and `jwt.ts:177`. Real edges, wrong ones for this question. **⚠️**

**Q8. What does `duration` (`middleware/timeout/index.ts:39`) reach?**
Ground truth: `timer`@43, via `setTimeout(…, duration)`.
Result: nothing. **❌**

**Q9. What does `status` (`http-exception.ts:55`) reach?**
Ground truth: `this.status = status`@58, read at lines 69 and 75 in `getResponse`.
Result: nothing. **❌** — object fields are not flow-tracked at all. New gap, see C below.

**Q10. What does `middleware` (`compose.ts:16`) reach?**
Ground truth: `handler`@40.
Result: `handler`@40. **✅**

### C. Cross-file

**Q11. Does `part` (`utils/jwt/jwt.ts:35`) reach `str` in `utils/encode.ts:6`?**
Ground truth: yes — `decodeBase64Url(part)`@36, imported from `../../utils/encode`.
Result: yes, directly. **✅** (this is gap 16's path, working on a foreign repo)

**Q12. What feeds `buf` in `utils/encode.ts:10`?**
Ground truth: `encodeSignaturePart`'s `buf` (jwt.ts:33) and the `utf8Encoder` expression (jwt.ts:32).
Result: both. **✅**

**Q13. What feeds `str` in `utils/encode.ts:25`?**
Ground truth: the local call at encode.ts:7, plus every cross-file caller.
Result: four cross-file sources — `aws-lambda/handler.ts:318`, `lambda-edge/handler.ts:200`, `basic-auth.ts:10`, `jws.ts:50`. **✅**

**Q14. What feeds `buf` in `utils/encode.ts:15`?**
Ground truth: `encodeBase64(buf)` at encode.ts:11, plus external callers.
Result: three external callers found; the intra-file one at line 11 missed. **⚠️**

### D. Negative controls — the answer is "no"

**Q15. Does `onNotFound` (`compose.ts:18`) reach `index` (`compose.ts:21`)?** No. Result: no. **✅**

**Q16. Does `exception` (`timeout/index.ts:40`) reach `timer`@43?** No. Result: no. **✅**

**Q17. Does `sha1`'s `data` (`crypto.ts:21`) reach `sha256`'s `hash` (`crypto.ts:17`)?** No — separate functions. Result: no. **✅**

### E. Grep traps — name-based search gives the wrong answer

**Q18. What feeds `createHash`'s `algorithm` param (`utils/crypto.ts:33`)?**
Ground truth: three distinct call sites — `algorithm`@16 (SHA-256), @22 (SHA-1), @28 (MD5). Grep for `algorithm` returns eight lines with no way to tell which flows where.
Result: none of the three. **❌**

**Q19. What feeds `handler` in `compose.ts:40`?**
Ground truth: `i`@32, `next`@20, `middleware`@16. Grep also returns `errorHandler` and `notFoundHandler` noise.
Result: exactly those three. **✅**

**Q20. What feeds `filename` at `utils/filepath.ts:36`?**
Ground truth: `options`@33 only. There is a *different* `filename` at line 13 in the other function; grep cannot separate them.
Result: `options`@33. **✅**

---

## Scorecard

| | run 1 (before gap 18) | run 2 (after gap 18) | run 3 (after gaps 19 + 23) |
| --- | --- | --- | --- |
| ✅ correct | 11 / 20 | 15 / 20 | **19 / 20** |
| ⚠️ partial | 3 | 3 | **0** |
| ❌ missing | 6 | 2 | **1** |
| **wrong** | **0** | **0 proven / see note** | **0** |

> The first draft of this file reported run 1 as 10/4/6. That was an arithmetic slip in the
> summary — the per-question verdicts below have always been 11 ✅, 3 ⚠️, 6 ❌. Corrected here.

### Run 2 — after gap 18 (August 17 2026)

Four questions moved ❌ → ✅: **Q3, Q4, Q6, Q8.** All four were the same cause, and closing it closed all four.

Q3 is the one worth showing, because it is the security question and it now resolves end to end:

```
userPass (basic-auth.ts:15)
  <- decodeBase64 (encode.ts:25) ~inferred
      <- str (encode.ts:25) ~inferred
          <- match (basic-auth.ts:10)
              <- req (basic-auth.ts:9) ~inferred
```

The `Request` parameter reaches the parsed credentials, across two files and five hops.

**Q1 now returns a superset**, and this is the over-approximation showing up exactly where it was predicted to. It adds `err`@52 and `context`@20 to the three assignment sources, because `onError` and `onNotFound` are *parameters* holding functions, so their call sites don't resolve and their arguments pass through. Both additions are defensible on inspection — an error handler's output really does depend on the error it is handed — so this is arguably the ground truth being incomplete rather than the tool being wrong. `query --strict` returns exactly the original three.

**All three negative controls still hold** (Q15, Q16, Q17), which was the main risk. The proven subgraph is **set-identical** to run 1's graph: 2,549 edges, zero added, zero removed, and no inferred edge duplicates a proven one.

| | run 1 | run 2 |
| --- | --- | --- |
| edges | 2,549 | 2,924 |
| — proven | 2,549 | 2,549 |
| — inferred | 0 | 375 (12.8%) |

**Remaining failures, both single-cause:**

- ⚠️ Q5, Q7, Q14 — gap 19 (forward references in callee lookup)
- ❌ Q9 — gap 20 (object fields)
- ❌ Q18 — gap 19

Gap 19 is now the whole of the remaining shortfall except one question. That is the next thing to fix, and this file predicts it moves four answers.

### Run 3 — after gaps 19 and 23 (November 2026)

**The prediction held: all four moved.** Q5, Q7 and Q14 went ⚠️ → ✅ and Q18 went ❌ → ✅. Score **19 / 0 / 1**; the only miss left is Q9, which is gap 20.

| | before | after |
| --- | --- | --- |
| Q5 — what feeds `hash`@17 | `createHash` and its return, not the arguments | `createHash`@33, and through it `data`@15 and `algorithm`@16 — and *not* `sha1`'s or `md5`'s |
| Q7 — what `str`@6 reaches | the return out to `jws.ts`/`jwt.ts` only | also `decodeBase64`'s `str`@25 → `binary`@26 → `bytes`@27 |
| Q14 — what feeds `buf`@15 | external callers only | also `encodeBase64Url`'s `buf`@10, the intra-file call at line 11 |
| Q18 — what feeds `algorithm`@33 | none of the three | all three: @16, @22, @28 |

**It did not hold on the first attempt, and that is the useful part.** Gap 19 alone broke negative control **Q17**: with `createHash` finally receiving its arguments, `sha1`'s `data` traced in through `sha1`'s call and back out to `sha256`'s `hash`. Every edge on that path was real; the path was not, because the query layer returned to *every* caller of a function rather than the one the value came through. Q5 showed the same thing as a superset (`data`@21 and @27). Filed and fixed as gap 23 in NOTES.md — calls are now matched by position — and Q17 holds again, along with Q15 and Q16.

Without the negative controls this would have shipped as "four answers fixed" with a false positive inside one of them. That is the case for keeping questions whose answer is *no*.

**Every other answer re-checked keeps its full ground truth** (Q1–Q4, Q6, Q8, Q10–Q13, Q19, Q20). Several got *smaller*: Q1's backward trace drops 33 nodes it reached only through impossible call/return pairings, e.g. into `buildMiddlewareTuple` through one call and out through another.

Method note: run on a fresh Hono clone rather than the August one, so whole-graph numbers (11,145 edges, all 313 files) are not comparable with run 2's. The line numbers of every question above were checked against the new checkout before scoring.

### The headline is the zero

Not one answer contained an edge that isn't real. All three negative controls held, and every ⚠️ is a strict subset of the truth. **Every single failure is a missing edge, never a false one** — which is exactly the posture NOTES.md has been maintaining on purpose, now confirmed against questions the engine was not built around.

Run 2 keeps this property *for the proven subgraph*, which is why gap 18's edges are marked rather than blended in. `query --strict` reproduces run 1's answers exactly; the default adds reach at the cost of edges that are assumed rather than proven.

That matters for the agent case more than the 10/20 does. A tool that is silent 30% of the time is usable with a caveat. A tool that fabricates a data-flow edge 30% of the time is worse than no tool.

### What the failures attribute to

| cause | questions | count |
| --- | --- | --- |
| **A. Argument flow dropped at an unresolved callee** | Q3, Q4, Q6, Q7, Q8 | 5 |
| **B. Forward references (single-pass walk order)** | Q5, Q14, Q18 | 3 |
| **C. Object fields not flow-tracked** | Q9 | 1 |

Nine of the ten imperfect answers come from three causes, and **one cause accounts for half the failures.** That is the thing the benchmark was built to find and no internal metric would have surfaced: `unlinkedImports` is 0, `skipped` is 0, resolution is ~96%, and the graph still cannot say that an HTTP header reaches a parsed password.

Gap A is measured separately: 719 arguments on this repo (19.5% of all arguments) sit in a feed context and lose it. Making an unknown call transparent takes the graph from 2,549 to 2,924 edges (+14.7%).

### What this changes about priorities

*Next up* item 6 said "serve the graph to agents once coverage is trustworthy." The dependency was backwards. Coverage was never the binding constraint here — Q1, Q12, Q13 and Q19 show the engine answering multi-source, cross-file provenance questions perfectly on a codebase nobody here wrote. What blocked it was first the query surface, and now three specific engine gaps that self-analysis could not have ranked.

Suggested order, revised:

1. **Gap A** — half the failures, biggest measured edge gain, and it removes an internal inconsistency (the receiver of a call gets an edge; the argument to the same call does not).
2. **Gap B** — a hoisting pre-pass over module-level declarations.
3. **Gap C** — decide whether `this.x = y` should be an edge at all. Bigger design question than the other two.

Re-score this file after each. The questions do not change; that is the point of them.

## Method notes / caveats

- Ground truth was written from the Hono source before any query was run.
- "Direct feed" questions were scored at `--depth 1`; reachability questions at the default depth.
- `file:line` is not always a unique address — `utils/crypto.ts:33` matches three declarations sharing that line (`data`, `algorithm`, `createHash`). The `file:name` form disambiguates, and the ambiguity list prints pasteable addresses, but this is a real rough edge in the addressing scheme worth fixing.
- Twenty questions is small. It is enough to rank three causes; it is not enough to claim a percentage that will hold on another repo.

---

# Benchmark #2 — does it hold up as repos get larger?

**August 19 2026.** Benchmark #1 asked whether the graph can answer real questions. It
can, on one 309-file repo. This one asks the next question down: **does that answer
survive scale, and is what survives worth an agent's tokens?**

Four repos, increasing size, `analyse()` called headlessly (the viewer and its server
bypassed, so the numbers are the engine's). Ground rules carried over from #1: any
question where `grep` settles it does not count, and where `grep` *does* settle it,
that is recorded as a loss rather than omitted.

## The four scans

| repo | files | nodes | edges | proven / inferred | time | graph.json | peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vena `src/` | 13 | 531 | 445 | 421 / 24 | 0.06 s | 0.6 MB | — |
| hono `src/` | 309 | 15,325 | 9,898 | 8,486 / 1,412 | 0.78 s | 22 MB | — |
| excalidraw `packages/` | 572 | 28,434 | 23,250 | 19,954 / 3,296 | 1.26 s | 63 MB | 0.8 GB |
| vscode `src/` | 8,144 | 544,862 | 417,256 | 318,438 / 98,818 | 22.6 s | **1.21 GB** | **5.3 GB** |

Zero parse failures at every size, including 8,144 files of vscode. **Extraction is not
the bottleneck and this table is the good news** — gaps 13 and 14 held, and the thing
that could not survive contact with a foreign repo four days ago now survives contact
with one twenty-six times larger than the last one measured.

Two numbers in it are problems, and they are the last two columns. See section D.

---

## A. The property that scales: answers stay small

The failure mode this benchmark was most worried about is the one where a bigger graph
means bigger answers — a reachability query that returns four thousand nodes is not an
answer, it is a second problem.

Undirected structure suggests exactly that. On vscode the graph has 250,948 connected
components and **the largest holds 215,595 nodes — 40% of the graph in one blob.**

It does not happen. Sampling ~300 nodes with outgoing edges per repo and measuring
directed forward reachability:

| | p50 | p75 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| hono | 2 | 4 | 10 | 28 | 74 |
| excalidraw | 2 | 5 | 16 | 146 | 146 |
| vscode | 2 | 3 | 10 | 70 | **212** |

**Reachability on vscode is indistinguishable from reachability on hono.** The giant
component is a weakly-connected artifact; flow direction cuts it into small pieces. A
trace returns tens of nodes, not thousands, at 8,144 files as much as at 309.

This is the single most important result in this file. Bounded output is what makes a
tool usable by an agent at all, it is not a property the engine was designed for, and
it is now measured rather than hoped for.

Cross-file edges hold their share too — 33.2% on hono, 25.4% on excalidraw, 29.3% on
vscode — so the graph is not degenerating into per-file islands as it grows. 41.7% of
vscode's nodes are isolated (no edges at all), against 40% on hono; that ratio is flat.

---

## B. The property that does not scale: cross-file linking

Every import specifier was instrumented at `analyse.ts:244`, with type-only imports
excluded (`import type` is deliberately outside the graph, and counting it would
understate the rate).

| | value import specifiers | linked | resolved to a file, no declaration found | no file resolved |
| --- | --- | --- | --- | --- |
| vena | 42 | 21 — 50% | 0 | 21 (all genuinely external) |
| hono | 963 | 769 — **80%** | 139 | 55 |
| excalidraw | 5,892 | 2,611 — **44%** | **2,459** | 822 |

**Cross-file linkage halves between hono and excalidraw**, and the difference is not
size — it is module structure. Two causes, filed as gaps 21 and 22, and both get *more*
common as a repo grows, not less. This inverts the pitch: the graph is weakest exactly
where "I can no longer hold the data flow in my head" is most true.

### The measurement that ranked them

excalidraw resolves cross-package imports through tsconfig `paths` — 1,209 of its
~3,700 in-project import statements are `@excalidraw/*`. `engine.ts:284` only
absolutizes a source that starts with `"."`, so every one of those is classified as a
third-party package and skipped.

Worse, it is skipped **silently**: `analyse.ts:235` guards the `unlinkedImports`
counter on `isAbsolute(binding.source)`, and an unrewritten alias is not absolute. The
run reports 234 unlinked while roughly 1,200 are missing. *The one metric whose job is
to make missing edges visible is blind to the largest source of them.*

So: hardcode the alias map, rebuild, and see what comes back. **+579 edges. 2.5%.**

That non-result is the finding. `@excalidraw/element` resolves to
`packages/element/src/index.ts`, which contains `export * from "./cropElement"`, and
`analyse.ts:244` looks for a *declaration* named `cropElement` in that file, finds a
re-export it has no model for, and gives up. The alias was only the first of two walls.
2,459 of 5,892 specifiers — 42% — land on a real, analysed file and find nothing in it.

Gap 21 (re-exports) is therefore the larger of the two and **neither is worth shipping
without the other**: on a monorepo, fixing aliases alone buys 2.5%, and fixing
re-exports alone leaves the barrel unreachable.

---

## C. Three gaps, resized

### Gap 19 is bigger than #1 estimated, and self-analysis structurally cannot see it

Benchmark #1 bounded gap 19 at "at most 148 of 719, loose upper bound." Measured
directly — module-level `const f = () => {}` whose name is called earlier in the same
file:

| repo | arrow call sites | called before declared | share | files affected |
| --- | --- | --- | --- | --- |
| hono | 381 | 99 | **26%** | 35 |
| excalidraw | 717 | 115 | **16%** | 31 |
| vena `src/` | 3 | 0 | **0%** | 0 |

*(Regex-based, so approximate in both directions; the ranking is what it is for.)*

**The zero is the important row.** This repo declares before use everywhere, uses three
arrow-function call sites in total, and therefore had a 0% chance of surfacing gap 19
from the inside — the same lesson as gaps 13/14 in case study #1, arriving a third time.

Live example: `avoidRectangularCorner` is called at `binding.ts:1500` and declared at
`binding.ts:1616`. `vena-trace element/src/binding.ts:1618 --back` returns the header
line and nothing else. `grep` finds the call site in 0.03 s.

### Gap 20 is not "one question in twenty" on class-heavy code

| repo | `this.x =` assignments | class declarations |
| --- | --- | --- |
| hono | 59 | 54 |
| excalidraw | 249 | 77 |
| vscode | **25,445** | **10,764** |

Every one of those 25,445 is a missing edge. Tracing `path` in `vs/base/common/uri.ts`
returns four within-file edges and stops, because the value goes into `this.path` and
the graph has no node for it. On a DI/class-structured codebase gap 20 is not a ranked
item below gaps 18 and 19 — it is the difference between a graph and no graph.

### Delivery, not analysis, is what breaks first

`query.ts` re-reads and re-parses the whole graph per invocation. On vscode that is
**2.7 s and 4.1 GB RSS for one trace.** Ten traces in an agent loop is 27 s and ~40 GB
of allocation churn, to answer questions whose *outputs* (section A) are a few hundred
bytes.

The graph itself is 1.21 GB of JSON for 8,144 files — ~150 KB per file, against ~4 KB
per file of actual source. The compaction already in `flow.ts` (no indenting,
`MAX_SNIPPET`) is doing real work and is nowhere near enough at this size.

---

## D. Head-to-head against grep

Both tools, same question, same repo, output measured.

**Q1. Who passes what into `elementCenterPoint` (excalidraw, `bounds.ts:1555`)?**

`vena-trace … --back --depth 1` returned **23 of 25 call sites in 0.2 s**, and for each
one named the *bound variable and its declaration site* — `hitElement` declared at
`bucketFill.ts:1890`, `bindTarget` at `binding.ts:1618`, and so on. `grep -rn
"elementCenterPoint("` returned 26 lines of call text that do not say what `element` is
at `collision.ts:627`; recovering that means opening ten files.

**vena wins, and this is the shape of question it should be sold on.** The two misses
are `bounds.ts`'s own internal calls — gap 19 again. Zero wrong edges.

**Q2. Where does `naturalWidth` into `cropElement` come from?**

vena: nothing. grep: `App.tsx:13392`, `image.naturalWidth`, in 0.03 s. **grep wins** —
the caller is across a package boundary, so gaps 21/22.

**Q3. What does `pointerX` (`cropElement.ts:39`) reach?**

vena: 1 edge, 159 bytes. grep: 5 lines, 205 bytes, covering the whole function
including the `pointRotateRads` round-trip at lines 64/69 that vena missed. **grep wins,
and would have on most within-file questions** — an agent can simply read the function,
which is cheaper *and* complete.

Q3 is the uncomfortable one and it should stay in this file. The engine's within-file
edges are its most reliable, and they are also the ones an agent needs least. **The
25–33% of edges that cross a file boundary are the entire value proposition** — which
is what makes section B the priority it is.

---

## Scorecard

| | verdict |
| --- | --- |
| Runs on a large repo at all | ✅ 8,144 files, 0 parse failures |
| Answer size stays bounded | ✅ p90 = 10 nodes at every scale |
| Cross-file linkage holds up | ❌ 80% → 44% on a modular repo |
| Beats grep on cross-file provenance | ✅ Q1 |
| Beats grep within a file | ❌ Q3 |
| Still no wrong edges | ✅ every miss found here was a missing edge |

The zero from Benchmark #1 held. Nothing in four repos produced an edge that isn't
real; every failure above is silence.

---

## What this changes about priorities

Benchmark #1 ended by saying coverage was never the binding constraint and the query
surface was. That was right for one repo of 309 files. At 8,144 it is **linking** —
and then delivery.

1. **Gap 21 — re-export chains.** 2,459 specifiers on one repo, the largest single
   measured hole in the project, and a recursive lookup at `analyse.ts:244`.
2. **Gap 22 — tsconfig `paths`.** Small and mechanical. Ship with 21; alone it is 2.5%.
3. **Gap 19 — hoisting pre-pass for module-level declarations.** 16–26%, and
   re-measure Q5/Q7/Q14/Q18 in Benchmark #1 after, which predicted four moves.
4. **Then the MCP server, over an index rather than the JSON.** Section D says the
   agent-facing surface is one question — *who feeds this parameter, and where did that
   value come from* — and section C says a 1.21 GB reload per call cannot serve it.
   Keep Read for within-file questions; Q3 says that is the right division of labour.
5. **Gap 20 — decide it, in or out.** vscode says it is the whole graph on class-heavy
   code. It is also still the design question #1 said it was.

Re-run this file after 21 and 22. The prediction on record: excalidraw's linkage moves
from 44% toward hono's 80%, and Q2 goes from a grep win to a vena win.

## Method notes / caveats

- `analyse()` was called directly rather than through `flow.ts`, so no viewer or server
  is in the timings. Alias resolution in section B is a hardcoded map in a scratch copy
  of `engine.ts`, not a real tsconfig reader.
- The forward-reference and `this.x =` counts are regex-derived and approximate. They
  are used to rank causes, not to claim precision.
- Reachability sampled ~300 nodes with outgoing edges per repo, evenly strided over
  node order — not uniformly random, so treat the tails as indicative.
- Timings are single-run on one machine (M-series, bun 1.3.14). vscode was built under
  `bun --smol`; peak RSS without it will be higher.
- Four repos is still small, and three of them are TypeScript application code. Nothing
  here exercises decorators, namespaces, or CommonJS-heavy source.
