#!/usr/bin/env node
/**
 * Publish gate: fail if the built output is not safe to publish.
 *
 * Every check, which of them a repository asks for, and the defect behind each
 * live in `lib/exports.mjs`, which this prints the findings of. It reads
 * `dist/`, so whatever runs it builds first.
 */
import { loadDevkitConfig } from "./lib/config.mjs";
import { verifyExports } from "./lib/exports.mjs";
import { repositoryRoot } from "./lib/repo.mjs";

const root = repositoryRoot();
const { name, failures, counts, zeroDependencies } = verifyExports(
  root,
  await loadDevkitConfig(root)
);

if (failures.length > 0) {
  console.error(`\n✘ ${name} is not safe to publish:\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error("");
  process.exit(1);
}

// stderr, not stdout: this runs from `prepack`, and `npm pack --json` expects
// stdout to be nothing but its own JSON.
console.error(
  `✓ ${name}: ${counts.subpaths} subpaths resolve, ` +
    `${counts.runtimeEntries} runtime entries verified over ` +
    `${counts.modules} emitted modules, realms isolated, every import declared` +
    (zeroDependencies ? ", zero dependencies" : "")
);
