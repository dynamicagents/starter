/**
 * Install the sibling checkouts of this repository into it, for developing
 * across them at once.
 *
 * `npm pack` + tarball install, deliberately — **not `npm link`**, and not a
 * `file:` dependency either:
 *
 * - `npm link` symlinks the checkout, which gives it its own `node_modules` and
 *   so its own copy of every peer. Two copies of `agents` in one Worker bundle
 *   breaks the `Session` / `SessionMessage` types and every `instanceof`, and it
 *   breaks at runtime rather than at the type level, which is the worst place to
 *   find out.
 * - A `file:` dependency has the same duplication hazard and additionally hides
 *   packing mistakes: a file missing from `package.json#files` still resolves
 *   locally and 404s for everyone else.
 *
 * A tarball is what npm actually publishes, so if it works here it works from the
 * registry. Nothing is written to `package.json`, so a plain `npm install` (and CI,
 * which never runs this) builds against whatever the branch declares.
 *
 * Re-run it after changing a sibling; `npm install` alone will not pick the
 * change up.
 *
 * Which checkouts those are is the repository's, in the `linkLocal` section of
 * its `devkit.config.mjs`: `siblings` is required and a missing one is an error,
 * `optional` is packed when present and skipped when not. An optional sibling is
 * one nothing here imports directly, so requiring the checkout would break the
 * command for everyone who does not have it — but when it *is* checked out, an
 * edit to it must reach this build, or a linked sibling silently resolves the
 * published copy and the change under test is not the one running.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireSection } from "./config.mjs";

/**
 * Pack every configured sibling of `root` and install the tarballs into it.
 *
 * `run` is the command runner, and it is a parameter rather than a direct call
 * to `execFileSync` for one reason: the lockfile restore below has to happen
 * when the install **throws**, and that is the path no real install can be asked
 * to take on demand. A spec passes a runner that rewrites the lockfile and then
 * fails, which is what npm does.
 */
export function linkLocal(
  root,
  config,
  { run = execFileSync, log = console.log } = {}
) {
  const rules = requireSection(
    config,
    "linkLocal",
    "this repository names the checkouts it builds against"
  );
  const siblings = rules.siblings ?? [];
  const optional = rules.optional ?? [];

  const out = mkdtempSync(path.join(tmpdir(), "da-pack-"));
  const packed = [];

  for (const name of [...siblings, ...optional]) {
    const dir = path.resolve(root, "..", name);
    if (!existsSync(dir)) {
      if (optional.includes(name)) {
        log(`${name} not checked out — using the published package.`);
        continue;
      }
      throw new Error(
        `${name} not found at ${dir}.\n` +
          "Check out the repos as siblings, or skip this script and use the " +
          "published packages."
      );
    }
    log(`packing ${name}…`);
    // `npm pack` runs the package's own `prepack`, so this builds `dist/` and runs
    // its export verification — the same gate a real publish passes.
    run("npm", ["pack", "--pack-destination", out], {
      cwd: dir,
      stdio: "inherit"
    });
    packed.push(name);
  }

  const tarballs = readdirSync(out)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => path.join(out, file));

  /**
   * The lockfile's exact bytes, captured *before* npm runs — this snapshot is what
   * gets put back below.
   *
   * The predecessor restored with `git checkout -- package-lock.json`, which takes
   * the file from the index and so silently discards any uncommitted lockfile work
   * in progress: a dependency bump being tested, a conflict just resolved by hand.
   * A development helper destroying unrelated work is the one thing it must never
   * do, and the loss is invisible — the script prints that it *restored* the file.
   *
   * Reading the bytes is also fewer moving parts than shelling out to git: it
   * works on an untracked lockfile, in a fresh clone with nothing staged, and
   * outside a git checkout entirely.
   */
  const lockfile = path.join(root, "package-lock.json");
  const lockBefore = existsSync(lockfile)
    ? readFileSync(lockfile, "utf8")
    : null;

  log(`installing ${tarballs.length} tarball(s)…`);
  try {
    // `--no-save` keeps the published ranges in package.json intact.
    run("npm", ["install", "--no-save", ...tarballs], {
      cwd: root,
      stdio: "inherit"
    });
  } finally {
    /**
     * Put the lockfile back exactly as it was — even if the install above threw.
     *
     * `--no-save` protects the *manifest*, not the lockfile: npm can still pin
     * `@dynamicagents/*` to `file:/var/folders/…/da-pack-*.tgz`. Those paths do not
     * exist on a CI runner — or on this machine once the temp dir is cleaned — so the
     * damage surfaces as a failed install belonging to whoever pulls next, with no
     * connection to the command that caused it.
     *
     * A `finally` because a rejected install can still have rewritten the lockfile
     * partway through — npm resolves the tree before it fails on the first conflict
     * it hits — so skipping this on the throwing path would leave exactly the
     * corruption it exists to prevent, for a caller who has no reason to expect it
     * from a command that just failed.
     *
     * Restoring is safe precisely because the linked install is meant to be
     * throwaway: `node_modules` keeps the local tarballs, the lockfile keeps
     * describing the manifest, and a plain `npm install` puts the two back in step.
     *
     * *Any* difference is reverted, not just a `file:` path. Everything npm writes
     * here is an artifact of a throwaway install — a dropped `integrity`, a
     * rewritten `version`, a reordered key — so none of it is worth keeping, and
     * matching one known-bad pattern only holds until npm records it differently.
     */
    if (lockBefore === null) {
      // Nothing to protect: npm wrote the repo's first lockfile. Removing it leaves
      // the tree as found, and stops one full of temp paths becoming what gets
      // committed.
      if (existsSync(lockfile)) {
        rmSync(lockfile);
        log("removed package-lock.json — there was none before this ran.");
      }
    } else if (readFileSync(lockfile, "utf8") !== lockBefore) {
      writeFileSync(lockfile, lockBefore);
      log(
        "restored package-lock.json — npm had rewritten it against the temp " +
          "tarballs, whose paths exist on this machine, until they don't."
      );
    }
  }

  return { packed, tarballs };
}
