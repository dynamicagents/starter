#!/usr/bin/env node
/**
 * Fail if a comment names a path that is not there.
 *
 * The rule, both classes of reference and why only comments are read live in
 * `lib/references.mjs`, which this prints the findings of. What a repository
 * scans and what it allows live in the `references` section of its own
 * `devkit.config.mjs`.
 *
 * Run from a repository root, which is where `npm run` puts it:
 *
 * ```sh
 * npm run verify:references
 * ```
 */
import { CONFIG_FILE, verifyReferences } from "./lib/references.mjs";
import { repositoryRoot } from "./lib/repo.mjs";

try {
  const { failures } = await verifyReferences(repositoryRoot());

  for (const { file, line, ref } of failures)
    console.error(`✗ ${file}:${line} names ${ref}, which does not exist`);

  if (failures.length > 0) {
    console.error(
      "\nA comment points at a file that is not there. Either the path moved " +
        "and the comment did not, or the reference was never right. Fix the " +
        "comment, and if the path really is outside this repository, say so in " +
        `\`references.external\` in ${CONFIG_FILE}, with the reason.`
    );
    process.exit(1);
  }

  console.log("Every path named in a comment exists.");
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
