# da-starter

**The reference deployment of the Dynamic Agents train.**

Zero-trust A2A, a durable task lifecycle, delegation to sub-agents, and one
continuous, searchable conversation per caller — composed into one Worker on
Cloudflare and running at `agents.loopingai.org`, which follows this repo's `main`.

To start a project of your own, run **`npm create dynamicagents`**, which scaffolds
gates, leaders and agents on the same framework. Read this repo to see what those
pieces look like once they are wired together and deployed.

It mounts **several agents in one Worker**, and adding or removing a capability is a
single line. Almost none of it is framework: the turn is `@cloudflare/think`'s, and
the A2A task around it and delegation to sub-agents live in `@dynamicagents/core`, so
what is here is only the part that is yours to write — each agent's plugins, soul,
manifest and sub-agents, and the config and copy they share.

> The rest of the train:
> [`@dynamicagents/core`](https://github.com/dynamicagents/core) (the mandatory foundation) ·
> [`@dynamicagents/plugins`](https://github.com/dynamicagents/plugins) (optional capabilities) ·
> [`create-dynamicagents`](https://github.com/dynamicagents/create-dynamicagents) (the scaffolding CLI) ·
> **`da-starter`** (this — the deployment that composes them).

---

## Quick start

These steps run _this_ repository — locally, or as a deployment of your own.

```bash
npm install
npm run keygen          # one key for the deployment — see .env.example
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
`npx wrangler deploy --secrets-file .env`), create the bucket the sandboxes back their
checkouts up to — once, since a deploy binds it but does not make it — and:

```bash
npx wrangler r2 bucket create da-sandbox-backups
npm run deploy
```

Register each agent with your gatekeeper using the **same endpoint** and its own
**tenant id**:

| endpoint                    | tenant id            |
| --------------------------- | -------------------- |
| `https://<your-worker>/a2a` | `generic`            |
| `https://<your-worker>/a2a` | `coding`             |
| `https://<your-worker>/a2a` | `claude-coordinator` |

`/a2a` is core's default, not a requirement — see [Where the endpoints
live](#where-the-endpoints-live). Register whatever path this deployment actually serves.

> **The default models need a paid Workers plan**, or prepaid AI Gateway credits. Every
> agent takes its model from [`src/config.ts`](src/config.ts), and those are not served
> on Workers Free. On the free tier, point each agent's `modelId` at one that is, and that
> supports function calling. `claude-coordinator`'s is the exception: its `modelId` is
> an AI Gateway catalog slug rather than a Workers AI model, so a paid Workers plan does
> nothing for it and AI Gateway credits are what it spends — which also means the
> `default` gateway must not have **Require provider credentials** switched on with no
> key stored for the provider, or the call is refused with `400`.

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
// src/agents/generic/definition.ts — declared once
export const generic = defineAgent({
  tenant: "generic",
  manifest,
  agent: (env: Env) => env.GenericHost
});

// src/index.ts — mounted
createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [generic, coding, claudeCoordinator]
});
```

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
  "params": { "tenant": "generic" }
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

| Agent                                                   | What it is                                                                                                             | Why it's here                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`generic/`](src/agents/generic/)                       | Answers, and hands self-contained work to a sub-agent it waits for                                                     | The flagship                                                                             |
| [`coding/`](src/agents/coding/)                         | Clones a repo into a Linux sandbox, changes it, opens a pull request                                                   | Proves a plugin can own a Durable Object and a container without core knowing            |
| [`claude-coordinator/`](src/agents/claude-coordinator/) | Coordinates Claude Code sessions in the container, which build the change, open its pull request and answer its review | **Proves a sub-agent need not be a model loop at all** — its model is the session itself |

Each is a task host, a pipeline and a step agent, all three from
[`@dynamicagents/core`](https://github.com/dynamicagents/core): the host owns the A2A
task, the pipeline runs it as steps, and the step agent — on `@cloudflare/think` —
runs a step's job. Each is a one-step pipeline. A sub-agent that may run past the
fifteen minutes a turn can last runs **in the background**: the job stays open, and its
result arrives as a later turn. A step whose job fails runs once more, told it is a
retry.

### `claude-coordinator` plans with tools, and a plan is a link

Planning, approving and building are the agent's own tool calls, so whether a change
gets a plan — and whether the caller approves it first — is the agent's to judge and the
caller's to set, in what the agent remembers about them. A small, clear change skips
all three and goes straight to `claude_code`.

1. **`claude_code_plan`** runs a Claude Code session in a worktree of its own, in Claude
   Code's plan mode — it reads, and changes nothing — which answers through
   `--json-schema`: a title, the plan, and a short account for the agent. The plan is
   filed as an [artifact](https://github.com/dynamicagents/core) — a page anyone with its
   link can read, kept 30 days — and the agent gets its **id**, never its text. Called
   again with the id, the session that wrote the plan revises it on the same page.
2. **`ask_user`** with the plan's id asks the caller to approve it, with its link:
   Approve, Reject, or a comment, which the agent turns into an edit. Approving locks
   the plan. A caller whose memory says they do not approve plans is not asked.
3. **`claude_code`** with the plan's id **carries on from the planning session's
   conversation**, forked, in the worktree that holds it — so the build starts knowing
   what the planner read and found — and is given the plan whole, the text the caller
   read. Where that worktree is busy or gone, it starts fresh from the plan.
   `prepareWriter` in [`children.ts`](src/agents/claude-coordinator/children.ts) has how.

A plan belongs to the caller whose agent opened it
([`plans.ts`](src/agents/claude-coordinator/plans.ts)): a link is shared by design, but only
that caller's agent edits, approves or builds it.

### `claude-coordinator` coordinates, and the sessions own the pull request

The agent's own model coordinates and neither writes nor reviews code — and it is the
one model in this deployment that is not a Workers AI one: its `modelId` in
[`src/config.ts`](src/config.ts) is an AI Gateway catalog slug, reached over the same
`AI` binding, and it compacts on that slug too. A session pushes its branch, opens the
pull request — ready for review, which is what asks for Copilot's — and answers through
`--json-schema` how it ended: done, stopped for the person's decision, or blocked.
Between sessions the agent watches the
pull request with `check_back`, `repo_pr_view`, `repo_pr_threads` and `repo_pr_checks`
— none of which starts a container, and all of which read GitHub through its hosted
MCP server — and sends it back with **`claude_code_revise`** when a review, an
unresolved thread or a failing check lands, or for a self-review it judges worth one.
Nothing asks whether a review is still _pending_: that is not a question this surface
answers, so a wait with nothing landing ends on the clock. A revision carries
on the conversation that last worked on the branch, in its worktree, so the session
that answers a review is the one that wrote the code. A worktree's container stops as
soon as its session settles, so nothing idles through the wait.

The agent's file reads follow the latest session into its worktree, and stay there
across tasks until it moves them with `repo_worktree`. Where they run is a context
block re-read every turn, so a move never goes unannounced.

GitHub is reached as the deployment's account: a session's `gh` and git present a
placeholder, and the egress swaps in `GITHUB_TOKEN` for GitHub's hosts only — and never
lets a push update a repository's default branch.
[`.env.example`](.env.example) says how to scope that token.

### The two coders need one thing the others do not

A **container**. Everything else about them — the turn, the A2A task, the model
call through AI Gateway — is what every other agent here runs.

The two differ in exactly one place, and it is one level below the agent: what a
sub-agent _is_. `coding`'s `code` is a Think sub-agent on Workers AI, working in
the container. A `claude-coordinator` session is one `claude -p` process — its own loop,
its own tools, its own context management — so its sub-agent's model is
`claudeCodeHarnessModel`, which runs the session, rather than a model call. Their
sandboxes are two thin subclasses of `SandboxObjectBase` from
`@dynamicagents/plugins/sandbox`, differing in their config and in what their egress
lets through.

That egress is the whole reason `claude-coordinator` exists. An Anthropic
**subscription** credential is refused for raw Messages API calls on every
frontier model and accepted from the sanctioned client — so reaching Opus on one
means running that client, and the client runs in a container that also runs a
cloned repository's `postinstall`. The credential never goes there: the session
launches with a placeholder pointed at a host the container's runtime intercepts,
and an entrypoint on the Worker side swaps the real one in. That egress leases from
an ordered **pool** of credentials the sandbox keeps, and rotates when Anthropic says
one's 5-hour or weekly bucket is spent. Each host an agent's containers may reach is
declared by the plugin that needs it, in the agent's `egress.ts`.

Every agent's own model, both coders included, runs through the `AI` binding — Workers AI
for all of them but `claude-coordinator`, whose calls name an AI Gateway catalog slug and
so reach a third-party provider over that same binding. **There is no model credential in
this deployment** on either path: the platform authenticates the binding and AI Gateway
decides what pays, so there is nothing to store, nothing to rotate, and `coding`'s
container has never seen one. [`.env.example`](.env.example) is the full list of what a
deployment does need, and what a gateway error means.

The container needs the **Workers Paid** plan and a running Docker daemon on the
machine that runs `wrangler deploy` — wrangler builds this repository's Dockerfiles
locally and pushes an image per `containers[]` entry in
[`wrangler.jsonc`](wrangler.jsonc), so that is your laptop or your CI runner, never
Cloudflare:

- **macOS and Windows** — install **Docker Desktop** and have it running. The
  `docker` CLI on its own is not enough: the build needs a Linux kernel, which is
  what Desktop's VM provides. (Anything else that exposes a daemon socket works —
  OrbStack, Colima, Rancher Desktop.)
- **Linux** — the Docker CLI and engine, and nothing else. No Desktop.

With no daemon reachable, `npx wrangler deploy --containers-rollout=none` deploys
the Worker and leaves the container alone.

> **The image and the Worker are one release.** The sandbox image's daemon is
> bundled from this repository's own `node_modules` before every deploy
> (`scripts/build-daemon.mjs`), so the object and the daemon it drives speak one
> `agents` version. A running container keeps the image it started with, and a deploy
> does not interrupt it: a sandbox takes a new image at its next start.

> **Deleting a container application does not rebuild it.** In the dashboard it
> reads like turning something off and on again, and it is not: the application
> is created by `wrangler deploy`, and the Durable Object can only start
> instances of one that already exists. Delete it and every sandbox fails —
> `There is no container application assigned to this Durable Object namespace`
> — until the next deploy, which turns a bounded problem into an open-ended one.
> To replace one sandbox's container, let it go idle.

#### The checkout is the container's disk, and it outlives the task

The **sandbox** is a Durable Object, one per caller per repository, driving one container
through `agents`' `ContainerHarness`, and that container's disk holds `node_modules`
beside the checkout. The object keeps the durable record: each session, its transcript,
the CLI's own files to resume it from. The checkout's own files never cross into it —
reading one means asking the container — so a reset of the object leaves the container
running. `@dynamicagents/plugins/sandbox`'s README has the mechanism.

A container nobody uses is backed up to R2 and stopped minutes after its last use, and
its next start is a snapshot of its disk — the checkout, the dependencies, and any commit
nobody pushed — or a restore from that backup, when a new image dropped the snapshot. An
install runs once per checkout and again only when what it depends on changed: the
fingerprint is the plugin's, and the commands are in
[`src/workspace/install-plan.ts`](src/workspace/install-plan.ts). A writing session's
worktree is a sandbox of its own, seeded from the parent's checkpoint so its checkout and
dependencies sit at the same path.

Two consequences worth knowing before you debug something surprising:

- **A caller's checkout outlives their task.** `repo_clone` therefore fetches and
  resets an existing checkout rather than assuming an empty directory — and
  refuses outright if the tree is dirty, because those changes are a previous
  task's work and nobody could recover them once discarded. What ends a checkout
  is the weekly sweep: a sandbox nothing has touched for `SANDBOX_RECLAIM_MS`
  ([`src/config.ts`](src/config.ts)) is emptied, its backups and any unpushed
  commit with it.
- **A cancelled task leaves its work where it stopped.** A cancel may be a
  pause — to add to the task, or to pick it up later — and what a run did may
  have had effects that redoing it would repeat, so nothing is reset for it. A
  writing session's worktree keeps its work committed on its branch; a
  checkout keeps its changes. Whether to continue, commit or discard is the
  agent's call, on the next task.

A sub-agent reaches its sandbox through its spec's `prepare`, which runs on the
**parent**, where the caller and the repository are known, and hands the
sandbox name to the sub-agent as `runtime()`. It is deliberately not the
sub-agent's input: the parent's model writes that, and a model could then name
somebody else's sandbox. A `claude-coordinator` writing session gets a worktree of its
own that way, and its `settle` records and frees it when the run ends.

---

## The one file you edit

Each agent has its own `plugins.ts`. Delete a line and that module leaves the bundle
entirely:

```ts
// src/agents/generic/plugins.ts
export const plugins = (env: Env): AgentPlugin<Env>[] => [
  browser({ binding: env.BROWSER })
];
```

Files are Think's own workspace, in each object's SQLite, so nothing is installed for
them. An agent whose files live in a container says so itself, next to its plugins:

```ts
// src/agents/coding/agent.ts
override workspace = sandboxWorkspace(this.#place);
```

Nothing in core imports a plugin, and `@dynamicagents/plugins` has no root barrel — the bare
specifier does not resolve — so the guarantee is structural rather than a tree-shaker's
opinion. `npm run verify:isolation` asserts it on the built module graph.

There is deliberately **no shared plugin list**: a single one would put every plugin in
every agent and make the guarantee unmeasurable.

A coder's list takes more than `env`: the agent's own repository selection, one
instance shared with its `workspace`, because the selection caches what it last read
and two instances would disagree about where the checkout is.

### Writing your own

A plugin is not a package; it is an object satisfying a contract, declared with
`definePlugin`. A sub-agent is the same: a `SubAgentSpec` bound to a `SubAgent` class.
[`src/agents/generic/children.ts`](src/agents/generic/children.ts) binds one this repo
writes — the `general` catch-all — and it is indistinguishable at the seam from the Claude
Code specs `@dynamicagents/plugins` publishes.

It is also _why_ there is no `@dynamicagents/plugins/general`: a spec must declare its soul,
and core refuses to lend one, so that no run ever executes under an identity nobody chose.
That identity is yours to write.

---

## Add or delete an agent

Scaffolding an agent is moving to
[`create-dynamicagents`](https://github.com/dynamicagents/create-dynamicagents) —
`npm create dynamicagents@latest agent`. It is a work in progress; follow it at
[dynamicagents.dev](https://dynamicagents.dev).

Deleting one never edits a migration tag you have deployed: its Durable Object class
goes into `deleted_classes` in a new tag. The `migrations` comments in
[`wrangler.jsonc`](wrangler.jsonc) say why.

---

## What runs in CI

```bash
npm run check              # wrangler types, prettier, eslint, tsc, comment path refs
npm test                   # vitest, inside real workerd
npm run verify:isolation   # per-agent module graphs + size ceilings
npx wrangler deploy --dry-run --outdir dist
```

`verify:isolation` is the one that survives a refactor six months from now. This Worker
deploys as **one bundle containing every agent**, so grepping `dist/` for "computer"
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

It earns its keep: it has caught a real leak — a shared base class living in one agent's
directory, which dragged that agent's plugins into a sibling's graph that installs none of
them.

---

## Continuous deployment

This repository's own deployment, `agents.loopingai.org`, follows `main`. On every push to
`main`, [`deploy.yml`](.github/workflows/deploy.yml) waits for Test to pass on that commit,
then runs `npx wrangler deploy` for it — building and pushing the container images with the
Worker — and polls `/.well-known/agent-card.json` until it answers 200.
That shows the domain still serves; it cannot tell the new version from the old. A commit
that is no longer `main`'s tip by the time its run gets there stands aside rather than roll
production back.

What `main` installs is what runs, a git ref onto core's or plugins' `main` included —
running those here is how unreleased work upstream is exercised.

It needs a GitHub environment named `deployment` holding these secrets:

- `CLOUDFLARE_ACCOUNT_ID`.
- `CLOUDFLARE_API_TOKEN`, with Account › Workers Scripts › Edit, Account › Containers ›
  Edit for the images, and Zone › Workers Routes › Edit on the custom domain's zone, which
  every deploy re-asserts. Bound resources such as Workers AI and Browser Rendering need
  no scope of their own to deploy against.

The Worker's runtime secrets are not in GitHub. Set them once with `wrangler secret put`;
they persist across deploys, and a deploy fails naming any in `secrets.required` that was
never set.

A copy of this repository skips the deploy, since it has neither the environment nor the
domain. To deploy yours the same way, create the environment, then name your repository in
`deploy.yml`'s `if:` and your origin in its URLs.

---

## Looking at a running deployment

```bash
cp .cf.env.example .cf.env    # an account-scoped API token + your account id
npm run cf -- logs --since 2h --level error
npm run cf -- ai --since 2h
npm run cf -- ai --task <taskId> --all
```

[`scripts/cf.mjs`](scripts/cf.mjs) is a small Cloudflare API proxy for the questions a
deploy actually raises: what did it log, and what did the model get asked. Each subcommand
prints a digest rather than the raw envelope — `logs` a level-tallied timeline, `ai <logId>`
the prompt and reply as text — with `--json` or `--raw` when you want the body. Every model
call is tagged with its agent, its task and its phase (`turn`, `subagent` or
`compaction`), so `ai --task` gathers one task's calls across the agent and its
sub-agents.

A container's own stdout and stderr are not in the Worker's logs, which record only that
it exited. `logs --container <app>` reads them — `npm run cf -- containers` lists the
application names — and that is where a container that dies says why.

`spans` reads the Worker's traces, which neither log shows: each turn's model calls and
tool calls with their durations, and each Durable Object's lifecycle. An agent object's
`agent_start` marks a new instance, and most are ordinary — after an idle eviction or a
deploy. One that lands while the same object's earlier `alarm` or `chat_turn` is still
open (`spans --object <id> --name alarm`) is the platform replacing a live instance
mid-turn: the old one's next storage call then fails with "this Durable Object instance is
no longer active".

The credentials go in `.cf.env`, not `.env`, because they are not bindings: they
authenticate **you** to the Cloudflare API, not the Worker to anything. Keeping them in
their own file also keeps the token off wrangler's dotenv path, so it is never loaded into
the Worker's env or uploaded as a secret. The script reads the file itself and holds the
token in memory — it never becomes an argv, so it stays out of your shell history and out
of an agent's context, and it is redacted from the output as a safety net.

Anything the subcommands don't cover falls through to a raw request:

```bash
npm run cf -- GET workers/scripts
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
  config.ts             ← model ids and compaction (values; core ships no numbers)
  copy.ts               ← user-facing copy + guidance every soul shares (core ships none)
  model.ts              ← the one model each class runs (Workers AI or a catalog slug), tagged for AI Gateway
  sandbox-daemon.ts     ← the sandbox image's entrypoint, bundled for Node before every deploy
  workspace/            ← where both coders' sandboxes are, and how their tools reach them
  agents/
    generic/           ← agent, children (the `general` sub-agent), definition, plugins, soul, manifest
    coding/           ← the same set, plus the `code` spec, the sandbox and its egress
    claude-coordinator/       ← the same set, plus the Claude Code sessions' report, the sandbox and its egress
test/
scripts/
```

## License

[Apache-2.0](./LICENSE).
