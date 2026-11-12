#!/usr/bin/env bun
/**
 * Benchmark #5: pool every arm's answers, then score them once adjudicated.
 *
 * Ground truth is pooled, as in TREC: the union of every destination any arm
 * listed, each checked against the source by hand. A destination no arm found
 * is missing from the truth for everyone — so recall here is *relative*: it
 * says how much of the known flow each arm found, and overstates all of them
 * equally.
 *
 *   bun score.ts pool <seeds.json> <vena-answers.json> <answers-dir> <adjudication.json>
 *       Merge arm B (vena) with every `<seed>-<arm>.txt` agent reply in
 *       answers-dir. Writes candidates with `verdict: null`; verdicts already
 *       in adjudication.json are kept, so pooling again after a rerun is safe.
 *
 *   bun score.ts report <adjudication.json>
 *       Recall and precision per arm, per seed and in total.
 *
 * Verdicts: "true" — a real destination within 3 hops; "false" — not a
 * destination at all; "out-of-scope" — real, but beyond 3 hops or in a test
 * file (neither rewarded nor penalised). `sameAs` points a candidate at
 * another one's `cid` when two arms cited the same destination differently.
 *
 * A value used only as a condition (`x ? a : b`, `if (x)`, `x === y`) does not
 * land in what the expression produces, so those destinations are "false" —
 * the question asks where the value *lands*, not what it influences.
 *
 * Every true destination also gets a `mechanism`: "plain" when every hop on
 * its path is ordinary TypeScript (assignment, call, return, `this` field),
 * otherwise the first hop on the path that isn't — "jsx" (a prop or
 * children), "callback" (a parameter of a callback given to a built-in such as
 * `.map`), "object-field" (`o.x =`, `ref.current.x`, React state), or "other".
 * The report gives recall per mechanism, separating "is vena complete on the
 * flow it models" from "how much flow is of a kind it doesn't model".
 */
import { readdir } from "fs/promises";

type Verdict = "true" | "false" | "out-of-scope" | null;
type Candidate = {
    cid: string; file: string; line: number; name: string; kind: string;
    foundBy: string[]; verdict: Verdict; sameAs: string | null; note: string;
    mechanism?: Mechanism | null;
};
type Mechanism = "plain" | "jsx" | "callback" | "object-field" | "other";
type Adjudication = Record<string, { name: string; candidates: Candidate[] }>;

/** The lines of an agent reply's FINAL ANSWER block. */
export function parseFinalAnswer(text: string): { file: string; line: number; name: string; kind: string }[] {
    const at = text.lastIndexOf("FINAL ANSWER");
    if (at < 0) return [];
    const out = [];
    for (const raw of text.slice(at + "FINAL ANSWER".length).split("\n")) {
        const m = raw.trim().replace(/^[-*]\s*/, "").match(/^`?([^\s:`]+):(\d+)`?\s+`?([^\s`]+)`?\s*`?(\w+)?`?/);
        if (m) out.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), name: m[3]!, kind: (m[4] ?? "").toLowerCase() });
    }
    return out;
}

/** Same destination: same file and name, declared within 3 lines (a
 *  multi-line declaration is cited at either end). */
const same = (a: { file: string; line: number; name: string }, b: { file: string; line: number; name: string }) =>
    a.file === b.file && a.name === b.name && Math.abs(a.line - b.line) <= 3;

async function pool(seedsPath: string, venaPath: string, answersDir: string, adjPath: string) {
    const { seeds } = await Bun.file(seedsPath).json();
    const vena = (await Bun.file(venaPath).json()).answers;
    const existing: Adjudication = (await Bun.file(adjPath).exists()) ? await Bun.file(adjPath).json() : {};
    const replies = (await readdir(answersDir).catch(() => [] as string[])).filter((f) => /^S\d+-[A-Z]\.txt$/.test(f));
    const adj: Adjudication = {};

    for (const seed of seeds) {
        const candidates: Candidate[] = existing[seed.id]?.candidates.map((c) => ({ ...c, foundBy: [] })) ?? [];
        const add = (arm: string, d: { file: string; line: number; name: string; kind: string }) => {
            let c = candidates.find((x) => same(x, d));
            if (!c) {
                c = { cid: `${seed.id}.${candidates.length + 1}`, file: d.file, line: d.line, name: d.name, kind: d.kind, foundBy: [], verdict: null, sameAs: null, note: "" };
                candidates.push(c);
            }
            if (!c.foundBy.includes(arm)) c.foundBy.push(arm);
        };
        for (const d of vena[seed.id]?.destinations ?? []) {
            add("B", d);
            if (d.proven) add("B-strict", d);
        }
        for (const f of replies.filter((f) => f.startsWith(`${seed.id}-`))) {
            const arm = f.slice(seed.id.length + 1, -4);
            for (const d of parseFinalAnswer(await Bun.file(`${answersDir}/${f}`).text())) add(arm, d);
        }
        adj[seed.id] = { name: seed.name, candidates };
    }
    await Bun.write(adjPath, JSON.stringify(adj, null, 2));
    const all = Object.values(adj).flatMap((s) => s.candidates);
    console.log(`${all.length} candidates, ${all.filter((c) => c.verdict === null).length} awaiting a verdict; wrote ${adjPath}`);
}

async function report(adjPath: string) {
    const adj: Adjudication = await Bun.file(adjPath).json();
    const arms = [...new Set(Object.values(adj).flatMap((s) => s.candidates.flatMap((c) => c.foundBy)))].sort();
    const pending = Object.values(adj).flatMap((s) => s.candidates).filter((c) => c.verdict === null && !c.sameAs);
    if (pending.length) console.log(`⚠ ${pending.length} candidates have no verdict yet; they are left out below.\n`);

    const totals = new Map(arms.map((a) => [a, { tp: 0, fp: 0, truth: 0 }]));
    const rows: string[] = [];
    for (const [id, { name, candidates }] of Object.entries(adj)) {
        const byCid = new Map(candidates.map((c) => [c.cid, c]));
        const canonical = (c: Candidate): Candidate => (c.sameAs && byCid.get(c.sameAs)) ? canonical(byCid.get(c.sameAs)!) : c;
        const truth = new Set(candidates.filter((c) => canonical(c).verdict === "true").map((c) => canonical(c).cid));
        const cells: string[] = [];
        for (const arm of arms) {
            const found = candidates.filter((c) => c.foundBy.includes(arm));
            const tp = new Set(found.filter((c) => canonical(c).verdict === "true").map((c) => canonical(c).cid)).size;
            const fp = found.filter((c) => canonical(c).verdict === "false").length;
            const t = totals.get(arm)!;
            t.tp += tp; t.fp += fp; t.truth += truth.size;
            cells.push(`${tp}/${truth.size}${fp ? ` (${fp} false)` : ""}`);
        }
        rows.push(`| ${id} ${name} | ${truth.size} | ${cells.join(" | ")} |`);
    }
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
    console.log(`| seed | true destinations | ${arms.join(" | ")} |`);
    console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
    for (const r of rows) console.log(r);
    console.log(`| **recall** | | ${arms.map((a) => `**${pct(totals.get(a)!.tp, totals.get(a)!.truth)}**`).join(" | ")} |`);
    console.log(`| **precision** | | ${arms.map((a) => { const t = totals.get(a)!; return pct(t.tp, t.tp + t.fp); }).join(" | ")} |`);

    // Recall by mechanism, over every seed's true destinations.
    const all = Object.values(adj).flatMap((s) => {
        const byCid = new Map(s.candidates.map((c) => [c.cid, c]));
        const canonical = (c: Candidate): Candidate => (c.sameAs && byCid.get(c.sameAs)) ? canonical(byCid.get(c.sameAs)!) : c;
        return s.candidates.map((c) => ({ c, canon: canonical(c) }));
    });
    const truths = new Map<string, Candidate>();
    for (const { canon } of all) if (canon.verdict === "true") truths.set(canon.cid, canon);
    const untagged = [...truths.values()].filter((t) => !t.mechanism).length;
    if (untagged) console.log(`\n⚠ ${untagged} true destinations have no mechanism yet.`);
    const mechs = [...new Set([...truths.values()].map((t) => t.mechanism ?? "untagged"))].sort();
    console.log(`\n| mechanism | true destinations | ${arms.join(" | ")} |`);
    console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
    for (const m of mechs) {
        const ids = new Set([...truths.values()].filter((t) => (t.mechanism ?? "untagged") === m).map((t) => t.cid));
        const cells = arms.map((arm) => {
            const found = new Set(all.filter(({ c, canon }) => c.foundBy.includes(arm) && ids.has(canon.cid)).map(({ canon }) => canon.cid)).size;
            return `${found}/${ids.size} (${pct(found, ids.size)})`;
        });
        console.log(`| ${m} | ${ids.size} | ${cells.join(" | ")} |`);
    }
}

const [cmd, ...args] = Bun.argv.slice(2);
if (cmd === "pool" && args.length === 4) await pool(args[0]!, args[1]!, args[2]!, args[3]!);
else if (cmd === "report" && args.length === 1) await report(args[0]!);
else {
    console.error("usage: bun score.ts pool <seeds.json> <vena-answers.json> <answers-dir> <adjudication.json>\n       bun score.ts report <adjudication.json>");
    process.exit(1);
}
