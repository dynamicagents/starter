import type { ClaudeCodeConfig } from "@dynamicagents/plugins/claude-code";
import { CLAUDE_CODE_SESSION } from "@/config";
import { gitIdentity } from "@/workspace/git-identity";

/** Where the credential pool's `{ index → resetAt }` map lives in DO storage. */
export const CREDENTIALS_KEY = "claude-credentials";

/**
 * One `ClaudeCodeConfig`, built the same way by everything that needs it.
 *
 * Two places hold this config and they must hold the *same* one: the workspace
 * Durable Object, which turns it into the egress gateway, and each Claude Code
 * sub-agent, which drives the session. A partial copy of a config like this has
 * already cost an outage — see `@/workspace/container.ts`.
 *
 * ## The credentials never enter the container, and barely leave this file
 *
 * `credentials` and `forge` are read by **`.egress()`**, which runs inside the workspace
 * object. A sub-agent holds this same config and reads the thunk only to check
 * one is configured at all — it needs the model name and the timeouts, none of
 * which is secret. The container is launched with placeholders and the swap
 * happens on the Worker side of the boundary.
 *
 * ## The pool
 *
 * Order is priority: entry 0 is used until Anthropic says its bucket is spent,
 * then the egress gateway advances. `.filter(Boolean)` is what lets a deployment set
 * only `_1` — an unset secret is an empty string, and an empty entry is skipped
 * rather than sent as a bare `Bearer `. A pool of one is a perfectly ordinary
 * deployment; it simply gives up when its bucket empties instead of rotating.
 */
export function claudeCodeConfig(env: Env): ClaudeCodeConfig {
  return {
    credentials: () =>
      [
        env.CLAUDE_CODE_OAUTH_TOKEN_1,
        env.CLAUDE_CODE_OAUTH_TOKEN_2,
        env.CLAUDE_CODE_OAUTH_TOKEN_3
      ].filter(Boolean),
    ...CLAUDE_CODE_SESSION,
    /**
     * GitHub as the deployment's account: the session pushes its branch, opens
     * its pull request and answers its review. The token reaches GitHub's hosts
     * through the egress gateway and never the container.
     */
    forge: { token: () => env.GITHUB_TOKEN },
    /**
     * The same identity the workspace and the repo plugin answer with — see
     * `@/workspace/git-identity`.
     *
     * The session commits in repositories neither of those configured: the
     * submodules of a superproject it cloned, anything it initialises for
     * itself. It also amends and rebases in the checkout that *is* configured,
     * and those take the committer from config rather than from the tool that
     * made the original commit. The plugin turns this into the session's git
     * environment, which every git it starts inherits.
     */
    author: gitIdentity(env)
    /**
     * `restrictToHosts` is deliberately **unset**, which means unrestricted.
     *
     * Two reasons, and the second is the operational one. First, parity:
     * `coding`'s container runs `mode: "direct"` and has always had open egress, so
     * a restriction here would be a new boundary rather than a preserved one.
     * Second, `http-gateway` intercepts *everything* — so a restriction that
     * forgets a host does not degrade the agent, it stops `npm ci` dead, inside
     * a `postinstall` whose error mentions nothing about egress.
     *
     * What that gives up is a bound on exfiltration: this container holds the
     * checkout and can send it anywhere. The containment that does hold is
     * that it holds no credential — though anything in it can act on GitHub as
     * the token's account while a session runs, which is why the token is
     * scoped to the repositories this deployment works on (`.env.example`).
     */
  };
}
