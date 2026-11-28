/**
 * The Wrangler configuration the test pool reads, derived from the real one.
 *
 * **Why a second configuration exists.** The Workers Vitest pool builds every
 * container image the configuration it reads declares, through Docker, before a
 * single test runs. Nothing in this suite starts a container, so that build buys
 * the tests nothing and costs them a Docker daemon they otherwise never need.
 * The switch the pool honours is `dev.enable_containers`, and Wrangler accepts
 * it only at the top level of a configuration: it is not a field a named
 * environment can override. Setting it in `wrangler.jsonc` would therefore also
 * stop `wrangler dev` from running containers, which is the one place local work
 * on a sandbox needs them. So the switch lives in a configuration only the pool
 * is pointed at, and `wrangler.jsonc` keeps containers for `wrangler dev` and
 * for every deploy.
 *
 * **Derived on every run, never written by hand.** What the pool needs from the
 * real configuration is most of it: the compatibility settings, the AI binding,
 * the agent Durable Objects and the SQLite migration that creates them. A copy
 * maintained by hand would drift, and the drift would read as a suite passing
 * against bindings the deployment no longer has. Regenerating makes drift
 * impossible rather than unlikely, which is why this is not a committed file.
 *
 * **It sits beside `wrangler.jsonc`**, because a path in a Wrangler
 * configuration resolves against the directory holding that configuration.
 * `main` and the custom `build` command are both relative, so the same bytes in
 * another directory would name other files.
 *
 * The raw configuration is what gets read, rather than the resolved one: raw is
 * the authored shape and round-trips through JSON, where a resolved
 * configuration carries derived fields that are not valid to declare.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { experimental_readRawConfig } from "wrangler";

/** The generated file's name, beside the configuration it derives from. */
const GENERATED = "wrangler.test.json";

/** The configuration it derives from. */
const SOURCE = "wrangler.jsonc";

/**
 * Write the pool's configuration and answer the path to pass as `configPath`.
 *
 * @param root The directory holding `wrangler.jsonc`.
 * @returns The generated file's absolute path. Absolute rather than relative
 *   because the pool resolves a relative one against Vitest's root, which is
 *   this directory today and need not stay that way.
 */
export function writeTestWranglerConfig(root) {
  const { rawConfig } = experimental_readRawConfig({
    config: path.join(root, SOURCE)
  });
  const forTests = {
    ...rawConfig,
    // Containers stay declared, so a binding the suite reads has the shape it
    // has in production. Only their image build is refused.
    dev: { ...rawConfig.dev, enable_containers: false }
  };
  const generated = path.join(root, GENERATED);
  writeFileSync(generated, `${JSON.stringify(forTests, null, 2)}\n`);
  return generated;
}
