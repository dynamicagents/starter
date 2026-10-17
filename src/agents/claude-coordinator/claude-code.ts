/** Where the credential pool's `{ index → resetAt }` map lives in DO storage. */
export const CREDENTIALS_KEY = "claude-credentials";

/**
 * The credential pool, read by the sandbox the egress leases it from
 * (`./sandbox.ts`), on the Worker side: the container is started with
 * placeholders, so no credential ever reaches it.
 *
 * Order is priority: entry 0 is used until Anthropic says its bucket is spent,
 * then the egress advances. `.filter(Boolean)` is what lets a deployment set
 * only `_1` — an unset secret is an empty string, and an empty entry is skipped
 * rather than sent as a bare `Bearer `. A pool of one is a perfectly ordinary
 * deployment; it simply gives up when its bucket empties instead of rotating.
 */
export function claudeCredentials(env: Env): string[] {
  return [
    env.CLAUDE_CODE_OAUTH_TOKEN_1,
    env.CLAUDE_CODE_OAUTH_TOKEN_2,
    env.CLAUDE_CODE_OAUTH_TOKEN_3
  ].filter(Boolean);
}
