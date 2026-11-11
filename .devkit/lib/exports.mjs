/**
 * Publish gate: the checks that only fail at a consumer.
 *
 * Every defect this catches was a real one in one of these packages, and none of
 * them failed `tsc`, `eslint`, or `vitest` — they only surfaced when something
 * outside the repo imported the built output. So they run on `prepack` and
 * `prepublishOnly`, and in `check` where the repository puts them there, which is
 * where a failure is cheapest.
 *
 * They read `dist/`, so anything running them builds first.
 *
 * Checks every repository gets:
 *
 *   1. Every `exports` subpath resolves to a file that actually emitted.
 *   2. No relative import in `dist/` omits its `.js` extension (Node ESM throws
 *      `ERR_MODULE_NOT_FOUND` on those; `moduleResolution: "Bundler"` does not).
 *      Read in the declarations as well as the emitted JavaScript: a **type-only**
 *      relative import is erased from the `.js` and survives only in the `.d.ts`,
 *      so scanning one file class leaves the other unchecked, and a missing
 *      extension there breaks a consumer's typecheck instead of their bundle.
 *   3. No spec files reached `dist/`.
 *   4. No source maps reached `dist/`. Their `sources` is `../src/*.ts`, which
 *      is not published, so every one is dangling — and a consumer's test runner
 *      prints "Sourcemap for … points to missing source files" once per module
 *      it loads, every run. `build` cleans `dist/` first, so this also catches
 *      the stale-artifact case that made the original defect survive a rebuild.
 *   5. Realm isolation: no *runtime* subpath can reach `node:*`, `undici`,
 *      `cloudflare:test` or `vitest` through any depth of relative import.
 *   6. Every bare specifier a subpath reaches is a declared dependency. Hoisting
 *      makes an undeclared one work in the repo it was written in and nowhere
 *      stricter.
 *
 * Checks a repository asks for in the `exports` section of its `devkit.config.mjs`:
 *
 *   - `realmExempt`: subpaths that are a test harness and are expected to reach
 *     the test-only modules. Such a subpath is separate precisely so it cannot
 *     enter a runtime graph.
 *   - `nodeOnly`: subpaths that are a container image's entrypoint rather than a
 *     Worker's import. `node:*` is their realm; the rest of check 5 still holds.
 *   - `buildsOn`: turns on **subpath isolation** and declares its exceptions. No
 *     subpath's module graph may reach a file belonging to another subpath,
 *     except one it is declared to build on. This is the promise a package of
 *     composable parts is built around — a bundle grows only with what it
 *     imports — and it is the one that rots silently, because a convenience
 *     re-export across two parts typechecks, lints, and tests perfectly while
 *     quietly doubling every consumer's bundle. Only a check on the built graph
 *     catches it. An empty object turns the rule on with no exceptions.
 *   - `forbidRootExport`: no `"."` entry, for the same reason.
 *   - `zeroDependencies`: `dist/` contains no bare import at all, and the
 *     manifest declares no dependencies of any kind. For the wire contract both
 *     sides of a boundary depend on, "zero dependencies" is not a preference: it
 *     is the property that makes the package safe for both, and a promise in a
 *     README is not a mechanism. One `import { X } from "jose"` and the reason to
 *     have split it out is gone, silently, in a patch release.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { section } from "./config.mjs";
import { readManifest } from "./repo.mjs";

/** The section of the repository's config this checker reads. */
const SECTION = "exports";

/** The one test-only pattern a Node-realm subpath is allowed to reach. */
const NODE_REALM = /^node:/;

/**
 * Bare specifiers that must never be reachable from a runtime subpath.
 *
 * `NODE_REALM` is in here by identity rather than by a second literal, because
 * a Node-realm subpath is checked against this list with that one pattern
 * removed. Two equal literals are two objects, and the filter would silently
 * remove neither.
 */
const TEST_ONLY = [NODE_REALM, /^undici$/, /^cloudflare:test$/, /^vitest$/];

/**
 * Drop comments, so prose is never mistaken for code.
 *
 * The scan below is a regex over text rather than an AST walk, and a doc comment
 * is free to *discuss* an import — these checks are documented with the
 * specifiers they were written for. Without this, explaining a defect in a
 * comment is enough to re-report it, which is the fastest way to make a publish
 * gate something people learn to override.
 *
 * String-aware, because `"image/*"` is a real value in this train and a naive
 * strip would eat from there to the next `*​/`. Line comments are only recognised
 * at the start of a line, which is where every one in emitted output lives and
 * where a regex literal never is — that avoids having to lex regexes to tell
 * `/\/\//` from a comment.
 */
export function stripComments(source) {
  let out = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += source[++i] ?? "";
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/" && /(^|\n)[ \t]*$/.test(out)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const importsIn = (source) =>
  [...stripComments(source).matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
    (match) => match[1]
  );

/**
 * Everything reachable from `entry` through relative imports: the bare
 * specifiers it ends at, and every local file it walked through on the way.
 *
 * A declaration graph is walked in declaration space. `tsc` emits a `.js`
 * specifier in a `.d.ts` as well, and that `.js` exists right beside the `.d.ts`
 * in `dist/` — so resolving naively would step out of the types graph on the
 * first hop and silently re-walk the runtime one, which is exactly the graph
 * that has already erased the type-only imports a declaration pass exists to
 * see.
 */
export function reachableFrom(entry) {
  const declarations = entry.endsWith(".d.ts");
  const resolve = (from, spec) => {
    const target = path.resolve(path.dirname(from), spec);
    if (!declarations || !target.endsWith(".js")) return target;
    const dts = `${target.slice(0, -".js".length)}.d.ts`;
    return existsSync(dts) ? dts : target;
  };

  const files = new Set();
  const bare = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const spec of importsIn(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) stack.push(resolve(file, spec));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * A specifier that could actually be a package.
 *
 * A second line of defence behind {@link stripComments}: the scan is a regex
 * over text, not an AST walk, so anything that survives and does not even have
 * the shape of a package name is prose rather than a dependency. Reporting one
 * as undeclared is how a publish gate earns a reputation for crying wolf.
 */
const PACKAGE_SPECIFIER =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*/i;

/** `@scope/name/deep/path` → `@scope/name`; `name/sub` → `name`. */
const packageName = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/** A subpath is covered by a list entry when it is that entry or is under it. */
const listed = (list, subpath) =>
  list.some((entry) => subpath === entry || subpath.startsWith(`${entry}/`));

/** `./browser` → `dist/browser` — the directory a subpath's files must stay in. */
const ownDir = (root, subpath) =>
  path.join(root, "dist", subpath.replace(/^\.\//, ""));

/**
 * Every reason the built output at `root` is not safe to publish.
 *
 * `config` is the loaded `devkit.config.mjs`; a repository that writes no
 * `exports` section gets the checks every repository gets and none of the ones
 * it has to ask for.
 */
export function verifyExports(root, config) {
  const pkg = readManifest(root);
  const rules = section(config, SECTION) ?? {};
  const realmExempt = rules.realmExempt ?? [];
  const nodeOnly = rules.nodeOnly ?? [];
  const buildsOn = rules.buildsOn;
  const zeroDependencies = rules.zeroDependencies === true;

  const failures = [];
  const fail = (message) => failures.push(message);
  const relative = (file) => path.relative(root, file);

  // --- 1. every exports target exists ---------------------------------------

  const subpathEntries = [];
  /** Every subpath's `types` target, for the checks that must see erased imports. */
  const typeEntries = [];
  const subpaths = Object.entries(pkg.exports ?? {});
  for (const [subpath, value] of subpaths) {
    const targets = typeof value === "string" ? [value] : Object.values(value);
    for (const target of targets) {
      if (!existsSync(path.join(root, target))) {
        fail(`exports "${subpath}" points at ${target}, which does not exist`);
      }
    }
    const runtime = typeof value === "string" ? value : value.import;
    if (runtime?.endsWith(".js")) subpathEntries.push([subpath, runtime]);
    const types = typeof value === "string" ? undefined : value.types;
    if (types?.endsWith(".d.ts")) typeEntries.push([subpath, types]);
  }

  // --- 2, 3 & 4. what reached dist/ -----------------------------------------

  let modules = 0;
  for (const file of walk(path.join(root, "dist"))) {
    if (/\.spec\.(js|d\.ts)$/.test(file)) {
      fail(`spec file shipped to dist: ${relative(file)}`);
    }
    if (file.endsWith(".map")) {
      fail(
        `source map shipped to dist: ${relative(file)} — its sources ` +
          `are under src/, which this package does not publish, so it dangles at ` +
          `every consumer`
      );
    }
    if (!/\.(js|d\.ts)$/.test(file)) continue;
    if (file.endsWith(".js")) modules += 1;
    for (const spec of importsIn(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        if (!spec.endsWith(".js")) {
          fail(
            `${relative(file)} imports "${spec}" without a .js extension ` +
              `— Node ESM will throw ERR_MODULE_NOT_FOUND`
          );
        }
      } else if (zeroDependencies) {
        fail(
          `${relative(file)} imports "${spec}" — this package must have no ` +
            `dependencies, so that either side of the boundary can depend on it ` +
            `without importing the other's runtime`
        );
      }
    }
  }

  // --- 5 & the subpath isolation a repository asks for ----------------------

  for (const [subpath, target] of subpathEntries) {
    const { files, bare } = reachableFrom(path.join(root, target));

    if (!listed(realmExempt, subpath)) {
      // An image's entrypoint runs in Node, never in a Worker bundle: `node:*` is
      // its realm, and only the test-only modules are not.
      const realm = listed(nodeOnly, subpath)
        ? TEST_ONLY.filter((pattern) => pattern !== NODE_REALM)
        : TEST_ONLY;
      const leaked = [...bare].filter((spec) =>
        realm.some((pattern) => pattern.test(spec))
      );
      if (leaked.length > 0) {
        fail(
          `runtime subpath "${subpath}" can reach test-only modules: ${leaked.join(", ")}`
        );
      }
    }

    // A part may reach only its own directory. Code only one part consumes lives
    // inside that part's directory; reaching *out* into a sibling is what must
    // not happen.
    if (buildsOn !== undefined) {
      const homes = [subpath, ...(buildsOn[subpath] ?? [])].map((home) =>
        ownDir(root, home)
      );
      const trespass = [...files]
        .filter((file) => !homes.some((home) => file.startsWith(home + path.sep)))
        .map(relative);
      if (trespass.length > 0) {
        fail(
          `subpath "${subpath}" reaches outside its own directory: ${trespass.join(", ")}. ` +
            `Installing one part would pull in another's code. Duplicate the helper, ` +
            `or move it inside the only part that uses it.`
        );
      }
    }
  }

  // --- 6. every bare specifier is declared ----------------------------------

  /**
   * A package a consumer must install is one this package must declare. Anything
   * else works in the repo it was written in and only there, because npm hoists a
   * transitive dependency into a flat `node_modules` that a consumer's package
   * manager may not reproduce — pnpm and Yarn PnP do not, and neither does npm
   * once the intermediate package restructures.
   *
   * The defect that motivated it: a package was imported for one error class
   * from a subpath every consumer loads, while appearing in no dependency field
   * at all. It resolved through another dependency's own copy, so nothing in that
   * repo noticed — the exact shape of failure this file exists to catch.
   *
   * Both graphs are walked, and the `.d.ts` one is not optional. A **type-only**
   * import is erased from the emitted `.js` and survives only in the
   * declarations, so scanning the runtime graph alone would report "every import
   * declared" while an undeclared package still breaks a pnpm or Yarn PnP
   * consumer's `tsc`. That was how the type-only half of that same usage
   * surfaced once the value import had moved.
   *
   * The declaration graph feeds **only this check**. Realm isolation and subpath
   * isolation stay on the runtime graph, because a type-only import costs a
   * consumer no bundle and no realm: `import type` from a Node-realm module is
   * erased before anything loads it.
   *
   * `node:*` and `cloudflare:*` are excluded because check 5 already governs who
   * may reach them, and subpath imports (`ai/test`, `agents/experimental/...`) are
   * reduced to their package name before the lookup. The package's own name is
   * allowed: a self-reference resolves through `exports`, which check 1 has
   * already verified.
   */
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {})
  ]);

  // Subsumed under `zeroDependencies`, which has already failed every bare
  // import in `dist/`, declared or not, in both file classes. Running this as
  // well would report one import twice, and a gate that double-counts is one
  // people read less carefully.
  for (const [kind, entries] of zeroDependencies
    ? []
    : [
        ["imports", subpathEntries],
        ["declares a type from", typeEntries]
      ]) {
    for (const [subpath, target] of entries) {
      for (const spec of reachableFrom(path.join(root, target)).bare) {
        if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
        if (!PACKAGE_SPECIFIER.test(spec) || /\s/.test(spec)) continue;
        const name = packageName(spec);
        if (!declared.has(name)) {
          fail(
            `subpath "${subpath}" ${kind} "${spec}", but ${name} is in neither ` +
              `dependencies nor peerDependencies — it resolves here only because ` +
              `npm hoisted it, and will not resolve under pnpm or Yarn PnP`
          );
        }
      }
    }
  }

  // --- what the repository asked for, on the manifest -----------------------

  if (rules.forbidRootExport === true && pkg.exports?.["."]) {
    fail(
      `"." is exported. A root barrel re-exports every part, so importing one ` +
        `pulls in all of them — the exact promise this package makes. Keep subpaths only.`
    );
  }

  if (zeroDependencies) {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies"
    ]) {
      const keys = Object.keys(pkg[field] ?? {});
      if (keys.length > 0) {
        fail(
          `package.json declares ${field}: ${keys.join(", ")} — this package ` +
            `must install nothing into a consumer's tree`
        );
      }
    }
  }

  return {
    name: pkg.name,
    failures,
    counts: {
      subpaths: subpaths.length,
      runtimeEntries: subpathEntries.length,
      modules
    },
    zeroDependencies
  };
}
