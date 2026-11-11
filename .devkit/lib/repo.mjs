/**
 * The repository a copy of this was run against.
 *
 * Every entry script beside this one takes the repository from `process.cwd()`,
 * which is what `npm run` hands a script: npm sets it to the directory holding
 * the `package.json` whose script is running, from wherever the command was
 * typed. That is the one input available to a vendored copy and to this source
 * at once, so a fixture repository in a temporary directory is driven the same
 * way a real one is, and the checkers are testable without a copy existing.
 *
 * A directory with no `package.json` is an error naming the directory, because
 * the alternative is a checker that reads nothing and says everything is fine.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The directory to check, proven to be a repository root. */
export function repositoryRoot(cwd = process.cwd()) {
  if (!existsSync(path.join(cwd, "package.json")))
    throw new Error(
      `${cwd} has no package.json, so it is not a repository root. ` +
        `A devkit script runs from one: use the \`npm run\` script that calls it.`
    );
  return cwd;
}

/** The manifest at `root`, parsed, with a readable error on either failure. */
export function readManifest(root) {
  const file = path.join(root, "package.json");
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, {
      cause: error
    });
  }
}
