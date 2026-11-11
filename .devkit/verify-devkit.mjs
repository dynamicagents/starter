#!/usr/bin/env node
/**
 * Fail if this copy of the devkit is not the copy its manifest describes.
 *
 * This is what makes vendoring safe. The scripts beside this one are a copy of
 * dev-agents' `packages/devkit/src`, and a copy is the kind of thing somebody
 * fixes in place: the fix then works in one repository, drifts from the source,
 * and is lost the next time the copy is written. So each repository runs this in
 * its own `check`, where a hand-edited copy fails in the repository it was
 * edited in, naming the file and where the fix belongs.
 *
 * It reads the directory it is in rather than the repository, because that is
 * what it is checking: the copy's own identity, with nothing else needed. That
 * is also why it works in a submodule's CI, which cannot see dev-agents at all.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  MANIFEST_FILE,
  describeDifferences,
  differences,
  hashDirectory
} from "./lib/hash.mjs";

const copy = import.meta.dirname;
const manifestFile = path.join(copy, MANIFEST_FILE);
const where =
  "The source is `packages/devkit/src` in dev-agents, and " +
  "`npm run devkit:sync` there rewrites this copy.";

if (!existsSync(manifestFile)) {
  console.error(
    `✘ ${MANIFEST_FILE} is missing from ${path.basename(copy)}/, so this copy ` +
      `cannot say what it should contain. ${where}`
  );
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
} catch (error) {
  console.error(
    `✘ ${MANIFEST_FILE} is not valid JSON: ${error.message}. ${where}`
  );
  process.exit(1);
}

if (!manifest?.files || typeof manifest.tree !== "string") {
  console.error(
    `✘ ${MANIFEST_FILE} has no \`tree\` and \`files\`, so it describes nothing. ` +
      where
  );
  process.exit(1);
}

const actual = hashDirectory(copy, { skip: [MANIFEST_FILE] });
const detail = describeDifferences(differences(manifest.files, actual.files));

if (detail !== null || actual.tree !== manifest.tree) {
  console.error(
    `✘ this devkit copy does not match ${MANIFEST_FILE}: ` +
      (detail ?? "the files match one by one but the tree digest does not") +
      `.\n  A copy is never edited here. ${where}`
  );
  process.exit(1);
}

console.log("✓ the devkit copy matches its manifest.");
