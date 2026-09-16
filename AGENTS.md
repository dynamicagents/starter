# AGENTS.md — working in `da-starter`

This is the repo you fork. It composes
[`@dynamicagents/core`](https://github.com/dynamicagents/core) (the mandatory
foundation) and
[`@dynamicagents/plugins`](https://github.com/dynamicagents/plugins) (optional
capabilities) into a deployable Worker.

The single most useful thing to know: **almost nothing here is framework.** The
round loop, the durable Subtask rows, the concurrent fan-out, the subagent execution,
the Durable Object body and the task lifecycle are all in core. What lives here is
what core deliberately refuses to ship — the words, the config values, and which
plugins each agent installs.

If you find yourself writing durable-execution logic in this repo, that is the
signal it belongs in core instead. If you find yourself writing the Durable
Object a capability lives in — a container, its alarm, its install — that is the
signal it belongs in plugins. `src/workspace/` holds only config, addresses and
adapters for the workspace this Worker deploys; the object itself is
`@dynamicagents/plugins/computer`.

---

## Where a thing goes

| You are changing…                         | It goes in                              |
| ----------------------------------------- | --------------------------------------- |
| what the model is told about a domain     | the plugin that owns that domain        |
| what the agent _is_                       | `src/agents/<tenant>/soul.ts`           |
| how a round ends, or a user-facing string | `src/round-policy.ts`                   |
| which capabilities an agent has           | `src/agents/<tenant>/plugins.ts`        |
| model ids, budgets, limits                | `src/config.ts`                         |
| the object a capability runs in           | **`@dynamicagents/plugins`** — not here |
| cancellation, retries, idempotency, DAGs  | **`@dynamicagents/core`** — not here    |

`src/round-policy.ts` and `src/config.ts` sit at the top level because two agents
share them. An agent importing a _sibling's_ module is what `npm run
verify:isolation` fails on, because the sibling's plugin list comes with it — even
a type-only import, because the next person makes it a value import.

---

## Adding and removing agents

```bash
npm run agent:new <tenant> [--kind round|single]
npm run agent:remove <tenant>
```

Never do it by hand. An agent exists in four places — its directory, `src/index.ts`,
three blocks in `wrangler.jsonc`, and `scripts/verify-isolation.mjs` — and each
missed one fails at a different time: a forgotten DO binding at deploy, a forgotten
`new_sqlite_classes` entry at the first request, a forgotten isolation entry
_never_, because it just stops checking that agent.

Add-then-remove must return all four files byte-for-byte to where they started.
That round trip is the test that keeps the script honest; run it if you change the
script.

**A tenant id is a public identifier.** A gatekeeper registers against it and it rides
in a JWT claim, so renaming one is a re-registration, not a refactor.

---

## The two invariants that have already broken once

**1. Cancellation is checked by the guarded write, never by a probe.**
`saveTask` returns whether the write applied, and `markWorking` returns
`"ok" | "canceled"`. Read those. Calling `getTask` first and acting second reopens
a window in which a cancel lands and the gatekeeper still gets a `completed`
callback — and that is exactly how this repo's proactive agent drifted from its
sibling. `test/proactive/workflow.spec.ts` pins both.

**2. `verify:isolation` is the check that survives a refactor.**
This Worker deploys as one bundle containing every agent, so grepping `dist/`
proves nothing. Each agent's entry is bundled alone and esbuild's **metafile** —
the module list, not a string search — is checked for plugins that agent does not
install, plus `@dynamicagents/core/dist/round/` for the agent that does not delegate.

It has caught two real leaks: a shared base class living in one agent's directory,
and (after the core split) it is what holds proactive at ~1.5 MiB instead of ~2.5.

---

## Working here

```bash
npm run check              # wrangler types, prettier, eslint, tsc, comment path refs
npm test                   # vitest, inside real workerd
npm run verify:isolation   # per-agent module graphs + size ceilings
npx wrangler deploy --dry-run --outdir dist
```

`npm test` alone will not catch a type error — vitest transpiles specs without
typechecking them — so run `check` before pushing.

### Across the three repos

```bash
npm run link:local    # npm pack + tarball install from ../core, ../plugins
```

`npm pack` + tarball, deliberately — **not `npm link`**, which symlinks the checkout
and gives it its own copy of every peer. Two copies of `agents` in one Worker bundle
breaks the `Session` / `SessionMessage` types and every `instanceof`, at runtime
rather than at the type level.

A contract change is a three-repo publish train (core → plugins → starter), so one
repo is always briefly behind. `PLUGIN_CONTRACT_VERSION` is asserted at DO start so
a skew fails with a sentence naming the plugin rather than a structural-type error
several frames away.

### The branches, and what each installs

This repo is not versioned and publishes nothing, but it still has a released line:
**`main` is what a fork builds.** It pins published versions of core and plugins, and
nothing on it may depend on a commit that is not released. Development lands on
`next`, by squash-merged PR.

**`next` pins published versions too, by default.** A change that needs core or
plugins work not yet published may point `next` at their `main` by git ref for as long
as it needs to, which is how a contract change is exercised end-to-end before any of it
ships. The ref installs only because those repos carry a `prepare` that builds and
because `allowScripts` here lets npm run it — drop either and every subpath resolves
to a missing file. npm pins the ref to a SHA in the lockfile, so a merge upstream does
not reach this repo until someone reinstalls; a plain reinstall of the lockfile keeps
the old commit.

**A release is a PR from `next` into `main`, merged with a merge commit.** Before it,
once core and plugins are published, a PR into `next` pins the new versions and removes
any git ref; Test fails a PR into `main` that still names one. Nothing reaches `main`
any other way, a fix included, so `main` only ever gains merges of `next` and a release
never needs merging back.

Use `npm run link:local` for work that is not committed anywhere yet; a git ref only
reaches what is on a branch.

---

## Comments

This repo comments heavily, and that is deliberate: a lot of what is here was
expensive to learn and invisible in the code. The cost is that comments rot, so
they are held to the same bar as the code.

A comment states a **constraint, a measurement, or a coupling** — something that
changes a decision. Not what changed, not when, not what a previous version said;
`git log` owns that. In particular:

- **No changelog.** "This used to…", "removed in 0.8.2", "the design plan called
  for…" are all history. Write the rule that survives it. A measurement is worth
  keeping (`npm ci` at 225 s, `check` at 28 s); the date it was taken is not.
- **No package versions or dates** in prose. They are stale on the next bump and
  nothing checks them.
- **One home per fact.** Put the explanation in the file somebody edits when they
  change that behaviour, and a pointer everywhere else. Four copies of the same
  paragraph in four files do not stay in step — they diverge, and then the reader
  cannot tell which one is current.
- **No counts.** "the three agents", "the four values below", "the ten workspace
  specs", module counts, spec counts. Every one of these was wrong within a
  release. Name the thing, not how many there are.
- **Cross-file references name a real path**, and a path in a comment is
  checkable — so check it before you write it.

If a comment is longer than the code it explains, ask what decision it is
protecting. Usually one paragraph of that is doing the work.

---

## Size ceilings

`verify:isolation` enforces a byte ceiling per agent. They are not aesthetic:
bundle growth is the observable symptom of the subpath-export discipline rotting,
and a ceiling turns a slow leak into a failing build. Raise one **deliberately**,
with the dependency bump that caused it — never to make a build pass.
