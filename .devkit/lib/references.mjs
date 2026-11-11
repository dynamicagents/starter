/**
 * The comment-reference check, in one home for the whole train.
 *
 * Every repository here comments heavily and cross-references constantly, and a
 * reference is the part that rots first: the file moves, the comment stays, and
 * the next reader spends a minute proving the note is stale rather than reading
 * it. A path in a comment is checkable, so this checks it.
 *
 * This module is the engine, and `../verify-references.mjs` is the script that
 * prints its findings. Both are vendored from dev-agents' `packages/devkit`, so
 * every repository of the train runs this code rather than a copy of it that
 * has drifted. What varies by repository is the config, not the rule: see
 * `loadConfig` for the file and its defaults.
 *
 * **Two classes of reference, because each is blind where the other sees.** A
 * relative one, spelled the way an import is, is what a rename inside a
 * directory leaves behind, and `tsc` cannot see it because a path inside a
 * comment is not an import. A repository-rooted one, starting at a scanned
 * directory, is what prose reaches for when the file is nowhere near. The two
 * were once two scripts, each checking only its own class, and the gap between
 * them is where both of the pointers that prompted this one had rotted.
 *
 * **Comments only, and that is the whole scope.** A path in a string literal is
 * data rather than a note: prompt copy naming an example file, a config value, a
 * URL. Those belong to whatever reads them, and checking them means an allowlist
 * of things that were never wrong. Prose is the subject here, so Markdown counts
 * whole-file and a `#` line counts in a Dockerfile or an `.env.example`.
 *
 * A reference spelled `.js` resolves against the `.ts` beside it, so a comment
 * written the way an import is spelled still checks out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, loadDevkitConfig, section } from "./config.mjs";
import { lex } from "./lexer.mjs";

export { CONFIG_FILE };

/** The section of that file this checker reads. */
const SECTION = "references";

/**
 * What a repository gets when it writes no config.
 *
 * Deliberately narrow: the directories every repository of the train has, and
 * the one root file all of them keep prose in. A repository that wants its
 * `AGENTS.md` or its `wrangler.jsonc` covered says so, because which root files
 * carry references is the one thing that genuinely differs between them.
 */
export const DEFAULT_CONFIG = {
  scan: ["src", "test", "scripts"],
  loose: ["README.md"],
  external: new Map()
};

/** Files worth reading at all. */
const EXT = /\.(ts|mjs|js|md|json|jsonc)$/;

/** Comment-bearing files with no extension of ours, where `#` opens a comment. */
const HASH_COMMENTS = new Set(["Dockerfile", ".env.example"]);

// Longest alternative first. Regex alternation is ordered, so a shorter
// extension listed ahead of a longer one that starts with it truncates the
// match and reports a file nobody named: `js` ahead of `json` did exactly that,
// and the predecessor script found it in itself.
const TARGET = "(?:jsonc|json|mjs|md|ts|js)";

/** A sibling or a neighbour, resolved against the file that names it. */
export const RELATIVE = new RegExp(
  `(?<![\\w.-])\\.{1,2}/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.${TARGET}`,
  "g"
);

const escapeMeta = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A path from the repository root, resolved against it.
 *
 * Built from the scanned directories rather than from a list of its own, so one
 * config key decides both what is read and what a rooted reference may start
 * with. The cost is that a rooted path into a directory nobody scans is not
 * checked; adding it to `scan` is the fix.
 */
export const rootedPattern = (scan) =>
  new RegExp(
    `(?<![\\w/.-])(?:${scan.map(escapeMeta).join("|")})/` +
      `[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.${TARGET}`,
    "g"
  );

/**
 * The comment spans of one file, each carrying where in the file it started.
 *
 * The offset is the point: a line counted from the match's own position names
 * the comment that is wrong, where a search for the reference's first occurrence
 * in the file names whichever string literal happened to mention it earlier.
 */
export function commentSpans(file, text) {
  const name = path.basename(file);
  if (name.endsWith(".md")) return [{ start: 0, text }];
  if (HASH_COMMENTS.has(name)) return hashSpans(text);
  return lex(text).comments;
}

/** Whole lines whose first non-space character opens a comment. */
function hashSpans(text) {
  const spans = [];
  let start = 0;
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) spans.push({ start, text: line });
    start += line.length + 1;
  }
  return spans;
}

/**
 * A file with C-style comments, which is `.ts`, `.mjs`, `.js`, and the `.json`
 * and `.jsonc` files this train writes comments in, is read by the lexer in
 * `lib/lexer.mjs`. That is where what it has to get right lives, and why: a
 * quote, a template interpolation and a regex literal can each carry any
 * delimiter the others open with, and a comment lost to one of them is a comment
 * nobody notices going unchecked.
 */

/**
 * Every reference a file's comments name, with its absolute offset, in the
 * order they are written.
 *
 * Sorted because the two classes are two passes: without it, every relative
 * finding in a file is printed ahead of every rooted one, and a reader working
 * down the output jumps about the file for no reason they can see.
 */
export function references(file, text, rooted) {
  const found = [];
  for (const span of commentSpans(file, text)) {
    for (const [kind, pattern] of [
      ["relative", RELATIVE],
      ["rooted", rooted]
    ]) {
      for (const match of span.text.matchAll(pattern))
        found.push({
          ref: match[0],
          kind,
          index: span.start + match.index
        });
    }
  }
  return found.sort((one, other) => one.index - other.index);
}

/**
 * A list of strings, or the default for that key.
 *
 * `scan` may not be empty, and that is not pedantry: it also names the prefixes a
 * rooted reference may start with, so an empty one builds a pattern whose
 * alternation matches nothing and therefore matches *anything* beginning with a
 * slash.
 */
const asList = (value, key) => {
  if (value === undefined) return [...DEFAULT_CONFIG[key]];
  const bad =
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string");
  if (bad || (key === "scan" && value.length === 0))
    throw new Error(
      `${CONFIG_FILE}: \`${SECTION}.${key}\` must be a${key === "scan" ? " non-empty" : "n"} array of strings.`
    );
  return value;
};

const asExternal = (value) => {
  if (value === undefined) return new Map();
  if (value instanceof Map) return value;
  if (value && typeof value === "object") return new Map(Object.entries(value));
  throw new Error(
    `${CONFIG_FILE}: \`${SECTION}.external\` must be a Map, or an object of ` +
      `path to reason.`
  );
};

/**
 * This checker's section of the repository's config, or the defaults.
 *
 * `configured` is read by the caller rather than by anything here, and it is
 * the difference between a repository that said nothing about references and a
 * directory that is not a repository root at all.
 */
export async function loadConfig(root) {
  const config = await loadDevkitConfig(root);
  const mine = section(config, SECTION);
  // Fresh lists and a fresh Map either way, so a caller cannot reach in and edit
  // the defaults every later call would read.
  if (mine === undefined)
    return {
      scan: [...DEFAULT_CONFIG.scan],
      loose: [...DEFAULT_CONFIG.loose],
      external: new Map(DEFAULT_CONFIG.external),
      configured: config.configured
    };
  return {
    scan: asList(mine.scan, "scan"),
    loose: asList(mine.loose, "loose"),
    external: asExternal(mine.external),
    configured: true
  };
}

/**
 * The files to read: every candidate under a scanned directory, plus the root
 * files named one by one.
 *
 * A scanned directory that is not there is skipped rather than fatal, because
 * the set of directories a repository of this train has is not fixed and a
 * checker that throws on the absence of `test/` is one nobody can adopt.
 */
export function collect(root, config) {
  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return EXT.test(entry) ? [full] : [];
    });

  return [
    ...config.scan.flatMap((dir) => {
      const full = path.join(root, dir);
      return existsSync(full) ? walk(full) : [];
    }),
    ...config.loose.map((file) => path.join(root, file)).filter(existsSync)
  ];
}

/** A reference resolves if it is there, or if its `.js` is a `.ts` beside it. */
const resolves = (abs) =>
  existsSync(abs) ||
  (abs.endsWith(".js") && existsSync(abs.slice(0, -".js".length) + ".ts"));

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every reference in the repository at `root` that names nothing.
 *
 * A file whose comments name the same missing path twice reports it once: the
 * finding is the path, and the first comment carrying it is where a reader
 * starts. Reading nothing at all is an error rather than a pass, because a
 * config whose directories have all moved would otherwise leave `check` green
 * over a repository this never looked at.
 */
export async function verifyReferences(root) {
  const config = await loadConfig(root);
  const files = collect(root, config);
  if (files.length === 0)
    throw new Error(
      `nothing to check under ${root}. ` +
        (config.configured
          ? `\`${SECTION}.scan\` and \`${SECTION}.loose\` in ${CONFIG_FILE} ` +
            "name no file that is there."
          : `There is no ${CONFIG_FILE} here, and the directories defaulted to are ` +
            "not here either, so this is probably not the repository root.")
    );

  const rooted = rootedPattern(config.scan);
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const reported = new Set();
    for (const { ref, kind, index } of references(file, text, rooted)) {
      if (reported.has(ref) || config.external.has(ref)) continue;
      const abs =
        kind === "relative"
          ? path.resolve(path.dirname(file), ref)
          : path.join(root, ref);
      if (resolves(abs)) continue;
      reported.add(ref);
      failures.push({
        file: path.relative(root, file),
        line: lineOf(text, index),
        ref
      });
    }
  }
  return { files, failures };
}
