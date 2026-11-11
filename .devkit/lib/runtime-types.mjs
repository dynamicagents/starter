/**
 * The half of the types gate that `wrangler types --check` does not cover.
 *
 * `worker-configuration.d.ts` is committed and is generated with
 * `--include-env=false`, and that flag is load-bearing: the default output
 * declares a **global** `Env` built from the repository's own dev-only
 * `wrangler.jsonc` bindings. A published package declares its own env slices and
 * takes bindings as parameters, so a module that names `Env` must fail here
 * rather than resolve against a consumer's bindings at their build, where the
 * mistake is invisible.
 *
 * `--check` compares the runtime types and is indifferent to that flag: a file
 * regenerated with a bare `wrangler types` carries the global `Env` and is still
 * reported "up to date". Measured, not assumed — and wrangler's own staleness
 * error says "Run `wrangler types` to regenerate", which is precisely the command
 * that reintroduces it. So the one guard rail points at the hole.
 *
 * Hence this: the flag is verified by its effect on the committed file, not by
 * trusting that whoever last regenerated it used the right script.
 *
 * `declare namespace Cloudflare { interface Env {} }` is expected and left alone.
 * It ships inside the runtime types as an empty extension point; it is nested, so
 * it is not the global this rejects, and nothing can reach it as a bare `Env`.
 *
 * One sentence covers every repository that wires this, because every repository
 * that wires it is a published package. There is nothing per-repository here and
 * so no config section.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The generated file this reads, by the name `wrangler types` writes. */
export const RUNTIME_TYPES = "worker-configuration.d.ts";

/**
 * The global `Env` declarations in the repository's runtime types.
 *
 * `missing` is a finding rather than an error here: the file is committed, so
 * its absence means a tree that cannot typecheck, which is worth a different
 * sentence from a tree that typechecks against the wrong declaration.
 */
export function verifyRuntimeTypes(root) {
  let source;
  try {
    source = readFileSync(path.join(root, RUNTIME_TYPES), "utf8");
  } catch {
    return { file: RUNTIME_TYPES, missing: true, globals: [] };
  }

  // Column zero is the whole test: a global declaration is unindented, and the
  // legitimate `Cloudflare.Env` is nested inside a namespace and therefore is not.
  const globals = source
    .split("\n")
    .filter((line) => /^(?:declare\s+)?interface\s+Env\b/.test(line));

  return { file: RUNTIME_TYPES, missing: false, globals };
}
