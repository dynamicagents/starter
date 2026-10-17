#!/usr/bin/env node
/**
 * Bundle the sandbox image's daemon, `src/sandbox-daemon.ts`, into
 * `container/daemon.mjs`, which the `Dockerfile` copies in.
 *
 * Run by wrangler before every deploy, dev run and type generation (`build` in
 * `wrangler.jsonc`), and built rather than committed: the daemon has to speak
 * the `agents` version the Worker it serves was installed with, and a bundle
 * built from this `node_modules` on the way to the deploy cannot be a stale
 * one.
 *
 * `cloudflare:*` is external, never resolved. What the daemon reaches of
 * `@dynamicagents/core` names it in modules the daemon never runs, and a
 * bundler drops those only once the import is left alone; a daemon that does
 * reach one fails at start, which is where to find out.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.join(root, "container", "daemon.mjs");
mkdirSync(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src", "sandbox-daemon.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["cloudflare:*"],
  // Some of what is bundled is CommonJS that calls `require`, which an ES
  // module has no binding for.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
  },
  logLevel: "warning",
  metafile: true
});

const leaked = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((imported) => imported.path.startsWith("cloudflare:"));
if (leaked.length > 0) {
  console.error(
    `✗ the sandbox daemon still imports ${[...new Set(leaked.map((i) => i.path))].join(", ")}: ` +
      "something it runs reaches the Worker. It would fail at start in the container."
  );
  process.exit(1);
}
console.error(
  `✓ sandbox daemon: ${path.relative(root, outfile)}, ${Math.round(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes / 1024)} KB`
);
