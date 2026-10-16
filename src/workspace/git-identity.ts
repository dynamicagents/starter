/**
 * Who a commit is attributed to, wherever in this Worker one is made.
 *
 * Two kinds of committer must agree. The repo and scratch plugins write this
 * into the checkout's own config at clone time, and the sandbox gives the same
 * pair to every command and session it runs as git's author and committer
 * (`sandboxEnv` in `./container.ts`) — so a commit a plugin makes and one a
 * session makes, in a submodule or after an amend, carry one author.
 * Disagreement here is invisible: nothing fails, the history just gains a second
 * committer nobody configured.
 *
 * One function rather than the pair written out at each site, because "has to
 * match" in a comment is a rule with nothing enforcing it, and every plugin that
 * commits plus every sandbox would otherwise have to keep it.
 *
 * `da-coder` is the fallback for an unset `GITHUB_NAME` — see `.env.example`.
 * Nothing downstream has a fallback of its own, which is the right split: a
 * default identity is this deployment's choice.
 */
export function gitIdentity(env: Env): { name: string; email: string } {
  return {
    name: env.GITHUB_NAME || "da-coder",
    email: env.GITHUB_EMAIL
  };
}
