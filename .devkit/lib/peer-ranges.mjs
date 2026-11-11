/**
 * The one field in `package.json` that nothing else reads.
 *
 * npm does not validate a package against its own `peerDependencies`. Measured,
 * not assumed: a manifest declaring `agents` as a peer at `^0.21.0` alongside a
 * devDependency of `^0.22.0` installs 0.22.0 with no error, no warning, and
 * `npm ls` reports the tree as valid. Arborist resolves the root's peers for
 * *consumers*; it never turns them back on the root.
 *
 * So a peer range is prose until something asserts it. `tsc` reads the installed
 * copy, the specs run against the installed copy, and the range — the only part
 * a consumer actually installs against — can say anything at all. A `0.x` caret
 * is where that bites first: it locks to the *minor*, so a devDependency moving
 * to the next one leaves the range behind, with a green build and a green suite
 * the whole way.
 *
 * What it does **not** check: that the floor of a range can actually run this
 * code. A range is a claim about an API surface, and only the installed copy is
 * ever exercised here — so a floor naming a release predating an import this
 * package makes is a claim nothing on this machine can falsify. Raising a floor
 * is a judgement about what the source needs; this script only holds the range
 * and the installed copy to each other.
 *
 * Offline and deterministic, which is why it belongs in `check`:
 *
 *   1. Every installed peer satisfies its declared range. What the specs ran
 *      against is what a consumer is told to bring.
 *   2. Every required peer is installed at all. If it is not, nothing here has
 *      ever exercised it, and check 1 has nothing to stand on.
 *   3. Every `peerDependenciesMeta` key names a real peer. npm ignores a stale
 *      one in silence, so a renamed peer that leaves its `optional: true` behind
 *      becomes required without anyone deciding that.
 *
 * Peers are read from the installed tree rather than from `devDependencies`,
 * because the two are not the same set: a peer can be imported by shipped code
 * and arrive through another package, so a devDependency-driven check would
 * skip the peer most likely to drift.
 *
 * `semver` is the one dependency any of these checkers has, and the repository
 * running this declares it as a devDependency of its own. The devkit README in
 * dev-agents states that prerequisite; a repository that does not wire this
 * script needs nothing.
 *
 * `--latest` is the other half, and is deliberately **not** in `check`, which has
 * no network. `classifyLatest` is the judgement half of it and lives here with
 * the rest of the semver reasoning; `../verify-peer-ranges.mjs` asks the
 * registry and prints.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { readManifest } from "./repo.mjs";

/**
 * The installed version of `name` under `root`, or `undefined`.
 *
 * Read off disk rather than through `require.resolve(name + "/package.json")`,
 * which is the obvious way and does not work here: a package whose `exports` map
 * omits that subpath is unreachable that way, and peers in these repos are.
 *
 * Only the top level of `node_modules` is consulted, because that is the copy
 * this package resolves. A nested one belongs to whoever nested it.
 */
function installedVersion(root, name) {
  const manifest = path.join(root, "node_modules", name, "package.json");
  let source;
  try {
    source = readFileSync(manifest, "utf8");
  } catch (error) {
    // Absent is the only error that means absent. A manifest that exists and
    // cannot be read — a permission problem, a half-written tree — is not the
    // same as a peer nobody installed, and swallowing it here would let an
    // *optional* peer pass this gate while unreadable, which is the one case
    // where nothing downstream would notice either.
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw new Error(`cannot read ${manifest}: ${error.message}`, {
      cause: error
    });
  }
  try {
    return JSON.parse(source).version;
  } catch (error) {
    throw new Error(`${manifest} is not valid JSON: ${error.message}`, {
      cause: error
    });
  }
}

/**
 * Every way the peer ranges at `root` and the installed tree disagree.
 *
 * `checked` is what check 3 compares against and what `--latest` walks: the
 * peers that are installed and in range, which are the only ones a question
 * about the registry can be asked about.
 */
export function verifyPeerRanges(root) {
  const pkg = readManifest(root);
  const failures = [];
  const fail = (message) => failures.push(message);

  const peers = Object.entries(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};
  const optional = (name) => meta[name]?.optional === true;
  const checked = [];

  // --- 1 & 2. the installed copy is the one the range describes --------------

  for (const [name, range] of peers) {
    if (semver.validRange(range) === null) {
      fail(
        `peer "${name}" declares "${range}", which is not a valid semver range`
      );
      continue;
    }
    const version = installedVersion(root, name);
    if (version === undefined) {
      if (!optional(name)) {
        fail(
          `peer "${name}" is required at "${range}" but is not installed — ` +
            `nothing here has ever run against it, so the range is unverified`
        );
      }
      continue;
    }
    if (!semver.satisfies(version, range)) {
      fail(
        `peer "${name}" declares "${range}", but ${version} is installed — ` +
          `every check in this repo ran against ${version}, and a consumer ` +
          `following "${range}" gets something else`
      );
      continue;
    }
    checked.push([name, range, version]);
  }

  // --- 3. no meta entry without a peer --------------------------------------

  for (const name of Object.keys(meta)) {
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a stale key
    // named `constructor` or `toString` would name a "peer" that does not exist.
    if (!Object.hasOwn(pkg.peerDependencies ?? {}, name)) {
      fail(
        `peerDependenciesMeta has "${name}", which is not a peer — npm ignores ` +
          `it silently, so if the peer was renamed its replacement is now required`
      );
    }
  }

  return { name: pkg.name, failures, peers, checked };
}

/**
 * What each checked peer's newest release says about its range.
 *
 * Two ways a range and reality drift apart, and both are normal states:
 *
 *   - **The newest release falls outside the range.** A ceiling is meant to be
 *     crossed eventually; this is what turns widening one into a deliberate act
 *     after a green test run, rather than a guess made in advance.
 *   - **The range admits a release newer than the installed one.** An open range
 *     claims support for every version yet to be published, and check 1 only ever
 *     sees the one in the tree. This is the only place that claim is visible.
 */
export function classifyLatest(checked, latest) {
  const rows = [];
  const outsideRange = [];
  const untested = [];

  for (const [name, range, version] of checked) {
    const newest = latest.get(name);
    let verdict = "up to date";
    if (newest === undefined) {
      verdict = "unknown — registry did not answer";
    } else if (!semver.satisfies(newest, range)) {
      verdict = "outside the range";
      outsideRange.push([name, range, newest]);
    } else if (semver.gt(newest, version)) {
      verdict = "in range, not installed";
      untested.push([name, range, version, newest]);
    }
    rows.push([name, range, version, newest, verdict]);
  }

  return { rows, outsideRange, untested };
}
