/**
 * What identifies a vendored copy, on both sides of the copy.
 *
 * A copy of this package lives in a repository that cannot see the source, so
 * the only thing the two sides can compare is a digest of the content. This
 * module is that digest, and it is vendored with the copy for exactly that
 * reason: `verify-devkit.mjs` re-hashes the copy against the manifest beside it
 * in a submodule's CI, and dev-agents' `sync.mjs` hashes the source with the
 * same code, so a disagreement is never about the algorithm.
 *
 * **`\r\n` is normalised to `\n` before hashing.** Line endings are the one
 * difference git is entitled to introduce: a checkout with `core.autocrlf` on
 * writes CRLF into the working tree, and a byte comparison would then report
 * every file as changed on a platform nobody has a defect on.
 *
 * **Nothing else is normalised, and the file mode in particular is not part of
 * the identity.** Every script here runs as `node .devkit/<name>.mjs`, so the
 * executable bit decides nothing, and hashing it would add a way for two
 * identical copies to disagree.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The manifest's name inside a copy. Never one of the files it describes. */
export const MANIFEST_FILE = "manifest.json";

const sha256 = (input) => createHash("sha256").update(input).digest("hex");

/** One file's digest: its bytes as text, with CRLF normalised. */
export const fileDigest = (bytes) =>
  sha256(bytes.toString("utf8").replace(/\r\n/g, "\n"));

/**
 * One digest over a whole set of files, path and content both.
 *
 * The path is in the digest because a rename is a change: hashing only the
 * contents would call a module moved from `lib/` to the top identical to where
 * it was. The `\u0000` separates them because it is the one byte a path cannot
 * contain, so no pair of (path, digest) can be spelled two ways.
 *
 * Sorted, so the digest is a property of the set rather than of the order a
 * directory walk happened to return.
 */
export const treeDigest = (files) =>
  sha256(
    Object.keys(files)
      .sort()
      .map((file) => `${file}\u0000${files[file]}\n`)
      .join("")
  );

/** Every file under `dir`, as posix paths relative to it, in sorted order. */
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const walk = (at) =>
    readdirSync(at).flatMap((entry) => {
      const full = path.join(at, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return walk(dir)
    .map((file) => path.relative(dir, file).split(path.sep).join("/"))
    .sort();
}

/**
 * The digest of a directory tree: every file in it, and the tree digest over
 * them.
 *
 * `skip` is how the manifest stays out of its own digest. It is written after
 * the walk and names every other file, so hashing it would be a fixed point
 * nothing could compute.
 */
export function hashDirectory(dir, { skip = [] } = {}) {
  const skipped = new Set(skip);
  const files = {};
  for (const file of filesUnder(dir)) {
    if (skipped.has(file)) continue;
    files[file] = fileDigest(readFileSync(path.join(dir, file)));
  }
  return { files, tree: treeDigest(files) };
}

/** A manifest's bytes: 2-space JSON with sorted keys and a trailing newline. */
export function manifestText({ tree, files }) {
  const sorted = {};
  for (const file of Object.keys(files).sort()) sorted[file] = files[file];
  return `${JSON.stringify({ tree, files: sorted }, null, 2)}\n`;
}

/**
 * How two file sets differ, named rather than counted.
 *
 * "Extra" is a finding of its own and not a curiosity: a file in a copy that
 * the source does not have is either a rename the sync has not been run for or
 * something somebody added by hand, and both are the state this whole mechanism
 * exists to refuse.
 */
export function differences(expected, actual) {
  const differing = [];
  const missing = [];
  const extra = [];
  for (const file of Object.keys(expected).sort()) {
    if (!Object.hasOwn(actual, file)) missing.push(file);
    else if (actual[file] !== expected[file]) differing.push(file);
  }
  for (const file of Object.keys(actual).sort())
    if (!Object.hasOwn(expected, file)) extra.push(file);
  return { differing, missing, extra };
}

/** `differences` as a sentence, or null when there is nothing to say. */
export function describeDifferences({ differing, missing, extra }) {
  const parts = [];
  if (differing.length > 0) parts.push(`differs: ${differing.join(", ")}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`not in the manifest: ${extra.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : null;
}
