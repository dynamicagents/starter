/**
 * Who a commit is attributed to, wherever in this Worker one is made.
 *
 * Two sides make commits and they must agree. The repo and scratch plugins write
 * this into the checkout's own config at clone time, and the workspace object
 * hands the same pair to its git client as `defaultGitIdentity` — so a commit
 * made in the container and a commit made on the Worker side carry one author.
 * Disagreement here is invisible: nothing fails, the history just gains a second
 * committer nobody configured.
 *
 * One function rather than the pair written out at each site, because "has to
 * match" in a comment is a rule with nothing enforcing it, and this Worker now
 * has four places that would have to keep it.
 *
 * `da-coder` is the fallback for an unset `GITHUB_NAME` — see `.env.example`.
 * The workspace object takes the resolved answer and has no fallback of its own,
 * which is the right split: a default identity is this deployment's choice.
 */
export function gitIdentity(env: Env): { name: string; email: string } {
  return {
    name: env.GITHUB_NAME || "da-coder",
    email: env.GITHUB_EMAIL
  };
}
