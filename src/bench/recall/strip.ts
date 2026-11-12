#!/usr/bin/env bun
/**
 * Benchmark #5b: strip local names, to test whether an agent's recall depends
 * on them.
 *
 * Every local variable and parameter in non-test code is renamed to a
 * meaningless one (`v1`, `v2`, …; `V1` when the original was capitalised, so
 * a local component stays a component in JSX). Resolution is TypeScript's own
 * checker, so a declaration and every use of it change together.
 *
 * Left alone, because they cross files or carry structure rather than a local
 * label: exported and module-level names, function, class and method names,
 * object properties, types, parameter properties, and comments.
 *
 * Lines never move, so a `file:line` in the original still points at the same
 * code. `const { x } = o` becomes `const { x: v3 } = o` and the shorthand
 * `{ x }` becomes `{ x: v3 }`, both on the same line.
 *
 * Writes the stripped copy to <out-dir> and `names.json`, mapping each file's
 * new names back to the originals, for scoring.
 *
 * Usage: bun strip.ts <repo-dir> <out-dir>
 */
import ts from "typescript";
import { cp } from "fs/promises";
import { relative } from "path";
import { isTestFile } from "./select-shared";

const [repo, out] = Bun.argv.slice(2);
if (!repo || !out) { console.error("usage: bun strip.ts <repo-dir> <out-dir>"); process.exit(1); }

await cp(repo, out, { recursive: true, filter: (p) => !p.includes("/node_modules") && !p.includes("/.git/") });

const files: string[] = [];
for await (const abs of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: out, absolute: true })) {
    const rel = relative(out, abs);
    if (!rel.includes("node_modules") && !isTestFile(rel)) files.push(abs);
}

// noResolve/noLib: only local symbols matter, and those come from each file's
// own binder, so nothing outside the file has to be loaded.
const program = ts.createProgram(files, {
    noResolve: true, noLib: true, allowJs: false, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext, skipLibCheck: true,
});
const checker = program.getTypeChecker();

/** A local the strip renames: a parameter, or a variable inside a function. */
function isLocal(symbol: ts.Symbol, sf: ts.SourceFile): boolean {
    if (symbol.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Class |
        ts.SymbolFlags.Function | ts.SymbolFlags.Alias | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface |
        ts.SymbolFlags.Enum)) return false;
    const decls = symbol.declarations ?? [];
    if (decls.length === 0) return false;
    return decls.every((d) => {
        if (d.getSourceFile() !== sf) return false;
        if (ts.isParameter(d)) return !ts.getModifiers(d)?.length && ts.isIdentifier(d.name);
        if (ts.isVariableDeclaration(d) || ts.isBindingElement(d)) {
            return ts.findAncestor(d, ts.isFunctionLike) !== undefined;
        }
        return false;
    });
}

const names: Record<string, Record<string, string>> = {};
let renamedTotal = 0;

for (const abs of files) {
    const sf = program.getSourceFile(abs);
    if (!sf) continue;
    const rel = relative(out, abs);
    const text = sf.getFullText();
    const taken = new Set<string>();
    sf.forEachChild(function collect(n): void { if (ts.isIdentifier(n)) taken.add(n.text); n.forEachChild(collect); });

    const renamed = new Map<ts.Symbol, string>();
    let counter = 0;
    const fresh = (old: string) => {
        let name: string;
        do { name = `${/^[A-Z]/.test(old) ? "V" : "v"}${++counter}`; } while (taken.has(name));
        return name;
    };
    const newNameOf = (symbol: ts.Symbol | undefined): string | undefined => {
        if (!symbol || !isLocal(symbol, sf)) return undefined;
        let name = renamed.get(symbol);
        if (!name) { name = fresh(symbol.name); renamed.set(symbol, name); }
        return name;
    };

    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
        // { x } in an object literal: the property keeps its name, the value is renamed.
        if (ts.isShorthandPropertyAssignment(node)) {
            const name = newNameOf(checker.getShorthandAssignmentValueSymbol(node));
            if (name) edits.push({ start: node.name.getStart(), end: node.name.getEnd(), text: `${node.name.text}: ${name}` });
            node.objectAssignmentInitializer && visit(node.objectAssignmentInitializer);
            return;
        }
        // const { x } = o: the key stays, the binding is renamed.
        if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && !node.propertyName &&
            ts.isObjectBindingPattern(node.parent)) {
            const name = newNameOf(checker.getSymbolAtLocation(node.name));
            if (name) edits.push({ start: node.name.getStart(), end: node.name.getEnd(), text: `${node.name.text}: ${name}` });
            node.initializer && visit(node.initializer);
            return;
        }
        if (ts.isIdentifier(node)) {
            // A property name in `o.x`, `{ x: 1 }` or a JSX attribute is a key, not the local.
            const p = node.parent;
            const isKey = (ts.isPropertyAccessExpression(p) && p.name === node) ||
                (ts.isPropertyAssignment(p) && p.name === node) || (ts.isJsxAttribute(p) && p.name === node) ||
                (ts.isBindingElement(p) && p.propertyName === node) || ts.isQualifiedName(p);
            if (!isKey) {
                const name = newNameOf(checker.getSymbolAtLocation(node));
                if (name) edits.push({ start: node.getStart(), end: node.getEnd(), text: name });
            }
            return;
        }
        node.forEachChild(visit);
    };
    visit(sf);
    if (edits.length === 0) continue;

    edits.sort((a, b) => b.start - a.start);
    let result = text;
    for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
    await Bun.write(abs, result);
    names[rel] = Object.fromEntries([...renamed].map(([symbol, name]) => [name, symbol.name]));
    renamedTotal += renamed.size;
}

await Bun.write(`${out}/../names.json`, JSON.stringify(names, null, 1));
console.log(`stripped ${renamedTotal} locals across ${Object.keys(names).length} of ${files.length} files`);
