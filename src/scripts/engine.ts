import type { Binding, Kind, Scope, Results, ReExport, Use } from "./types";
import { TSESTree } from "@typescript-eslint/typescript-estree";
import { resolve, dirname, isAbsolute } from "path";
import { BUILTIN_METHODS, KNOWN_GLOBALS } from "./globals";
// loc gives us line numbers, which is off by default in typescript-estree.

// Define the file
let currentFile = "";

/**
 * Turns a module specifier as written into something `resolveImport` can look
 * up: an absolute path when it points inside the project, the raw string when
 * it names a package.
 *
 * The dot test used to be inline and used to be the whole theory of what an
 * in-project import looks like — which is true right up until a project gives
 * itself a specifier vocabulary of its own. `baseUrl` and `paths` in tsconfig
 * do exactly that, and `"@/core/thing"` is then indistinguishable from
 * `"react"` to a resolver that only knows about dots: bare specifier, must be a
 * package, skip. On a monorepo that was a third of all in-project imports (gap
 * 22), and every one of them took a whole subtree of the project out of reach.
 *
 * Kept as a replaceable function rather than a fixed rule because the alias map
 * comes from a file on disk, which is `analyse`'s business, not the walker's.
 */
export type SpecifierResolver = (raw: string, importerFile: string) => string;

/**
 * The resolver used when nobody supplies one: relative specifiers only, which
 * is what the engine has always done. Tests that call `collectVariables`
 * directly get this, and so does any caller that has no tsconfig to offer.
 */
export const relativeSpecifierResolver: SpecifierResolver = (raw, importerFile) =>
    raw.startsWith(".") ? resolve(dirname(importerFile), raw) : raw;

let currentResolveSpecifier: SpecifierResolver = relativeSpecifierResolver;

/**
 * Any identifier reached from here on flows into these, until the setter puts it
 * back. `const a = z` opens [a], so `z` feeds `a`; `console.log(z)` opens nothing,
 * so no edge. Nests — `const a = f(z)` opens [a], then [p] for the argument, so
 * `z` feeds `p` and `f` feeds `a`. Every setter must restore (see gap 5).
 *
 * A list because `const { a, b } = foo()` feeds two. The Identifier branch copies
 * out of it rather than keeping the Binding — why gap 16 patches feeds by value.
 */
let currentFeedTargets : Binding[] = [];

/**
 * Qualifies `currentFeedTargets`: true when we reached them by passing through a
 * call whose callee never resolved, so the flow is assumed rather than proven
 * (gap 18). Travels with the targets — every save/restore of one must save and
 * restore the other, or an edge gets labelled by whatever the last unrelated
 * call happened to leave behind.
 */
let currentFeedsInferred = false;

// Define the function the walker is currently in.
let currentFunction : Binding | null = null;

// Define whether we're in a ReturnStatement or not.
let inReturnStatement = false;

/**
 * A use that did NOT resolve when the walk reached it, held for a
 * second attempt once the walk is over -- this is what makes forward references 
 * work (E.g. `foo(); function foo() {}`, `const a = b; const b = 2`).
 * 
 * `chain` is a *shallow* copy of the scope stack: the array is snapshotted
 * so the later pushes/pops can't disturb it, but the `Scope` objects inside
 * are the live ones, so their `declarations` keep filling as the walk continues
 * and are complete by retry time. That is the whole trick -- no second walk, 
 * no pre-pass, just a deferred lookup until the scopes it needs are finished
 * 
 * `use` is built at the point of use, so it already carries the `feeds` that
 * `currentFeedTargets` held back then; `inReturn/fn` are captured for the same
 * reason, since both are mutable module state that won't survive.
 * 
 * Think of it as a sticky note of reminder (when a use doesn't
 * get resolved because it's not declared, it's pending to be resolved
 * until the walker rewalks it.)
 */
type PendingUse = {
    use: Use; // Represents the use itself.
    chain: Scope[]; // Represents where the use was standing (in which scope?) when it got a "pending" state.
    inReturnStatement: boolean; // Whether the pending use was in a return statement.
    fn: Binding | null; // Which function the use was in.
}

let pendingUses: PendingUse[] = [];

/**
 * Every call's callee is resolved after the walk, never during it. During the
 * walk a later declaration isn't in scope yet — so a function declared further
 * down got no arguments (gap 19), and an inner function declared further down
 * lost to an outer one it shadows (gap 8). Resolving everything afterwards,
 * through the scopes that were visible at the call, gets both right.
 *
 * One `CallSite` per call, shared by its arguments and its callee use so they
 * all agree on the answer: `resolved` memoises it.
 */
type Receiver = { kind: "this" } | { kind: "name"; name: string } | { kind: "other" };

type CallSite = {
    /** Start offset of the call expression. */
    start: number;
    name: string;
    chain: Scope[];
    /** Present for `o.m(x)`; absent for a plain `m(x)`. */
    receiver?: Receiver;
    /** The class `this` refers to at the call, if any. */
    thisClass: number | null;
    resolved?: MethodAnswer;
};

/**
 * What a call resolved to. With no callee, `external` says the call is the
 * environment's or another package's, and `unresolved` says it is definitely
 * ours and missed. Neither set leaves it to the method name, so `xs.map()` on
 * an unknown receiver still counts as a built-in.
 */
type MethodAnswer = { callee?: Binding; external: boolean; unresolved?: boolean };

/**
 * One argument of a call. It was stamped with a placeholder feed whose start is
 * `id` (negative, like gap 16's), rewritten once the call is resolved.
 *
 * `fallback` is what the argument would have fed had nobody deferred anything:
 * the enclosing targets, which gap 18 passes through as inferred. A callee that
 * doesn't resolve, or has no parameter at this position, falls back to exactly
 * that — so deferring changes nothing for a call that was never going to resolve.
 */
type PendingCall = {
    site: CallSite;
    argIndex: number;
    id: number;
    fallback: Binding[];
};

let pendingCalls: PendingCall[] = [];

/** The method name in `o.m(x)`, resolved with its call rather than as a name. */
type PendingCallee = { site: CallSite; use: Use; inReturnStatement: boolean; fn: Binding | null };

let pendingCallees: PendingCallee[] = [];

/**
 * The write target of `x = …`, resolved after the walk for the same reason as a
 * callee: the use of `x` is, so the write has to be too, or a later inner
 * `var x` would get the use and an outer `x` the value (gap 8).
 */
type PendingTarget = { name: string; chain: Scope[]; id: number; fallback: Binding[]; fallbackInferred: boolean };

let pendingTargets: PendingTarget[] = [];

/**
 * Class bookkeeping for gap 1. `classStack` holds the classes being walked, so a
 * method knows which one it belongs to. `thisClass` is what `this` refers to
 * right now: the class inside its body and methods, kept by arrows, and cleared
 * by any other function, which gets a `this` of its own.
 */
let classStack: number[] = [];
let thisClass: number | null = null;
let savedThisClasses: (number | null)[] = [];
/** Set by MethodDefinition just before walking the method's function. */
let nextFunctionIsMethod = false;

/**
 * Every method in the file, with the scope its class was declared in. Methods
 * are kept out of the lexical scopes: nothing refers to one by bare name —
 * `score` alone is never `this.score` — so in a scope they could only ever be
 * found by mistake (gap 1). Only `o.m()` reads them, through `methodsNamed`.
 */
let methodBindings: { binding: Binding; scope: Scope }[] = [];

/** The superclass a class names in `extends`, when that is a plain name, and
 *  the scopes visible where it was written — what `this.m()` follows when the
 *  class doesn't declare `m` itself. Keyed like `classStack`. */
let classSupers = new Map<number, { name: string; chain: Scope[] }>();

/**
 * Gap 20: instance fields. A field is one node per class and name, and exists
 * only once something declares or writes it — a class property, a parameter
 * property, or `this.x =`. A read alone never makes one: `this.render` with no
 * write is a method or getter, or comes from a class in another file, and
 * guessing would invent a node.
 *
 * Which class a `this.x` belongs to waits for the walk to finish, like every
 * other name (gap 8): a subclass can read a field its superclass declares
 * further down the file.
 */
/** Fields declared outright, keyed `${class}:${name}`. */
let declaredFields = new Map<string, Binding>();
/** Every field name each class declares or writes, keyed by class. */
let fieldNames = new Map<number, Set<string>>();
/** `this.x = …` — the write's placeholder id, rewritten to the field. */
type FieldWrite = { cls: number; name: string; property: TSESTree.Node; id: number };
let fieldWrites: FieldWrite[] = [];
/** A read of `this.x`, attached to the field once it is known. */
type FieldRead = { cls: number; use: Use; inReturnStatement: boolean; fn: Binding | null };
let fieldReads: FieldRead[] = [];

/**
 * A shallow copy of the scope stack, shared between every note filed while the
 * stack is unchanged. Deferring every lookup files a note per identifier, and a
 * copy each would be the cost. Same length and same top scope means the same
 * chain: a scope object is pushed once and never re-pushed.
 */
let chainCache: { length: number; top: Scope | undefined; chain: Scope[] } | null = null;

function chainOf(stack: Scope[]): Scope[] {
    const top = stack[stack.length - 1];
    if (chainCache && chainCache.length === stack.length && chainCache.top === top) return chainCache.chain;
    chainCache = { length: stack.length, top, chain: [...stack] };
    return chainCache.chain;
}

/** A stand-in feed target with a negative start, rewritten after the walk. */
function placeholder(name: string, call?: number): Binding {
    const target: Binding = {
        name, kind: "param", varType: "N/A",
        file: currentFile, start: -(++placeholderCount), line: 0, role: "declaration", uses: [],
    };
    if (call !== undefined) target.call = call;
    return target;
}

function receiverOf(object: TSESTree.Node): Receiver {
    if (object.type === "ThisExpression") return { kind: "this" };
    if (object.type === "Identifier") return { kind: "name", name: object.name };
    return { kind: "other" };
}

/** Every method called `name` visible from `chain` — all of them, not the
 *  nearest, because which class a receiver holds is the open question. */
function methodsNamed(name: string, chain: Scope[]): Binding[] {
    return methodBindings
        .filter((m) => m.binding.name === name && chain.includes(m.scope))
        .map((m) => m.binding);
}

/**
 * Class `cls`'s method among `methods`, or failing that the nearest local
 * superclass's. Undefined when it can't be sure: two candidates on one class,
 * or a superclass that isn't a class declared in this file — an imported
 * `Base` may well define the method, so an unrelated class's must not stand in.
 */
function methodOfClass(cls: number, methods: Binding[]): Binding | undefined {
    const seen = new Set<number>();
    let current: number | undefined = cls;
    while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const owner: number = current;
        const own = methods.filter((m) => m.methodOf === owner);
        if (own.length === 1) return own[0];
        if (own.length > 1) return undefined;
        const parent = classSupers.get(owner);
        const holder = parent && lookup(parent.name, parent.chain);
        current = holder?.kind === "class" ? holder.start : undefined;
    }
    return undefined;
}

/**
 * Which method `o.m(x)` calls, without types (gap 1). Each rule answers only
 * when it can be sure, and anything else is left unresolved — which costs an
 * edge, where a guess could invent one.
 *
 *   this.m()     — the enclosing class's `m`, or a local superclass's; nothing
 *                  else, since an unrelated class's `m` is not inherited
 *   C.m()        — class `C`'s own `m`, or a local superclass's
 *   Bun.m()      — a known global's, never ours; any other undeclared receiver
 *                  is a miss
 *   ns.m()       — a package import's members are external; a project
 *                  import's are ours, and not resolved here
 *   anything.m() — the one method called `m`, if there is exactly one and the
 *                  name isn't also a built-in method (`xs.map` could be either).
 *                  A plain function's `this` is anything too.
 */
function resolveMethod(site: CallSite): MethodAnswer {
    const methods = methodsNamed(site.name, site.chain);
    const receiver = site.receiver!;

    if (receiver.kind === "this" && site.thisClass !== null) {
        return { callee: methodOfClass(site.thisClass, methods), external: false };
    }
    if (receiver.kind === "name") {
        const holder = lookup(receiver.name, site.chain);
        if (!holder) {
            return KNOWN_GLOBALS.has(receiver.name)
                ? { external: true }
                : { external: false, unresolved: true };
        }
        if (holder.kind === "import") {
            // `source` is an absolute path exactly when the import is in-project.
            return isAbsolute(holder.source ?? "")
                ? { external: false, unresolved: true }
                : { external: true };
        }
        if (holder.kind === "class") {
            return { callee: methodOfClass(holder.start, methods), external: false };
        }
    }
    if (methods.length !== 1 || BUILTIN_METHODS.has(site.name)) return { external: false };
    return { callee: methods[0], external: false };
}

/** The class `cls` extends, when that is a class declared in this file. */
function superclassOf(cls: number): number | undefined {
    const parent = classSupers.get(cls);
    const holder = parent && lookup(parent.name, parent.chain);
    return holder?.kind === "class" ? holder.start : undefined;
}

/** The name a non-computed member key or property stands for, as a field:
 *  `#x` keeps its `#`, since `this.#x` and `this.x` are different fields. */
function fieldNameOf(key: TSESTree.Node): string | undefined {
    if (key.type === "Identifier") return key.name;
    if (key.type === "PrivateIdentifier") return `#${key.name}`;
    return undefined;
}

function noteFieldName(cls: number, name: string): void {
    let names = fieldNames.get(cls);
    if (!names) fieldNames.set(cls, names = new Set());
    names.add(name);
}

/** A field declared outright on `cls`, its node at `at` (a key, or the
 *  parameter property). Kept out of every scope; see `declaredFields`. */
function declareField(cls: number, name: string, at: TSESTree.Node, results: Results): Binding {
    const field = makeBinding(at, "declaration", "field");
    field.name = name;
    field.fieldOf = cls;
    declaredFields.set(`${cls}:${name}`, field);
    noteFieldName(cls, name);
    results.declarations.push(field);
    trace("declare", `${name} (field) at offset ${field.start}`);
    return field;
}

/**
 * The class whose field `this.name` in `cls` is: the topmost class up the
 * in-file `extends` chain that declares it, or failing that the topmost that
 * writes it. Topmost, because a subclass writing an inherited field writes the
 * same property. Undefined when nothing in the chain declares or writes it.
 */
function fieldOwner(cls: number, name: string): number | undefined {
    let declared: number | undefined;
    let written: number | undefined;
    const seen = new Set<number>();
    for (let c: number | undefined = cls; c !== undefined && !seen.has(c); c = superclassOf(c)) {
        seen.add(c);
        if (declaredFields.has(`${c}:${name}`)) declared = c;
        if (fieldNames.get(c)?.has(name)) written = c;
    }
    return declared ?? written;
}

/**
 * Gap 20, after the walk: give every field a node, point each write's
 * placeholder at it, and attach each read. A field nothing declares gets its
 * node at its first write in the owning class's chain — a real identifier
 * position, so its id can't collide with a declaration's.
 */
function resolveFields(results: Results): Map<number, Feed[]> {
    const answers = new Map<number, Feed[]>();
    const fields = new Map(declaredFields);
    const fieldFor = (cls: number, name: string, at?: TSESTree.Node): Binding | undefined => {
        const owner = fieldOwner(cls, name);
        if (owner === undefined) return undefined;
        const key = `${owner}:${name}`;
        let field = fields.get(key);
        if (!field && at) {
            field = makeBinding(at, "declaration", "field");
            field.name = name;
            field.fieldOf = owner;
            fields.set(key, field);
            results.declarations.push(field);
        }
        return field;
    };

    // In source order, so an undeclared field's node is its first write.
    for (const write of [...fieldWrites].sort((a, b) => a.property.range[0] - b.property.range[0])) {
        const field = fieldFor(write.cls, write.name, write.property)!;
        answers.set(write.id, [feedOf(field, false)]);
        trace("resolve", `this.${write.name} = … -> field at offset ${field.start}`);
    }
    for (const read of fieldReads) {
        const field = fieldFor(read.cls, read.use.name);
        if (field) attachUse(field, read.use, read.inReturnStatement, read.fn);
    }
    return answers;
}

function resolveSite(site: CallSite): MethodAnswer {
    site.resolved ??= site.receiver
        ? resolveMethod(site)
        : { callee: lookup(site.name, site.chain), external: false };
    return site.resolved;
}

/** Counter behind every negative placeholder start in the current file, gap 16
 *  and gap 19 alike. Shared, because both live in the same `use.feeds` and a
 *  collision would rewrite one call's argument onto the other's parameter. */
let placeholderCount = 0;

type Feed = NonNullable<Use["feeds"]>[number];

/** A feed entry for `target`, flagged inferred only when it is, and carrying
 *  the call it enters when `target` is a per-call parameter copy. */
function feedOf(target: { name: string; file: string; line: number; start: number; call?: number }, inferred: boolean): Feed {
    const fed: Feed = { name: target.name, file: target.file, line: target.line, start: target.start };
    if (inferred) fed.inferred = true;
    if (target.call !== undefined) fed.call = target.call;
    return fed;
}

/**
 * The identifier currently being walked as a call's callee, and that call's
 * start offset. The Identifier branch stamps the offset onto the use, which is
 * how an edge out of a function knows which call's result it carries.
 */
let currentCallee: { identifier: TSESTree.Node; call: number } | null = null;

/**
 * One thing the walker did, reported to whoever is watching. `kind` groups
 * them (declare / resolve / defer / feed / scope), `detail` is the human
 * sentence, `depth` is how deeply nested it was so a printer can indent.
 */
export type TraceEvent = { kind: string; detail: string; depth: number };

/**
 * Tracing hook — null in every normal run, so the whole mechanism costs one
 * null check per event and nothing else. `trace.ts` sets it to watch a walk
 * happen step by step.
 *
 * These events live in here rather than in trace.ts because they describe
 * moments *inside* the walk — which scope was open, what the feed target was
 * — and none of that is visible from outside once `collectVariables` returns.
 */
let onTrace: ((event: TraceEvent) => void) | null = null;
let traceDepth = 0;

/** Start (or, with null, stop) watching the walk. See trace.ts. */
export function setTraceHook(hook: ((event: TraceEvent) => void) | null): void {
    onTrace = hook;
    traceDepth = 0;
}

/**
 * Report one event. `depthChange` is +1 for "everything after this is nested
 * inside it" (entering a scope) and -1 for leaving one; the decrement happens
 * before reporting so the closing line sits at the same indent as its opener.
 */
function trace(kind: string, detail: string, depthChange: 0 | 1 | -1 = 0): void {
    if (!onTrace) return;
    if (depthChange === -1) traceDepth--;
    onTrace({ kind, detail, depth: traceDepth });
    if (depthChange === 1) traceDepth++;
}


/** Innermost-scope-outward lookup of `name` or undefined if there is nothing binding to it */
function lookup(name: string, chain: Scope[]): Binding | undefined {
    for (let i = chain.length - 1; i >= 0; i--) {
        // Methods are never in here (see `methodBindings`), so a bare name
        // can't find one.
        const found = chain[i]?.declarations.find(d => d.name === name);
        if (found) return found;
    }

    return undefined;
}

/**
 * Record `use` against the declaration it resolved to, and - if it happend 
 * inside a return - note on the enclosing function that this declaration
 * escapes through it. Shared by the immediate path and the deferred retry 
 * so a forward reference inside a `return` still stamps `returns`.
 */
function attachUse(found: Binding, use: Use, wasInReturnStatement: boolean, fn: Binding | null): void {
    if (wasInReturnStatement && fn) {
        if (!Array.isArray(fn.returns)) {
            fn.returns = [];
        }
        let entry = fn.returns.find(
            r => r.start === found.start && r.file === found.file
        );
        if (!entry) {
            // push the IDENTITY of the thing being returned:
            entry = { name: found.name, file: found.file, start: found.start };
            fn.returns.push(entry);
        }
        // `return f(x)` hands back the result of that call, not `f` itself.
        if (use.call !== undefined) {
            entry.calls ??= [];
            if (!entry.calls.includes(use.call)) entry.calls.push(use.call);
        } else {
            entry.direct = true;
        }
    }

    found.uses.push(use);
}

// Build a Binding from an Identifier-like node (something with a `.name`).
// varType is the declaration keyword (var/let/const) for variables, and ""
// for binding kinds where it doesn't apply (params, functions, ...).
function makeBinding(
    idNode: any,
    role: Binding["role"],
    kind: Kind,
    varType = "",
): Binding {
    return {
        name: idNode.name ?? String(idNode.value),
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        varType,
        file: currentFile,
        kind,
        role,
        uses: [],
    };
}

// Build a Use from an Identifier-like node.
function makeUse(idNode: any): Use {
    return {
        name: idNode.name || String(idNode.value),
        line: idNode.loc?.start.line ?? -1,
        start: idNode.range?.[0] ?? -1,
        file: currentFile,
    };
}

export function collectVariables(
    node: TSESTree.Node,
    file: string,
    resolveSpecifier: SpecifierResolver = relativeSpecifierResolver,
): Results {
    currentFile = file;
    currentResolveSpecifier = resolveSpecifier;
    // reset so that the pending uses from one file does not
    // leak into another file.
    pendingUses = [];
    pendingCalls = [];
    pendingCallees = [];
    pendingTargets = [];
    placeholderCount = 0;
    currentCallee = null;
    classStack = [];
    thisClass = null;
    savedThisClasses = [];
    nextFunctionIsMethod = false;
    methodBindings = [];
    classSupers = new Map();
    declaredFields = new Map();
    fieldNames = new Map();
    fieldWrites = [];
    fieldReads = [];
    chainCache = null;
    // Same reasoning for the walk state. A balanced walk leaves both at their
    // initial value anyway; resetting means a file that threw mid-walk can't
    // hand its leftover feed target to the next one.
    currentFeedTargets = [];
    currentFeedsInferred = false;
    const results: Results = { 
        declarations: [], 
        lookups: { resolved: 0, unresolved: 0, external: 0 }, 
        deferredCallFeeds: [],
        exports: new Map(),
        reExports: [],
    };
    // A stack to know which scope we're in, so that 2 or more variables with
    // the same name can be found without ambiguity. Created fresh per call so
    // repeated invocations don't leak declarations/uses from earlier walks.
    const stack: Scope[] = [{ name: "global", declarations: [], savedFeedTargets: [], savedFunction: null }];
    walkVariables(node, results, stack);
    results.declarations.push(...stack[0]!.declarations);   // save global
    // Re-lookup: Every declaration is walked with pendingUses so it's 
    // time for pending uses to resolve.

    for (const note of pendingUses) {
        const found = lookup(note.use.name, note.chain);
        // Nothing binds this name even now that every scope is complete. Two
        // very different reasons for that, and keeping them apart is the whole
        // of gap 11: `console` was never going to be here, while a name this
        // project really does declare failing to bind is the engine falling
        // short. Only THIS note fails either way — the rest are unrelated, so
        // carry on rather than abandoning them.
        if (!found) {
            if (KNOWN_GLOBALS.has(note.use.name)) results.lookups.external++;
            else results.lookups.unresolved++;
            continue;
        }
        // it's its own start, skip
        if (found.start === note.use.start) {
            continue;
        }
        attachUse(found, note.use, note.inReturnStatement, note.fn);
        results.lookups.resolved++;
    }

    // Must run after the pending-use retry above: a use that resolved late was
    // attached there, and its feeds can hold a placeholder too. Fields first,
    // since a field read's feeds can hold one as well.
    resolvePendingCalls(results, resolveFields(results));

    const { resolved, unresolved, external } = results.lookups;
    trace("phase", `walk finished — ${resolved} resolved, ${unresolved} unresolved, ${external} external`);
    return results;
}

/**
 * Gap 19: answer every call that deferred its callee, now that every scope in
 * the file is complete, and rewrite the placeholders its arguments were
 * stamped with.
 *
 * A placeholder can resolve to another placeholder. In `later(unknown(z))` both
 * calls defer: `z` feeds unknown's placeholder, whose fallback is later's
 * placeholder, which in turn becomes later's parameter. So answers are
 * collected first and expanded recursively afterwards. That can't cycle — a
 * fallback is captured before its own call's placeholder exists, so it only
 * ever points outward. Passing through a fallback marks everything beneath it
 * inferred, the same as gap 18 does when the walk passes through directly.
 */
function resolvePendingCalls(results: Results, fieldAnswers: Map<number, Feed[]>): void {
    if (pendingCalls.length === 0 && pendingCallees.length === 0 && pendingTargets.length === 0 && fieldAnswers.size === 0) return;

    // Field writes (gap 20) are answered already; their placeholders are
    // rewritten by the same pass as everything else.
    const answers = new Map<number, Feed[]>(fieldAnswers);
    const deferred: { entry: Results["deferredCallFeeds"][number]; fallback: Binding[] }[] = [];
    for (const call of pendingCalls) {
        const { callee } = resolveSite(call.site);
        const name = call.site.name;
        // The callee is imported — found late or not, its parameters live in
        // another file. Leave the placeholder in place and queue it for gap 16's
        // resolution in analyse.ts, with the gap 18 pass-through to use if that
        // finds no parameter. The fallback is expanded below, once every
        // placeholder in this file has an answer.
        if (callee?.kind === "import") {
            const entry = { callee, argIndex: call.argIndex, id: call.id, fallback: [] };
            results.deferredCallFeeds.push(entry);
            deferred.push({ entry, fallback: call.fallback });
            trace("resolve", `call ${name}(arg ${call.argIndex}) -> import, resolved across files later`);
            continue;
        }
        const param = callee?.params?.[call.argIndex];
        answers.set(call.id, param
            ? [{ ...feedOf(param, false), call: call.site.start }]
            : call.fallback.map((target) => feedOf(target, true)));
        trace("resolve", param
            ? `call ${name}(arg ${call.argIndex}) -> param ${param.name} at offset ${param.start}`
            : `call ${name}(arg ${call.argIndex}) -> no parameter, passes through`);
    }

    // `x = …` writes to whatever `x` names once every scope is complete. If it
    // names nothing, the value goes where the enclosing expression's does.
    for (const target of pendingTargets) {
        const found = lookup(target.name, target.chain);
        answers.set(target.id, found
            ? [feedOf(found, false)]
            : target.fallback.map((t) => feedOf(t, target.fallbackInferred)));
    }

    // The method name in `o.m(x)` is a use of whichever method the call
    // resolved to — and of nothing at all when it didn't. Attached before the
    // rewrite below, since its feeds can hold placeholders of their own.
    for (const pending of pendingCallees) {
        const { callee, external, unresolved } = resolveSite(pending.site);
        if (callee) {
            attachUse(callee, pending.use, pending.inReturnStatement, pending.fn);
            results.lookups.resolved++;
        } else if (!unresolved && (external || KNOWN_GLOBALS.has(pending.site.name))) {
            results.lookups.external++;
        } else {
            results.lookups.unresolved++;
        }
    }

    const expand = (fed: Feed): Feed[] => {
        const answer = fed.file === currentFile ? answers.get(fed.start) : undefined;
        if (!answer) return [fed];          // a real target, or gap 16's to resolve
        const expanded = answer.flatMap(expand);
        return fed.inferred ? expanded.map((e) => ({ ...e, inferred: true })) : expanded;
    };

    for (const { entry, fallback } of deferred) {
        entry.fallback = fallback.map((target) => feedOf(target, true)).flatMap(expand);
    }

    for (const declaration of results.declarations) {
        for (const use of declaration.uses) {
            if (!use.feeds?.some((fed) => fed.start < 0)) continue;
            // One entry per target. Two routes to the same target are one feed,
            // and it is proven if either route was.
            const byTarget = new Map<string, Feed>();
            for (const fed of use.feeds.flatMap(expand)) {
                const key = `${fed.file}:${fed.start}`;
                const seen = byTarget.get(key);
                if (!seen) byTarget.set(key, fed);
                else if (seen.inferred && !fed.inferred) byTarget.set(key, fed);
            }
            if (byTarget.size > 0) use.feeds = [...byTarget.values()];
            else delete use.feeds;      // fell back to nothing: no target, as before
        }
    }
}

/**
 * A `let`/`const` loop variable belongs to the loop, not to the block around it.
 * Putting it in the enclosing block was harmless while every use resolved the
 * moment the walk reached it. Once uses resolve against finished scopes (gap 8),
 * `f(path); for (const path of paths) {}` would read the loop's `path` — so the
 * loop gets a scope. `var` is not block-scoped, so it keeps its old home.
 */
function opensScope(declaration: TSESTree.Node | null | undefined): boolean {
    return declaration?.type === "VariableDeclaration" && declaration.kind !== "var";
}

/** A scope that only holds declarations: flow targets and the current function
 *  pass straight through it. */
function pushScope(name: string, stack: Scope[]): void {
    stack.push({ name, declarations: [], savedFeedTargets: currentFeedTargets, savedFunction: currentFunction });
}

function popScope(results: Results, stack: Scope[]): void {
    results.declarations.push(...stack.pop()!.declarations);
}

function walkVariables(node: TSESTree.Node, results: Results, stack: Scope[]): void {
    // 1. null / undefined — skip
    if (node === null || node === undefined) {
        return;
    }

    // 2. primitives — nothing to descend into
    if (typeof node !== "object") {
        return;
    }

    // 3. arrays — recurse element-wise
    if (Array.isArray(node)) {
        for (const item of node) {
            walkVariables(item, results, stack);
        }
        return;
    }


    if (node.type === "Identifier") {
        // create a use of the node
        const use = makeUse(node);
        // populate feeds from currentFeedTargets
        if (currentFeedTargets.length > 0) {
            // Inferred is set only when true, so a proven feed stays exactly the
            // shape it has always been and graph.json doesn't grow a false on
            // every use.
            use.feeds = currentFeedTargets.map(t => feedOf(t, currentFeedsInferred));
        }
        if (currentCallee?.identifier === node) use.call = currentCallee.call;
        // 
        // Looks up the declaration of this identifier name in the scope stack,
        // returning the nearest matching declared variable/function/param, or undefined if not found
        const feedNote = use.feeds ? ` (feeds ${use.feeds.map(f => f.name).join(" + ")})` : "";

        // Never resolved here (gap 8). A declaration further down an inner
        // scope can still shadow the outer one this would find now, so every
        // use waits until the walk is over and every scope is complete.
        trace("defer", `${node.name} at offset ${node.range[0]}${feedNote}`);
        pendingUses.push({ use, chain: chainOf(stack), inReturnStatement, fn: currentFunction });
    }

    // import { parse } from "acorn" — each specifier binds a local name
    if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
            const binding = makeBinding(spec.local, "declaration", "import");
            binding.source = currentResolveSpecifier(node.source.value, binding.file);

            // What the *source* module calls this thing, which is only the same
            // as the local name when nothing was renamed. `import { a as b }`
            // binds `b` here but has to be asked for as `a` over there, and
            // matching on the local name meant every renaming import silently
            // failed to link. A default import binds whatever name the importer
            // chose and has to be asked for as `default`; a namespace import
            // binds the whole module object, so there is no one name to ask for.
            binding.imported =
                spec.type === "ImportDefaultSpecifier" ? "default" :
                spec.type === "ImportNamespaceSpecifier" ? "*" :
                (spec.imported as TSESTree.Identifier | undefined)?.name ?? binding.name;

            // `import type { X }` and `import { type X }` — both spellings.
            if (node.importKind === "type" || (spec as any).importKind === "type") {
                binding.typeOnly = true;
            }

            stack[stack.length - 1]!.declarations.push(binding);
        }
    }

    // export ... from — a name published here that is declared somewhere else.
    // Handled before the generic recursion because these statements have no
    // `declaration` to descend into: the names live in `specifiers` beside a
    // `source`, so the ordinary walk records nothing at all and a barrel file
    // contributes zero declarations to the graph. That is gap 21, and it is why
    // the linker's search for a declaration *inside* the barrel could never
    // succeed — the language guarantees there is nothing there to find.
    //
    // The `node.source` guard matters. `export const alpha = 1` and
    // `export { beta }` are the same node type without a source, and both
    // already work: the first because the generic walk descends into
    // `declaration` and the VariableDeclaration branch records `alpha`, the
    // second because `beta` was recorded by its own `const`. Those must keep
    // falling through to the bottom of this function.
    if (node.type === "ExportNamedDeclaration" && node.source) {
        const source = currentResolveSpecifier(node.source.value, currentFile);
        for (const spec of node.specifiers) {
            const local = (spec.local as TSESTree.Identifier | undefined)?.name;
            const exported = (spec.exported as TSESTree.Identifier | undefined)?.name;
            if (!local || !exported) continue;
            const entry: ReExport = { exported, local, source };
            if (node.exportKind === "type" || (spec as any).exportKind === "type") {
                entry.typeOnly = true;
            }
            results.reExports.push(entry);
            trace("reexport", `${exported} <- ${local} from ${node.source.value}`);
        }
        // Nothing in here is a use. `local` names something in the *other*
        // file, so letting the generic walk try to resolve it against this
        // file's scopes charged a genuine miss to the unresolved counter for a
        // name that was never going to be in scope.
        return;
    }

    // Everything this file publishes from its own declarations. Recorded, but
    // deliberately *not* returned from: `export const alpha = 1` still has to
    // fall through so the VariableDeclaration branch below declares `alpha` the
    // way it always has. This table only says which names are public, which is
    // a different question from which names exist — and the right one to ask
    // when another module comes looking for one of them.
    if (node.type === "ExportNamedDeclaration" && !node.source) {
        // export { beta }, export { beta as b } — exported name -> local name.
        for (const spec of node.specifiers) {
            const local = (spec.local as TSESTree.Identifier | undefined)?.name;
            const exported = (spec.exported as TSESTree.Identifier | undefined)?.name;
            if (local && exported) results.exports.set(exported, local);
        }
        // export const/function/class/type X — published under its own name.
        for (const name of exportedDeclarationNames(node.declaration)) {
            results.exports.set(name, name);
        }
    }

    // export default — recorded only when it has a name to record. An anonymous
    // `export default () => {}` declares nothing the rest of the project can
    // address, so there is deliberately no entry: an importer of it links to
    // nothing, which is the honest outcome rather than a guessed one.
    if (node.type === "ExportDefaultDeclaration") {
        const declaration = node.declaration as any;
        const name =
            declaration?.type === "Identifier" ? declaration.name :
            declaration?.id?.name ?? undefined;
        if (name) results.exports.set("default", name);
    }

    // export * from "./other" — and export * as ns from "./other"
    if (node.type === "ExportAllDeclaration") {
        const source = currentResolveSpecifier(node.source.value, currentFile);
        const entry: ReExport = { source, star: true };
        // `export * as ns from` republishes the module as a single namespace
        // instead of spilling its names into this one, so it is not a wildcard
        // to search: recorded, but deliberately not followed by name later.
        if (node.exported) entry.namespace = (node.exported as TSESTree.Identifier).name;
        if (node.exportKind === "type") entry.typeOnly = true;
        results.reExports.push(entry);
        trace("reexport", `* ${entry.namespace ? `as ${entry.namespace} ` : ""}from ${node.source.value}`);
        return;
    }

    // var/let/const (also for-of / for-in / classic for loop vars).
    // node.kind is the "var" | "let" | "const" keyword — record it as varType.
    // The id can be a destructuring pattern, so go through collectPatternNames;
    // the init is where uses live, so harvest those as "use" bindings.
    // Each declarator is handled here rather than in a separate
    // `VariableDeclarator` branch, because a declarator on its own can't see
    // `node.kind` (the var/let/const keyword) and — more importantly — can't
    // tell which bindings are *its own*. Slicing the scope's declarations
    // around each collectPatternNames call pairs a declarator with exactly
    // the names it introduced, which is what the feed target has to be.
    //
    // The old code took "the last declaration in scope" as the target. That
    // was wrong twice over: `const { a, b } = foo()` fed only `b`, and
    // `const a = foo(), b = 2` fed `b` — a variable foo has nothing to do
    // with — because every declarator's names were pushed up front.
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
            // grabs the top (latest) list. 
            const scopeDeclarations = stack[stack.length - 1]!.declarations;
            const before = scopeDeclarations.length;

            // Prevent the classification of all "id" fields as variables
            const initType = decl.init?.type;
            const isFunction = initType === "ArrowFunctionExpression" || initType === "FunctionExpression";
            // sends it over to collectPatternNames with the top list
            // (it first checks if the type is a function expression (see above) to send the correct "kind")
            collectPatternNames(decl.id, scopeDeclarations, isFunction ? "function" : "variable", node.kind);

            // Everything pushed by this declarator — one name normally, several
            // for a destructuring pattern, none for `let x` with no init.
            const targets = scopeDeclarations.slice(before);

            const previous = currentFeedTargets;   // save
            const previousInferred = currentFeedsInferred;
            currentFeedTargets = targets;          // set
            currentFeedsInferred = false;          // a declarator names its target outright
            if (targets.length) trace("feed", `anything used from here flows into ${targets.map(t => t.name).join(" + ")}`, 1);

            if (decl.init) {                       // only if there's an init to walk
                walkVariables(decl.init, results, stack); // walk — uses inside get stamped
            }

            if (targets.length) trace("feed", `done — ${targets.map(t => t.name).join(" + ")} no longer the target`, -1);
            currentFeedTargets = previous;         // restore
            currentFeedsInferred = previousInferred;
        }
        return;   // declarators are walked above; don't let the generic loop repeat them
    }

    // Loops: walk the children in *source* order rather than the parser's.
    //
    // The generic recursion at the bottom of this function iterates
    // `Object.values(node)`, and typescript-estree emits a node's properties
    // alphabetically — so `body` comes before `init`, `left`, `test` and
    // `update`. The walker was therefore visiting a loop's body before the
    // loop's own variable had been declared, and
    // `for (let i = 0; i < 3; i++) { const b = i; }` dropped the use of `i`
    // inside the body while still resolving the two in `i < 3` and `i++`
    // (those are walked after `init`, so by then it exists). Naming the
    // children explicitly is the same move VariableDeclaration and
    // MethodDefinition already make to control their own traversal.
    //
    // Note this is *not* the hoisting gap: nothing here is used before it is
    // declared in the source, only before the walker happened to reach it.
    if (node.type === "ForStatement") {
        const scoped = opensScope(node.init);
        if (scoped) pushScope("for", stack);
        if (node.init) walkVariables(node.init, results, stack);
        if (node.test) walkVariables(node.test, results, stack);
        if (node.update) walkVariables(node.update, results, stack);
        walkVariables(node.body, results, stack);
        if (scoped) popScope(results, stack);
        return;
    }

    // for (const x of xs) / for (const k in o) — `left` declares the loop
    // variable and `right` is the iterable being read; both have to be walked
    // before the body that uses them. `right` goes first, outside the loop's
    // scope: in `for (const path of paths)` it is read before `path` exists.
    if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
        walkVariables(node.right, results, stack);
        const scoped = opensScope(node.left);
        if (scoped) pushScope("for", stack);
        walkVariables(node.left, results, stack);
        walkVariables(node.body, results, stack);
        if (scoped) popScope(results, stack);
        return;
    }

    // switch (k) { case 1: const x = … } — the cases share one block of their
    // own. Without a scope the `const` landed in the enclosing one and, once
    // uses resolve against finished scopes, captured an outer `x` read before
    // the switch. The discriminant is read outside it, like a for-of's `right`.
    // A class's `static { }` block is the same story: a block that is not a
    // BlockStatement.
    if (node.type === "SwitchStatement") {
        walkVariables(node.discriminant, results, stack);
        pushScope("switch", stack);
        for (const switchCase of node.cases) walkVariables(switchCase, results, stack);
        popScope(results, stack);
        return;
    }
    if (node.type === "StaticBlock") {
        pushScope("static", stack);
        for (const statement of node.body) walkVariables(statement, results, stack);
        popScope(results, stack);
        return;
    }

    // { a: b } — an object literal property. A non-computed key is a label,
    // not a reference: the `a` names the property, so walking it would resolve
    // to any variable that happens to also be called `a` and record a use that
    // isn't in the source. Shorthand { z } is the same problem twice over —
    // key and value are separate nodes at the same offset, so `z` got two
    // identical uses. Only a computed key, { [k]: v }, really does read a
    // variable. Same computed/non-computed split as MethodDefinition's key
    // and a MemberExpression's property.
    if (node.type === "Property") {
        if (node.computed) walkVariables(node.key, results, stack);
        walkVariables(node.value, results, stack);
        return;
    }

    if (node.type === "ReturnStatement") {
        const previous = inReturnStatement;
        inReturnStatement = true;
        // node.argument contains the expression (x + y, {a, b}, c, etc.)
        // that is returned

        // Since there can also be empty returns: add a conditional that
        // triggers walkVariables only if node.argument exists
        // If it is an empty return statement, we don't need to walk it. 

        if (node.argument)
            walkVariables(node.argument, results, stack);

        inReturnStatement = previous;
        return;
    }

    // Functions: declaration, expression, arrow.
    // The function's own name plus every param (params can be defaults,
    // rest, or destructuring patterns).
    if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    ) {
        // store the binding in a variable to later attach it to the param field 
        // of the Binding type.
        let funcBinding;

        // if the function has an ID (meaning it isn't an anonymous function)
        // write the function in the current stack (not a separate one) — unless
        // it is a function *expression*, whose name is visible only inside its
        // own body. In the enclosing scope `function process() {}` would capture
        // every use of the global `process` there, before it as well as after.
        let ownName: Binding | undefined;
        if (node.id) {
            trace("declare", `${node.id.name} (function) at offset ${node.id.range[0]}`);
            funcBinding = makeBinding(node.id, "declaration", "function", "N/A");
            if (node.type === "FunctionExpression") ownName = funcBinding;
            else stack[stack.length - 1]!.declarations.push(funcBinding);
        } else {
            // If there is no node.id (anonymous function), check whether a feed
            // target is available and treat it as the function binding to which
            // to attach params later. Only a lone target can name a function —
            // `const { a, b } = () => {}` has two, and neither is the function.
            if (currentFeedTargets.length === 1 && currentFeedTargets[0]!.kind === "function") {
                funcBinding = currentFeedTargets[0];
            }
        }
    
        // Build a parameter list with type Binding, THIS is the list that
        // needs to be separate from the stack list. 
        // Fill in the param list 
        const paramDeclarations: Binding[] = [];
        for (const param of node.params) {
            collectPatternNames(param, paramDeclarations, "param", "N/A");
        }
        
        // constructor(private x) — gap 20. The parameter is an ordinary one,
        // and also declares field `x` and feeds it. The field's node is the
        // whole parameter property, so it can't share the parameter's id.
        const cls = nextFunctionIsMethod ? classStack[classStack.length - 1] : undefined;
        for (const param of node.params) {
            if (param.type !== "TSParameterProperty" || cls === undefined) continue;
            const id = param.parameter.type === "AssignmentPattern" ? param.parameter.left : param.parameter;
            if (id.type !== "Identifier") continue;
            const field = declareField(cls, id.name, param, results);
            const declared = paramDeclarations.find((p) => p.start === id.range[0]);
            declared?.uses.push({ ...makeUse(id), feeds: [feedOf(field, false)] });
        }
        // if there is a funcBinding, set it to the filled paramDeclarations list.
        if (funcBinding) {
            funcBinding.params = paramDeclarations;
        }
        trace("scope", `enter function ${node.id?.name ?? "(anonymous)"} — its parameters start this scope`, 1);
        // push the function now that params are filled in paramDeclarations
        stack.push({
            name: node.id?.name ?? "anonymous_func",
            // After the parameters, so `function f(f) {}` still reads the parameter.
            // A copy, so the name doesn't become one of the function's `params`.
            declarations: ownName ? [...paramDeclarations, ownName] : paramDeclarations,
            savedFeedTargets: currentFeedTargets,
            savedFeedsInferred: currentFeedsInferred,
            savedFunction: currentFunction,
            savedThisClass: thisClass,
        });
        // `this`: an arrow keeps the one around it; a method's is its class;
        // any other function gets a `this` of its own, which is no class we know.
        if (node.type !== "ArrowFunctionExpression") {
            thisClass = nextFunctionIsMethod ? (classStack[classStack.length - 1] ?? null) : null;
        }
        nextFunctionIsMethod = false;
        // Clear the list of currentFeedTargets because we are now inside a new function scope,
        // so there are no flow-carrying targets to link variable uses to at this level.
        currentFeedTargets = [];
        currentFeedsInferred = false;
        // Set the currentFunction to the current function's binding (funcBinding),
        // or to null if there is no function binding. This keeps track of which function
        // scope we are currently in, which is important for identifying return statements
        // and properly attributing variable uses that escape through return.
        currentFunction = funcBinding ?? null;
    }

    // Arguments need to feed the parameters, i.e., 
    // args and params must match 

    // End result we're trying to achieve: 

    /*
        "params": [
            {
              "name": "p",
              "line": 1,
              "start": 13,
              "varType": "N/A",
              "file": "/Users/temiralimov/Desktop/flowdata/src/tests/example.ts",
              "kind": "param",
              "role": "declaration",
              "uses": [
                {
                  "name": "p",
                  "line": 1,
                  "start": 34,
                  "file": "/Users/temiralimov/Desktop/flowdata/src/tests/example.ts"
   NEW PROP ----> "feeds": {
                    "name": ARG name
                    ... rest of arg's properties
                  }       
                }
              ]
            }
          ]
    */

    if (node.type === "CallExpression") {
        let calleeName: string | undefined;
        if (node.callee.type === "Identifier") {
            // Plain call ==> the name is at node.callee.name
            calleeName = node.callee.name;
        } else if (node.callee.type === "MemberExpression" && !node.callee.computed) {
            // Method (dotted) call ==> the name is at node.callee.property.name
            calleeName = node.callee.property.name;
        }

        if (calleeName !== undefined) {
            // Resolved after the walk (resolvePendingCalls), never here: see
            // CallSite. Every argument gets a placeholder target in the meantime.
            const site: CallSite = {
                start: node.range[0],
                name: calleeName,
                chain: chainOf(stack),
                receiver: node.callee.type === "MemberExpression" ? receiverOf(node.callee.object) : undefined,
                thisClass,
            };

            let save;
            let saveInferred;
            for (let argIndex = 0; argIndex < node.arguments.length; argIndex++) {
                save = currentFeedTargets;
                saveInferred = currentFeedsInferred;
                // Gaps 16 and 19 both started here as special cases: an imported
                // callee, and one declared later. With every callee resolved
                // after the walk, they are the general case.
                const target = placeholder(calleeName, node.range[0]);
                pendingCalls.push({ site, argIndex, id: target.start, fallback: save });

                // Gap 18: with no parameter to feed, fall through to the enclosing
                // target instead of dropping the argument. `x = y.replace(z)` used
                // to record `y -> x` (the receiver is walked below, with `save`
                // already restored) and nothing for `z` — the same call treating
                // its two halves differently for no reason but where the loop ends.
                //
                // Passing through treats an unknown call as transparent, which is
                // an over-approximation: `n = arr.push(y)` returns a length, not
                // `y`. So the stamp is marked inferred and stays separable
                // downstream, rather than being blended into proven flow.
                currentFeedTargets = [target];
                // A resolved parameter is proven flow, even when the enclosing
                // context was itself inferred: in `unknown(known(x))` the inner
                // `x -> param` is real regardless of the outer call. The fallback
                // carries its own inferred mark, set when it is resolved.
                currentFeedsInferred = false;
                const arg = node.arguments[argIndex];
                if (arg) walkVariables(arg, results, stack);   // guard: fewer args than params
                currentFeedTargets = save;
                currentFeedsInferred = saveInferred;
            }

            // This block ensures that all sub-expressions of the function call's callee are visited.
            // For member expressions (e.g., obj.method()), both the object ('obj') and the property ('method') could reference identifiers or expressions that should be walked.
            // For other callee types (e.g., identifier, function expression), just walk the callee itself.
            if (node.callee.type === "MemberExpression") {
                // Walk the object part of the member expression (e.g., 'obj' in 'obj.method')
                walkVariables(node.callee.object, results, stack);
                // The method name is a use too, but of whatever *method* the call
                // resolves to — not of anything in scope that shares the name,
                // which is how `Bun.file()` used to record a use of a local
                // `file`. So it is built here and resolved with the call.
                const property = node.callee.property as TSESTree.Identifier;
                const use = makeUse(property);
                if (currentFeedTargets.length > 0) {
                    use.feeds = currentFeedTargets.map(t => feedOf(t, currentFeedsInferred));
                }
                use.call = node.range[0];
                pendingCallees.push({ site, use, inReturnStatement, fn: currentFunction });
            } else {
                // For non-member calls, walk the callee (could be identifier or another expression)
                currentCallee = { identifier: node.callee, call: node.range[0] };
                walkVariables(node.callee, results, stack);
            }
            currentCallee = null;
            return;
        }
    }

    if (node.type === "BlockStatement") {
        trace("scope", "enter block { } — names declared inside are invisible once it closes", 1);
        // Push a new stack but there is no declarations
        stack.push({
            name: "block",
            declarations: [],
            savedFeedTargets: currentFeedTargets,
            savedFeedsInferred: currentFeedsInferred,
            savedFunction: currentFunction,
        })
    }

    // try {} catch (err) {} — the catch param (optional since ES2019)
    // The catch param is scoped to its clause. In the enclosing block it was
    // visible before the `try` too — harmless while every use resolved as the
    // walk reached it, wrong once uses resolve against the finished block.
    if (node.type === "CatchClause") {
        pushScope("catch", stack);
        if (node.param) collectPatternNames(node.param, stack[stack.length - 1]!.declarations, "catch");
        // The names are declarations, but a destructured param can hold
        // expressions too: `catch ({ message = fallback })` reads `fallback`.
        // The names themselves resolve to their own declarations and drop out.
        if (node.param) walkVariables(node.param, results, stack);
        walkVariables(node.body, results, stack);
        popScope(results, stack);
        return;
    }

    // class R { x = init } — gap 20. The key is the field's name, not a read
    // of anything (it used to be walked as one, so `x = 1` recorded a use of
    // whatever `x` was in scope). The initialiser feeds the field. A static
    // property isn't an instance field: only its value is walked.
    if (node.type === "PropertyDefinition" || node.type === "TSAbstractPropertyDefinition") {
        if (node.computed) walkVariables(node.key, results, stack);
        const cls = classStack[classStack.length - 1];
        const name = node.computed ? undefined : fieldNameOf(node.key);
        if (node.static || name === undefined || cls === undefined) {
            if (node.value) walkVariables(node.value, results, stack);
            return;
        }
        const field = declareField(cls, name, node.key, results);
        const previous = currentFeedTargets;
        const previousInferred = currentFeedsInferred;
        currentFeedTargets = [field];
        currentFeedsInferred = false;
        if (node.value) walkVariables(node.value, results, stack);
        currentFeedTargets = previous;
        currentFeedsInferred = previousInferred;
        return;
    }

    // class Ranker {} — the class name
    if (node.type === "ClassDeclaration" && node.id) {
        stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "class"));
    }

    // score(result) {} — the name lives on node.key, the params on node.value.
    // That value is an anonymous FunctionExpression (id is always null for a
    // method), so the function branch can't name it from node.id; for anonymous
    // functions it falls back to currentFeedTarget instead. Point that at the
    // binding we just made and walk the value ourselves, so the params (and,
    // via currentFunction, the returns) land on the method. Same
    // save/set/walk/restore shape VariableDeclarator uses for `const f = () => {}`.
    if (node.type === "MethodDefinition" || node.type === "TSAbstractMethodDefinition") {
        // An overload signature (`m(a: string): void;`), an abstract method or
        // a `declare class` member has no body. It declares no method of its
        // own — counting each signature as one made every overloaded method
        // look like two, and two candidates resolve to neither — and its
        // parameters are types, not values. Only a computed key is read.
        if (node.value.type === "TSEmptyBodyFunctionExpression") {
            if (node.computed) walkVariables(node.key, results, stack);
            return;
        }

        // class R { [name]() {} } — a computed key is an expression, not the
        // method's name. Binding it would declare something called "name",
        // which is the variable being read, not the method it names (and the
        // real name isn't knowable until runtime). So walk the key as an
        // ordinary expression instead, letting `name` resolve to its own
        // declaration and record a use there.
        if (node.computed) {
            walkVariables(node.key, results, stack);
            nextFunctionIsMethod = true;
            walkVariables(node.value, results, stack);
            return;
        }

        const methodBinding = makeBinding(node.key, "declaration", "function");
        // Which class it belongs to — this is what gap 1's resolution reads.
        methodBinding.methodOf = classStack[classStack.length - 1];
        // Straight into the results, not into a scope: see `methodBindings`.
        results.declarations.push(methodBinding);
        methodBindings.push({ binding: methodBinding, scope: stack[stack.length - 1]! });
        nextFunctionIsMethod = true;

        const previous = currentFeedTargets; // save the old value
        const previousInferred = currentFeedsInferred;
        currentFeedTargets = [methodBinding]; // set
        currentFeedsInferred = false;         // the method names its own target
        walkVariables(node.value, results, stack); // walk
        currentFeedTargets = previous; // restore
        currentFeedsInferred = previousInferred;
        return; // node.key is the declaration itself, nothing to resolve there.
    }

    /*
        Reassignment — gap 5. Note what was actually missing: in `let x; x = foo()`
        both identifiers already resolved, `x` to its declaration and `foo` to its
        function. What no one recorded is that foo's value lands in x, because only
        a declaration's initializer ever set a feed target. So this is not a
        resolution problem, it's a missing `feeds` stamp — the fix belongs here and
        not anywhere near `lookup`.

        The branch does for `x = foo()` what the VariableDeclaration branch does for
        `const x = foo()`: point currentFeedTargets at the thing being written, walk
        the right-hand side so the uses inside get stamped, then restore.

        Two details that look arbitrary and aren't:

        - `left` is walked BEFORE the target is set. Walking it after would stamp the
          write as flowing into itself, so `x = 1` would emit `x -> x`.
        - When the left side can't be named — `o.p = foo()`, or an identifier that
          resolves to nothing — the target falls back to `previous` rather than [].
          Not naming the write target says nothing about where the expression's own
          value goes, and `const a = (o.p = foo())` really does put foo's result in
          `a`. [] would throw that away.
    */
    if (node.type === "AssignmentExpression") {
        walkVariables(node.left, results, stack);
        const previous : Binding[] = currentFeedTargets;
        const previousInferred = currentFeedsInferred;

        if (node.left.type === "Identifier") {
            // Resolved after the walk, like every other name (gap 8). If it
            // names a declaration the flow is proven; if not, it falls back to
            // `previous` with whatever qualification those targets already had.
            const target = placeholder(node.left.name);
            target.kind = "variable";
            pendingTargets.push({
                name: node.left.name, chain: chainOf(stack), id: target.start,
                fallback: previous, fallbackInferred: previousInferred,
            });
            currentFeedTargets = [target];
            currentFeedsInferred = false;
        } else if (
            node.left.type === "MemberExpression" && node.left.object.type === "ThisExpression" &&
            !node.left.computed && thisClass !== null
        ) {
            // Gap 20: `this.x = y` writes the field, proven. Which class's
            // field waits for the walk to finish; see `resolveFields`.
            const name = fieldNameOf(node.left.property);
            if (name !== undefined) {
                const target = placeholder(name);
                target.kind = "field";
                fieldWrites.push({ cls: thisClass, name, property: node.left.property, id: target.start });
                noteFieldName(thisClass, name);
                currentFeedTargets = [target];
                currentFeedsInferred = false;
            }
        }
        walkVariables(node.right, results, stack);
        // Restore currentFeedTargets to its previous value after handling AssignmentExpression
        currentFeedTargets = previous;
        currentFeedsInferred = previousInferred;
        return;
    }

    if (node.type === "MemberExpression") {
        // Gap 20: `this.x` reads the field, and carries it wherever the
        // expression around it goes — the same stamp an identifier gets.
        const name = node.object.type === "ThisExpression" && !node.computed && thisClass !== null
            ? fieldNameOf(node.property)
            : undefined;
        if (name !== undefined) {
            const use = makeUse(node.property);
            use.name = name;
            if (currentFeedTargets.length > 0) {
                use.feeds = currentFeedTargets.map(t => feedOf(t, currentFeedsInferred));
            }
            fieldReads.push({ cls: thisClass!, use, inReturnStatement, fn: currentFunction });
            return;
        }
        walkVariables(node.object, results, stack);
        if (node.computed) walkVariables(node.property, results, stack);
        return;
    }

    // TS-only declarations: interface Config, type Result
    // return to avoid getting TS declarations treated as references
    // Note: enum needs a separate handling since there could be variables inside
    if (
        node.type === "TSInterfaceDeclaration" ||
        node.type === "TSTypeAliasDeclaration"
    ) {
       stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "type"));
       return;
    }

    // For Enums, only go into the declared variables. 
    // (variables are in the `initializer` prop)
    if (node.type === "TSEnumDeclaration") {
        stack[stack.length - 1]!.declarations.push(makeBinding(node.id, "declaration", "type"));
        for (const member of node.body.members) {
            walkVariables(member.initializer!, results, stack);
        }
        return;
    }

    // Don't recurse into TypeAnnotation since it's just noise
    // and incorrectly puts the variable into uses array.
    //
    // Gap 15 — TSTypeAnnotation alone wasn't enough. It covers `x: T`, but type
    // space is reachable by several other routes that never pass through an
    // annotation node, and each one was handing the walker an identifier to
    // look up in the *value* scope chain:
    //
    //   function f<T>(x: T)      TSTypeParameter    — the `<T>` declaration
    //   const y = z as Foo       TSTypeReference    — every use of a type name
    //   const x = o as const     TSTypeReference    — yes, `const` is one
    //   foo<Bar>(1)              TSTypeReference    — call type arguments
    //   class D implements I     TSClassImplements  — no runtime effect
    //
    // On Hono `T` was the single most unresolved name (120), with E, P, S,
    // BasePath and JSX behind it — and where a value of the same name exists,
    // the leak isn't just noise, it's a phantom use pointing at a variable the
    // type never referred to.
    //
    // What must NOT be skipped, and isn't: `class D extends B` puts `B` on the
    // ClassDeclaration itself, and a superclass is a real runtime value. Same
    // for the left-hand side of `as` / `satisfies` / `!`, which live on their
    // own nodes rather than inside the type. Only the type halves go.
    if (
        node.type === "TSTypeAnnotation" ||
        node.type === "TSTypeParameter" ||
        node.type === "TSTypeReference" ||
        node.type === "TSClassImplements"
    ) {
        return;
    }

    // 4. plain object — recurse into every value.
    //
    // This is also the default handler for every node type without a branch
    // above. A bare expression statement — `rank(query)` — needs no case of
    // its own for exactly that reason: nothing in it declares anything, so
    // recursing generically makes every identifier inside it a use, which is
    // the correct answer.
    // A class's methods record which class they belong to, and inside its body
    // `this` is that class — field initialisers and arrows included.
    const isClass = node.type === "ClassDeclaration" || node.type === "ClassExpression";
    if (isClass) {
        const id = node.id ? node.id.range[0] : node.range[0];
        classStack.push(id);
        if (node.superClass?.type === "Identifier") {
            classSupers.set(id, { name: node.superClass.name, chain: chainOf(stack) });
        }
        savedThisClasses.push(thisClass);
        thisClass = id;
    }

    for (const value of Object.values(node)) {
        walkVariables(value, results, stack);
    }

    if (isClass) {
        classStack.pop();
        thisClass = savedThisClasses.pop() ?? null;
    }

        // AFTER the Object.values loop (pop):
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") {
        trace("scope", "leave function — its declarations move into the results list", -1);
        // get the top list
        const closing = stack[stack.length - 1]!;
        // Restore feed targets and function context when leaving a function scope
        currentFeedTargets = closing.savedFeedTargets ?? [];
        currentFeedsInferred = closing.savedFeedsInferred ?? false;
        currentFunction = closing.savedFunction ?? null;
        thisClass = closing.savedThisClass ?? null;

        // save the top list in results
        results.declarations.push(...closing.declarations);
        // pop it from the stack (stops being findable)
        stack.pop();
    }
    
    if (node.type === "BlockStatement") {
        trace("scope", "leave block — its declarations move into the results list", -1);
        const closing = stack[stack.length - 1]!;
        currentFeedTargets = closing.savedFeedTargets;
        currentFeedsInferred = closing.savedFeedsInferred ?? false;
        currentFunction = closing.savedFunction;
        results.declarations.push(...closing.declarations);
        stack.pop();
    }
}

// A binding position (variable id, function param, catch param) isn't always
// a plain identifier — it can be a destructuring pattern, a default value,
// or a rest element, and these nest inside each other. `kind` is the kind to
// tag every name found beneath this pattern with; `varType` carries the
// var/let/const keyword through to each leaf identifier.
/**
 * The names introduced by the declaration attached to an `export` — the `alpha`
 * in `export const alpha = 1`, the `makeThing` in `export function makeThing`.
 *
 * Separate from `collectPatternNames` because that one builds `Binding`s to put
 * into a scope, and this only needs the strings: the bindings themselves are
 * created by the ordinary walk a moment later, and creating them twice would
 * declare every exported name two times over.
 */
function exportedDeclarationNames(declaration: TSESTree.Node | null | undefined): string[] {
    if (!declaration) return [];
    const node = declaration as any;
    // export const a = 1, b = 2 — and destructuring patterns, which really do
    // export every leaf name: `export const { a, b } = obj` publishes both.
    if (node.type === "VariableDeclaration") {
        const found: Binding[] = [];
        for (const declarator of node.declarations) {
            collectPatternNames(declarator.id, found, "variable");
        }
        return found.map((binding) => binding.name);
    }
    // function / class / type / interface / enum — one name, on `id`.
    return node.id?.name ? [node.id.name] : [];
}

export function collectPatternNames(pattern: TSESTree.Node | null, declarations: Binding[], kind: Kind, varType = "") {
    if (pattern === null || pattern === undefined) {
        return;
    }

    switch (pattern.type) {
        // If the type is an identifier, it makes a Binding with a "declaration" tag
        // (because the variable is being declared)
        case "Identifier":
            trace("declare", `${pattern.name} (${kind}) at offset ${pattern.range[0]}`);
            declarations.push(makeBinding(pattern, "declaration", kind, varType));
            break;

        // { query, limit = 10 } — each property's value is itself a pattern;
        // { ...rest } shows up as a RestElement among the properties
        case "ObjectPattern":
            for (const prop of pattern.properties) {
                if (prop.type === "Property") {
                    collectPatternNames(prop.value, declarations, kind, varType);
                } else {
                    collectPatternNames(prop, declarations, kind, varType); // RestElement
                }
            }
            break;


        case "ArrayPattern":
            for (const element of pattern.elements) {
                collectPatternNames(element, declarations, kind, varType);
            }
            break;

        // y = 5 — the name lives on the left, the default on the right
        case "AssignmentPattern":
            collectPatternNames(pattern.left, declarations, kind, varType);
            break;

        // ...args
        case "RestElement":
            collectPatternNames(pattern.argument, declarations, kind, varType);
            break;

        // constructor(private x) — still a parameter, in its position. Missing
        // it shifted every later argument onto the wrong parameter.
        case "TSParameterProperty":
            collectPatternNames(pattern.parameter, declarations, kind, varType);
            break;
    }
}
