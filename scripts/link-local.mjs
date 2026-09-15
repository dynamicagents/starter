#!/usr/bin/env node
/**
 * Install the sibling `core` / `plugins` checkouts into this repo, for
 * developing across the three at once.
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
 * Re-run it after changing either sibling; `npm install` alone will not pick the
 * change up.
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

/** Checkouts this repo composes. A missing one is an error. */
const SIBLINGS = ["core", "plugins"];

/**
 * Packed too when present, skipped when not.
 *
 * `g2a-protocol` is the wire contract `@dynamicagents/core` and
 * slack-gatekeeper both depend on. Nothing here imports it directly and it
 * changes about once a year, so requiring the checkout would break `link:local`
 * for everyone who only has the two above — but when it *is* checked out, an
 * edit to it must reach this build, or a linked core silently resolves the
 * published copy and the change under test is not the one running.
 */
const OPTIONAL_SIBLINGS = ["g2a-protocol"];

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "da-pack-"));
const tarballs = [];

for (const name of [...SIBLINGS, ...OPTIONAL_SIBLINGS]) {
  const dir = path.resolve(root, "..", name);
  if (!existsSync(dir)) {
    if (OPTIONAL_SIBLINGS.includes(name)) {
      console.log(`${name} not checked out — using the published package.`);
      continue;
    }
    console.error(
      `${name} not found at ${dir}.\n` +
        "Check out the three repos as siblings, or skip this script and use the " +
        "published packages."
    );
    process.exit(1);
  }
  console.log(`packing ${name}…`);
  // `npm pack` runs the package's own `prepack`, so this builds `dist/` and runs
  // its export verification — the same gate a real publish passes.
  execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: dir,
    stdio: "inherit"
  });
}

for (const file of readdirSync(out)) {
  if (file.endsWith(".tgz")) tarballs.push(path.join(out, file));
}

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
const lockBefore = existsSync(lockfile) ? readFileSync(lockfile, "utf8") : null;

console.log(`installing ${tarballs.length} tarball(s)…`);
try {
  // `--no-save` keeps the published ranges in package.json intact.
  execFileSync("npm", ["install", "--no-save", ...tarballs], {
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
   * connection to the command that caused it. The README used to ask the developer
   * to notice this by hand.
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
      console.log(
        "removed package-lock.json — there was none before this ran."
      );
    }
  } else if (readFileSync(lockfile, "utf8") !== lockBefore) {
    writeFileSync(lockfile, lockBefore);
    console.log(
      "restored package-lock.json — npm had rewritten it against the temp " +
        "tarballs, whose paths exist on this machine, until they don't."
    );
  }
}

console.log("done. Re-run after changing either sibling.");
