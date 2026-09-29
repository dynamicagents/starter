#!/usr/bin/env node
/**
 * Prove that each agent's module graph is its own.
 *
 * ## What this actually checks, and why it is not the obvious thing
 *
 * This Worker deploys as **one bundle containing every agent**, so grepping
 * `dist/` for "computer" would always find it and prove nothing. The invariant
 * that matters is the one a user relies on the moment they delete the agents
 * they don't want: *each agent's graph pulls in only the plugins that agent
 * installed.* So each entry is bundled on its own here, in CI only, and the
 * result is inspected.
 *
 * The check is on esbuild's **metafile** — the exact list of modules that made it
 * into the graph — not on string matching. A string search answers "does this
 * word appear", which a comment or a coincidence can satisfy; the metafile
 * answers "did this module get pulled in", which is the actual question. A single
 * convenience re-export added to `@dynamicagents/plugins` six months from now would
 * silently defeat a grep and cannot defeat this.
 *
 * It also enforces a **size ceiling** per agent. Not for its own sake: bundle
 * growth is the observable symptom of the subpath-export discipline rotting, and
 * a ceiling is what turns a slow leak into a failing build.
 *
 * Run: `npm run verify:isolation`
 */
import { build } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const plugin = (name) => `@dynamicagents/plugins/dist/${name}/`;

/**
 * One agent, its entry points, and what must not be in its graph.
 *
 * `forbidden` is the interesting column. Each entry is a plugin *another* agent
 * installs — so it is not a list of things nobody uses, it is a list of things
 * that exist in this repo and must not have leaked sideways.
 *
 * ## What every agent carries whatever it imports
 *
 * Every agent and sub-agent extends Think, and `@cloudflare/think` imports
 * eagerly: just-bash, two model providers, the MCP client, yaml and the chat
 * SDK, on top of the `agents` SDK's own `Lifecycle`. So each entry below
 * carries all of it, used or not — about 1.7 MB gzipped for one agent, which is
 * why these ceilings are what they are. Each entry is built on its own, so
 * Think is counted once per entry. That share moves with Think and `agents`, so
 * a bump of either moves every ceiling here at once, and that is not a leak:
 * `forbidden` is the check that would catch one.
 *
 * An agent that owns a workspace additionally carries `core/dist/alarm` and
 * `core/dist/job` — and *only* such an agent, which is the isolation this file
 * exists to assert still holding.
 *
 * Each tenant's task host and pipeline are entries too, and each carries the
 * `agents` SDK on its own: about 1.3 MB apiece, counted once per entry like
 * Think.
 *
 * Every ceiling below is its measurement plus the ~8% headroom this file runs
 * with.
 */
const AGENTS = [
  {
    name: "generic",
    entries: [
      "src/agents/generic/host.ts",
      "src/agents/generic/workflow.ts",
      "src/agents/generic/agent.ts",
      "src/agents/generic/children.ts"
    ],
    // Every container-side plugin, and the container client itself: this agent's
    // files are Think's own workspace, in its SQLite.
    forbidden: [
      plugin("computer"),
      plugin("workspace"),
      plugin("repo"),
      plugin("scratch"),
      plugin("claude-code"),
      "@cloudflare/computer"
    ],
    // Measured 11694 KiB, and nearly all of it is Think and the `agents` SDK:
    // see "What every agent carries" above.
    maxBytes: 12_940_000
  },
  {
    name: "coding",
    entries: [
      "src/agents/coding/host.ts",
      "src/agents/coding/workflow.ts",
      "src/agents/coding/agent.ts",
      "src/agents/coding/children.ts",
      // The workspace object is a deployed class of this agent's too, and
      // omitting it left the one assertion below that names `/claude-code`
      // unable to fail: the shared base arrives in this graph anyway (via
      // `workspaceName` in `agent.ts`), but the *subclass* did not, so an import
      // added only there was neither leak-checked nor size-counted.
      "src/agents/coding/workspace.ts"
    ],
    // Both coders share one workspace base, from
    // `@dynamicagents/plugins/workspace`, and the whole point of that base is
    // that it knows nothing about Claude Code: the egress policy arrives through
    // a config seam, and only `anthropic-coding`'s subclass fills it in. If this ever
    // fails, the shared base has grown an import that belongs in a subclass —
    // which would also put an Anthropic credential path in an agent that has no
    // business with one.
    forbidden: [plugin("claude-code")],
    // Measured 13474 KiB. Over generic's by the container client and
    // `@cloudflare/computer/git`, which bundles isomorphic-git so that clone,
    // fetch and push run on this side of the container boundary and the forge
    // token never crosses it. A workspace agent, so it also carries `/alarm`
    // and `/job`.
    maxBytes: 14_910_000
  },
  {
    name: "anthropic-coding",
    entries: [
      "src/agents/anthropic-coding/host.ts",
      "src/agents/anthropic-coding/workflow.ts",
      "src/agents/anthropic-coding/agent.ts",
      "src/agents/anthropic-coding/children.ts",
      // Included for the reason `coding`'s is, and more sharply: this subclass
      // is where the credential-egress gateway is wired, so it is the single
      // file this check most needs to be watching.
      "src/agents/anthropic-coding/workspace.ts"
    ],
    // Nothing to forbid: this agent installs every plugin in this repo, and
    // `coding`'s entry above is the other half of the `/claude-code` pair.
    forbidden: [],
    // Measured 13606 KiB: `coding`'s, plus `/claude-code`.
    maxBytes: 15_050_000
  }
];

/**
 * Modules the Workers runtime provides, so esbuild must not try to resolve them.
 *
 * The bare builtins (`fs`, `path`, …) are here because transitive dependencies
 * still import them unprefixed, and `nodejs_compat` supplies them at runtime —
 * wrangler's own build externalizes the same set. Without them this fails on
 * dependencies that have nothing to do with what is being measured.
 */
const EXTERNAL = ["cloudflare:*", "node:*", ...builtinModules];

/**
 * An agent class's own modules. A pipeline reaches its step agents by binding
 * name: one that imported a class would carry that agent's plugins into every
 * graph it is part of, another tenant's included.
 */
const AGENT_CLASS = /^src\/agents\/[^/]+\/(agent|children|workspace)\.ts$/;

let leakFailed = false;
let sizeFailed = false;
let pipelineFailed = false;

for (const agent of AGENTS) {
  const results = [];
  for (const entry of agent.entries)
    results.push(
      await build({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        write: false,
        metafile: true,
        // Never written (`write: false`), but esbuild requires it whenever a build
        // can emit more than one file — which `splitting` makes true of all of them.
        outdir: path.join(root, ".isolation-check"),
        format: "esm",
        // Load-bearing, and the reason this file once measured a lie.
        //
        // Without it esbuild cannot emit chunks, so a module reached only through a
        // dynamic `import()` is parsed — it still appears in `metafile.inputs`, so
        // the isolation half of this check always saw it — and then dropped from the
        // output. `@cloudflare/computer/git` lazy-loads its bundled isomorphic-git
        // exactly that way, and wiring it into `coding` moved the real deploy by
        // ~800 KiB while this script reported no change at all. A ceiling that
        // cannot see the largest thing anyone has added to a bundle is not a
        // ceiling.
        //
        // It is paired with building one entry point at a time below. `splitting`
        // across all three at once would also hoist what they *share* into one
        // chunk, which counts shared code once instead of once per entry and would
        // silently redefine every ceiling in this file. One entry per build keeps
        // the old scale and adds only what was missing.
        splitting: true,
        // Resolve the way wrangler does. `platform: "neutral"` applies no export
        // conditions at all, which makes perfectly-installed packages (`partyserver`,
        // via `agents`) look unresolvable — and a check that cannot resolve the graph
        // cannot measure it.
        platform: "browser",
        conditions: [
          "workerd",
          "worker",
          "browser",
          "import",
          "module",
          "default"
        ],
        mainFields: ["module", "main"],
        target: "es2022",
        external: EXTERNAL,
        // Required, not cosmetic. The Agents SDK resolves a facet through
        // `ctx.exports[this.constructor.name]`, so a build that minifies class
        // identifiers turns `GenericChild` into `_a` and the lookup fails at
        // runtime. Keeping names here also keeps this measurement honest against the
        // real deploy, which does the same.
        keepNames: true,
        // Minified, so the ceiling is a number about the *deploy* rather than about
        // source formatting. Unminified sizes drift with comments and would make the
        // budget react to documentation.
        minify: true,
        absWorkingDir: root,
        logLevel: "silent"
      })
    );

  const inputs = [
    ...new Set(results.flatMap((r) => Object.keys(r.metafile.inputs)))
  ];
  const bytes = results.reduce(
    (n, r) => n + r.outputFiles.reduce((m, f) => m + f.contents.length, 0),
    0
  );

  agent.entries.forEach((entry, i) => {
    if (!entry.endsWith("/workflow.ts")) return;
    const classes = Object.keys(results[i].metafile.inputs).filter((input) =>
      AGENT_CLASS.test(input)
    );
    if (classes.length === 0) return;
    pipelineFailed = true;
    console.error(
      `✗ ${agent.name}: its pipeline imports ${classes.join(", ")}`
    );
  });

  const leaked = agent.forbidden.filter((needle) =>
    inputs.some((input) => input.includes(needle))
  );

  if (leaked.length > 0) {
    leakFailed = true;
    console.error(`✗ ${agent.name}: leaked ${leaked.join(", ")}`);
    for (const needle of leaked) {
      // Name the actual file, so the fix is obvious rather than a hunt.
      const culprits = inputs.filter((i) => i.includes(needle)).slice(0, 3);
      for (const c of culprits) console.error(`    via ${c}`);
    }
  } else if (bytes > agent.maxBytes) {
    sizeFailed = true;
    console.error(
      `✗ ${agent.name}: ${fmt(bytes)} exceeds its ${fmt(agent.maxBytes)} ceiling.\n` +
        "    Either something was pulled in that should not have been, or the " +
        "ceiling needs raising deliberately."
    );
  } else {
    console.log(
      `✓ ${agent.name}: ${fmt(bytes)} (ceiling ${fmt(agent.maxBytes)}), ` +
        `${inputs.length} modules, no cross-agent plugin`
    );
  }
}

function fmt(n) {
  return `${(n / 1024).toFixed(0)} KiB`;
}

if (leakFailed) {
  console.error(
    "\nA plugin reached an agent that does not install it. Nothing in core " +
      "imports a plugin and `@dynamicagents/plugins` has no root barrel, so this is " +
      "almost always one agent importing another agent's module — follow the " +
      "`via` lines. Anything genuinely shared between agents belongs in " +
      "src/workspace/, src/config.ts, src/copy.ts or src/model.ts, never in a sibling's directory."
  );
}
if (sizeFailed) {
  console.error(
    "\nAn agent outgrew its ceiling with no forbidden plugin in its graph. " +
      "Either a dependency arrived that nobody asked for, or the agent really " +
      "did grow — in which case raise the number here, deliberately, in the same " +
      "commit as whatever grew it."
  );
}
if (pipelineFailed) {
  console.error(
    "\nA pipeline imported an agent class. Name the step agent's binding in " +
      "`step.agent` instead: the workflow reaches it by name, never by import."
  );
}
if (leakFailed || sizeFailed || pipelineFailed) process.exit(1);

console.log("\nEach agent's graph carries only the plugins it installs.");
