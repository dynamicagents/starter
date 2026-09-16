#!/usr/bin/env node
/**
 * Prove that each agent's module graph is its own.
 *
 * ## What this actually checks, and why it is not the obvious thing
 *
 * This Worker deploys as **one bundle containing every agent**, so grepping
 * `dist/` for "arc-agi" would always find it and prove nothing. The invariant
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
/** A core subpath. `/round` is the delegation engine — opt-in, and its own graph. */
const core = (name) => `@dynamicagents/core/dist/${name}/`;

/**
 * One agent, its entry points, and what must not be in its graph.
 *
 * `forbidden` is the interesting column. Each entry is a plugin *another* agent
 * installs — so it is not a list of things nobody uses, it is a list of things
 * that exist in this repo and must not have leaked sideways.
 *
 * ## What every agent carries whatever it imports
 *
 * The `agents` SDK composes its own `Lifecycle` into the `Agent` base class, with
 * a scheduler, a task runner, dynamic-agent routing and WebSocket handling
 * installed on it — so **every** entry that extends `Agent` carries all of them,
 * used or not. Measured at 372 KiB of `agents` in `reactive`'s agent entry, which
 * imports neither `/alarm` nor `/job` and cannot shed any of it. That share moves
 * with the SDK, so a bump of it moves every ceiling here at once, and that is not
 * a leak: `forbidden` is the check that would catch one.
 *
 * An agent that owns a workspace additionally carries `core/dist/alarm` (7 KiB)
 * and `core/dist/job` (13 KiB) — and *only* such an agent, which is the
 * isolation this file exists to assert still holding.
 *
 * Every ceiling below is its measurement plus the ~8% headroom this file runs
 * with.
 */
const AGENTS = [
  {
    name: "reactive",
    entries: [
      "src/agents/reactive/agent.ts",
      "src/agents/reactive/workflow.ts",
      "src/agents/reactive/subagent.ts"
    ],
    forbidden: [
      plugin("arc-agi"),
      plugin("triage"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/computer"
    ],
    // Re-baselined when `splitting` was turned on above, not because this agent
    // grew: the old number simply never counted the chunks it reaches through a
    // dynamic `import()`. Measured 3687 KiB the first time it was weighed
    // honestly, against a 3613 KiB ceiling it had been quietly over. ~8% over
    // that measurement, the headroom every entry here runs with.
    //
    // Measured 4427 KiB. The agent that shows the SDK's share cleanly — see
    // "What every agent carries" above — since it imports neither `/alarm` nor
    // `/job` and still carries the scheduler.
    maxBytes: 4_900_000
  },
  {
    name: "proactive",
    entries: [
      "src/agents/proactive/agent.ts",
      "src/agents/proactive/workflow.ts"
    ],
    // Also no `/workspace`: this agent never delegates, so no execution ever
    // needs a durable file store — and `@cloudflare/shell` is a real dependency
    // to carry for nothing.
    //
    // And no `@dynamicagents/core/round`. That is the strongest assertion here: core
    // ships the whole delegating loop — DAG scheduler, chunked subagent
    // execution, the repair ladder — behind an opt-in subpath, and an agent that
    // answers in one turn must not pay a byte for it. If this ever fails, the
    // root barrel has started re-exporting `/round`.
    forbidden: [
      plugin("arc-agi"),
      plugin("workspace"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/shell",
      "@cloudflare/computer",
      core("round")
    ],
    // Measured 1909 KiB. See "What every agent carries" above.
    maxBytes: 2_110_000
  },
  {
    name: "arc-player",
    entries: [
      "src/agents/arc-player/agent.ts",
      "src/agents/arc-player/subagent.ts"
    ],
    // No triage, no browser, no recall: this agent plays games.
    forbidden: [
      plugin("triage"),
      plugin("browser"),
      plugin("recall"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/computer"
    ],
    // Measured 3560 KiB. See "What every agent carries" above.
    maxBytes: 3_940_000
  },
  {
    name: "coder",
    entries: [
      "src/agents/coder/agent.ts",
      "src/agents/coder/workflow.ts",
      "src/agents/coder/subagent.ts",
      // The workspace object is a deployed class of this agent's too, and
      // omitting it left the one assertion below that names `/claude-code`
      // unable to fail: the shared base arrives in this graph anyway (via
      // `workspaceName` in `agent.ts`), but the *subclass* did not, so an import
      // added only there was neither leak-checked nor size-counted.
      "src/agents/coder/workspace-do.ts"
    ],
    // No arc-agi, no triage, no recall — and no `/workspace`, which is the one
    // worth stating: the computer plugin is this agent's filesystem, and having
    // both would hand the model two unrelated ones with no way to tell from a
    // path which it is addressing.
    //
    // `/claude-code` is the newest entry and the one doing the most work. Both
    // coders share one workspace base, from
    // `@dynamicagents/plugins/computer`, and the whole point of that base
    // is that it knows nothing about Claude Code: the egress policy arrives
    // through a config seam, and only `claude-coder`'s subclass fills it in. If
    // this ever fails, the shared base has grown an import that belongs in a
    // subclass — which would also put an Anthropic credential path in an agent
    // that has no business with one.
    forbidden: [
      plugin("arc-agi"),
      plugin("triage"),
      plugin("recall"),
      plugin("workspace"),
      plugin("claude-code"),
      "@cloudflare/shell"
    ],
    // Higher than its siblings because it is the only agent carrying a container
    // client and a second model provider — but still a real ceiling, ~8% over
    // the measured size, the same headroom the others run with. Raise it
    // deliberately, with the dependency bump that caused it, never to make a red
    // build go green.
    //
    // Moved 4300 → 5450 KB in two steps, both deliberate and worth separating:
    //   +111 KiB  turning on `splitting` — weight this agent already carried
    //             through dynamic imports and this script could not see.
    //   +608 KiB  `@cloudflare/computer/git` in the workspace DO, which bundles
    //             isomorphic-git so that clone, fetch and push run on this side
    //             of the container boundary and the forge token never crosses
    //             it. Bought knowingly: it is the cost of the credential never
    //             being readable by a shell the model controls.
    // Measured 4918 KiB after both.
    //
    // Raised when `workspace-do.ts` was added to `entries` above. That moved the
    // *measurement*, not the agent: the deployed bytes are unchanged and the
    // check simply stopped being blind to one of its classes. Measured 5185 KiB
    // after, which the old 5322 KiB ceiling left only 2.6% of headroom over —
    // too tight for the ~8% every other entry here runs with, so it would have
    // gone red on the next dependency bump for no real reason.
    //
    // Measured 6075 KiB. A workspace agent, so it also carries `/alarm` and
    // `/job`; see "What every agent carries" above for the rest.
    //
    // The last 99 KiB of that is the container client growing wherever it is
    // embedded — a bigger sync engine and a newer capnweb. It is the whole of
    // the difference, and `forbidden` stayed clean through it, which is the
    // check that would have caught a leak instead.
    maxBytes: 6_720_000
  },
  {
    name: "claude-coder",
    entries: [
      "src/agents/claude-coder/agent.ts",
      "src/agents/claude-coder/workflow.ts",
      "src/agents/claude-coder/subagent.ts",
      // Included for the reason the coder's is, and more sharply: this subclass
      // is where the credential-egress gateway is wired, so it is the single
      // file this check most needs to be watching.
      "src/agents/claude-coder/workspace-do.ts"
    ],
    // The coder's list, minus `recall` — this agent installs it, for the reason
    // in its `plugins.ts`. No `/workspace` for the same reason as the coder: the
    // computer plugin is this agent's filesystem and two would be ambiguous.
    //
    // No `arc-agi`, no `triage`. Nothing here forbids `/claude-code`, obviously
    // — this is the one agent that installs it, and the coder's entry above is
    // the other half of that pair.
    forbidden: [
      plugin("arc-agi"),
      plugin("triage"),
      plugin("workspace"),
      "@cloudflare/shell"
    ],
    // Sized like the coder's, which is the right comparison: same container
    // client, same isomorphic-git, same round loop. What it adds over the coder
    // is `/recall` and `/claude-code`, and what it drops is nothing.
    // Re-baseline against a measurement, never to make a red build green.
    //
    // Measured 5976 KiB, and sized with the same ~8% headroom as the rest: the
    // tighter margin the coder's comment above describes is what sends a build
    // red on the next bump for no real reason. It carries the same 99 KiB of
    // container client the coder does, for the same reason.
    maxBytes: 6_610_000
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

let leakFailed = false;
let sizeFailed = false;

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
        // exactly that way, and wiring it into the coder moved the real deploy by
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
        // identifiers turns `ArcPlayerSubagent` into `_a` and the lookup fails at
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
      "src/workspace/, src/config.ts or src/round-policy.ts, never in a sibling's directory."
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
if (leakFailed || sizeFailed) process.exit(1);

console.log("\nEach agent's graph carries only the plugins it installs.");
