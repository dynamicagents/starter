#!/usr/bin/env node
/**
 * Fail if the committed runtime types carry a global `Env`.
 *
 * Why that flag is load-bearing, and why `wrangler types --check` cannot see
 * this, live in `lib/runtime-types.mjs`, which this prints the findings of. It
 * runs from `types:check`, after `wrangler types --check` itself.
 */
import { repositoryRoot } from "./lib/repo.mjs";
import { verifyRuntimeTypes } from "./lib/runtime-types.mjs";

const { file, missing, globals } = verifyRuntimeTypes(repositoryRoot());

if (missing) {
  console.error(
    `✘ ${file} is missing. It is committed, not generated on demand — ` +
      `run \`npm run types\` and commit the result.`
  );
  process.exit(1);
}

if (globals.length > 0) {
  console.error(
    `✘ ${file} declares a global \`Env\`:\n` +
      globals.map((line) => `    ${line.trim()}`).join("\n") +
      `\n\n  It was regenerated without \`--include-env=false\` — likely by ` +
      `running \`wrangler types\` directly, which is what wrangler's own ` +
      `staleness error suggests.\n  That global is this repo's dev-only ` +
      `bindings, and a published package must never name a consumer's ` +
      `\`Env\`.\n  Fix: \`npm run types\`, then commit the result.`
  );
  process.exit(1);
}

console.log(`✓ ${file}: runtime types only, no ambient Env`);
