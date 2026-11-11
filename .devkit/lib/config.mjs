/**
 * The one file a repository configures every devkit checker in.
 *
 * It is a module rather than JSON because every entry in it carries prose: why
 * a root file is scanned, why a path is allowed, why one subpath may reach
 * another. An allowlist without reasons becomes a silencer, and JSON has
 * nowhere to write one.
 *
 * It sits at the repository root, which is also the one place the reference
 * checker does not read, so a config can neither report itself nor excuse
 * itself.
 *
 * One file and one load per run, with a section per checker, because the
 * alternative is a config file per checker and five places to look. Each
 * checker normalises its own section: what a key means is the checker's, and
 * only the shape of the file as a whole is here.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The file a repository configures this in, read from the directory it runs in. */
export const CONFIG_FILE = "devkit.config.mjs";

/**
 * The config of the repository at `root`, loaded once.
 *
 * `configured` is the difference between "this repository said nothing" and
 * "this repository said nothing about this checker", and the checkers' messages
 * need it: a reference run that reads no file at all is almost always a run in
 * the wrong directory, and saying so beats reporting a clean repository.
 */
export async function loadDevkitConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { configured: false, sections: {} };
  const loaded = (await import(pathToFileURL(file).href)).default;
  if (!loaded || typeof loaded !== "object")
    throw new Error(`${CONFIG_FILE}: must export a config object as default.`);
  return { configured: true, sections: loaded };
}

/** One checker's section, or `undefined` when the repository wrote none. */
export function section({ sections }, key) {
  const value = sections[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${CONFIG_FILE}: \`${key}\` must be an object.`);
  return value;
}

/**
 * One checker's section, where running without it would mean checking nothing.
 *
 * `need` says what the section decides, because the useful error is not "a key
 * is missing" but "this repository has not said which siblings to pack".
 */
export function requireSection(config, key, need) {
  const value = section(config, key);
  if (value === undefined)
    throw new Error(
      `${CONFIG_FILE} at this repository root has no \`${key}\` section, ` +
        `which is where ${need}.`
    );
  return value;
}
