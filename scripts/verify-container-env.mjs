/**
 * The pairs the image is released apart from, held together: each builds and
 * deploys cleanly when it drifts, and fails only in a running container — which
 * exists only in production, so neither a build nor a test can catch it. Hence
 * a script, and hence its place in `npm run check`.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * The Claude Code the image installs is the version the claude-code plugin
 * verified its egress gateway and stream parser against.
 *
 * Another pair released apart that fails only in a running container: a CLI
 * whose requests or `stream-json` lines moved builds and deploys cleanly. The
 * plugin moves its verified version only once its probe passes, so a pin that
 * matches it is one somebody checked.
 */
const wrangler = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
);
const pins = [...wrangler.matchAll(/"CLAUDE_CODE_VERSION":\s*"([^"]*)"/g)].map(
  (match) => match[1]
);
const verifiedModule = new URL(
  "../node_modules/@dynamicagents/plugins/dist/claude-code/verified.js",
  import.meta.url
);
const verified = existsSync(verifiedModule)
  ? (await import(verifiedModule.href)).VERIFIED_CLAUDE_CODE_VERSION
  : undefined;

if (!verified) {
  console.error(
    "@dynamicagents/plugins names no verified Claude Code version — install one " +
      "that exports VERIFIED_CLAUDE_CODE_VERSION from its claude-code subpath."
  );
  process.exit(1);
}
const unverified = pins.filter((pin) => pin !== verified);
if (pins.length === 0 || unverified.length > 0) {
  console.error(
    `wrangler.jsonc: CLAUDE_CODE_VERSION is ${unverified[0] ?? "not pinned"} but the ` +
      `claude-code plugin verified ${verified}. Set every pin to ${verified}; a newer ` +
      "CLI is verified in the plugin first, by its probe."
  );
  process.exit(1);
}

console.log(
  `✓ wrangler.jsonc: Claude Code ${verified} is the version the claude-code plugin verified`
);

/**
 * `sandbox-shim` is `@cloudflare/sandbox`'s, which the Worker's `Files` and
 * `DirectoryBackup` drive, so its donor image is the installed version. And the
 * daemon refuses to start unless the image starts it as the agent holding its
 * one capability — the entrypoint `@dynamicagents/plugins/sandbox`'s README
 * gives — which a container would report only as a sandbox that never starts.
 */
const dockerfile = readFileSync(
  new URL("../Dockerfile", import.meta.url),
  "utf8"
);
const shimTag = /cloudflare\/sandbox:(\S+)/.exec(dockerfile)?.[1];
const shimVersion = JSON.parse(
  readFileSync(
    new URL(
      "../node_modules/@cloudflare/sandbox/package.json",
      import.meta.url
    ),
    "utf8"
  )
).version;
if (shimTag !== shimVersion) {
  console.error(
    `Dockerfile: cloudflare/sandbox is ${shimTag ?? "not pinned"} but ` +
      `@cloudflare/sandbox is ${shimVersion}. Set the tag to ${shimVersion}.`
  );
  process.exit(1);
}
const entrypoint = /^ENTRYPOINT (\[[\s\S]*?\])/m
  .exec(dockerfile)?.[1]
  ?.replace(/\\\n/g, "");
const argv = entrypoint ? JSON.parse(entrypoint) : [];
const required = [
  "setpriv",
  "--reuid=10001",
  "--regid=10001",
  "--init-groups",
  "--inh-caps=-all,+net_bind_service",
  "--ambient-caps=+net_bind_service",
  "--bounding-set=-all,+net_bind_service"
];
if (required.some((flag, i) => argv[i] !== flag)) {
  console.error(
    `Dockerfile: the ENTRYPOINT must start ${JSON.stringify(required)}, ` +
      "or the sandbox daemon refuses to start."
  );
  process.exit(1);
}
console.log(
  `✓ Dockerfile: sandbox-shim ${shimTag} matches @cloudflare/sandbox, and the daemon starts as the agent`
);
