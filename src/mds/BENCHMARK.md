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

### Re-measured after gaps 21 + 22 — November 3 2026

Fresh excalidraw clone (`dd2f8fc`). The "before" column is today's engine with only those two fixes switched off — no `paths`, one-hop export lookup — so nothing else that changed since August is in the comparison.

| analysed directory | | linked / value specifiers | linked / in-project | edges | cross-file edges |
| --- | --- | --- | --- | --- | --- |
| repo root | before | 2,912 / 7,379 — **39.5%** | 79.6%* | 30,068 | 7,647 — 25.4% |
| repo root | after | 6,165 / 7,379 — **83.5%** | **93.8%** | 39,356 (+31%) | 16,890 — **42.9%** |
| `packages/` | before | 2,778 / 6,869 — 40.4% | 79.4%* | 29,081 | 7,530 |
| `packages/` | after | 3,072 / 6,869 — **44.7%** | 87.8% | 29,403 | 7,852 |

\*Inflated: with aliases off, the `@excalidraw/*` imports count as external rather than in-project.

**From the root, linkage more than doubled and cross-file edges more than doubled** — hono-level linkage on a monorepo. **From `packages/`, almost nothing moved**, because excalidraw's `paths` live in the *root* tsconfig and vena only reads one in the directory it analyses. August measured `packages/`, so the like-for-like number is 40% → 45%. The fix only helps when vena runs at the repo root, which is now how `vena` runs by default. Filed as gap 24.

What's left from the root is 236 `noFile` and 173 `noDeclaration` specifiers, not yet read by name.

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

---

# Benchmark #3 — does an agent do better with vena? (November 3 2026)

NOTES.md designed this as "Benchmark #2 — does an agent do *better*", before the scaling run above took that number. It is the claim that matters most: #1 and #2 show the graph *contains* the answers, not that an agent holding it does better than one with `grep` and `Read`.

## Setup

- **Tasks:** the twenty questions of #1, word for word, on a fresh Hono clone. Two short paths were expanded (`timeout/index.ts` → `middleware/timeout/index.ts`, `crypto.ts` → `utils/crypto.ts`) in both arms.
- **Arm A:** a fresh general-purpose agent (Opus 5.5) with Read, Grep and Bash, plus a paragraph on searching well: find every call site, follow imports, read the functions, and the warning that a missing answer and a false one both count against it.
- **Arm B:** the identical prompt plus one paragraph on `vena-trace`, run as a standalone copy of `query.ts` against a prebuilt graph in a separate directory. That way neither arm could reach this file's answer key in the vena repo.
- **Controls:** same model, a fresh context per task, one run per question per arm (40 runs). Every answer ended in the same `FINAL ANSWER` format.
- **Graded** against the ground truth above. **Cost** is the harness's own count of tokens, tool calls and wall time per run.

## Correctness: a wash

| | ✅ | ⚠️ | ❌ | wrong yes/no | false sources spotted |
| --- | --- | --- | --- | --- | --- |
| Arm A (grep + Read) | 18 | 1 | 1 | 0 | 0 |
| Arm B (+ vena-trace) | 19 | 1 | 0 | 0 | 0 |

- **The one difference is Q8, and it is disputed.** The key says `duration` reaches `timer` via `setTimeout(…, duration)`. Arm A answered "no": a timer id doesn't depend on the delay. That is a better reading of the code than the key, which was written to the engine's over-approximation. Arm B gave `timer` and called the hop inferred.
- **Q19 is ⚠️ in both.** Both arms excluded `i`@32 as "only an index", which the key includes. Arm B dropped it *although the tool listed it*.
- **All three negative controls held in both arms.** On Q17 both agents explicitly reasoned that `createHash` returns only to its own caller — the exact mistake gap 23 had to fix in the tool.

Both arms routinely went further than the key, following callers across files. I spot-checked these extra entries rather than verifying every one, and found none false.

## Cost: not lower

| | Arm A | Arm B | B − A |
| --- | --- | --- | --- |
| tokens, mean | 38,405 | 41,048 | **+7%** (B higher in 18 of 20) |
| tokens above the ~35k fixed baseline, mean | 3,289 | 5,932 | **1.8×** |
| tool calls, mean | 4.8 | 4.2 | −13% (B lower in 8, higher in 6, tied in 6) |
| wall time, mean | 27.0 s | 27.4 s | +2% |

On the four multi-hop, cross-file questions (Q1, Q3, Q12, Q13) the picture barely changes: tool calls −23%, time −8%, tokens +12%. The biggest wins were Q9 (13 → 4 calls) and Q13 (8 → 4). In both, Arm A read its way across many files. On Q9 the tool returned *nothing* (gap 20) and Arm B traced the field by hand, but answered less deeply than Arm A.

## Against the prediction

NOTES recorded before running: *"Correctness will be close. The difference will show up in cost."* **The first half held; the second did not.** Arm B made slightly fewer tool calls, but each `vena-trace` call returns a lot of text, and the agents then checked it against the source anyway. Net working tokens went *up* by 80%, and time was flat. NOTES set the bar in advance: *if cost is also a wash, the honest conclusion is that the graph does not earn its place.* On these twenty questions it does not.

## Why — read from the transcripts

1. **The questions are too easy for an agent.** Arm A's median run was 4 tool calls and 21 s. A strong model on a 60-line function needs no graph, which #2's grep head-to-head already showed within a file. These twenty were written to test the engine, not to stress an agent.
2. **Agents verify the tool.** Every Arm B run that used the tool cross-checked it against the source. They caught its real limits:
   - the field-insensitive `root`@35 in Q6
   - the inferred `err`/`context` in Q1
   - `dispatch` "returning" `res` in Q10
   - the `timingSafeEqual` path through a `hashFunction` variable that it missed in Q5
   - the `hono-base.ts:244` call it missed in Q19

   That is the right behaviour, but it means the tool adds reading rather than replacing it.
3. **The output format misleads.** Two agents reported that the tracer's line numbers "don't match the source". They do match. The line printed is the *declaration* of the node, and the quoted code beside it is the *use* on a different line. Both agents read the line as the use's location.
4. **One Arm B agent never ran the tool** (Q18), and still answered correctly.

## Threats to validity

- One run per cell. Twenty pairs is small, and the 1-question correctness gap is noise.
- The same author wrote the questions, the tool and the grading. Q8 shows the key itself can be wrong.
- Arm B's prompt is a paragraph longer and names data flow, which is a hint in itself.
- Hono is small and flat. #2 showed the graph's value is in cross-file linkage on *larger, modular* repos, and nothing here tested that.

## What would actually test the claim

Questions an agent cannot answer cheaply by reading — long cross-file chains through barrels and aliases on excalidraw or vscode, where #2 found grep returning tens of candidates. And a compact output mode, so a trace costs fewer tokens than the reading it replaces.

---

# Benchmark #4 — the same question on a real monorepo (November 3 2026)

#3 concluded its questions were too easy for an agent. This one asks harder ones on excalidraw (`dd2f8fc`, 704 files, tsconfig aliases and barrels — the shape #2 says vena is for).

## Setup

- **Question selection, without consulting vena.** I listed the 519 functions exported from `packages/{element,math,common}`, kept the 84 called 3–8 times from at least two app files, and sampled 8 with a fixed seed (20261103). I then wrote one multi-hop question per sampled function. Each one starts from a call site of that function and asks for a full trace: forward through the action manager, backward through four layers of chart helpers, five Stats call sites behind a callback prop, an eraser set through two returns into an App field. Two are negative controls.
- **Ground truth** was derived by hand from the source and written to an answer key before any run.
- **Same arms, prompts, model and grading as #3.** Arm B's graph was built from the repo root (39,356 edges). 16 runs; the first E5–E8 batch hit a rate limit with no answers and was rerun.

## Correctness: a wash again

| | correct | partial | wrong | 
| --- | --- | --- | --- |
| Arm A (grep + Read) | 7 / 7 | 0 | 0 |
| Arm B (+ vena-trace) | 6 / 7 | 1 (E4) | 0 |

**E2 is excluded: my key was wrong.** I keyed it "no" because the two values pass through separate calls of `syncMovedIndices`. *Both* arms independently answered "yes", through shared state: the duplication writes the elements into `Scene` (`replaceAllElements`, App.duplicate.ts:513), they land in `Scene.elements`, and a later group action reads them back through the ActionManager. I checked every hop in the source; the flow is real. A call/return-only notion of data flow — vena's, and the one I wrote the key in — misses it.

Both arms routinely went *past* the key: through `useApp()` into React context, the `App.renderEnvironment` getter, `AppHost`, and the `<Excalidraw>` props. Those hops are real and none of them is in the graph.

## Cost: identical

| | Arm A | Arm B | B − A |
| --- | --- | --- | --- |
| tokens, mean | 43,515 | 43,522 | **+0%** |
| tool calls, mean | 7.5 | 6.6 | −12% (B lower in 6 of 8) |
| wall time, mean | 43.9 s | 46.1 s | +5% |

The questions *were* harder: tool calls rose from Hono's 4.8 to 7.5, time from 27 s to 44 s. The gap between the arms did not open up.

## Why — what the tool actually returned in arm B

| | vena-trace's contribution |
| --- | --- |
| E1 | nothing: "no downstream hops" (the value goes through `this.app.actionManager.executeAction` and an action's `perform`) |
| E2 | missed the real path (it runs through a `Scene` field) |
| E3 | not used |
| E4 | part of one caller; its `~inferred` hops were rejected by the agent |
| E5 | the first four hops, correct, then stopped at `useApp()` |
| E6 | "nothing matching": the question names a call line, and an address must be a declaration |
| E7 | agreed: no |
| E8 | the declaration only, no forward flow (it goes into `this.elementsToErase`) |

On a real class-and-React codebase **the graph mostly does not contain the paths an agent is asked about.** The flows go through fields (`this.x`), getters, React context, callback props and action registries. That is gap 20 and its relatives, not a delivery problem. Where the graph had the answer (E5's parameter chain), the agent got it faster — then had to read on by hand past the point where the graph stopped.

## What this changes

#3 said "test on hard questions before investing in delivery". This is that test, and it says the order is: **object-field flow (gap 20) first.** Without it, on code shaped like excalidraw's app layer, vena answers a minority of real questions, and a model reading the source answers all of them at the same cost.

Threats: 8 questions, one run each; the same author picked the question template, wrote the key and graded — and the key was wrong once, in vena's favour of a narrower definition of flow.

# Benchmark #5 — recall: does an agent find *every* destination? (November 12 2026)

#3 and #4 scored *correctness* on questions with one or two paths, and an agent matched vena on both. That leaves vena's strongest claim untested: an agent reads until it is satisfied, so it returns *a* path, not *all* of them, and nobody can see what it skipped. This benchmark scores **recall** — of everything a value really reaches, what fraction each arm finds.

## Setup

- **Repo:** excalidraw `701b901` (`master`, November 5 2026), 704 files.
- **Seeds, chosen without consulting vena** (`src/bench/recall/select.ts`). Picking by "vena reaches a lot from here" would pick exactly the flow vena models. So the proxy is syntactic: exported constants (V) and exported functions whose result is used (R), with 4–12 uses across at least 3 non-test files, counted from the AST only in files that declare or import the name. Pools of 81 and 159; 5 of each sampled with seed `20261112`. Three of the five V seeds turned out to be icons passed as JSX props. Dull, but changing the filter after seeing the sample would be cherry-picking, so they stay.
- **The question,** identical for every arm: every destination — variable, parameter, field, or function return — the value reaches **within 3 hops**. One hop is an assignment or initialisation (also as part of an expression), an argument reaching a parameter (a JSX prop counts), a `return`, a call result reaching a variable, or a field write. Test files are out of scope. Cited as `file:line name kind`, at the destination's declaration.
  - **Why bounded:** unbounded, `BAR_GAP` reaches 40 hops of chart-layout arithmetic, which nobody means by "where does this value end up", and a pool of a thousand candidates can't be checked by hand.
- **Arms:**
  - **A — agent alone.** A fresh general-purpose agent with Read, Grep and Bash, as in #3.
  - **B — vena alone.** No agent: every destination of a forward trace from the seed, at depth 3 (`vena-arm.ts`). Also scored as **B-strict**, proven edges only.
  - **C — agent + vena.** A's prompt plus one paragraph on `vena-trace`, run from a standalone copy outside this repo, as in #3.
- **Ground truth is pooled** (`score.ts`): the union of every destination any arm lists, each checked against the source and marked `true`, `false`, or `out-of-scope` (real, but beyond 3 hops or in a test). A destination no arm found is missing for everyone, so recall here is *relative* — it overstates every arm equally, and it can still rank them.

## Already visible, before any agent ran

Arm B's answer for **S9 `isExcalidrawElement`** shows a false-positive pattern. `.filter(isExcalidrawElement)` passes the *function itself* as a callback; gap 18's pass-through treats that as data flowing into `filter`'s result, and unbounded the chain runs 199 hops through `arrayToMap` and beyond — 1,408 destinations, 10 proven. Bounded to 3 hops it is 19, 16 "proven". Adjudication will say how many are real; the pattern itself is the "confident but wrong" output a developer can't tell apart from a real answer.

## Prediction, recorded before running

- **A** recall about 65%: it will get hop 1 right and thin out by hop 3, worst on the R seeds with many call sites (S6, S8).
- **B** recall about 70%, losing JSX props and fields on receivers other than `this` (both unmodelled), and precision about 85%, losing S9's callback chain.
- **C** recall about 80%, the best of the three.
- **What decides the pitch:** if A's recall is within 10 points of B's or C's, completeness is not a reason to use vena. If B or C beats A by 15 points or more, that gap is the number to show.

## How to run

```bash
# 1. The checkout (outside this repo; never run bun from inside it).
git clone --depth 1 https://github.com/excalidraw/excalidraw.git <dir>/excalidraw   # then check out 701b901
# 2. Seeds, arm B, and the standalone vena-trace for arm C.
bun src/bench/recall/select.ts <dir>/excalidraw <out>/seeds.json
bun src/bench/recall/vena-arm.ts <dir>/excalidraw <out>/seeds.json <out>/vena-answers.json
mkdir -p <out>/vena-trace && cp src/scripts/query.ts src/scripts/types.ts <out>/vena-trace/
#    ...and write the graph there: analyse(<dir>/excalidraw) -> <out>/vena-trace/graph.json
bun src/bench/recall/prompts.ts <dir>/excalidraw <out>/seeds.json <out>/prompts <out>/vena-trace
# 3. One fresh agent per prompt (A and C); save each full reply as <out>/answers/<seed>-<arm>.txt.
# 4. Pool, adjudicate every candidate in adjudication.json by reading the source, then report.
bun src/bench/recall/score.ts pool <out>/seeds.json <out>/vena-answers.json <out>/answers <out>/adjudication.json
bun src/bench/recall/score.ts report <out>/adjudication.json
```

## Results (run November 12 2026)

All 20 agent runs completed (Opus 5.5, fresh context each). Pooling gave 215 candidates. Every candidate was checked against the source, and every `false` carries a one-line note (`src/bench/recall/results/2026-11-12/adjudication.json`, with every reply under `answers/`). Result: 161 true destinations, 32 false, 22 out of scope.

| | A — agent | B — vena | B-strict | C — agent + vena |
| --- | --- | --- | --- | --- |
| **recall** | **96%** | **48%** | 47% | **84%** |
| precision | 99% | 68% | 69% | 98% |
| tokens (10 runs) | 518k | — | — | 516k |

By what carried the value (a destination is `plain` only if every hop on its path is ordinary TypeScript):

| mechanism | true | A | B | C |
| --- | --- | --- | --- | --- |
| plain TypeScript | 103 | 98% | **73%** | 99% |
| `.map` / `.forEach` callback | 26 | 100% | 4% | 12% |
| JSX prop or children | 22 | 86% | 5% | 100% |
| React state, `ref.current`, `o.x` | 7 | 100% | 0% | 86% |
| dynamic dispatch, Promise | 3 | 67% | 0% | 67% |

**The prediction failed on every line.** It said A 65%, B 70%, C 80%. The agent alone found 96%, twice vena's recall, at 99% precision. By the decision rule recorded above, **completeness within 3 hops is not a reason to use vena**: the agent beat it by 48 points, not the other way round.

### Why vena lost

- **React, callbacks and object state are 36% of the true flow** (58 of 161) in this React app, and vena found 2 of them. JSX props, `.map` callback parameters and React state are not modelled at all.
- **Even on plain TypeScript it found only 73%.** The misses are three engine bugs, confirmed on minimal repros:
  1. **An expression-bodied arrow returns nothing.** `const f = (x) => x` never carries `x` out. TypeScript is full of these — `cloneLibraryItems`, `getArrowTypeIcon`, `defineTools` all missed this way, and with them everything downstream.
  2. **Object-literal methods are not functions.** `register({ perform() { return v } })` records no return.
  3. **`for (const x of xs)` doesn't connect `xs` to `x`.**
- **A third of what vena listed was false** (31 of 97):
  - **Conditions as data, 24.** A value used only as a test (`c ? a : b`, `if (c)`, `x === y`) is recorded as flowing into the result. The whole of S9 — 19 destinations, 16 marked proven — is this.
  - **Object fields not told apart, 7.** Once `opts.y` carried the value, every `opts.fontFamily`, `opts.text`… read did too.
  - **The rest:** the returns of two handlers that return nothing, and chains reached only through test files.

### Vena made the agent worse

Arm C's recall (84%) is **below** arm A's (96%). On S6 the arm C agent wrote that it left callback parameters out "which matches vena-trace" and dropped 21 real destinations that arm A, with no tool, listed. The tool's output set the agent's idea of what counts. Where vena was silent (JSX), the agent filled the gap itself; where vena drew a line, the agent followed it. A tool that is incomplete but looks authoritative lowers recall instead of raising it. C also cost the same tokens as A (516k vs 518k).

### What still favours vena

- **Cost and repeatability.** The graph builds in 2 s and each query is milliseconds and deterministic. Each agent run took 16–170 s and 40–78k tokens. Run-to-run variation wasn't measured — one run per cell.
- **Nothing here tested deep or wide flow.** At 3 hops an agent reads every file involved. Whether it holds at 10 hops or across 100 call sites is untested — but this benchmark is no evidence that it doesn't.

### Rules settled during adjudication

Each was applied to every seed, and the affected verdicts say so:

- **Condition-only use is false** — the question asks where the value lands, not what it influences (decided with the author before checking).
- **A destination counts if it holds the value or a part of it** (`corners[2]`, `el.type`). A sibling field that never held it (`opts.fontFamily` beside `opts.y`) does not.
- **A built-in that hands back its input's elements is one hop** — `concat`, spread, `.map` returning the element or a copy of it. A value computed from it by another function (rotated, measured, interpolated) is counted hop by hop through that function, which put most of those past hop 3 (`out-of-scope`).
- **JSX returned by a component holds what it contains**, so a value rendered in a component's output lands in that component's return.

## Threats to validity, to state in the writeup

- **Pooled truth** misses whatever no arm found. Recall is relative, not absolute.
- **The adjudicator is a model from the same family as the agents**, and the rules above were settled while reading their answers. A rule that suits how a model reads code would favour A and C. The condition rule was agreed with the author first; the others are recorded so they can be disputed.
- **The adjudicator is the tool's author** (or a model). Every `false` verdict should carry a one-line note, so a reader can check it.
- **One run per cell**, as in #3 and #4.
- **One repo.** excalidraw is the shape vena is for (modular, aliased), but it is one codebase.

# Benchmark #5b — does the agent need the names? (November 12 2026)

#5's agents followed values through `opts`, `curve`, `c` and `v` without trouble, which suggested they read structure, not names. This tests it directly: the same 10 prompts, run by a fresh agent with no tool (arm A's setup), on a copy of excalidraw with every local variable and parameter renamed to `v1`, `v2`, … (`src/bench/recall/strip.ts`).

- **What was stripped:** 22,654 locals across 475 files, through TypeScript's own checker, so each declaration and its uses change together. `const { x } = o` and the shorthand `{ x }` become `{ x: v3 }` on the same line, so every `file:line` still points at the same code. All 475 files still parse and keep their line counts.
- **What was kept:** exported and module-level names, function, class and method names, object properties, types and comments. They cross files, or carry structure rather than a local label — so this strips the labels on *values*, not every hint in the code.
- **Scoring:** answers mapped back to the original names (`unstrip.ts`) and pooled with #5's adjudicated candidates. The 32 new candidates were adjudicated under #5's rules.

## Result

| | agent, real names (#5 arm A) | agent, names stripped |
| --- | --- | --- |
| recall on #5's 161 true destinations | 96% | **94%** |
| precision | 99% | 97% |
| tokens (10 runs) | 518k | 520k |

**Stripping the names barely moved recall.** The agent follows calls, returns and destructuring, not what things are called. Of the four destinations it lost on #5's pool, three are judgement calls the real-names run made differently — React state set through `setAllCommands` and the `.find` callback after it (S5), and stopping at the `withBatchedUpdates` wrapper rather than its parameter (S3) — and one is a plain miss, `cloneLibraryItems`'s parameter on the second pass (S8). None is a lookup that failed for want of a name.

The stripped run also found **26 real destinations that no arm of #5 listed**, 25 of them in S8: it counted `for (const element of elements)` as a hop and followed `element` into every `new*Element({ ...element })` call in `transform.ts`. The real-names agent saw the same loop and explicitly chose not to count it. With those added, the pool has 187 true destinations, and arm A's recall on the larger pool is 83%.

## What it means

- **Names are not where agents are weak.** A scanner that classifies data by name (Bearer: `username`, and `fontFamily` mistaken for a surname) is a different and weaker thing than an agent reading the code. "Data not stored in a descriptive variable" is not a gap agents leave open.
- **What varies is interpretation, not capability.** Two runs of the same question disagreed on whether a loop variable, React state or a property read counts — and that moved 25 destinations on one seed. Run-to-run variation, flagged as unmeasured in #5, is real, and it comes from the definition of "flow", not from search.
- That is the opening a deterministic graph could own: not finding what an agent can't, but **answering the same question the same way every time, under a definition that is written down.** Whether anyone pays for that is a question for users, not for another benchmark.

## Threats to validity

- Comments, function names and property names still carry meaning; a fully obfuscated build was not tested.
- One run per cell. The 96% vs 94% gap is within what one different judgement call moves.
- Adjudicated by the same model family, under rules settled in #5.
