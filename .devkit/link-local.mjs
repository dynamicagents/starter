#!/usr/bin/env node
/**
 * Install this repository's sibling checkouts into it.
 *
 * Why a tarball rather than `npm link`, which siblings a repository names and
 * why the lockfile is restored even when the install throws live in
 * `lib/link-local.mjs`, which this runs.
 *
 * ```sh
 * npm run link:local
 * ```
 */
import { loadDevkitConfig } from "./lib/config.mjs";
import { linkLocal } from "./lib/link-local.mjs";
import { repositoryRoot } from "./lib/repo.mjs";

const root = repositoryRoot();

try {
  const { packed } = linkLocal(root, await loadDevkitConfig(root));
  console.log(
    `done. Re-run after changing ${packed.join(", ") || "a sibling"}, or after ` +
      "any `npm install`."
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
