#!/usr/bin/env bun
/**
 * Benchmark #5b: put the original names back into answers given on the
 * stripped copy, so they score against #5's adjudicated pool.
 *
 * Lines didn't move, so only the name changes: `v94` in a file becomes
 * whatever names.json says `v94` stood for there. Names the strip never
 * touched (exports, properties, function names) pass through unchanged.
 *
 * Usage: bun unstrip.ts <names.json> <in-dir> <out-dir> <arm>
 *   Reads <seed>-A.txt from in-dir, writes <seed>-<arm>.txt to out-dir.
 */
import { readdir, mkdir } from "fs/promises";

const [namesPath, inDir, outDir, arm] = Bun.argv.slice(2);
if (!namesPath || !inDir || !outDir || !arm) { console.error("usage: bun unstrip.ts <names.json> <in-dir> <out-dir> <arm>"); process.exit(1); }
const names: Record<string, Record<string, string>> = await Bun.file(namesPath).json();
await mkdir(outDir, { recursive: true });

let restored = 0, total = 0;
for (const f of (await readdir(inDir)).filter((f) => /^S\d+-A\.txt$/.test(f))) {
    const text = await Bun.file(`${inDir}/${f}`).text();
    const at = text.lastIndexOf("FINAL ANSWER");
    const head = at < 0 ? text : text.slice(0, at);
    const tail = at < 0 ? "" : text.slice(at).replace(/^(\s*[-*]?\s*`?)([^\s:`]+):(\d+)(`?\s+`?)([^\s`]+)/gm, (m, pre, file, line, mid, name) => {
        total++;
        const original = names[file.replace(/^\.\//, "")]?.[name];
        if (!original) return m;
        restored++;
        return `${pre}${file}:${line}${mid}${original}`;
    });
    await Bun.write(`${outDir}/${f.replace("-A.txt", `-${arm}.txt`)}`, head + tail);
}
console.log(`${total} answer lines, ${restored} names restored`);
