import type { ClaudeCodeConfig } from "@dynamicagents/plugins/claude-code";
import { CLAUDE_CODE_SESSION } from "@/config";

/** Where the credential pool's `{ index → resetAt }` map lives in DO storage. */
export const CREDENTIALS_KEY = "claude-credentials";

/**
 * What `gh` is given so that it will start at all — never a credential.
 *
 * `gh` refuses to make any request without a token, even against a public
 * repository. The sessions' egress gateway deletes `authorization` from every
 * request not bound for Anthropic, so what reaches GitHub is anonymous: REST
 * reads of public repositories work, and GraphQL — which GitHub gives anonymous
 * callers a quota of zero on — does not, so `gh pr view` and `gh issue view`
 * fail where `gh api repos/…` succeeds.
 *
 * Set here rather than in the image because it is only harmless **behind that
 * gateway**. The Dockerfile is shared with the coder, whose workspace egresses
 * `direct`: there nothing strips the header, and anything reading `GH_TOKEN` —
 * a repository script, an `npx`'d client — would present this as a credential
 * and get a 401 where it would otherwise have had anonymous access. A session's
 * env reaches only `claude` and the commands it runs, which is exactly the
 * process tree the gateway covers.
 */
export const GH_TOKEN_PLACEHOLDER = "not-a-credential-the-gateway-strips-this";

/**
 * One `ClaudeCodeConfig`, built once and shared by everything that needs it.
 *
 * Three places hold this object and they must hold the *same* one: the workspace
 * Durable Object (which turns it into the egress gateway), the parent's plugin
 * list (which registers the subtask type and resolves the workspace name), and
 * the subagent facet (which drives the session). A partial copy of a config like
 * this has already cost an outage — see `@/workspace/container.ts`.
 *
 * ## The credential never enters the container, and barely leaves this file
 *
 * `credentials` is read by **`.egress()` only**, which runs inside the workspace
 * object. The parent and the facet hold this same config and never call the
 * thunk — they need the model name, the timeouts and the workspace name, none of
 * which is secret. The container is launched with `CREDENTIAL_PLACEHOLDER` and
 * the swap happens on the Worker side of the boundary.
 *
 * ## The pool
 *
 * Order is priority: entry 0 is used until Anthropic says its bucket is spent,
 * then the egress gateway advances. `.filter(Boolean)` is what lets a deployment set
 * only `_1` — an unset secret is an empty string, and an empty entry is skipped
 * rather than sent as a bare `Bearer `. A pool of one is a perfectly ordinary
 * deployment; it simply gives up when its bucket empties instead of rotating.
 */
export function claudeCodeConfig(
  env: Env,
  workspaceName: () => string
): ClaudeCodeConfig {
  return {
    credentials: () =>
      [
        env.CLAUDE_CODE_OAUTH_TOKEN_1,
        env.CLAUDE_CODE_OAUTH_TOKEN_2,
        env.CLAUDE_CODE_OAUTH_TOKEN_3
      ].filter(Boolean),
    workspaceName,
    ...CLAUDE_CODE_SESSION,
    env: { GH_TOKEN: GH_TOKEN_PLACEHOLDER }
    /**
     * `restrictToHosts` is deliberately **unset**, which means unrestricted.
     *
     * Two reasons, and the second is the operational one. First, parity: the
     * coder's container runs `mode: "direct"` and has always had open egress, so
     * a restriction here would be a new boundary rather than a preserved one.
     * Second, `http-gateway` intercepts *everything* — so a restriction that
     * forgets a host does not degrade the agent, it stops `npm ci` dead, inside
     * a `postinstall` whose error mentions nothing about egress.
     *
     * What that gives up is a bound on exfiltration: this container holds the
     * checkout and can send it anywhere. The containment that does hold, and the
     * only one, is that it holds no credential.
     */
  };
}
