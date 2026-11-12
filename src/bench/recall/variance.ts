#!/usr/bin/env bun
/**
 * Benchmark #5c: how much do repeated agent runs of the same question agree?
 *
 * Reads a pooled, adjudicated file in which several runs of one arm appear as
 * separate arms (A, R2, R3, …). Duplicates are merged through `sameAs`, so two
 * runs citing one destination differently count as agreeing.
 *
 * Per seed and in total:
 *   agreement — of the destinations any run listed, the share every run listed
 *               (all candidates, adjudicated or not: it needs no ground truth)
 *   recall    — each run against the true destinations in the pool
 *   spread    — the gap between the best and worst run's recall
 *
 * Usage: bun variance.ts <adjudication.json> <arm> [<arm> …]
 */
const [adjPath, ...runs] = Bun.argv.slice(2);
if (!adjPath || runs.length < 2) { console.error("usage: bun variance.ts <adjudication.json> <arm> <arm> [...]"); process.exit(1); }
const adj = await Bun.file(adjPath).json();

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
let anyTotal = 0, allTotal = 0, truthTotal = 0;
const tpTotal = new Map(runs.map((r) => [r, 0]));

console.log(`| seed | listed by any run | by every run | agreement | ${runs.map((r) => `recall ${r}`).join(" | ")} | spread |`);
console.log(`| --- | --- | --- | --- | ${runs.map(() => "---").join(" | ")} | --- |`);
for (const [id, { name, candidates }] of Object.entries<any>(adj)) {
    const byCid = new Map(candidates.map((c: any) => [c.cid, c]));
    const canon = (c: any): any => (c.sameAs && byCid.get(c.sameAs)) ? canon(byCid.get(c.sameAs)) : c;
    // Which canonical destinations each run listed (false ones included: agreement is about the lists).
    const listed = new Map(runs.map((r) => [r, new Set(candidates.filter((c: any) => c.foundBy.includes(r)).map((c: any) => canon(c).cid))]));
    const any = new Set([...listed.values()].flatMap((s) => [...s]));
    const all = [...any].filter((cid) => runs.every((r) => listed.get(r)!.has(cid)));
    const truth = new Set(candidates.filter((c: any) => canon(c).verdict === "true").map((c: any) => canon(c).cid));
    const recalls = runs.map((r) => [...listed.get(r)!].filter((cid) => truth.has(cid)).length);
    anyTotal += any.size; allTotal += all.length; truthTotal += truth.size;
    runs.forEach((r, i) => tpTotal.set(r, tpTotal.get(r)! + recalls[i]!));
    const rs = recalls.map((n) => (truth.size ? n / truth.size : 1));
    const spread = truth.size ? `${Math.round(100 * (Math.max(...rs) - Math.min(...rs)))} pts` : "—";
    console.log(`| ${id} ${name} | ${any.size} | ${all.length} | ${pct(all.length, any.size)} | ${recalls.map((n) => `${n}/${truth.size}`).join(" | ")} | ${spread} |`);
}
console.log(`| **total** | ${anyTotal} | ${allTotal} | **${pct(allTotal, anyTotal)}** | ${runs.map((r) => `**${pct(tpTotal.get(r)!, truthTotal)}**`).join(" | ")} | |`);
