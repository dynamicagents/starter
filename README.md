# da-starter

**A working, deployable Dynamic Agent on Cloudflare Workers.**

Zero-trust A2A, durable task lifecycle, delegation to isolated subagents, episodic
memory. Clone it, generate keys, deploy.

It ships **five example agents in one Worker** — grow the one you want, and
`npm run agent:remove` the rest. Adding or removing a capability is a single line.

Everything here is an _example_. The round loop, the durable Subtask rows, the
subagent execution and the task lifecycle all live in `@dynamicagents/core`, so this
repo is the ~250 lines per agent that are actually yours: plugins, soul, manifest,
config, and the round contract.

> Part of a three-package split:
> [`@dynamicagents/core`](https://github.com/dynamicagents/core) (the mandatory foundation) ·
> [`@dynamicagents/plugins`](https://github.com/dynamicagents/plugins) (optional capabilities) ·
> **`da-starter`** (this — a working agent that composes them).

---

## Quick start

```bash
npm install
npm run keygen          # one key for the deployment — see .env.example
npx wrangler vectorize create da-starter-recall --dimensions=1024 --metric=cosine
```

Put the key and `GATEKEEPER_ORIGINS` in `.env` before starting — the Worker reads both
on its first request ([`.env.example`](.env.example) documents every secret,
including the coder-only ones):

```bash
npm run dev
```

Wrangler loads `.env`, then `.env.local`, then — with `--env <name>` — `.env.<name>`
and `.env.<name>.local`, each overriding the last, so a staging deployment is
`.env.staging` rather than an edit to `wrangler.jsonc`. Everything but `.env.example`
is gitignored.

> One caveat: if a `.dev.vars` file exists it wins outright and none of the above is
> read. This project uses `.env`; keep a single file so there is never a question which
> one is live.

To ship, set the same secrets with `wrangler secret put` (or push the whole file with
`npx wrangler deploy --secrets-file .env`) and:

```bash
npm run deploy
```

Register each agent with your gatekeeper using the **same endpoint** and its own
**tenant id**:

| endpoint                    | tenant id      |
| --------------------------- | -------------- |
| `https://<your-worker>/a2a` | `reactive`     |
| `https://<your-worker>/a2a` | `proactive`    |
| `https://<your-worker>/a2a` | `arc-player`   |
| `https://<your-worker>/a2a` | `coder`        |
| `https://<your-worker>/a2a` | `claude-coder` |

`/a2a` is core's default, not a requirement — see [Where the endpoints
live](#where-the-endpoints-live). Register whatever path this deployment actually serves.

> **The default models need a paid Workers plan**, or prepaid AI Gateway credits. Every
> Workers AI agent takes its models from `MODEL` in [`src/config.ts`](src/config.ts),
> and those are not served on Workers Free. On the free tier, point `MODEL`'s
> `chatModelId` and `fallbackChatModelId` at models that are, and that support function
> calling. Then check `PROACTIVE_CONFIG` in the same file: it sets its own
> `fallbackChatModelId` over `MODEL`'s, and core refuses a fallback identical to the
> primary.

> **Browser Rendering needs a paid Workers plan.** On the free tier, remove `browser()`
> from the agents' `plugins.ts` and the `browser` binding from `wrangler.jsonc`.

> **The two coders' containers need a paid plan and a running Docker daemon** — Docker
> Desktop on macOS and Windows, the Docker CLI **and engine** on Linux. `npm run deploy`
> builds `./Dockerfile` on this machine. See [The two coders need one thing the others
> do not](#the-two-coders-need-one-thing-the-others-do-not).

---

## One Worker, several agents

A Worker is not one agent. The agents here are **tenants** of one deployment — one origin,
one endpoint, one signing key, one card ([`src/index.ts`](src/index.ts)):

```ts
// src/agents/reactive/definition.ts — declared once
export const reactive = defineAgent({
  tenant: "reactive",
  manifest,
  agent: (env: Env) => env.ReactiveAgent,
  workflow: (env: Env) => env.HANDLE_TASK_WORKFLOW
});

// src/index.ts — mounted
createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [reactive, proactive, arcPlayer, coder, claudeCoder]
});
```

That same declaration is what the agent's Workflow resolves its DO stub from, so
the tenant and the workflow can never address different Durable Objects — a
mismatch that used to type-check perfectly and surface as a task that never
called back.

```
/.well-known/agent-card.json   the stub card for the deployment
/.well-known/jwks.json         the one public key, verifying every card
/a2a                           every agent, picked by params.tenant
```

`AgentInterface.tenant` is the A2A mechanism for exactly this — _"an opaque string used for
routing requests to a specific agent or tenant when multiple agents are served behind a
single A2A endpoint"_ — and §8.3.2 requires a client to send the value the interface it
selected declared. A tenant is required on every request: there is no default agent and no
implicit routing.

### Where the endpoints live

Only the **first** of those three paths is fixed, for the reason the next section gives:
it is a well-known URI, so core matches it by suffix and you cannot move it. The other two
are defaults, and both are options on `createA2AWorker`:

```ts
createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [ … ],
  rpcPath: "/rpc",                     // default "/a2a"
  jwksPath: "/.well-known/keys.json"   // default "/.well-known/jwks.json"
});
```

Nothing else has to be told. The cards' `supportedInterfaces[0].url` is built as
`${origin}${rpcPath}`, each card's `jku` points at `jwksPath`, and the gatekeeper-token
`audience` defaults to that same `${origin}${rpcPath}` — so the path served, the path
advertised, and the audience tokens must be minted for stay in step by construction.

What does _not_ follow automatically is the **gatekeeper's registration**, which has to name
the endpoint this deployment actually serves: that URL is the `aud` its tokens carry. Change
`rpcPath` on an already-registered agent and every request 401s until it is re-registered.

### Why not a path prefix per agent

That is what this repo did first, and it cannot work. The AgentCard lives at a **well-known
URI**, which RFC 8615 defines per-authority, so only one card per origin is discoverable at
the path A2A registered with IANA. A gatekeeper resolving `/.well-known/agent-card.json`
against the origin found whichever agent owned the bare path and pinned _its_ key for every
agent here — so the rest registered under a name and key that were not theirs, and their
push callbacks were rejected after the model work was already done.

So the card served there is a **stub** describing the deployment. Each agent's real card —
its name, skills and signature — comes from `GetExtendedAgentCard`, the spec's own
tenant-aware card method:

```jsonc
// POST /a2a  (whatever `rpcPath` serves)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "GetExtendedAgentCard",
  "params": { "tenant": "proactive" }
}
```

A card carries one interface entry and clients take the first, so the stub cannot list its
siblings — they are named in its `description` for a human, and registered out of band.

### One key, and what actually separates them

Each agent used to hold its own signing key, which never bought anything: they share a
Worker and an `env`, so each could always read the others'. The card is per-origin and so
is the key.

What separates them is the gatekeeper token's **tenant claim**, checked against the tenant the
request addressed. That is a real boundary — it is cryptographic, and it holds even though
they share an audience. Without it `tenant` would be an unauthenticated field in the
request body, and a token minted for one agent would work against any sibling.

> **This needs a gatekeeper that mints the tenant claim and registers agents with a tenant
> id** ([slack-gatekeeper#62](https://github.com/dynamicagents/slack-gatekeeper/pull/62)).
> Both sides take the claim names from `@dynamicagents/g2a-protocol` rather than spelling
> them out, and that package exists for exactly this reason: when the two disagree the
> failure is silent. The gatekeeper writes a tenant claim core never reads, core compares an
> empty tenant against the one the body addressed, and **every request 401s** — with neither
> build noticing, because each side is internally consistent on its own. So the two do not
> interoperate across a change to either, and they deploy together with registered agents
> re-registered.

---

## The agents

| Agent                                       | What it is                                                              | Why it's here                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`reactive/`](src/agents/reactive/)         | Round loop, delegation, subagent execution                              | The flagship                                                                                     |
| [`proactive/`](src/agents/proactive/)       | Sees every message, decides whether each is for it, answers in one turn | **The second consumer** — the only thing proving core isn't shaped around reactive's assumptions |
| [`arc-player/`](src/agents/arc-player/)     | Plays ARC-AGI-3 games                                                   | Proves a domain plugin composes without touching anything shared                                 |
| [`coder/`](src/agents/coder/)               | Clones a repo into a Linux sandbox, changes it, opens a pull request    | Proves a plugin can own a Durable Object and a container without core knowing                    |
| [`claude-coder/`](src/agents/claude-coder/) | The same, but each subtask is a Claude Code session in the container    | **Proves a subtask need not be a model loop at all** — `executeChunk` is overridden outright     |

Reactive, arc-player and both coders are all `RoundAgentBase` from
[`@dynamicagents/core/round`](https://github.com/dynamicagents/core) and differ in five
methods each. Proactive extends `DynamicAgent` directly and writes its own loop — it
imports no part of `/round` at all, and `npm run verify:isolation` asserts that on the
built graph. Two genuinely different loop shapes on one core.

|             | reactive                                                  | proactive                            |
| ----------- | --------------------------------------------------------- | ------------------------------------ |
| bound by    | a mutable `TurnBudget` metered across rounds              | a flat `MAX_STEPS`                   |
| ends when   | the model calls a control tool (`toolChoice: "required"`) | the model stops, or calls `no_reply` |
| can decline | no — every round answers or delegates                     | yes, that is the point               |
| rounds      | many, driven by a Workflow                                | exactly one                          |

### The two coders need one thing the others do not

A **container**. Everything else about them — the round loop, the durable Subtask
rows, the model pair — is what every other agent here runs.

The two differ in exactly one place, and it is one level below the agent: what a
subtask _is_. A `coder` subtask is a Dynamic Agents subagent running core's tool loop
inside the container. A `claude-coder` subtask is one `claude -p` session — its
own loop, its own tools, its own context management — which is why that agent
overrides `executeChunk` instead of configuring a recipe. Their workspace Durable
Objects are two thin subclasses of `WorkspaceObjectBase` from
`@dynamicagents/plugins/computer`, differing only in a
`WorkspaceObjectConfig`.

That egress policy is the whole reason `claude-coder` exists. An Anthropic
**subscription** credential is refused for raw Messages API calls on every
frontier model and accepted from the sanctioned client — so reaching Opus on one
means running that client, and the client runs in a container that also runs a
cloned repository's `postinstall`. The credential never goes there: the session
launches with a placeholder, and `{ mode: "http-gateway" }` routes every outbound
request through a `Fetcher` on the Worker side which swaps the real one in. That
egress gateway also holds an ordered **pool** of credentials and rotates when
Anthropic says one's 5-hour or weekly bucket is spent.

Every agent's own round loop, both coders included, runs on Workers AI through
the `AI` binding. **There is no model credential in this deployment**: the
binding is authenticated by the platform, so there is nothing to store, nothing
to rotate, and the coder's container has never seen one. An AI Gateway `401` means
Authenticated Gateway is switched on for the AI Gateway named by `aiGatewayId` —
switch it off, because the binding does not send a token.
[`.env.example`](.env.example) is the full list of what a deployment does need.

The container needs the **Workers Paid** plan and a running Docker daemon on the
machine that runs `wrangler deploy` — wrangler builds `./Dockerfile` locally and
pushes the image, so that is your laptop or your CI runner, never Cloudflare:

- **macOS and Windows** — install **Docker Desktop** and have it running. The
  `docker` CLI on its own is not enough: the build needs a Linux kernel, which is
  what Desktop's VM provides. (Anything else that exposes a daemon socket works —
  OrbStack, Colima, Rancher Desktop.)
- **Linux** — the Docker CLI and engine, and nothing else. No Desktop.

With no daemon reachable, `npx wrangler deploy --containers-rollout=none` deploys
the Worker and leaves the container alone.

> **The image and the Worker are one release.** The library in the Worker speaks
> to `computerd` in the image, and it authenticates: a host refuses a container
> that does not enforce the shared secret it was launched with, and a container
> already running when a Worker with different launch settings arrives is
> relaunched rather than adopted. So a Worker deployed without its image has
> workspaces that cannot open, and the first deploy after an image change takes
> any session running in an old container with it. Roll them together, and expect
> in-flight sessions to end — `--containers-rollout=none` is for a Worker-only
> change, not for skipping a container build you also made.

A staged image rollout is the same hazard with a timer on it, which is why every
container entry in [`wrangler.jsonc`](wrangler.jsonc) pins
`rollout_step_percentage` — the comment there is the explanation.

> **Deleting a container application does not rebuild it.** In the dashboard it
> reads like turning something off and on again, and it is not: the application
> is created by `wrangler deploy`, and the Durable Object can only start
> instances of one that already exists. Delete it and every workspace fails —
> `There is no container application assigned to this Durable Object namespace`
> — until the next deploy, which turns a bounded problem into an open-ended one.
> To replace every container, deploy. To replace one workspace's, let it go idle.

#### The checkout outlives the container, and the container outlives the task

The **workspace** is a Durable Object, one per caller per repository, and the
checkout lives in its SQLite. `@cloudflare/computer` mounts that filesystem into
the container over FUSE at `/workspace`, so commands run against the same tree the
Worker reads over RPC — and the tree survives the container being replaced.

`node_modules` does not. It is a bind mount of the container's own disk, so an
install runs at disk speed and never crosses the wire, and a new container
reinstalls. The workspace arms that install as soon as a container comes up or a
command is about to start one; see `src/workspace/install-plan.ts`. Container
directory snapshots are the intended fix for the reinstall.

**There is deliberately no R2 bucket** — the checkout is already durable.
[`wrangler.jsonc`](wrangler.jsonc) records why the snapshot approach it replaces
could not work.

Two consequences worth knowing before you debug something surprising:

- **A caller's checkout outlives their task.** `repo_clone` therefore fetches and
  resets an existing checkout rather than assuming an empty directory — and
  refuses outright if the tree is dirty, because those changes are a previous
  task's work and nobody could recover them once discarded.
- **A cancelled task resets the working tree rather than destroying the
  container.** That is the opposite of what it used to do, and the reversal is the
  point: the container _was_ the state, and now it holds none of it but
  dependencies. Destroying one costs a container start and a reinstall, and
  leaves the abandoned edits exactly where they were.

Delegated subtasks reach the parent's workspace through a `resolveRuntime` hook —
`code()`'s for the coder, the `claude-code` plugin's for claude-coder. It runs on
the **parent** and puts the workspace name into the runtime state the subagent
receives. That indirection is required, not stylistic: core gives a subagent
execution a `callerKey` thunk that **throws**, so a facet cannot derive the name
itself — and it is deliberately not a subtask param, because those are
model-authored and a model could then name somebody else's workspace.

---

## The one file you edit

Each agent has its own `plugins.ts`. Delete a line and that module leaves the bundle
entirely:

```ts
// src/agents/reactive/plugins.ts
export const plugins = (host: PluginHost): AgentPlugin[] => [
  general({
    primaryModelId: host.primaryModelId,
    fallbackModelId: host.fallbackModelId
  }),
  browser({ binding: host.env.BROWSER }),
  workspace(),
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey
  })
];
```

Nothing in core imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
specifier does not resolve — so the guarantee is structural rather than a tree-shaker's
opinion. `npm run verify:isolation` asserts it on the built module graph.

There is deliberately **no shared plugin list**: a single one would put every plugin in
every agent and make the guarantee unmeasurable.

`plugins` takes a host object rather than `env` because a plugin may need more than
bindings — `arcAgi` needs the DO's storage for its ledger, and `recall` needs the verified
caller as a **thunk**, since that identity does not exist yet when `onStart` runs.

### Writing your own

A plugin is not a package; it is an object satisfying a contract.
[`src/agents/reactive/general.ts`](src/agents/reactive/general.ts) is one this repo writes
rather than installs — the `general` catch-all subtask type, declared with `definePlugin`
and indistinguishable from a published plugin at the seam.

It is also _why_ there is no `@dynamicagents/plugins/general`: core's `validateRecipe` refuses
a recipe with no soul rather than lending it one, so that no run ever executes under an
identity nobody chose. That identity is yours to write.

---

## Add or delete an agent

One command each.

```bash
npm run agent:new demo                 # a delegating round agent
npm run agent:new watcher --kind single  # a single-turn agent, its own loop
npm run agent:remove arc-player
```

Each edits every place an agent exists — its directory, [`src/index.ts`](src/index.ts),
[`wrangler.jsonc`](wrangler.jsonc) (DO binding, sqlite migration, workflow binding), and
[`scripts/verify-isolation.mjs`](scripts/verify-isolation.mjs) — then runs prettier over
what it touched. `agent:new` then tells you what it cannot decide for you: the config
entry and the agent's soul.

Do it by hand and a missed edit fails at a different time each: a forgotten DO binding at
deploy, a forgotten `new_sqlite_classes` entry at the first request, a forgotten
isolation entry _never_ — it just quietly stops checking that agent.

Add-then-remove returns every file it touched byte-for-byte to where it started, which
is the test that keeps this honest.

> The signing key and `GATEKEEPER_ORIGINS` are **not** removed: they belong to the
> deployment, not to any one agent. A secret only one agent's plugins needed —
> `ARC_API_KEY` — is yours to drop.

---

## What runs in CI

```bash
npm run check              # wrangler types, prettier, eslint, tsc, comment path refs
npm test                   # vitest, inside real workerd
npm run verify:isolation   # per-agent module graphs + size ceilings
npx wrangler deploy --dry-run --outdir dist
```

`verify:isolation` is the one that survives a refactor six months from now. This Worker
deploys as **one bundle containing every agent**, so grepping `dist/` for "arc-agi"
would always find it and prove nothing. Instead each agent's entry is bundled on its own,
and esbuild's **metafile** — the exact list of modules in the graph, not a string search —
is checked for plugins that agent does not install:

```
✓ <agent>: <size> (ceiling <max>), <n> modules, no cross-agent plugin
```

One line per agent, and a failing one names the module that leaked and the import path
that pulled it in. Sizes move with every dependency bump — the ceilings in
[`scripts/verify-isolation.mjs`](scripts/verify-isolation.mjs) are what CI enforces, and
raising one is a deliberate act that belongs in the same commit as whatever grew it.

Proactive's `forbidden` list carries `@dynamicagents/core/dist/round/` as well as the
plugins its siblings install. That is the strongest line in the file: core ships the
whole delegating loop behind an opt-in subpath, and an agent that answers in one turn
must not pay a byte for it. It is also why proactive is ~1.5 MiB rather than ~2.5.

It earns its keep: it caught a real leak during this repo's own construction, when the
shared base class still lived in `agents/reactive/` and arc-player extending it dragged
`/browser` and `/recall` into a graph that installs neither.

---

## Continuous deployment

This repository's own deployment, `agents.loopingai.org`, follows `main`. When Test goes
green on a push to `main` — a release merged from `next` —
[`deploy.yml`](.github/workflows/deploy.yml) runs `npx wrangler deploy` for that commit,
which builds and pushes the container images with the Worker, then polls
`/.well-known/agent-card.json` until it answers 200. That shows the domain still serves; it
cannot tell the new version from the old. A commit that is no longer `main`'s tip by the
time its run gets there stands aside rather than roll production back. `next` never
deploys.

It needs a GitHub environment named `deployment` holding these secrets:

- `CLOUDFLARE_ACCOUNT_ID`.
- `CLOUDFLARE_API_TOKEN`, with Account › Workers Scripts › Edit, Account › Containers ›
  Edit for the images, and Zone › Workers Routes › Edit on the custom domain's zone, which
  every deploy re-asserts. Bound resources such as Workers AI, Vectorize and Browser
  Rendering need no scope of their own to deploy against.

The Worker's runtime secrets are not in GitHub. Set them once with `wrangler secret put`;
they persist across deploys, and a deploy fails naming any in `secrets.required` that was
never set.

A repository made from this template skips the job, since it has neither the environment
nor the domain. To deploy yours the same way, create the environment, then name your
repository in the job's `if:` and your origin in its URLs.

---

## Looking at a running deployment

```bash
cp .cf.env.example .cf.env    # an account-scoped API token + your account id
npm run cf -- logs --since 2h --level error
npm run cf -- wf handle-task
npm run cf -- ai --since 2h
```

[`scripts/cf.mjs`](scripts/cf.mjs) is a small Cloudflare API proxy for the three questions
a deploy actually raises: what did it log, did the workflow finish its steps, and what did
the model get asked. Each subcommand prints a digest rather than the raw envelope — `logs`
a level-tallied timeline, `wf <name> <instance>` per-step pass/fail, `ai <logId>` the
prompt and reply as text — with `--json` or `--raw` when you want the body. This Worker's
workflows are `handle-task`, `arc-handle-task` and `notify-task`.

The credentials go in `.cf.env`, not `.env`, because they are not bindings: they
authenticate **you** to the Cloudflare API, not the Worker to anything. Keeping them in
their own file also keeps the token off wrangler's dotenv path, so it is never loaded into
the Worker's env or uploaded as a secret. The script reads the file itself and holds the
token in memory — it never becomes an argv, so it stays out of your shell history and out
of an agent's context, and it is redacted from the output as a safety net.

Anything the subcommands don't cover falls through to a raw request:

```bash
npm run cf -- GET workflows -q per_page=50
npm run cf -- help
```

---

## Local development across the three repos

```bash
npm run link:local    # npm pack + tarball install from ../core, ../plugins
```

`npm pack` + tarball, deliberately — **not `npm link`**, which symlinks the checkout and
gives it its own copy of every peer. Two copies of `agents` in one Worker bundle breaks the
`Session` / `SessionMessage` types and every `instanceof`, at runtime rather than at the
type level. A tarball is what npm actually publishes, so if it works here it works from the
registry.

Nothing is written to `package.json`, so a plain `npm install` — and CI, which never runs
this — builds against whatever the branch declares, never a local checkout.

`--no-save` protects the manifest, not the lockfile: npm can still pin both packages to
`file:/var/folders/…/da-pack-*.tgz`, and those paths do not exist on a CI runner — or
on your machine once the temp dir is cleaned. The script now detects that and restores
`package-lock.json` itself, so the damage no longer lands on whoever pulls next.

---

## Layout

```
src/
  index.ts              ← the agents this Worker mounts
  host-manifest.ts      ← the stub card served at the well-known path
  config.ts             ← model ids, budgets, limits (values; core owns the shapes)
  round-policy.ts       ← the round contract + user-facing copy (core ships no prompt copy)
  workspace/            ← the container-backed workspace both coders share
  agents/
    reactive/           ← definition, plugins, soul, manifest, the `general` plugin
    proactive/          ← its own loop + workflow, plus the same set
    arc-player/         ← definition, plugins, soul, manifest, thin subclasses
    coder/              ← the same set, plus the `code` subtask type
    claude-coder/       ← the same set, plus a subagent that drives the CLI
test/
scripts/
```

## License

[Apache-2.0](./LICENSE).
