#!/usr/bin/env bun
/**
 * Benchmark #5, step 1: choose the values to trace — without consulting vena.
 *
 * Choosing by "vena reaches a lot from here" would pick exactly the flows vena
 * models and tilt recall its way. So the fan-out proxy is syntactic: how many
 * places in the code *use* the value, counted from the AST alone.
 *
 *   V seeds — an exported module-level `const` that isn't a function. The
 *             question: where does this value end up?
 *   R seeds — an exported function whose result is used, not discarded. The
 *             question: where do the values it returns end up?
 *
 * A use counts only in a file that declares the name or imports it under that
 * name, so same-named locals elsewhere don't inflate it. Kept: 4–12 uses across
 * at least 3 non-test files — enough to fan out, few enough to adjudicate by
 * hand. Then 5 of each are sampled with a fixed seed.
 *
 * Usage: bun select.ts <repo-dir> [out.json]
 */
import { parse, type TSESTree } from "@typescript-eslint/typescript-estree";
import { relative } from "path";
import { isTestFile } from "./select-shared";

const SEED = 20261112;
const PER_KIND = 5;
const MIN_USES = 4, MAX_USES = 12, MIN_FILES = 3;


const [repo, out = "seeds.json"] = Bun.argv.slice(2);
if (!repo) { console.error("usage: bun select.ts <repo-dir> [out.json]"); process.exit(1); }

type Decl = { name: string; file: string; line: number; kind: "V" | "R" };
const decls: Decl[] = [];
/** Per file: the names it imports (by imported name) and every use site. */
const files = new Map<string, { imports: Set<string>; uses: { name: string; line: number; resultUsed: boolean; isCall: boolean }[] }>();

const isFunctionInit = (n: TSESTree.Node | null | undefined) =>
    n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";

for await (const abs of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: repo, absolute: true })) {
    const file = relative(repo, abs);
    if (file.includes("node_modules") || isTestFile(file)) continue;
    let ast: TSESTree.Program;
    try { ast = parse(await Bun.file(abs).text(), { jsx: file.endsWith("x"), loc: true, range: true }); } catch { continue; }

    const info = { imports: new Set<string>(), uses: [] as { name: string; line: number; resultUsed: boolean; isCall: boolean }[] };
    files.set(file, info);

    for (const stmt of ast.body) {
        if (stmt.type === "ImportDeclaration") {
            for (const s of stmt.specifiers) {
                if (s.type === "ImportSpecifier" && s.imported.type === "Identifier") info.imports.add(s.imported.name);
            }
        }
        if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
        const d = stmt.declaration;
        if (d.type === "FunctionDeclaration" && d.id) {
            decls.push({ name: d.id.name, file, line: d.loc.start.line, kind: "R" });
        } else if (d.type === "VariableDeclaration" && d.kind === "const") {
            for (const v of d.declarations) {
                if (v.id.type !== "Identifier") continue;
                decls.push({ name: v.id.name, file, line: v.loc.start.line, kind: isFunctionInit(v.init) ? "R" : "V" });
            }
        }
    }

    // Every identifier read, with whether it's a call whose result is used.
    const visit = (node: any, parent: any, key: string) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const x of node) visit(x, parent, key); return; }
        if (node.type === "Identifier" && parent) {
            const declaring = (parent.type === "VariableDeclarator" && key === "id") ||
                (parent.type === "FunctionDeclaration" && key === "id") ||
                parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier" ||
                (parent.type === "MemberExpression" && key === "property" && !parent.computed) ||
                (parent.type === "Property" && key === "key" && !parent.computed);
            if (!declaring) {
                const isCall = parent.type === "CallExpression" && key === "callee";
                info.uses.push({ name: node.name, line: node.loc.start.line, isCall, resultUsed: isCall && node.__resultUsed === true });
            }
        }
        if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
            node.callee.__resultUsed = parent?.type !== "ExpressionStatement";
        }
        for (const [k, v] of Object.entries(node)) if (k !== "loc" && k !== "range" && !k.startsWith("__")) visit(v, node, k);
    };
    visit(ast, null, "");
}

type Candidate = Decl & { uses: number; files: number };
const candidates: Candidate[] = [];
for (const d of decls) {
    let uses = 0;
    const usedIn = new Set<string>();
    for (const [file, info] of files) {
        if (file !== d.file && !info.imports.has(d.name)) continue;
        for (const u of info.uses) {
            if (u.name !== d.name) continue;
            if (d.kind === "R" ? !u.resultUsed : u.isCall) continue;
            uses++;
            usedIn.add(file);
        }
    }
    if (uses >= MIN_USES && uses <= MAX_USES && usedIn.size >= MIN_FILES) candidates.push({ ...d, uses, files: usedIn.size });
}

// Fixed-seed sample (Park–Miller), stable across runs and machines.
let state = SEED;
const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
const sample = (kind: "V" | "R") => {
    const pool = candidates.filter((c) => c.kind === kind).sort((a, b) => `${a.file}:${a.name}`.localeCompare(`${b.file}:${b.name}`));
    const picked: Candidate[] = [];
    while (picked.length < PER_KIND && pool.length > 0) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
    return { pool: pool.length + picked.length, picked };
};
const v = sample("V"), r = sample("R");
const seeds = [...v.picked, ...r.picked].map((s, i) => ({ id: `S${i + 1}`, ...s }));
await Bun.write(out, JSON.stringify({ repo, seed: SEED, pools: { V: v.pool, R: r.pool }, seeds }, null, 2));
console.log(`pools: ${v.pool} constants, ${r.pool} functions; wrote ${seeds.length} seeds to ${out}`);
for (const s of seeds) console.log(`  ${s.id} [${s.kind}] ${s.name}  ${s.file}:${s.line}  (${s.uses} uses, ${s.files} files)`);
