/**
 * Names that no project declares and every project uses. A use of `console`
 * failing to resolve is not the engine falling short — there was never
 * anything to find. Lumping these in with real misses put a permanent floor
 * under the resolution rate (on this repo `console` alone was 21 of 551) and
 * hid regressions behind it, so they get counted as `external` instead.
 *
 * Built-in *method* names are in here too — `push`, `map`, `log`. Those reach
 * the lookup because gap 1 resolves method calls by name, and nothing in a
 * project declares `push`. Exported because that same set is half of gap 1's
 * fix: knowing `Bun` is external is what should stop `Bun.file()` binding to
 * a local function called `file`.
 *
 * Deliberately not exhaustive, and deliberately not a correctness mechanism —
 * a name missing from here is counted as unresolved, which is the safe error.
 * Anything genuinely declared in the source still shadows this: the set is
 * only consulted after the scope chain has already come up empty.
 */
const GLOBAL_NAMES = [
    // Runtime objects and namespaces
    "globalThis", "console", "process", "Bun", "window", "document", "navigator",
    "performance", "crypto", "localStorage", "sessionStorage", "fetch", "Buffer",
    "require", "module", "exports", "__dirname", "__filename", "Intl",
    // Constructors and namespaces from the language itself
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math",
    "JSON", "Date", "RegExp", "Function", "Promise", "Map", "Set", "WeakMap",
    "WeakSet", "Proxy", "Reflect", "ArrayBuffer", "DataView", "Error", "TypeError",
    "RangeError", "SyntaxError", "ReferenceError", "URL", "URLSearchParams",
    "Response", "Request", "Headers", "Blob", "File", "FormData", "AbortController",
    "TextEncoder", "TextDecoder", "WebSocket", "Event", "CustomEvent",
    // Free functions and values
    "parseInt", "parseFloat", "isNaN", "isFinite", "structuredClone",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
    "encodeURIComponent", "decodeURIComponent", "NaN", "Infinity", "undefined",
];

/**
 * Method names the language and runtime define on their own objects. Kept
 * apart from the globals because gap 1 needs them on their own: when a project
 * declares a method with one of these names, `xs.map(f)` could be the array's
 * or the project's, and without types there is no telling which.
 */
export const BUILTIN_METHODS = new Set([
    "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join",
    "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every",
    "sort", "reverse", "includes", "indexOf", "keys", "values", "entries",
    "has", "get", "set", "add", "delete", "clear", "then", "catch", "finally",
    "toString", "valueOf", "trim", "split", "replace", "match", "test", "exec",
    "startsWith", "endsWith", "padStart", "padEnd", "repeat", "charAt",
    "toLowerCase", "toUpperCase", "stringify", "parse", "log", "warn", "error",
    "exit", "resolve", "reject", "all", "from", "of", "assign", "freeze",
]);

export const KNOWN_GLOBALS = new Set([...GLOBAL_NAMES, ...BUILTIN_METHODS]);
