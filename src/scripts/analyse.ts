import { collectVariables, relativeSpecifierResolver, type SpecifierResolver } from "./engine";
import { parse } from "@typescript-eslint/typescript-estree";
import { Glob } from "bun";
import type { Binding, Graph, GraphEdge, Results } from "./types";
import { dirname, isAbsolute, resolve } from "path";

/**
 * Directories that are never the user's own source. Without this a plain
 * `flow .` walks node_modules and parses every dependency — in this repo
 * that's 496 of 505 matched files, and the resulting graph runs to gigabytes.
 */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", "vendor",
  "*.min.js",
]);

/** Extensions the glob matches, in the order a resolver should prefer them */
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];


/**
 * Determines if a given path (relative to `projectDir`) is a project source file
 * worth analyzing, by filtering out ignored directories and ambient type declaration files.
 *
 * @param {string} relativePath - The path relative to the project directory.
 * @returns {boolean} True if the file should be analyzed as project source, false otherwise.
 */
export function isProjectSource(relativePath: string): boolean {
  if (relativePath.split("/").some((segment) => IGNORED_DIRS.has(segment))) return false;
  /**
   * Ambient type declarations: no runtime values, so no data flow to trace,
   * and they're the bulk of what ships inside packages.
   */
  if (relativePath.endsWith(".d.ts")) return false;
  /**
   * Minified bundles. IGNORED_DIRS catches the usual homes for vendored code,
   * but a checked-in bundle can live anywhere — `src/viewer/lib/cytoscape.min.js`
   * is under none of them, and on its own accounted for 8,621 of this repo's
   * 8,876 nodes. 97% of the graph was a dependency nobody wants to trace, and
   * it swamped every whole-project measurement.
   *
   * Filtering on the directory name wouldn't generalise — `lib/` is ordinary
   * source in plenty of projects. The property that actually matters is that
   * the file is minified: the names are mangled, so every edge is noise. The
   * `.min.` marker is the cheap version of that test; the general one is a
   * maximum line length, which needs the file's contents rather than its path.
   */
  if (/\.min\.[cm]?js$/.test(relativePath)) return false;
  return true;
}

/**
 * JSON with the parts a tsconfig is allowed to have and `JSON.parse` is not:
 * `//` and block comments, and trailing commas. Every real tsconfig in the wild
 * has at least the comments — the one TypeScript itself scaffolds is mostly
 * comments — so a strict parse throws on the common case and the alias map
 * silently comes back empty.
 *
 * String-aware rather than a pair of regexes, because a specifier like
 * `"https://example.com"` contains a `//` that must survive, and a Windows path
 * contains escapes that must not end the string early.
 */
export function parseJsonc(text: string): any {
  let out = "";
  let inString = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!, next = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; }        // escape: copy the pair verbatim
      else if (c === '"') inString = false;
      continue;
    }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === '"') inString = true;
    out += c;
  }
  // Trailing commas, now that no comma inside a string can be mistaken for one.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The two fields of a tsconfig that decide what a bare specifier means. */
type PathsConfig = { baseUrl?: string; paths: Record<string, string[]> };

/**
 * Read `baseUrl` and `paths` out of a project's tsconfig, following `extends`.
 *
 * Both are resolved to absolute paths here rather than at match time: `baseUrl`
 * is relative to the file that declares it, and a config three `extends` deep
 * declares it relative to *itself*, so the base has to be pinned as each file is
 * read or the meaning drifts with the inheritance chain.
 */
async function readPathsConfig(dir: string): Promise<PathsConfig> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const result = await readConfigFile(resolve(dir, name), new Set());
    if (result) return result;
  }
  return { paths: {} };
}

/**
 * One config file by its exact path, plus whatever it `extends`. Undefined when
 * the file doesn't exist, so the caller can fall through to the next candidate.
 *
 * Takes a file, not a directory, because `extends` names a file. Handing the
 * parent's *directory* back to the tsconfig.json/jsconfig.json search threw the
 * name away, so `"extends": "./tsconfig.base.json"` — the usual monorepo
 * spelling — was never read and its aliases were all scored as packages.
 */
async function readConfigFile(configPath: string, seen: Set<string>): Promise<PathsConfig | undefined> {
  if (seen.has(configPath)) return { paths: {} };         // extends cycle
  const file = Bun.file(configPath);
  if (!(await file.exists())) return undefined;
  seen.add(configPath);
  const dir = dirname(configPath);

  let config: any;
  try { config = parseJsonc(await file.text()); }
  catch { return { paths: {} }; }                          // malformed: no aliases, not a crash

  // Inherited first, so the child's own settings win on conflict.
  let result: PathsConfig = { paths: {} };
  const extendsField = config.extends;
  for (const parent of Array.isArray(extendsField) ? extendsField : extendsField ? [extendsField] : []) {
    if (typeof parent !== "string" || !parent.startsWith(".")) continue;   // package extends: not resolvable here
    // TypeScript accepts `"extends": "./base"` for `./base.json`.
    const parentPath = resolve(dir, parent);
    const inherited =
      (await readConfigFile(parentPath, seen)) ??
      (parentPath.endsWith(".json") ? undefined : await readConfigFile(`${parentPath}.json`, seen));
    if (!inherited) continue;
    result = { baseUrl: inherited.baseUrl ?? result.baseUrl, paths: { ...result.paths, ...inherited.paths } };
  }

  const options = config.compilerOptions ?? {};
  if (typeof options.baseUrl === "string") result.baseUrl = resolve(dir, options.baseUrl);
  if (options.paths && typeof options.paths === "object") {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) result.paths[pattern] = targets as string[];
    }
  }
  // `paths` without `baseUrl` has been legal since TS 4.1, and then targets
  // are relative to the config file itself.
  if (Object.keys(result.paths).length && !result.baseUrl) result.baseUrl = dir;
  return result;
}

/**
 * Every path a `paths` pattern says a specifier could mean, in the order the
 * config lists them. Empty when no pattern matches, which is the signal that
 * the specifier really is a package and should be left alone.
 *
 * A pattern holds at most one `*`, and TypeScript's rule is that the longest
 * matching prefix wins — `"@/core/*"` beats `"@/*"` for `"@/core/thing"` — so an
 * exact (starless) match is tried first and prefix matches are ranked by length.
 */
export function aliasCandidates(raw: string, config: PathsConfig): string[] {
  const base = config.baseUrl;
  if (!base) return [];

  const expand = (targets: string[], wildcard: string) =>
    targets.map((target) => resolve(base, target.replace("*", wildcard)));

  const exact = config.paths[raw];
  if (exact) return expand(exact, "");

  let best: { targets: string[]; wildcard: string; length: number } | undefined;
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
    if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) continue;
    if (raw.length < prefix.length + suffix.length) continue;
    if (best && prefix.length <= best.length) continue;
    best = { targets, wildcard: raw.slice(prefix.length, raw.length - suffix.length), length: prefix.length };
  }
  return best ? expand(best.targets, best.wildcard) : [];
}

/**
 * Which analysed file an import specifier names. 
 * @param base: the absolute path (extensionless (e.g. .ts, .js)) path the engine produced
 * @param files: A set of files that will be checked
 * @returns the matching key of `files` or undefined if the import points outside
 * the analysed set.
 */
export function resolveImport(base: string, files: Set<string>) : string | undefined {
    // 1. First case: If the base file exists (e.g. /project/util)
    // return it.
    if (files.has(base)) return base;
    
    // 2. Second case: If the base file with the extension exists (e.g. /project/util.ts)
    // return it.
    for (const extension of IMPORT_EXTENSIONS) {
      const candidate = base + extension;
      if (files.has(candidate)) return candidate;
    }

    // 3. Third case: Directory imports. The default file that's imported
    // whenever a directory instead of a file is imported is "index.ts" (Node convention).
    for (const extension of IMPORT_EXTENSIONS) {
      const candidate = base + "/index" + extension;
      if (files.has(candidate)) return candidate;
    }

    // 4. Fourth case: JS paths instead of TS paths. (Same for JSX --> TSX)
    if (base.endsWith(".js")) {
      const sibling = base.slice(0, -3) + ".ts";
      if (files.has(sibling)) return sibling;
    }

    if (base.endsWith(".jsx")) {
      const sibling = base.slice(0, -4) + ".tsx";
      if (files.has(sibling)) return sibling
    }

    return undefined;
}

/**
 * Whether to parse this file as JSX.
 *
 * The glob has always matched `.tsx` and `.jsx`, but the parser was never told
 * about them, so every JSX file in a project failed — `<div>` was read as a
 * less-than and the errors landed several tokens later ("Unterminated regular
 * expression literal"), pointing nowhere near the cause. On Hono that was 21
 * files, and every parse failure in the repo was one of them.
 *
 * `.ts` is the one extension that must stay false: there `<T>expr` is a type
 * assertion, and turning JSX on would reinterpret it as an unclosed element.
 * That ambiguity is exactly why TypeScript splits `.ts` from `.tsx` in the
 * first place. Everything else the glob matches can carry JSX — `.js` files
 * routinely do — and none of them have the type-assertion syntax to lose.
 */
export function allowsJsx(path: string): boolean {
    return !path.endsWith(".ts");
}

/**
 * Longest snippet stored per edge occurrence. A minified file is a handful
 * of lines hundreds of kilobytes wide (cytoscape.min.js: 33 lines, longest
 * 229k chars); storing one verbatim per edge is what turned a 9-file graph
 * into 1.1GB of JSON. The viewer only renders a single line anyway.
 */
const MAX_SNIPPET = 200;

/**
 * A declaration's file+start is unique, so it doubles as a stable node id
 * for edges (feeds targets are stamped with the same file+start).
 * 
 * @param {string} file: the file it takes in
 * @param {number} start: start number (unique for each node)
 * @returns {string} a string combining the file and start position (number)
 */
function nodeId(file: string, start: number): string {
  return `${file}:${start}`;
}

/**
 * The declaration behind a name that some module publishes — following the
 * chain of re-exports for as long as one continues (gap 21).
 *
 * The old one-hop version asked "is there a declaration called `name` inside
 * this file?", which is the wrong question for a barrel. `export { makeThing }
 * from "./thing"` creates no local binding whatsoever — referencing the name
 * inside the barrel is a ReferenceError — so the answer was always no, and the
 * 2,459 specifiers on excalidraw that land on a barrel all linked to nothing.
 *
 * Four ways to answer, most precise first:
 *
 *   1. the file's own export table — a name it publishes and declares itself;
 *   2. a named re-export — forward the *source's* name, which is not always the
 *      one this module publishes it under (`export { default as Widget }`);
 *   3. a bare `export * from` — the star names nothing, so an unmatched name has
 *      to be *searched* for across every star source in turn;
 *   4. any declaration in the file with that name, exported or not.
 *
 * (4) is the behaviour that existed before this function did, kept as a last
 * resort rather than replaced. The export table is built from the syntax and
 * anything it misses would otherwise become a link that used to work and
 * silently stopped — so the precise answers get to go first, and the loose one
 * still catches whatever they don't. It only ever adds links, never removes.
 *
 * `seen` is not optional: `export *` cycles between two barrels are ordinary in
 * real projects, and without it the first one hangs the analysis.
 */
function resolveExportedName(
  file: string,
  name: string,
  treeResults: Record<string, Results>,
  analysedFiles: Set<string>,
  seen: Set<string>,
): Binding | undefined {
  // A namespace import binds the whole module object, not one declaration.
  // Reaching the members would mean resolving `ns.foo` at each use site, which
  // is a different problem entirely — so this returns nothing rather than
  // guessing at a declaration the import never named.
  if (name === "*") return undefined;

  const key = `${file}\u0000${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const results = treeResults[file];
  if (!results) return undefined;

  const declaredHere = (local: string) =>
    results.declarations.find((declaration) => declaration.name === local);

  /** Continue into the module `source` names, asking it for `wanted`. */
  const follow = (source: string | undefined, wanted: string) => {
    if (!source) return undefined;
    const next = resolveImport(source, analysedFiles);
    return next ? resolveExportedName(next, wanted, treeResults, analysedFiles, seen) : undefined;
  };

  // 1. Published by this file under a name it declares itself.
  const local = results.exports.get(name);
  if (local) {
    const declaration = declaredHere(local);
    // `import { x } from "./a"; export { x }` — the other spelling of a barrel.
    // The local name is bound, but to an import, so the real declaration is one
    // module further on and under the name *that* module knows it by.
    if (declaration?.kind === "import") {
      const hit = follow(declaration.source, declaration.imported ?? declaration.name);
      if (hit) return hit;
    } else if (declaration) {
      return declaration;
    }
  }

  // 2. Forwarded by name from somewhere else.
  for (const reExport of results.reExports) {
    if (reExport.star || reExport.exported !== name) continue;
    const hit = follow(reExport.source, reExport.local!);
    if (hit) return hit;
  }

  // 3. Forwarded by a wildcard. `export * as ns from` is excluded on purpose:
  // it republishes the module as a single namespace rather than spilling its
  // names into this one, so searching through it for an arbitrary name would
  // invent a link the source never offered.
  for (const reExport of results.reExports) {
    if (!reExport.star || reExport.namespace) continue;
    const hit = follow(reExport.source, name);
    if (hit) return hit;
  }

  // 4. Pre-existing behaviour: any declaration of that name in the file.
  return results.declarations.find(
    (declaration) => declaration.name === name && declaration.kind !== "import"
  );
}

/**
 * Analyzes all source files in the given project directory, building a comprehensive
 * data flow graph of declarations, uses, and flow connections (feeds/returns/edges).
 *
 * @param {string} projectDir - The path to the root directory to be analyzed.
 * @returns {Promise<{
 *   graph: Graph,                                 // The constructed data flow graph.
 *   filesAnalysed: number,                        // Number of files successfully analyzed.
 *   lookups: {                                    // Stats on identifier lookups.
 *     resolved: number,                           // Identifiers resolved to a declaration.
 *     unresolved: number,                         // Identifiers not resolved.
 *     external: number                            // Identifiers resolved as external (globals).
 *   },
 *   skipped: { file: string, reason: string }[]   // Files that could not be parsed and why.
 * }>}
 */
export async function analyse(projectDir: string): Promise<{
  graph: Graph,
  filesAnalysed: number,
  /** Every identifier lookup across every file, bucketed. `unresolved` is the
   *  one to watch: `external` is names no project declares (see KNOWN_GLOBALS
   *  in engine.ts), so only this number moving means coverage changed. */
  lookups: { resolved: number, unresolved: number, external: number },
  /** Files matched by the glob that could not be parsed, with the parser's
   *  first line of complaint. Empty on a clean run. Each entry is a file
   *  missing from the graph, so a consumer that cares about completeness has
   *  to look here — nothing else signals the loss. */
  skipped: { file: string, reason: string }[],
  /** In-project import specifiers that reached no declaration — `imports.noFile`
   *  plus `imports.noDeclaration`. Package imports are not failures and are not
   *  counted. See `imports` for which kind of failure, which is the part that
   *  tells you whether the resolver or the export-chain walk is at fault. */
  unlinkedImports: number,
  /** Every import specifier bucketed by outcome. The cross-file linkage rate is
   *  `linked / (linked + noFile + noDeclaration)` — in-project specifiers only,
   *  since `external` is a dependency that was never meant to link and
   *  `typeOnly` / `namespace` could not have. That is the number that reads 80%
   *  on a repo of relative imports and collapsed to 44% on a monorepo. */
  imports: {
    total: number,
    typeOnly: number,
    namespace: number,
    external: number,
    noFile: number,
    noDeclaration: number,
    linked: number,
  },
}> {
  // keep each file's source around so edge clicks can show the actual code
  // at the use site, not just a file:line reference.
  const fileTexts: Record<string, string> = {};

  /** Lines per file, split once — `codeAt` is called for every occurrence of
   *  every edge, and re-splitting a large source each time is not free. */
  const fileLines: Record<string, string[]> = {};

  /** The source line (trimmed, truncated) at `file:line`, for edge-click display. */
  function codeAt(file: string, line: number): string {
    const lines = (fileLines[file] ??= fileTexts[file]?.split("\n") ?? []);
    const text = lines[line - 1]?.trim() ?? "";
    return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
  }

  const glob = new Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");

  // Step 0: collect the file list before parsing any of it. Scanning and
  // parsing used to be one pass, which meant the set of project files wasn't
  // known until the last file had been walked — and an alias resolver has to
  // choose between the several targets a `paths` entry can list, which it can
  // only do by asking which of them exists. Splitting the pass costs one extra
  // traversal of an in-memory list and makes that question answerable.
  const sourcePaths: string[] = [];
  for await (const file of glob.scan(projectDir)) {
    // disregards non-project source files
    // specified in the isProjectSource function
    if (!isProjectSource(file)) continue;
    sourcePaths.push(resolve(projectDir, file));
  }
  const projectFiles = new Set(sourcePaths);

  // Gap 22: teach the walker this project's own specifier vocabulary. Without
  // it every aliased import is read as a package and skipped, which on a repo
  // that uses them is not an edge case — it was a third of all in-project
  // imports on excalidraw, and each one hid a whole subtree.
  const pathsConfig = await readPathsConfig(projectDir);
  const usesAliases = Object.keys(pathsConfig.paths).length > 0;
  const resolveSpecifier: SpecifierResolver = usesAliases
    ? (raw, importerFile) => {
        if (raw.startsWith(".")) return resolve(dirname(importerFile), raw);
        const candidates = aliasCandidates(raw, pathsConfig);
        // No pattern matched, so this really is a package — leave it as written
        // so it stays distinguishable from an in-project import that failed.
        if (!candidates.length) return raw;
        // A matched pattern with several targets is a fallback list; the first
        // one that names a real file is the one meant. Falling back to
        // candidates[0] when none do keeps the failure *visible*: it is an
        // absolute path, so the unlinked counter sees an in-project miss rather
        // than mistaking it for a dependency.
        return candidates.find((candidate) => resolveImport(candidate, projectFiles)) ?? candidates[0]!;
      }
    : relativeSpecifierResolver;

  // Step 1: parse + walk every file in the project.
  const treeResults: Record<string, Results> = {};
  const skipped: { file: string, reason: string }[] = [];

  for (const absolutePath of sourcePaths) {
    // reads the file's text content
    const code = await Bun.file(absolutePath).text();

    // Parse, and survive files that don't. A project you didn't write will
    // contain something this parser can't handle — a syntax level newer than
    // the installed version, a file the glob shouldn't have matched, a
    // half-finished edit. Letting that throw meant one bad file produced no
    // graph at all rather than a graph missing one file, which is the
    // difference between a degraded result and no result. Skips are collected
    // and returned rather than swallowed: an unanalysed file is a hole in the
    // graph, and a hole nobody is told about is worse than one they are.
    let tree;
    try {
      tree = parse(code, { loc: true, range: true, jsx: allowsJsx(absolutePath) });
    } catch (error) {
      skipped.push({ file: absolutePath, reason: String((error as Error).message).split("\n")[0]! });
      continue;
    }

    // collects the variables in the AST
    // and stores the results in the treeResults object
    // format: {"some path": Results}
    treeResults[absolutePath] = collectVariables(tree, absolutePath, resolveSpecifier);
    // stores the file's text content
    fileTexts[absolutePath] = code;
  }

  // Step 2: for each file, for each import declaration, find the real
  // declaration in the source file and move the uses onto it.
  const analysedFiles = new Set(Object.keys(treeResults));

  // Where every import specifier ended up. One number used to stand for this,
  // and it could only ever see one of the several ways an import fails: it
  // required `!resolvedSource`, so a specifier that found the right file and
  // then failed to find the name in it — every barrel — was counted as a
  // success. The instrument was wired to the wrong pipe, which is why the
  // project's cross-file coverage looked fine from the inside for so long.
  const imports = {
    /** Every import specifier in the project, of every kind. */
    total: 0,
    /** `import type` — no value crosses, so it can never carry an edge and is
     *  excluded from the denominator rather than counted as a failure. */
    typeOnly: 0,
    /** `import * as ns` — binds a module object, not a declaration. Excluded
     *  for the same reason: reaching `ns.foo` is member resolution, a different
     *  problem, and scoring it here would bury the two this pass is about. */
    namespace: 0,
    /** Specifier names no file in the project and doesn't look like it should:
     *  an ordinary dependency, correctly skipped. */
    external: 0,
    /** Points inside the project but no such file — a broken or unresolvable
     *  path. Includes an alias whose `paths` pattern matched but whose targets
     *  don't exist, which is why the resolver returns an absolute path even
     *  when it can't confirm one. */
    noFile: 0,
    /** The file was found and the name was not: gap 21's signature. Watch this
     *  one against `linked` — it is the barrel number. */
    noDeclaration: 0,
    /** Reached a real declaration. The numerator. */
    linked: 0,
  };

  /** Gap 16: placeholder node id → the parameter it turned out to mean. */
  const deferredFeedResolutions = new Map<string, Binding>();

  for (const fileResults of Object.values(treeResults)) {
    for (const binding of fileResults.declarations) {
      // disregard non-import bindings
      if (binding.kind !== "import") continue;
      imports.total++;

      // Only specifiers that could have carried a value are scored.
      const scored = !binding.typeOnly && binding.imported !== "*";
      if (binding.typeOnly) imports.typeOnly++;
      else if (binding.imported === "*") imports.namespace++;

      // assign the source of the import
      const resolvedSource = resolveImport(binding.source!, analysedFiles);

      if (!resolvedSource) {
        // An absolute source is one the resolver recognised as in-project —
        // relative, or a matched alias — so failing it is this engine's bug.
        // Anything still bare is a package, and skipping it is correct.
        if (scored) isAbsolute(binding.source!) ? imports.noFile++ : imports.external++;
        continue;
      }

      // Ask the module for the name *it* knows this by, and let it forward the
      // question through as many re-exports as it takes.
      const realDec = resolveExportedName(
        resolvedSource,
        binding.imported ?? binding.name,
        treeResults,
        analysedFiles,
        new Set(),
      );

      if (!realDec) {
        if (scored) imports.noDeclaration++;
        continue;
      }
      if (scored) imports.linked++;

      // Gap 16: this import is now linked, so any call site that deferred its
      // argument→parameter feed can be answered. Record the answer keyed by the
      // placeholder's file+start; the feed entries themselves are patched in one
      // pass below, because `use.feeds` holds copies rather than the placeholder.
      for (const d of fileResults.deferredCallFeeds) {
        if (d.callee !== binding) continue;
        const realParam = realDec.params?.[d.argIndex];
        if (!realParam) continue;
        // Set the key value pair HERE ("file.ts:-1": realParam (Binding))
        deferredFeedResolutions.set(nodeId(binding.file, d.id), realParam);
      }

      realDec.uses.push(...binding.uses);
    }
  }

  // Step 2b (gap 16): rewrite the deferred feed entries now that every import
  // that could be linked has been. One pass over every use rather than a scan
  // per deferral — there are far more uses than deferrals, and this way the
  // cost is paid once. A placeholder with no resolution is left as it is: its
  // negative start can't match any node id, so step 4's `nodeIds.has(target)`
  // guard drops it and the call site simply produces no edge, exactly as
  // before this gap was fixed.
  for (const fileResults of Object.values(treeResults)) {
    for (const declaration of fileResults.declarations) {
      for (const use of declaration.uses) {
        if (!use.feeds) continue;
        for (const fed of use.feeds) {
          // if fed.start < 0, this is the <blank> that we set in engine.ts
          if (fed.start >= 0) continue;
          // Get the key value pair HERE with the key set above.
          const realParam = deferredFeedResolutions.get(nodeId(fed.file, fed.start));
          if (!realParam) continue;
          fed.name = realParam.name;
          fed.file = realParam.file;
          fed.line = realParam.line;
          fed.start = realParam.start;
        }
      }
    }
  }

  // Step 3: move the declarations into a flat "nodes" array:
  // every declaration from every file, uses already attached.
  const graph: Graph = { root: projectDir, nodes: [], edges: [] };

  for (const fileResults of Object.values(treeResults)) {
    for (const declaration of fileResults.declarations) {
      // skip every non-declaration (use) role
      if (declaration.role !== "declaration") continue;

      // skip every node that has imports
      if (declaration.kind === "import") continue;

      graph.nodes.push({ ...declaration, id: nodeId(declaration.file, declaration.start) });
    }
  }

  // Step 4: read the feeds stamped on each use: the use's owning declaration is
  // the thing being used, and use.feeds names the declaration that use flows into.
  // Draw an edge owning declaration -> fed declaration for each one, keeping
  // every use site that contributed to it so clicking the edge can show the code.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgesByKey = new Map<string, GraphEdge>();
  // Gap 18: an edge is only "inferred" if *every* use behind it was. One proven
  // use is enough to make the edge real, so this ANDs rather than ORs — tracked
  // beside the edge because the answer isn't known until the last contributor.
  const allInferred = new Map<string, boolean>();
  for (const node of graph.nodes) {
    for (const use of node.uses) {
      if (!use.feeds) continue;
      // One use can feed several declarations — `const { a, b } = foo()`
      // reads foo once and flows into both — so this is a list, and each
      // entry becomes its own edge from the same use site.
      for (const fed of use.feeds) {
        const target = nodeId(fed.file, fed.start);
        // the fed declaration may have been filtered out (e.g. an import);
        // only keep edges where both ends are real graph nodes.
        if (!nodeIds.has(target)) continue;

        const key = `${node.id}->${target}`;
        let edge = edgesByKey.get(key);
        if (!edge) {
          edge = { source: node.id, target, occurrences: [] };
          edgesByKey.set(key, edge);
        }
        edge.occurrences.push({ file: use.file, line: use.line, code: codeAt(use.file, use.line) });
        allInferred.set(key, (allInferred.get(key) ?? true) && fed.inferred === true);
      }
    }
  }
  // Stamped only when true, so a proven edge keeps the shape it always had.
  for (const [key, edge] of edgesByKey) {
    if (allInferred.get(key)) edge.inferred = true;
  }
  graph.edges.push(...edgesByKey.values());

  // Roll every file's lookup tally into one. Without this the counts stay
  // buried in each file's Results and the only way to read them is to attach
  // a trace hook and scrape the phase line, which is no way to watch a number
  // you want to treat as a regression signal.
  const lookups = { resolved: 0, unresolved: 0, external: 0 };
  for (const fileResults of Object.values(treeResults)) {
    lookups.resolved += fileResults.lookups.resolved;
    lookups.unresolved += fileResults.lookups.unresolved;
    lookups.external += fileResults.lookups.external;
  }

  // Kept as the headline regression number it has always been, but now it can
  // actually see both failure modes: a specifier that found no file, and one
  // that found the file and not the name.
  const unlinkedImports = imports.noFile + imports.noDeclaration;

  return {graph, filesAnalysed: Object.keys(treeResults).length, lookups, skipped, unlinkedImports, imports};
}