# The workspace container, for every agent in this Worker that has one.
#
# **One Dockerfile, two images.** `coder` and `claude-coder` both point a
# `containers[]` entry here; the second passes a `CLAUDE_CODE_VERSION` build arg
# (see the block near the end) and gets the CLI, the first does not and stays
# smaller. Cloudflare builds once per entry, so two entries naming this file are
# two images.
#
# The agents without a workspace — reactive, proactive, arc-player — never touch
# one. Cloudflare builds this on `wrangler deploy` from the `containers` block in
# wrangler.jsonc, always for linux/amd64: wrangler passes `--platform` itself and
# rejects any other value, so never set one here.
#
# The ENTRYPOINT is `computerd`, the workspace daemon from
# `@cloudflare/computer`. It mounts the Durable Object's SQLite-backed VFS at
# MOUNT_POINT over FUSE, so every command below sees the same tree the Worker
# reads and writes — and that tree survives the container, which is the whole
# reason this image replaced the `@cloudflare/sandbox` one.
#
# **The container's TLS trust is not established here**, and cannot be: under
# `egress: { mode: "http-gateway" }` the CA is mounted after the container
# starts, so anything in this image runs too early to find it. The workspace
# object installs it instead — the `ca-trust` module in
# `@dynamicagents/plugins/computer` carries the ordering constraint and the
# measurements.
# `NODE_OPTIONS` below is the other half, and belongs here because it is an
# image property.
#
# The `computerd` tag is paired with `@cloudflare/computer`;
# `scripts/verify-container-env.mjs` holds it to the installed version.
#
# Add to this file deliberately. Every layer is image size, image size is
# container cold start, and cold start is already the slow part of a round.

# A single layer over `scratch` holding one file: the 126 MB SEA binary at
# /usr/local/bin/computerd. Nothing else is in this image, so it is a staging
# stage and never a base.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.1 AS computerd

# `debian:stable-slim`, matching the upstream reference recipe
# (examples/container/Dockerfile) exactly — and the base is the load-bearing
# part of that match, not an incidental one.
#
# The obvious simplification is `node:24-slim`, which would drop the nodesource
# block below. It does not work: `node:24-slim` is Debian **bookworm**, and the
# FUSE packaging differs between the two releases in a way that decides whether
# this image can mount anything at all. On trixie, `fuse3` ships
# `/usr/bin/fusermount` (it took over the diversion, and `fusermount3` alongside
# it). On bookworm, `fusermount` comes from a separate `fuse` package which
# **conflicts** with `fuse3`, and `libfuse2t64` does not exist there — the
# pre-t64 name is `libfuse2`.
#
# So a bookworm base needs a different, untested package set for the one
# component whose failure mode is "the workspace is empty and no command can see
# the tree". `wrangler dev` cannot catch that either: it has no `/dev/fuse`, so
# computerd falls back to the userspace shim and a local run proves nothing.
# Fidelity to the tested set is worth a nodesource block.
FROM docker.io/debian:stable-slim

# fuse3,     — what computerd needs to mount its VFS. The `libfuse.so.2` the
# libfuse2t64   binary links is unpacked from inside the SEA at startup, so
#               these are the mount helper and its runtime, not the library
#               itself. Straight from the upstream recipe; keep them together.
# ripgrep    — reading an unfamiliar repo is the first thing the agent does, and
#               `grep -r` across node_modules is how a round runs out of time.
#               It matters more here than it did on a real disk: reads go
#               through FUSE.
# xxd        — the model reaches for it unprompted to inspect trailing bytes of a
#               file (`tail -c 200 README.md | xxd`), and it was the *first*
#               command of several consecutive production runs. Absent, that cost
#               a turn each time: exit 127, then a retry with `od -c`. It is the
#               `xxd` package on Debian 13, **not** `vim-common` — the two were
#               split apart, and vim-common alone leaves no `xxd` on PATH
#               (verified against debian:stable-slim, 13.6).
# make,      — node-gyp's prerequisites. Nothing in the Dynamic Agents repos compiles
# g++,          today (workerd, esbuild and friends all ship prebuilt binaries),
# python3       but one transitive dependency that does turns an install into
#               "gyp ERR! find Python", and that is not a failure the agent can
#               route around: fixing it means an operator rebuilding and
#               redeploying this image. ~150 MB to delete a class of dead round.
# git        — the whole delivery path is clone → commit → push.
#
# Node 24, not the reference's 22. Every Dynamic Agents repo pins 24 in `.nvmrc` and
# `engines`, and CI runs `setup-node@v6` with 24. An agent that builds and tests
# on 22 eventually produces "passed in the sandbox, failed in CI", which is the
# one result a coding agent must never produce.
#
# It is a plain system Node rather than the separate `/opt` prefix the
# predecessor image used. That prefix existed because the `@cloudflare/sandbox`
# base ran its own container server on the Node it shipped, and moving it out
# from under that server broke startup. `computerd` has no such constraint: it
# is a Node SEA that embeds its own runtime, the `fuse-native` prebuilds and
# `libfuse` as assets, so the host image needs no Node at all. Everything
# installed here is for the *agent's* commands, and there is one Node on PATH.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    fuse3 \
    libfuse2t64 \
    git \
    ripgrep \
    xxd \
    make \
    g++ \
    python3 \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# pnpm and yarn on demand, for repos that are not npm ones. A pnpm repo has no
# package-lock.json, so `npm ci` fails outright there and the install step burns
# its budget discovering it; corepack ships with Node and honours the repo's own
# `packageManager` pin, which is exactly what `resolveInstallCommand` keys on.
#
# Named managers rather than a bare `corepack enable`, which also shims `npm`:
# a shimmed npm in a repo with no `packageManager` field resolves through
# corepack's last-known-good version, putting a network round trip in front of
# every `npm ci`. Guarded because corepack is on its way out of Node, and a
# missing nice-to-have must not fail the image build.
RUN if command -v corepack > /dev/null; then \
      corepack enable pnpm yarn; \
    else \
      echo "corepack is not bundled with this Node build — skipping pnpm/yarn shims"; \
    fi

# --- Claude Code, for the agent whose subtasks run it -----------------------
#
# `image_vars` in wrangler.jsonc is a Docker build arg, so which image gets the
# CLI is decided per `containers[]` entry rather than per file. The `coder`
# entry passes nothing and this is a no-op; the `claude-coder` entry passes a
# version.
#
# A build arg rather than a second Dockerfile, because everything above encodes
# things that were expensive to learn — why the base is trixie and not bookworm,
# why `xxd` rather than `vim-common`, why Node 24 — and a copied file would drift
# silently, in whichever direction the image nobody redeployed recently went.
#
# **The pin is load-bearing, not tidiness.** The egress gateway rewrites this
# client's requests and `events.ts` parses its stream, and both are written
# against a wire shape captured from **2.1.238**: an `authorization: Bearer`
# with no `x-api-key`, a specific `anthropic-beta` list carrying
# `claude-code-20250219` and `oauth-2025-04-20`, and an unauthenticated
# `HEAD /api/hello` preflight. A version bump can move any of that, so it is a
# deliberate act that needs the smoke test re-run — see `src/claude-code/README.md`
# in `@dynamicagents/plugins`. Do not bump this to pick up a newer CLI without it.
#
# `--no-fund --no-audit` for the same reason as the ENV block below: a build log
# nobody reads is still a build log somebody has to scroll.
ARG CLAUDE_CODE_VERSION=""
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      npm i -g --no-fund --no-audit \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      && claude --version; \
    else \
      echo "no CLAUDE_CODE_VERSION build arg: this image has no Claude Code"; \
    fi

# --- The GitHub CLI, for reading a public repository ------------------------
#
# Behind its own build arg for the reason Claude Code is: `image_vars` in
# wrangler.jsonc decides per `containers[]` entry, so the `coder` image passes
# nothing and stays smaller.
#
# **It is unauthenticated, and that is the whole design.** The container holds no
# forge credential and must not — the `repo` module in `@dynamicagents/plugins`
# carries the argument, and it has not changed: git executes whatever `.git/config`
# and `.git/hooks` name, and the model has a root shell on that filesystem. What
# changed is that *reading a public repository needs no credential*, and reading
# is most of what a session reaches for `gh` to do.
#
# The catch: `gh` refuses to run at all without a token, even against a public
# repository — it exits asking for `gh auth login` before it makes a request. So
# the claude-coder sessions are launched with a placeholder GH_TOKEN, and the
# egress gateway deletes the header on the way out: the same swap the Anthropic
# credential rides on, inverted. The placeholder lives in the session env, not in
# this image, because it is only harmless behind that gateway — the `claude-coder`
# agent's `claude-code.ts` carries why.
#
# What that buys, and what it does not:
#   - REST reads of public repositories: `gh api repos/<o>/<r>/pulls/<n>`, its
#     `/comments`, `/files`, `/reviews`. 60 requests an hour for the whole egress
#     IP, which is shared, so it can be exhausted by someone else.
#   - **not** `gh pr view`, `gh issue view` or anything else built on GraphQL:
#     GitHub gives anonymous callers a GraphQL quota of zero.
#   - no write, and no private repository.
#   - the forge work — branches, commits, pushes, pull requests, review replies —
#     belongs to the parent's `repo_*` tools, which hold the credential Worker-side.
#
# A pinned release tarball rather than the apt repository: `gh` is a static Go
# binary that needs no dependency resolution, so this is one layer and no second
# keyring, and the checksum is verified because the build reaches the network for
# it. Only `bin/gh` is kept; the tarball also carries manpages and completions
# that nothing in here reads.
ARG GH_VERSION=""
ARG GH_SHA256=""
RUN if [ -n "$GH_VERSION" ]; then \
      curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
      && tar -xzf /tmp/gh.tar.gz -C /tmp \
      && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
      && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64" \
      && gh --version; \
    else \
      echo "no GH_VERSION build arg: this image has no GitHub CLI"; \
    fi

# Fail the BUILD, not round three, if the base image stops delivering the
# toolchain. npm ignores `engines` unless a repo opts in, so nothing downstream
# would tell you.
RUN node -e "const m=Number(process.versions.node.split('.')[0]); if (m < 24) { console.error('this image needs Node >= 24, PATH resolves to ' + process.execPath + ' at ' + process.versions.node); process.exit(1); }" \
  && node -p "'node ' + process.version + ' at ' + process.execPath" \
  && npm --version \
  && git --version \
  && rg --version | head -n1 \
# The workspace object shells out to this to trust the interception CA, so a
# base image that stopped shipping it must fail here rather than at round three.
  && command -v update-ca-certificates \
# The workspace object bind-mounts container disk over node_modules with these;
# `@dynamicagents/plugins/computer` carries why.
  && command -v mount && command -v mountpoint && command -v sha256sum \
  && test -x /usr/local/bin/computerd

# Everything below exists because tool output lands in a model's context window.
# `sb_exec` truncates to a byte budget, so every byte spent on an ANSI colour
# code or an npm progress bar is a byte not spent on the error message.
#
# **The COMPUTER_VAR_ prefix is what makes any of it reach a command**, and its
# absence fails silently. A command spawned by the workspace inherits PATH, HOME,
# TMPDIR, TZ, LANG, TERM and the LC_* family from `computerd` and nothing else —
# the allowlist that keeps the daemon's own secret out of a cloned repository's
# `postinstall`. Anything else arrives only as COMPUTER_VAR_<NAME>, which the
# daemon strips on the way through, so COMPUTER_VAR_CI=1 is what a command sees
# as CI=1. An unprefixed ENV here configures `computerd` and stops there.
#
# LANG is the exception below, and deliberately unprefixed: it is on the
# allowlist already, so it passes as itself.
#
# CI=1 does double duty: it is also what stops wrangler and friends from
# blocking on an interactive prompt that nobody is there to answer — a hang,
# which is a worse failure than an error.
#
# HUSKY=0 is the judgement call in this file. An install runs `prepare`, which
# in this repo family installs git hooks, and slack-gatekeeper's pre-commit hook
# runs the full `npm run check`. That would turn every `repo_commit` into a
# multi-minute lint run surfacing as an opaque "commit failed" with the real
# cause truncated out of the middle of the output. The agent should run
# `npm run check` deliberately, as its own visible step. Drop this line if you
# would rather the repo's own gate fire on each commit.
#
# DISABLE_AUTOUPDATER=1 belongs in the image as well as in the exec environment
# the plugin passes. The plugin's copy covers the sessions it launches; this one
# covers anything else that ever runs `claude` in here — a repo script, a command
# the model writes — and an autoupdate is exactly the event the pin above exists
# to prevent. Harmless in the image without the CLI.
#
# IS_SANDBOX=1 is here for the same reason, and it is load-bearing for the same
# clients. **This container runs as root**, and the CLI refuses to bypass its
# permission checks under uid 0 without it — `process.exit(1)` before the first
# JSON line, with the only explanation on stderr. The plugin sets it alongside
# `--permission-mode bypassPermissions` so the two cannot drift; this copy is
# what makes any other `claude` in here behave the same way the sessions do.
#
# It says what it means: a container with no persistent identity, holding no
# credential, running a cloned repository's `postinstall` by design. If this
# image is ever changed to exec as a non-root user, delete this line — the guard
# it clears will no longer be firing.
ENV COMPUTER_VAR_CI=1 \
    COMPUTER_VAR_HUSKY=0 \
    COMPUTER_VAR_DISABLE_AUTOUPDATER=1 \
    COMPUTER_VAR_IS_SANDBOX=1 \
    COMPUTER_VAR_NO_COLOR=1 \
    COMPUTER_VAR_FORCE_COLOR=0 \
    COMPUTER_VAR_NPM_CONFIG_FUND=false \
    COMPUTER_VAR_NPM_CONFIG_AUDIT=false \
    COMPUTER_VAR_NPM_CONFIG_PROGRESS=false \
    COMPUTER_VAR_NPM_CONFIG_UPDATE_NOTIFIER=false \
    COMPUTER_VAR_WRANGLER_SEND_METRICS=false \
    LANG=C.UTF-8

# Node reads the OS trust store instead of the one it bundles.
#
# This is what makes the workspace object's CA install reach the clients that
# matter. Node ships its own root list and ignores the system one, so
# `update-ca-certificates` alone leaves `npm ci`, `claude -p` and every
# `sb_exec node …` failing on an intercepted connection exactly as if nothing
# had been installed — measured, not assumed.
#
# The alternative is `NODE_EXTRA_CA_CERTS`, which cannot be set from here: the
# path does not exist at build time and nothing in the image can export it into
# a process the Worker spawns later. Supplying it per-exec would mean threading
# one variable through every path that spawns a process in this container, each
# with its own lifetime — and getting it wrong anywhere fails as a TLS error
# that names no cause.
#
# The prefix carries the same weight as the flag: unprefixed, this configures
# `computerd`, which makes no outbound TLS connection and does not need it, while
# every client that does keeps failing.
#
# Safe because `ca-certificates` is installed above, so the OS store already
# holds the normal public roots — verified: `npm ping` reaches the registry with
# this set and no extra CA present.
ENV COMPUTER_VAR_NODE_OPTIONS=--use-openssl-ca

# computerd's own configuration. `CloudflareContainerBackend` passes PORT and
# MOUNT_POINT in the container env when it starts the container, so these two
# are defaults for a manual `docker run` rather than load-bearing — but they
# must agree with the backend's, or a hand-run container answers on a port
# nothing dials.
#
# FUSE_MOUNT=auto is the one that matters, and it is why a single image serves
# both environments: Cloudflare Containers expose /dev/fuse to the workload, so
# the real FUSE backend mounts; `wrangler dev` does not, so computerd falls back
# to a userspace shim. `computerd` logs which one it resolved to at startup —
# `[info] FUSE_MOUNT=auto resolved to backend=…` — and that log line is the
# first thing to read when commands cannot see the tree.
ENV PORT=8080 \
    MOUNT_POINT=/workspace \
    FUSE_MOUNT=auto
EXPOSE 8080

# No WORKDIR, deliberately: computerd mounts the workspace at MOUNT_POINT after
# it starts, so a build-time WORKDIR /workspace would bake an empty directory
# that the mount then covers. Every exec passes an explicit cwd.
ENTRYPOINT ["/usr/local/bin/computerd"]
