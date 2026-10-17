# The sandbox image: one container per caller per repository, whose disk is
# the checkout, driven by its Durable Object through the harness daemon.
#
# What `@dynamicagents/plugins/sandbox` requires of an image is in its README:
# the `agent` user owning /workspace, setpriv, timeout, an `env` that takes
# `-C`, git, update-ca-certificates, sandbox-shim, and a root-owned session
# skeleton. The rest is what a repository needs to build: Node, a C toolchain
# for native modules, and ripgrep for the file tools' searches.
#
# Each `containers[]` entry in wrangler.jsonc builds its own image from this
# file; wrangler.jsonc says how they differ. wrangler builds for linux/amd64 and
# rejects any other `--platform`, so never set one here. Every layer is cold
# start; add to it deliberately.

# `sandbox-shim`, which `@cloudflare/sandbox`'s `Files` and `DirectoryBackup`
# run through. Its tag follows the `@cloudflare/sandbox` the plugins install.
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

FROM docker.io/node:24-trixie-slim

# Node 24 because every repository here pins it and CI runs it: an agent
# building on another reports "passed in the sandbox, failed in CI".
#
# `procps` for `pkill`, which a cancelled command is ended with. `xxd` is its
# own package on Debian 13 — `vim-common` alone leaves none on PATH — and the
# model reaches for it unprompted; without it, a turn goes on exit 127.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ripgrep \
    procps \
    xxd \
    make \
    g++ \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# pnpm and yarn for a repository that pins one, as `packageManager` does.
# Named rather than a bare `corepack enable`, which shims `npm` too and puts a
# network round trip in front of every `npm ci` in a repository with no pin.
RUN if command -v corepack > /dev/null; then \
      corepack enable pnpm yarn; \
    else \
      echo "corepack is not bundled with this Node build — skipping pnpm/yarn shims"; \
    fi

# Claude Code, for `claude-coordinator`'s image: `CLAUDE_CODE_VERSION` is a
# build var on that entry in wrangler.jsonc, pinned to the version the
# claude-code plugin verified, and `npm run check` fails when the two differ —
# plugins' egress and stream parser are written against one version's traffic.
# `coding`'s entry sets none, and its image has no CLI.
#
# The `postinstall` is the install — `claude` is published as a placeholder that
# exits 1 until it runs — and a global install never reads `allowScripts`, so
# `--allow-scripts` approves it here and `claude --version` fails the build on
# the placeholder.
ARG CLAUDE_CODE_VERSION=""
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      npm i -g --no-fund --no-audit \
        --allow-scripts=@anthropic-ai/claude-code \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      && claude --version; \
    else \
      echo "no CLAUDE_CODE_VERSION build arg: this image has no Claude Code"; \
    fi

# `gh`, for a session that opens and answers its own pull requests. It reaches
# the API through the egress, which intercepts `api.github.com` and swaps in the
# token: `gh` holds a placeholder, never the credential.
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

# The agent, which every command, install and session runs as, and which owns
# the checkouts. The skeleton every session's home starts as is root's, so a
# session starts from this image rather than from what an earlier one left.
RUN useradd --create-home --home-dir /home/agent --uid 10001 --user-group \
      --shell /bin/bash agent \
  && mkdir -p /workspace /etc/da/skel \
  && chown agent:agent /workspace

# Fail the build, not the first session, on a missing requirement.
RUN node -e "const m=Number(process.versions.node.split('.')[0]); if (m < 24) { console.error('this image needs Node >= 24, found ' + process.versions.node); process.exit(1); }" \
  && git --version \
  && rg --version | head -n1 \
  && command -v setpriv timeout pkill update-ca-certificates \
  && env -C / true \
  && test -x /usr/local/bin/sandbox-shim

COPY container/daemon.mjs /opt/da/daemon.mjs

ENV LANG=C.UTF-8
WORKDIR /workspace

# The daemon runs as the agent, holding one capability that grants nothing
# here, so Linux refuses agent processes its `/proc/<pid>/environ`, where the
# harness's token is. It refuses to start any other way:
# `@dynamicagents/plugins/sandbox/daemon` says why.
ENTRYPOINT ["setpriv", "--reuid=10001", "--regid=10001", "--init-groups", \
  "--inh-caps=-all,+net_bind_service", "--ambient-caps=+net_bind_service", \
  "--bounding-set=-all,+net_bind_service", "node", "/opt/da/daemon.mjs"]
